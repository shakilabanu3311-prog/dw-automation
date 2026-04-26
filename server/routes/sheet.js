'use strict';
// Sheet export / upload routes.
// - POST /api/sheet/template   — upload the master .xlsx template (admin only)
// - GET  /api/sheet/xlsx?date= — download a filled .xlsx for a business_date
// - POST /api/sheet/google     — push selected rows to Google Sheets (stub; requires GS_* env)

const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { db, audit } = require('../lib/db');
const A = require('../lib/auth');
const { currentBusinessDate } = require('../lib/businessDate');
const { writeWorkbook, buildDataForDate, buildGrid, loadTemplateStyles, renderTemplateAsHtml } = require('../lib/xlsxWriter');

const router = express.Router();
const TEMPLATE_DIR = path.join(__dirname, '..', '..', 'data', 'templates');
const OUT_DIR = path.join(__dirname, '..', '..', 'data', 'exports');
fs.mkdirSync(TEMPLATE_DIR, { recursive: true });
fs.mkdirSync(OUT_DIR, { recursive: true });

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

// Per-branch templates: settings keys are sheet_template_path_<CODE>.
// Falls back to the legacy single 'sheet_template_path' if a branch
// hasn't uploaded its own template — so existing single-sheet setups
// keep working unchanged.
function getTemplatePath(branchCode) {
  const code = String(branchCode || '').toUpperCase();
  if (code) {
    const r = db.prepare("SELECT value FROM settings WHERE key = ?").get('sheet_template_path_' + code);
    if (r && r.value) return r.value;
  }
  const row = db.prepare("SELECT value FROM settings WHERE key = 'sheet_template_path'").get();
  return row ? row.value : null;
}

