'use strict';
// 05:30 IST auto-rollover scheduler.
// At each rollover:
//   1. Computes the just-closed business date.
//   2. Writes a "last_rollover" + "last_rollover_date" into settings (UI reads this).
//   3. Archives a filled .xlsx snapshot of that date into data/exports/.
//   4. Optionally pushes the closed-day snapshot to Google Sheets (if configured).
// The rollover does NOT mutate any prior-date data — it just marks the boundary.

const fs = require('fs');
const path = require('path');
const { db } = require('./db');
const { businessDate, msUntilNextRollover, currentBusinessDate } = require('./businessDate');

const EXPORTS_DIR = path.join(__dirname, '..', '..', 'data', 'exports');
fs.mkdirSync(EXPORTS_DIR, { recursive: true });

function getTemplatePath(branchCode) {
  const code = String(branchCode || '').toUpperCase();
  if (code) {
    const r = db.prepare("SELECT value FROM settings WHERE key = ?").get('sheet_template_path_' + code);
    if (r && r.value) return r.value;
  }
  const row = db.prepare("SELECT value FROM settings WHERE key = 'sheet_template_path'").get();
  return row ? row.value : null;
}

async function runRollover(reason = 'scheduled') {
  const closedDate = businessDate(Date.now() - 1000); // the date that just ended
  const newDate = currentBusinessDate();
  const ts = new Date().toISOString();
  const info = { reason, closedDate, newDate, ts };

  // Archive a snapshot per branch (uses each branch's own template if uploaded,
  // else falls back to the legacy single template).
  try {
    const { writeWorkbook, buildDataForDate, buildGrid, renderTemplateAsHtml } = require('./xlsxWriter');
    const codes = ['MAIN', 'B1', 'B2', 'B3'];
    info.archived = {};
    info.html_snapshots = {};
    const snapIns = db.prepare(`INSERT INTO sheet_snapshots(business_date, branch, html, created_at)
                                VALUES (?,?,?,datetime('now'))
                                ON CONFLICT(business_date,branch) DO UPDATE SET
                                  html=excluded.html, created_at=excluded.created_at`);
    for (const code of codes) {
      const tpl = getTemplatePath(code);
      if (!tpl || !fs.existsSync(tpl)) continue;
      // 1) xlsx archive (filesystem; lost on free-tier redeploys)
      try {
        const out = path.join(EXPORTS_DIR, `hisab_${closedDate}_${code}.xlsx`);
        writeWorkbook(tpl, out, buildDataForDate(db, closedDate, code));
        info.archived[code] = out;
      } catch (_) {}
      // 2) HTML snapshot in DB — survives free-tier redeploys (until DB
      //    itself wipes), and serves "view past day" requests when the
      //    underlying live tables have been trimmed.
      try {
        const data = buildDataForDate(db, closedDate, code);
        const g = buildGrid(data, code);
        const liveValues = {};
        for (let r = 0; r < g.grid.length; r++) {
          for (let c = 0; c < g.grid[r].length; c++) {
            const v = g.grid[r][c];
            if (typeof v === 'number' && v !== 0) liveValues[`${r},${c}`] = v;
            else if (typeof v === 'string' && v !== '' && r > 0) liveValues[`${r},${c}`] = v;
          }
        }
        const ovs = db.prepare('SELECT row, col, value FROM sheet_overrides WHERE business_date = ?').all(closedDate);
        const overrides = {};
        for (const o of ovs) overrides[`${o.row},${o.col}`] = o.value;
        const html = renderTemplateAsHtml(tpl, { liveValues, overrides, editable: false });
        snapIns.run(closedDate, code, html);
        info.html_snapshots[code] = html.length;
      } catch (e) { info.html_snapshot_error = (info.html_snapshot_error || '') + ` ${code}:${e.message};`; }
    }
  } catch (e) { info.archive_error = String(e.message || e); }

  // Auto-purge snapshots older than 35 days. Keeps "last month" available
  // even when scrolling back, but caps DB growth.
  try {
    const cutoff = (() => {
      const d = new Date(Date.now() - 35 * 86400 * 1000);
      return d.toISOString().slice(0, 10);
    })();
    const r = db.prepare('DELETE FROM sheet_snapshots WHERE business_date < ?').run(cutoff);
    info.purged_snapshots = r.changes;
    // Also trim very old live tables so the DB doesn't grow forever even
    // if the operator never deletes anything. Same 35-day window.
    const r2 = db.prepare('DELETE FROM bank_txns WHERE business_date < ?').run(cutoff);
    const r3 = db.prepare('DELETE FROM dw WHERE business_date < ?').run(cutoff);
    const r4 = db.prepare('DELETE FROM gpay WHERE business_date < ?').run(cutoff);
    const r5 = db.prepare('DELETE FROM expenses WHERE business_date < ?').run(cutoff);
    const r6 = db.prepare('DELETE FROM sheet_overrides WHERE business_date < ?').run(cutoff);
    info.purged_live = { bank_txns: r2.changes, dw: r3.changes, gpay: r4.changes,
                         expenses: r5.changes, sheet_overrides: r6.changes };
  } catch (e) { info.purge_error = String(e.message || e); }

  // ── Bank opening-balance carry-forward ──────────────────────────────
  // Today's opening balance = yesterday's closing balance (= yesterday's
  // open_balance + all non-charge credits − all non-charge debits).
  // After rollover, today's sheet shows 0s for everything except bank
  // opening + closing balances (closing == opening until first txn arrives).
  try {
    const banks = db.prepare('SELECT id, open_balance FROM banks').all();
    const carry = db.transaction(() => {
      const upd = db.prepare('UPDATE banks SET open_balance = ? WHERE id = ?');
      const sumQ = db.prepare(`
        SELECT type, COALESCE(SUM(amt),0) AS total FROM bank_txns
        WHERE bank_id = ? AND business_date = ?
          AND (category IS NULL OR category != 'charge')
        GROUP BY type
      `);
      let updated = 0;
      for (const b of banks) {
        const rows = sumQ.all(b.id, closedDate);
        let credit = 0, debit = 0;
        for (const r of rows) (r.type === 'credit' ? credit = r.total : debit = r.total);
        const closing = Number(b.open_balance || 0) + credit - debit;
        upd.run(closing, b.id);
        updated++;
      }
      return updated;
    });
    info.banks_carried = carry();
  } catch (e) { info.carry_error = String(e.message || e); }

  // Best-effort push to Google Sheets for the closed date
  try {
    const cfg = (() => { try { return require('./googleSheetWriter').loadGoogleConfig?.() || {}; } catch (_) { return {}; } })();
    const haveCfg = (process.env.GOOGLE_SHEET_ID || cfg.sheetId)
                  && (process.env.GOOGLE_SERVICE_ACCOUNT_JSON || cfg.saJson);
    if (haveCfg) {
      const { pushToGoogleSheet } = require('./googleSheetWriter');
      const gs = await pushToGoogleSheet(db, closedDate);
      info.google = gs;
    }
  } catch (e) { info.google_error = String(e.message || e); }

  const upsert = db.prepare(
    `INSERT INTO settings(key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  );
  upsert.run('last_rollover', ts);
  upsert.run('last_rollover_date', closedDate);
  upsert.run('last_rollover_info', JSON.stringify(info));

  console.log('[rollover]', info);
  return info;
}

let timer = null;
function scheduleNext() {
  if (timer) clearTimeout(timer);
  const ms = msUntilNextRollover();
  timer = setTimeout(async () => {
    try { await runRollover('scheduled'); } catch (e) { console.error('[rollover] error', e); }
    // add a tiny drift guard, then reschedule
    setTimeout(scheduleNext, 2000);
  }, ms + 500);
  console.log('[rollover] next in', Math.round(ms / 1000), 's');
}

function start() {
  scheduleNext();
}

module.exports = { start, runRollover, scheduleNext };
