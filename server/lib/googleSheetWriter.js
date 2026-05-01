'use strict';
// Live Google Sheets writer — uses the same sheetMap as the xlsx writer.
// Setup (one-time):
//   1. Google Cloud Console → new project → enable "Google Sheets API".
//   2. Create a Service Account → key JSON (download).
//   3. Share your target Google Sheet with the service account's email (editor).
//   4. Set env:
//        GOOGLE_SERVICE_ACCOUNT_JSON = <absolute path to key.json>
//        GOOGLE_SHEET_ID            = <sheet id from its URL>
//        GOOGLE_SHEET_TAB           = DEMO  (default)
//
// This module is loaded lazily — if googleapis isn't installed or creds aren't set,
// routes that call it will 501 gracefully.

const { buildDataForDate } = require('./xlsxWriter');
const M = require('./sheetMap');

// Read settings either from env vars OR from the `settings` table so the
// user can configure Google Sheets connection from the UI without restarting.
function loadGoogleConfig() {
  const { db } = require('./db');
  const get = (k) => {
    if (process.env[k]) return process.env[k];
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(k);
    return row ? row.value : null;
  };
  // Per-branch sheet IDs. Falls back to legacy GOOGLE_SHEET_ID for MAIN.
  const branchSheets = {
    MAIN: get('GOOGLE_SHEET_ID_MAIN') || get('GOOGLE_SHEET_ID') || null,
    B1:   get('GOOGLE_SHEET_ID_B1')   || null,
    B2:   get('GOOGLE_SHEET_ID_B2')   || null,
    B3:   get('GOOGLE_SHEET_ID_B3')   || null,
  };
  return {
    sheetId: branchSheets.MAIN, // legacy single-sheet field (= MAIN)
    branchSheets,
    tab: get('GOOGLE_SHEET_TAB') || 'DEMO',
    saJson: get('GOOGLE_SERVICE_ACCOUNT_JSON'), // path OR raw JSON string
  };
}