router.post('/template', A.requireAuth, A.requireAdmin, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: 'no file' });
  // ?branch=B1 → store as sheet_template_path_B1; omit → legacy single template.
  const branch = String(req.query.branch || req.body?.branch || '').toUpperCase();
  const filename = branch ? `branch_${branch}.xlsx` : 'master.xlsx';
  const dest = path.join(TEMPLATE_DIR, filename);
  fs.writeFileSync(dest, req.file.buffer);
  const key = branch ? ('sheet_template_path_' + branch) : 'sheet_template_path';
  db.prepare(
    `INSERT INTO settings(key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, dest);
  audit(req.user.id, 'upload', 'sheet_template', branch || null, { bytes: req.file.buffer.length });
  res.json({ ok: true, path: dest, branch: branch || null });
});

// List which branches have a custom template uploaded.
router.get('/template/list', A.requireAuth, (req, res) => {
  const codes = ['MAIN', 'B1', 'B2', 'B3'];
  const out = {
    legacy: !!getTemplatePath(),
    branches: {},
  };
  for (const c of codes) {
    const r = db.prepare("SELECT value FROM settings WHERE key = ?").get('sheet_template_path_' + c);
    out.branches[c] = r && r.value && fs.existsSync(r.value) ? { path: r.value, has: true } : { has: false };
  }
  res.json({ ok: true, ...out });
});

router.get('/xlsx', A.requireAuth, (req, res) => {
  const date = req.query.date || currentBusinessDate();
  const branch = req.query.branch || null;
  const tpl = getTemplatePath(branch);
  if (!tpl || !fs.existsSync(tpl)) {
    return res.status(400).json({ ok: false, error: 'no template uploaded — POST /api/sheet/template first' });
  }
  try {
    const data = buildDataForDate(db, date, branch);
    const out = path.join(OUT_DIR, `hisab_${date}.xlsx`);
    writeWorkbook(tpl, out, data);
    res.download(out, `hisab_${date}.xlsx`);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

router.get('/preview', A.requireAuth, (req, res) => {
  const date = req.query.date || currentBusinessDate();
  try {
    const data = buildDataForDate(db, date);
    // Flatten into a per-row list the UI can checkbox
    const rows = [];
    for (const [slug, pd] of Object.entries(data.panels)) {
      for (const e of pd.entries) {
        if (e.deposit)    rows.push({ kind: 'panel_deposit',    panel: slug, name: e.name, amt: e.deposit, selected: true });
        if (e.withdrawal) rows.push({ kind: 'panel_withdrawal', panel: slug, name: e.name, amt: e.withdrawal, selected: true });
        if (e.freeChips)  rows.push({ kind: 'panel_free_chips', panel: slug, name: e.name, amt: e.freeChips, selected: true });
      }
    }
    for (const b of data.banks) {
      if (b.credit) rows.push({ kind: 'bank_credit', bank: b.name, amt: b.credit, selected: true });
      if (b.debit)  rows.push({ kind: 'bank_debit',  bank: b.name, amt: b.debit,  selected: true });
    }
    for (const r of data.bankExp) rows.push({ kind: 'bank_exp', ...r, selected: true });
    for (const r of data.parking) rows.push({ kind: 'parking', ...r, selected: true });
    res.json({ ok: true, business_date: date, rows, counts: {
      banks: data.banks.length,
      panels: Object.keys(data.panels).length,
      bankExp: data.bankExp.length,
      parking: data.parking.length,
    } });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

router.post('/google', A.requireAuth, async (req, res) => {
  // Read config from env OR settings table — see googleSheetWriter.loadGoogleConfig
  try {
    const { pushToGoogleSheet } = require('../lib/googleSheetWriter');
    const date = req.body?.date || req.query.date || currentBusinessDate();
    const result = await pushToGoogleSheet(db, date);
    audit(req.user.id, 'export', 'google_sheet', null, result);
    res.json({ ok: true, date, ...result });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// ── Google Sheets connection settings (UI-managed) ──────────────
// GET  /api/sheet/google/config              → { sheet_id, tab, sa_set }
// POST /api/sheet/google/config { sheet_id, tab, sa_json }
//   sa_json may be a path to a key.json OR the full JSON string.
router.get('/google/config', A.requireAuth, (req, res) => {
  const get = (k) => {
    if (process.env[k]) return process.env[k];
    const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(k);
    return r ? r.value : '';
  };
  res.json({
    ok: true,
    // Legacy field (= MAIN sheet id) for backward compat with old UI.
    sheet_id: get('GOOGLE_SHEET_ID_MAIN') || get('GOOGLE_SHEET_ID') || '',
    sheet_id_main: get('GOOGLE_SHEET_ID_MAIN') || get('GOOGLE_SHEET_ID') || '',
    sheet_id_b1:   get('GOOGLE_SHEET_ID_B1')   || '',
    sheet_id_b2:   get('GOOGLE_SHEET_ID_B2')   || '',
    sheet_id_b3:   get('GOOGLE_SHEET_ID_B3')   || '',
    tab: get('GOOGLE_SHEET_TAB') || 'DEMO',
    sa_set: !!get('GOOGLE_SERVICE_ACCOUNT_JSON'),
    via_env: !!(process.env.GOOGLE_SHEET_ID && process.env.GOOGLE_SERVICE_ACCOUNT_JSON),
  });
});
router.post('/google/config', A.requireAuth, A.requireAdmin, (req, res) => {
  const { sheet_id, sheet_id_main, sheet_id_b1, sheet_id_b2, sheet_id_b3, tab, sa_json } = req.body || {};
  const upsert = db.prepare(`INSERT INTO settings(key, value) VALUES (?,?)
                              ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
  // Legacy single-sheet field still writes MAIN so old admins keep working.
  if (sheet_id !== undefined)      upsert.run('GOOGLE_SHEET_ID_MAIN', String(sheet_id || ''));
  if (sheet_id_main !== undefined) upsert.run('GOOGLE_SHEET_ID_MAIN', String(sheet_id_main || ''));
  if (sheet_id_b1 !== undefined)   upsert.run('GOOGLE_SHEET_ID_B1',   String(sheet_id_b1   || ''));
  if (sheet_id_b2 !== undefined)   upsert.run('GOOGLE_SHEET_ID_B2',   String(sheet_id_b2   || ''));
  if (sheet_id_b3 !== undefined)   upsert.run('GOOGLE_SHEET_ID_B3',   String(sheet_id_b3   || ''));
  if (tab !== undefined)           upsert.run('GOOGLE_SHEET_TAB',     String(tab || 'DEMO'));
  if (sa_json !== undefined && sa_json) {
    // Validate JSON if it looks like JSON
    if (sa_json.trim().startsWith('{')) {
      try { JSON.parse(sa_json); }
      catch (e) { return res.status(400).json({ ok: false, error: 'sa_json is not valid JSON' }); }
    }
    upsert.run('GOOGLE_SERVICE_ACCOUNT_JSON', String(sa_json));
  }
  audit(req.user.id, 'config', 'google_sheet', null, {
    sheet_id_main, sheet_id_b1, sheet_id_b2, sheet_id_b3, tab, sa: sa_json ? '***' : null,
  });
  res.json({ ok: true });
});

