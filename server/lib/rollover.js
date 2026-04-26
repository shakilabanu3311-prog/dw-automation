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
    const { writeWorkbook, buildDataForDate } = require('./xlsxWriter');
    const codes = ['MAIN', 'B1', 'B2', 'B3'];
    info.archived = {};
    for (const code of codes) {
      const tpl = getTemplatePath(code);
      if (!tpl || !fs.existsSync(tpl)) continue;
      const out = path.join(EXPORTS_DIR, `hisab_${closedDate}_${code}.xlsx`);
      writeWorkbook(tpl, out, buildDataForDate(db, closedDate, code));
      info.archived[code] = out;
    }
  } catch (e) { info.archive_error = String(e.message || e); }

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