let _sheets = null;
let _sheetsKey = '';
async function sheetsClient() {
  const cfg = loadGoogleConfig();
  if (!cfg.saJson) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON not set (env or settings table)');
  // Cache invalidates if the credential changes
  if (_sheets && _sheetsKey === cfg.saJson) return _sheets;
  const { google } = require('googleapis');
  const fs = require('fs');
  let credentials = null;
  let keyFile = null;
  if (cfg.saJson.trim().startsWith('{')) {
    credentials = JSON.parse(cfg.saJson);
  } else if (fs.existsSync(cfg.saJson)) {
    keyFile = cfg.saJson;
  } else {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON: not a JSON string and not a file path');
  }
  const auth = new google.auth.GoogleAuth({
    ...(keyFile ? { keyFile } : { credentials }),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  _sheets = google.sheets({ version: 'v4', auth: await auth.getClient() });
  _sheetsKey = cfg.saJson;
  return _sheets;
}

// A1 helpers — convert 0-indexed (r, c) to "A1" style column letters.
function colLetter(c) {
  let s = '';
  c = Number(c);
  do { s = String.fromCharCode(65 + (c % 26)) + s; c = Math.floor(c / 26) - 1; } while (c >= 0);
  return s;
}
function a1(r, c) { return `${colLetter(c)}${r + 1}`; }
function rangeA1(r1, c1, r2, c2) { return `${a1(r1, c1)}:${a1(r2, c2)}`; }

// Convert business_date (YYYY-MM-DD) to a tab name in DD-MM-YYYY.
// Matches the user's manual convention (their existing tab was 30/04/2026)
// but uses dashes to avoid '/' edge cases in Sheets API range parsing.
function dateTabName(business_date) {
  const m = String(business_date || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return business_date;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

// Ensure a tab named `tabName` exists. If missing, duplicates `templateTab`
// (the canonical DEMO sheet) so the new date inherits all formulas, formats,
// merges, column widths, and headers — exactly like the user manually doing
// "Duplicate sheet" → rename to today's date.
//
// Returns: the resolved tabName (may differ if templateTab is missing).
async function ensureDateTab(svc, sheetId, tabName, templateTab) {
  const meta = await svc.spreadsheets.get({ spreadsheetId: sheetId, fields: 'sheets(properties(sheetId,title))' });
  const sheets = meta.data.sheets || [];
  const existing = sheets.find(s => s.properties.title === tabName);
  if (existing) return tabName;
  const tpl = sheets.find(s => s.properties.title === templateTab);
  if (!tpl) {
    // No template tab to clone — fall back to writing into the first sheet.
    return sheets[0]?.properties?.title || tabName;
  }
  // Insert the duplicate at index 0 so the newest day is the leftmost tab
  // (matches how the user reads the workbook: most-recent-first).
  await svc.spreadsheets.batchUpdate({
    spreadsheetId: sheetId,
    requestBody: {
      requests: [{
        duplicateSheet: {
          sourceSheetId: tpl.properties.sheetId,
          insertSheetIndex: 0,
          newSheetName: tabName,
        },
      }],
    },
  });
  return tabName;
}

// Auto-purge tabs older than 35 days. Looks for tabs named DD-MM-YYYY,
// parses them, deletes any whose date is more than 35 days behind today.
// The template tab (DEMO) is always preserved regardless of name.
async function purgeOldDateTabs(svc, sheetId, templateTab, maxAgeDays = 35) {
  try {
    const meta = await svc.spreadsheets.get({ spreadsheetId: sheetId, fields: 'sheets(properties(sheetId,title))' });
    const cutoff = Date.now() - maxAgeDays * 86400 * 1000;
    const toDelete = [];
    for (const s of (meta.data.sheets || [])) {
      const title = s.properties.title;
      if (title === templateTab) continue;
      const m = title.match(/^(\d{2})-(\d{2})-(\d{4})$/);
      if (!m) continue;
      const t = Date.parse(`${m[3]}-${m[2]}-${m[1]}T00:00:00Z`);
      if (Number.isFinite(t) && t < cutoff) toDelete.push(s.properties.sheetId);
    }
    if (!toDelete.length) return 0;
    await svc.spreadsheets.batchUpdate({
      spreadsheetId: sheetId,
      requestBody: { requests: toDelete.map(id => ({ deleteSheet: { sheetId: id } })) },
    });
    return toDelete.length;
  } catch (e) {
    console.warn('[gsync] purgeOldDateTabs failed:', e.message);
    return 0;
  }
}

// Build a single `values.batchUpdate` payload from the sheetMap-structured data.
//
// IMPORTANT: every block ALWAYS rewrites its full row capacity. If today
// has fewer entries than yesterday, the "missing" rows get blanked out
// instead of carrying yesterday's numbers — otherwise an entry that was
// edited/deleted would still appear in Google Sheets as a ghost row.
// This is the difference between "auto-entry" and "auto-mistake".
function buildBatch(data, tab) {
  const reqs = [];
  const push = (r1, c1, values) => reqs.push({
    range: `'${tab}'!${rangeA1(r1, c1, r1 + values.length - 1, c1 + values[0].length - 1)}`,
    values,
  });
  // Helper: pad an array of value-rows up to `targetLen` with blank rows
  // (each blank row is `cols` wide). This is what kills ghost data.
  const padBlanks = (rows, targetLen, cols) => {
    while (rows.length < targetLen) rows.push(new Array(cols).fill(''));
    return rows;
  };

  // ── banks: rows firstRow..lastRow (full 50-row capacity, always) ──
  {
    const cap = M.BANK.lastRow - M.BANK.firstRow + 1;
    const rows = (data.banks || []).slice(0, cap).map((b, i) => [
      i + 1, b.name || '', b.holder || '',
      Number(b.open) || 0, Number(b.credit) || 0, '', Number(b.debit) || 0,
      Number(b.closing) || 0,
    ]);
    push(M.BANK.firstRow, 0, padBlanks(rows, cap, 8));
  }

  // ── panels: each 3-col block (deposit, freeChips, withdrawal) ──
  // Always write the full PANEL_FIRST_ROW..PANEL_LAST_ROW range so a row
  // that was deleted today doesn't stay populated from yesterday's push.
  if (data.panels) {
    const panelCap = M.PANEL_LAST_ROW - M.PANEL_FIRST_ROW + 1;
    const allPanels = M.getBranch('MAIN').panels;
    allPanels.forEach((p, pi) => {
      const pd = data.panels[p.slug]; if (!pd) return;
      const entries = pd.entries || [];
      const values = entries.slice(0, panelCap).map(e => [
        Number(e.deposit) || 0, Number(e.freeChips) || 0, Number(e.withdrawal) || 0,
      ]);
      push(M.PANEL_FIRST_ROW, p.col, padBlanks(values, panelCap, 3));
      // SELF-HEAL the row-3 SUM formulas. An earlier buggy version of
      // this code wrote a literal value into row 3 (the totals row),
      // permanently replacing the =SUM(O4:O1000) formula with a stale
      // number. Re-inject the formulas on every push so user totals
      // always recompute live. Uses USER_ENTERED so '=SUM(...)' is
      // parsed as a formula instead of a literal string.
      const dCol = colLetter(p.col + M.PANEL_COL.deposit);
      const fCol = colLetter(p.col + M.PANEL_COL.freeChips);
      const wCol = colLetter(p.col + M.PANEL_COL.withdrawal);
      reqs.push({
        range: `'${tab}'!${a1(2, p.col)}:${a1(2, p.col + 2)}`,
        values: [[
          `=SUM(${dCol}4:${dCol}1000)`,
          `=SUM(${fCol}4:${fCol}1000)`,
          `=SUM(${wCol}4:${wCol}1000)`,
        ]],
        _formulas: true, // marker so the sender uses USER_ENTERED
      });
    });
  }

  // ── bank & exp ledger ──
  // Always rewrites the full range so deleted rows get blanked out.
  const writeLedger = (block, rows, hasSr) => {
    const cap = block.lastRow - block.firstRow + 1;
    const cols = Math.max(block.cols.debitDetails, block.cols.creditDetails) + 1;
    const values = (rows || []).slice(0, cap).map((row, i) => {
      const arr = new Array(cols).fill('');
      if (hasSr) arr[block.cols.sr] = i + 1;
      if (Number(row.credit)) { arr[block.cols.credit] = Number(row.credit); arr[block.cols.creditDetails] = row.creditDetails || ''; }
      if (Number(row.debit))  { arr[block.cols.debit]  = Number(row.debit);  arr[block.cols.debitDetails]  = row.debitDetails  || ''; }
      return arr;
    });
    push(block.firstRow, 0, padBlanks(values, cap, cols));
  };
  writeLedger(M.BANK_EXP,  data.bankExp || [], true);
  writeLedger(M.PARKING,   data.parking || [], false);

  return reqs;
}

// Push a single branch's data to its sheet. Returns null if no sheet
// configured for that branch (skipped silently).
async function pushBranchToGoogleSheet(db, business_date, branchCode) {
  const cfg = loadGoogleConfig();
  const sheetId = cfg.branchSheets[branchCode];
  if (!sheetId) return null;
  const svc = await sheetsClient();
  const data = buildDataForDate(db, business_date, branchCode);
  // Each business_date writes to its OWN tab (DD-MM-YYYY), cloned on first
  // touch from the canonical template tab (DEMO). This way the 05:30 IST
  // rollover automatically gets a fresh, formatted page — same as the user
  // manually duplicating DEMO and renaming to today's date.
  const dateTab = dateTabName(business_date);
  let activeTab = cfg.tab;
  try {
    activeTab = await ensureDateTab(svc, sheetId, dateTab, cfg.tab);
  } catch (e) {
    console.warn('[gsync] ensureDateTab failed, falling back to', cfg.tab, ':', e.message);
  }
  const reqs = buildBatch(data, activeTab);
  if (!reqs.length) return { branch: branchCode, sheetId, updated: 0 };
  // Split into two batches so formulas survive: RAW for literal values
  // (numbers stay numbers, no auto-parsing), USER_ENTERED for the
  // self-healing SUM formulas (so '=SUM(O4:O1000)' is treated as a
  // formula, not a literal string).
  const formulaReqs = reqs.filter(r => r._formulas).map(r => ({ range: r.range, values: r.values }));
  const literalReqs = reqs.filter(r => !r._formulas).map(r => ({ range: r.range, values: r.values }));
  let updated = 0;
  if (literalReqs.length) {
    const resp1 = await svc.spreadsheets.values.batchUpdate({
      spreadsheetId: sheetId,
      requestBody: { valueInputOption: 'RAW', data: literalReqs },
    });
    updated += resp1.data.totalUpdatedCells || 0;
  }
  if (formulaReqs.length) {
    const resp2 = await svc.spreadsheets.values.batchUpdate({
      spreadsheetId: sheetId,
      requestBody: { valueInputOption: 'USER_ENTERED', data: formulaReqs },
    });
    updated += resp2.data.totalUpdatedCells || 0;
  }
  const resp = { data: { totalUpdatedCells: updated } };
  return {
    branch: branchCode,
    updated: resp.data.totalUpdatedCells || 0,
    ranges: reqs.length,
    sheetId, tab: activeTab, templateTab: cfg.tab,
    url: `https://docs.google.com/spreadsheets/d/${sheetId}`,
  };
}

// Push to ALL configured branch sheets (MAIN + B1 + B2 + B3). Each branch
// is pushed only if its sheet ID is set, so partial config still works.
async function pushToGoogleSheet(db, business_date) {
  const cfg = loadGoogleConfig();
  const codes = ['MAIN', 'B1', 'B2', 'B3'];
  const results = [];
  let anyConfigured = false;
  for (const code of codes) {
    if (!cfg.branchSheets[code]) continue;
    anyConfigured = true;
    try {
      const r = await pushBranchToGoogleSheet(db, business_date, code);
      if (r) results.push(r);
    } catch (e) {
      results.push({ branch: code, error: String(e.message || e) });
    }
  }
  if (!anyConfigured) throw new Error('No GOOGLE_SHEET_ID configured for any branch (set GOOGLE_SHEET_ID_MAIN/_B1/_B2/_B3 or legacy GOOGLE_SHEET_ID)');
  // Aggregate stats for backward-compat callers.
  const totalUpdated = results.reduce((a, r) => a + (r.updated || 0), 0);
  return {
    updated: totalUpdated,
    branches: results,
    // legacy fields (point to MAIN)
    sheetId: cfg.branchSheets.MAIN || results[0]?.sheetId,
    tab: cfg.tab,
    url: cfg.branchSheets.MAIN ? `https://docs.google.com/spreadsheets/d/${cfg.branchSheets.MAIN}` : (results[0] && results[0].url),
  };
}

// Debounced live sync: fire-and-forget. Coalesces bursts of mutations
// (e.g. bulk imports) into one push per ~3 seconds per business_date.
const _pending = new Map(); // date -> timer
function scheduleLiveSync(business_date) {
  try {
    const cfg = loadGoogleConfig();
    if (!cfg.saJson) return; // no creds — skip
    const anySheet = Object.values(cfg.branchSheets).some(Boolean);
    if (!anySheet) return; // no sheet IDs configured for any branch
    if (_pending.has(business_date)) return;
    const t = setTimeout(async () => {
      _pending.delete(business_date);
      try {
        const { db } = require('./db');
        const r = await pushToGoogleSheet(db, business_date);
        console.log('[gsync]', business_date, r);
      } catch (e) {
        console.error('[gsync] error', business_date, e.message);
      }
    }, 3000);
    _pending.set(business_date, t);
  } catch (_) {}
}

module.exports = {
  pushToGoogleSheet, pushBranchToGoogleSheet, buildBatch, a1, rangeA1,
  loadGoogleConfig, scheduleLiveSync, sheetsClient,
  ensureDateTab, purgeOldDateTabs, dateTabName,
};