router.post('/google/test', A.requireAuth, async (req, res) => {
  try {
    const { pushToGoogleSheet } = require('../lib/googleSheetWriter');
    const date = currentBusinessDate();
    const result = await pushToGoogleSheet(db, date);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// List every date that has at least one entry — for the admin's history picker.
router.get('/dates', A.requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT d AS business_date, SUM(cnt) AS entries FROM (
      SELECT business_date AS d, COUNT(*) AS cnt FROM bank_txns GROUP BY business_date
      UNION ALL SELECT business_date, COUNT(*) FROM dw GROUP BY business_date
      UNION ALL SELECT business_date, COUNT(*) FROM gpay GROUP BY business_date
      UNION ALL SELECT business_date, COUNT(*) FROM expenses GROUP BY business_date
    ) GROUP BY d ORDER BY d DESC
  `).all();
  res.json({ ok: true, rows });
});

// Rollover status — UI uses this for the countdown banner.
router.get('/rollover/status', A.requireAuth, (req, res) => {
  const { nextRolloverInfo, currentBusinessDate } = require('../lib/businessDate');
  const last = db.prepare("SELECT value FROM settings WHERE key = 'last_rollover'").get();
  const lastDate = db.prepare("SELECT value FROM settings WHERE key = 'last_rollover_date'").get();
  const info = nextRolloverInfo();
  res.json({ ok: true,
    current_business_date: currentBusinessDate(),
    next_in: info.hms,
    next_ms: info.ms,
    next_business_date: info.nextBusinessDate,
    last_rollover_ts: last ? last.value : null,
    last_rollover_date: lastDate ? lastDate.value : null,
  });
});

// Force a rollover now (admin). Useful to trigger the archive snapshot manually.
router.post('/rollover/run', A.requireAuth, A.requireAdmin, async (req, res) => {
  try {
    const info = await require('../lib/rollover').runRollover('manual');
    audit(req.user.id, 'rollover', 'manual', null, info);
    res.json({ ok: true, info });
  } catch (e) { res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

// Reset (wipe) all entries for a specific business_date. Admin-only, audited.
router.post('/reset', A.requireAuth, A.requireAdmin, (req, res) => {
  const { date, confirm } = req.body || {};
  if (!date || confirm !== date) {
    return res.status(400).json({ ok: false, error: 'pass { date, confirm: <same date> }' });
  }
  const r1 = db.prepare('DELETE FROM bank_txns WHERE business_date = ?').run(date);
  const r2 = db.prepare('DELETE FROM dw WHERE business_date = ?').run(date);
  const r3 = db.prepare('DELETE FROM gpay WHERE business_date = ?').run(date);
  const r4 = db.prepare('DELETE FROM expenses WHERE business_date = ?').run(date);
  const deleted = { bank_txns: r1.changes, dw: r2.changes, gpay: r3.changes, expenses: r4.changes };
  audit(req.user.id, 'reset', 'business_date', null, { date, deleted });
  res.json({ ok: true, date, deleted });
});

// Inline edit of a single bank's opening balance (admin control).
router.post('/banks/:id/open', A.requireAuth, A.requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const amt = Number(req.body?.open_balance);
  if (!id || !Number.isFinite(amt)) return res.status(400).json({ ok: false, error: 'bad id/amt' });
  db.prepare('UPDATE banks SET open_balance = ? WHERE id = ?').run(amt, id);
  audit(req.user.id, 'update', 'bank_open_balance', id, { open_balance: amt });
  res.json({ ok: true });
});

// Live 2D grid for the Google-Sheets-style viewer in the web app.
router.get('/grid', A.requireAuth, (req, res) => {
  const date = req.query.date || currentBusinessDate();
  const branch = req.query.branch || null;
  try {
    const data = buildDataForDate(db, date, branch);
    const g = buildGrid(data, branch);
    const tpl = getTemplatePath(branch);
    const styles = tpl ? loadTemplateStyles(tpl) : { colors: [], fontColors: [], fontBold: [], tplValues: [], merges: [], colWidths: [] };
    // Build the final grid: start from the template's own labels & static
    // values (so headings like "Bank Balance Error Chek", "Total DW Details",
    // "Panel Name", "Total Deposit", "GPay Account Details", etc. all show
    // up); then overlay computed live data, then user overrides on top.
    const ROWS = Math.max(g.rows, styles.rows || 0);
    const COLS = Math.max(g.cols, styles.cols || 0);
    const grid = Array.from({ length: ROWS }, () => Array(COLS).fill(''));
    // Layer 1: template's own text/number values (the look)
    if (styles.tplValues) {
      for (let r = 0; r < styles.tplValues.length; r++) {
        for (let c = 0; c < styles.tplValues[r].length; c++) {
          const v = styles.tplValues[r][c];
          if (v !== '' && v != null) grid[r][c] = v;
        }
      }
    }
    // Layer 2: computed live data (overwrites template's placeholder zeros)
    for (let r = 0; r < g.grid.length; r++) {
      for (let c = 0; c < g.grid[r].length; c++) {
        const v = g.grid[r][c];
        if (v !== '' && v != null) grid[r][c] = v;
      }
    }
    // Layer 3: manual overrides on top
    const ovs = db.prepare('SELECT row, col, value FROM sheet_overrides WHERE business_date = ?').all(date);
    const overrides = {};
    for (const o of ovs) {
      overrides[`${o.row},${o.col}`] = o.value;
      if (grid[o.row]) {
        const isNum = o.value !== '' && /^-?\d+(\.\d+)?$/.test(String(o.value));
        grid[o.row][o.col] = isNum ? Number(o.value) : o.value;
      }
    }
    res.json({ ok: true, business_date: date,
      grid, rows: ROWS, cols: COLS,
      colors: styles.colors, fontColors: styles.fontColors, fontBold: styles.fontBold,
      merges: styles.merges, colWidths: styles.colWidths,
      overrides,
      generated_at: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

router.get('/google/status', A.requireAuth, (req, res) => {
  const get = (k) => {
    if (process.env[k]) return process.env[k];
    const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(k);
    return r ? r.value : null;
  };
  const sheetId = get('GOOGLE_SHEET_ID');
  const saSet   = !!get('GOOGLE_SERVICE_ACCOUNT_JSON');
  res.json({
    ok: true,
    configured: !!(sheetId && saSet),
    sheet_id: sheetId,
    tab: get('GOOGLE_SHEET_TAB') || 'DEMO',
    url: sheetId ? `https://docs.google.com/spreadsheets/d/${sheetId}` : null,
  });
});

// Render the master template as a styled HTML table for the Live Sheet.
// 1:1 visual of the .xlsx (colors, merges, fonts) + computed live data
// + manual overrides. Returns { html } the frontend drops into #liveGrid.
// In-memory render cache. Key = `${date}|${editable}|${ovStamp}|${tplMtime}`.
// Rendering the full 50-bank, 438-col template is ~7s; cached responses are
// instant. Cache invalidates whenever (a) template file changes, (b) any
// override row for that date is written.
const _htmlCache = new Map();
function cacheKey(tpl, date, editable, ovStamp) {
  const m = (() => { try { return fs.statSync(tpl).mtimeMs | 0; } catch (_) { return 0; } })();
  return `${date}|${editable ? 1 : 0}|${ovStamp}|${m}`;
}

router.get('/html', A.requireAuth, (req, res) => {
  const date = req.query.date || currentBusinessDate();
  const editable = req.query.editable !== '0';
  const branch = req.query.branch || null;
  const tpl = getTemplatePath(branch);
  if (!tpl || !fs.existsSync(tpl)) return res.status(400).json({ ok: false, error: 'no template uploaded' });
  try {
    // Cheap stamp for overrides: count + max(updated_at). Used to skip render.
    const ovStamp = (() => {
      const r = db.prepare("SELECT COUNT(*) c, COALESCE(MAX(updated_at),'') u FROM sheet_overrides WHERE business_date = ?").get(date);
      return `${r.c}@${r.u}`;
    })();
    const ck = cacheKey(tpl, date, editable, ovStamp) + '|' + (branch || 'MAIN');
    const hit = _htmlCache.get(ck);
    if (hit) return res.json({ ok: true, business_date: date, html: hit, cached: true });

    const data = buildDataForDate(db, date, branch);
    const g = buildGrid(data, branch);
    // Pack live values into a {"r,c": value} map for the renderer.
    // Only inject NUMERIC values (computed totals) — string header labels
    // are already in the template; we don't want to overwrite the template's
    // own headings like "B2C BANK BALANCE DETAILS" with "Sr".
    const liveValues = {};
    for (let r = 0; r < g.grid.length; r++) {
      for (let c = 0; c < g.grid[r].length; c++) {
        const v = g.grid[r][c];
        if (typeof v === 'number' && v !== 0) liveValues[`${r},${c}`] = v;
        // Strings only when they are dynamic data (bank name, holder, panel name) — these
        // are written by buildGrid into rows >= BANK.firstRow (row index 3) and panel
        // summary rows. Skip header row 0 to keep template title intact.
        else if (typeof v === 'string' && v !== '' && r > 0) liveValues[`${r},${c}`] = v;
      }
    }
    const ovs = db.prepare('SELECT row, col, value FROM sheet_overrides WHERE business_date = ?').all(date);
    const overrides = {};
    for (const o of ovs) overrides[`${o.row},${o.col}`] = o.value;
    const html = renderTemplateAsHtml(tpl, { liveValues, overrides, editable });
    _htmlCache.set(ck, html);
    if (_htmlCache.size > 30) {
      const firstKey = _htmlCache.keys().next().value;
      _htmlCache.delete(firstKey);
    }
    res.json({ ok: true, business_date: date, html, cached: false, generated_at: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// Manual cell write — used by the Live Sheet contenteditable cells.
// Body: { date, row, col, value }   (value '' or null clears the override)
router.post('/cell', A.requireAuth, (req, res) => {
  const { date, row, col, value } = req.body || {};
  if (!date || !Number.isInteger(row) || !Number.isInteger(col)) {
    return res.status(400).json({ ok: false, error: 'date, row, col required' });
  }
  if (value === '' || value === null || value === undefined) {
    db.prepare('DELETE FROM sheet_overrides WHERE business_date=? AND row=? AND col=?').run(date, row, col);
  } else {
    db.prepare(`INSERT INTO sheet_overrides(business_date,row,col,value,updated_by,updated_at)
                VALUES (?,?,?,?,?,datetime('now'))
                ON CONFLICT(business_date,row,col) DO UPDATE SET
                  value=excluded.value, updated_by=excluded.updated_by, updated_at=excluded.updated_at`)
      .run(date, row, col, String(value), req.user.id);
  }

  // Auto-import bank: if the cell sits under a column header that says
  // "BANK NAME" (any row above it that came from the template), then
  // ensure a banks-table row exists for that name.
  let bankAutoImport = null;
  try {
    if (value && typeof value === 'string' && value.trim().length > 1 && value.length < 80) {
      const tpl = getTemplatePath();
      if (tpl) {
        const styles = loadTemplateStyles(tpl);
        const tv = styles.tplValues || [];
        let columnIsBankName = false;
        for (let rr = 0; rr <= row && rr < tv.length; rr++) {
          const cellVal = tv[rr] && tv[rr][col];
          if (cellVal && /BANK\s*NAME/i.test(String(cellVal))) { columnIsBankName = true; break; }
        }
        if (columnIsBankName) {
          const name = value.trim();
          const existing = db.prepare('SELECT id FROM banks WHERE LOWER(name)=LOWER(?)').get(name);
          if (!existing) {
            const info = db.prepare('INSERT INTO banks(name, holder, acno, open_balance) VALUES (?,?,?,0)')
              .run(name, '', '');
            bankAutoImport = { id: info.lastInsertRowid, name };
            audit(req.user.id, 'auto_import', 'bank', info.lastInsertRowid, { from: 'sheet', date, row, col });
          } else {
            bankAutoImport = { id: existing.id, name, existing: true };
          }
        }
      }
    }
  } catch (_) { /* don't block cell-write on auto-import errors */ }

  audit(req.user.id, 'cell_write', 'sheet', null, { date, row, col, value });
  res.json({ ok: true, bankAutoImport });
});

module.exports = router;
