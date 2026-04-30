'use strict';
// Write hisab entries into a copy of the master DW SHEET (.xlsx).
// Reads an existing workbook, stamps cells using sheetMap coordinates,
// writes the output to a date-stamped file, returns the output path.

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const M = require('./sheetMap');

function addr(r, c) { return XLSX.utils.encode_cell({ r, c }); }

// Lazy HyperFormula loader so a missing dep doesn't crash the server boot.
let _HF = null;
function loadHF() {
  if (_HF !== null) return _HF;
  try { _HF = require('hyperformula'); }
  catch (e) { _HF = false; console.warn('[xlsx] hyperformula not installed; multi-cell formulas will use cached values'); }
  return _HF;
}

// Recompute every formula in `ws` (a SheetJS worksheet) against the LIVE
// cell values, writing results back to cell.v. SUM, arithmetic, IF, etc.
// are all evaluated. Single-cell mirror formulas (=A1) are also covered.
function recomputeFormulas(ws) {
  const hfMod = loadHF();
  if (!hfMod) return;
  const HyperFormula = hfMod.HyperFormula || hfMod.default || hfMod;
  if (!HyperFormula || !HyperFormula.buildEmpty) return;

  const range = XLSX.utils.decode_range(ws['!ref'] || 'A1');
  const ROWS = range.e.r + 1;
  const COLS = range.e.c + 1;

  // Build a 2D array: formulas as strings ("=SUM(...)"), values as numbers/
  // strings. HyperFormula expects strings starting with "=" to be formulas.
  const data = new Array(ROWS);
  for (let r = 0; r < ROWS; r++) {
    const row = new Array(COLS).fill(null);
    for (let c = 0; c < COLS; c++) {
      const cell = ws[XLSX.utils.encode_cell({ r, c })];
      if (!cell) continue;
      if (cell.f) {
        const f = String(cell.f);
        row[c] = f.startsWith('=') ? f : '=' + f;
      } else if (cell.v !== undefined && cell.v !== null) {
        row[c] = cell.v;
      }
    }
    data[r] = row;
  }

  let hf;
  try {
    hf = HyperFormula.buildFromArray(data, { licenseKey: 'gpl-v3' });
  } catch (e) {
    console.warn('[xlsx] HyperFormula build failed:', e.message);
    return;
  }

  // Walk every formula cell, ask HF for the computed value, write back.
  const sheetId = hf.getSheetId(hf.getSheetNames()[0]);
  for (const a of Object.keys(ws)) {
    if (a.startsWith('!')) continue;
    const cell = ws[a];
    if (!cell || !cell.f) continue;
    const { r, c } = XLSX.utils.decode_cell(a);
    let val;
    try { val = hf.getCellValue({ sheet: sheetId, row: r, col: c }); }
    catch (_) { continue; }
    if (val == null) continue;
    // HyperFormula returns objects like {error,...} for #REF!, #DIV/0!, etc.
    if (typeof val === 'object') {
      if (val.error) { cell.v = val.error; cell.t = 's'; }
      continue;
    }
    cell.v = val;
    cell.t = (typeof val === 'number') ? 'n' : (typeof val === 'boolean') ? 'b' : 's';
  }
  hf.destroy();
}

function writeCell(ws, r, c, value) {
  if (value === undefined || value === null || value === '') return;
  const a = addr(r, c);
  const isNum = typeof value === 'number' && Number.isFinite(value);
  ws[a] = isNum ? { t: 'n', v: value } : { t: 's', v: String(value) };
  // extend !ref if needed
  const range = XLSX.utils.decode_range(ws['!ref'] || 'A1');
  if (r > range.e.r) range.e.r = r;
  if (c > range.e.c) range.e.c = c;
  ws['!ref'] = XLSX.utils.encode_range(range);
}

// data shape:
// {
//   banks: [{ sr, name, holder, open, credit, debit, closing }],
//   panels: { '1XBET0001': { entries: [{name, deposit, freeChips, withdrawal}], openChips, closeChips, totalDeposit, totalWithdrawal }, ... },
//   bankExp: [{ credit, creditDetails, debit, debitDetails }],   // ordered rows
//   parking: [{ credit, creditDetails, debit, debitDetails }],
// }
function writeWorkbook(templatePath, outputPath, data) {
  const wb = XLSX.readFile(templatePath, { cellStyles: true });
  const ws = wb.Sheets[wb.SheetNames[0]];

  // ── banks ──────────────────────────────────────────────────────
  if (Array.isArray(data.banks)) {
    for (let i = 0; i < data.banks.length; i++) {
      const r = M.BANK.firstRow + i;
      if (r > M.BANK.lastRow) break;
      const b = data.banks[i];
      writeCell(ws, r, M.BANK.cols.sr,     i + 1);
      writeCell(ws, r, M.BANK.cols.name,   b.name);
      writeCell(ws, r, M.BANK.cols.holder, b.holder);
      writeCell(ws, r, M.BANK.cols.open,   Number(b.open) || 0);
      writeCell(ws, r, M.BANK.cols.credit, Number(b.credit) || 0);
      writeCell(ws, r, M.BANK.cols.debit,  Number(b.debit) || 0);
      writeCell(ws, r, M.BANK.cols.closing, Number(b.closing) || 0);
    }
  }

  // ── panel entries + summaries ─────────────────────────────────
  if (data.panels) {
    M.PANELS.forEach((p, pi) => {
      const pd = data.panels[p.slug];
      if (!pd) return;
      const baseCol = p.col;
      const entries = pd.entries || [];
      for (let i = 0; i < entries.length; i++) {
        const r = M.PANEL_FIRST_ROW + i;
        if (r > M.PANEL_LAST_ROW) break;
        const e = entries[i];
        if (Number(e.deposit))    writeCell(ws, r, baseCol + M.PANEL_COL.deposit,    Number(e.deposit));
        if (Number(e.freeChips))  writeCell(ws, r, baseCol + M.PANEL_COL.freeChips,  Number(e.freeChips));
        if (Number(e.withdrawal)) writeCell(ws, r, baseCol + M.PANEL_COL.withdrawal, Number(e.withdrawal));
      }
      // DW summary row
      const sRow = M.DW_SUMMARY.firstRow + pi;
      writeCell(ws, sRow, M.DW_SUMMARY.cols.totalDeposit,    Number(pd.totalDeposit) || 0);
      writeCell(ws, sRow, M.DW_SUMMARY.cols.totalWithdrawal, Number(pd.totalWithdrawal) || 0);
      writeCell(ws, sRow, M.DW_SUMMARY.cols.diff,
        (Number(pd.totalDeposit) || 0) - (Number(pd.totalWithdrawal) || 0));
      // Chips summary row
      const cRow = M.CHIPS_SUMMARY.firstRow + pi;
      writeCell(ws, cRow, M.CHIPS_SUMMARY.cols.openChips,  Number(pd.openChips) || 0);
      writeCell(ws, cRow, M.CHIPS_SUMMARY.cols.closeChips, Number(pd.closeChips) || 0);
      writeCell(ws, cRow, M.CHIPS_SUMMARY.cols.diff,
        (Number(pd.closeChips) || 0) - (Number(pd.openChips) || 0));
    });
  }

  // ── bank & expense ledger ─────────────────────────────────────
  writeLedger(ws, M.BANK_EXP,  data.bankExp || [],  /* hasSr */ true);
  writeLedger(ws, M.PARKING,   data.parking || [],  /* hasSr */ false);

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  XLSX.writeFile(wb, outputPath);
  return outputPath;
}

function writeLedger(ws, block, rows, hasSr) {
  for (let i = 0; i < rows.length; i++) {
    const r = block.firstRow + i;
    if (r > block.lastRow) break;
    const row = rows[i];
    if (hasSr) writeCell(ws, r, block.cols.sr, i + 1);
    if (Number(row.credit)) {
      writeCell(ws, r, block.cols.credit, Number(row.credit));
      writeCell(ws, r, block.cols.creditDetails, row.creditDetails || '');
    }
    if (Number(row.debit)) {
      writeCell(ws, r, block.cols.debit, Number(row.debit));
      writeCell(ws, r, block.cols.debitDetails, row.debitDetails || '');
    }
  }
}

// Build the `data` object from DB rows for a given business_date.
//
// `branchCode` (optional): when set to a non-aggregate branch (B1/B2/B3),
// banks are filtered to those assigned to that branch and panels are
// limited to that branch's slug list. MAIN/undefined = full aggregate
// (current behaviour).
function buildDataForDate(db, business_date, branchCode) {
  const branch = branchCode ? M.getBranch(branchCode) : null;
  const restrictPanels = branch && !branch.is_aggregate;
  const allowedSlugs = restrictPanels ? new Set(branch.panels.map(p => p.slug)) : null;

  const bankSql = restrictPanels
    ? 'SELECT id, name, holder, open_balance AS open FROM banks WHERE branch_code = ? ORDER BY id LIMIT 50'
    : 'SELECT id, name, holder, open_balance AS open FROM banks ORDER BY id LIMIT 50';
  const banks = restrictPanels
    ? db.prepare(bankSql).all(branch.code)
    : db.prepare(bankSql).all();
  // Aggregate credit/debit per bank_id for the date. Bank charges are kept out
  // of the per-bank credit/debit totals here — they flow into the Bank & Exp ledger.
  const txns = db.prepare(`
    SELECT bank_id, type, SUM(amt) AS total
    FROM bank_txns
    WHERE business_date = ? AND (category IS NULL OR category != 'charge')
    GROUP BY bank_id, type
  `).all(business_date);
  const byBank = {};
  for (const t of txns) {
    const k = t.bank_id || 0;
    byBank[k] = byBank[k] || { credit: 0, debit: 0 };
    if (t.type === 'credit') byBank[k].credit = t.total;
    else byBank[k].debit = t.total;
  }
  const bankRows = banks.map(b => {
    const tx = byBank[b.id] || { credit: 0, debit: 0 };
    return { ...b, credit: tx.credit, debit: tx.debit, closing: (b.open || 0) + tx.credit - tx.debit };
  });

  // Panels — aggregate dw rows per panel_slug
  const dwRows = db.prepare(`
    SELECT panel_slug, type, name, amt FROM dw
    WHERE business_date = ? AND panel_slug IS NOT NULL ORDER BY id
  `).all(business_date);
  const panels = {};
  const panelDefs = (branch ? (branch.is_aggregate ? M.getBranch('MAIN').panels : branch.panels) : M.PANELS);
  for (const p of panelDefs) panels[p.slug] = { entries: [], totalDeposit: 0, totalWithdrawal: 0 };
  // group by name within panel
  const byPanelName = {};
  for (const r of dwRows) {
    if (allowedSlugs && !allowedSlugs.has(r.panel_slug)) continue;
    const key = r.panel_slug + '|' + (r.name || '');
    byPanelName[key] = byPanelName[key] || { panel: r.panel_slug, name: r.name, deposit: 0, withdrawal: 0, freeChips: 0 };
    if (r.type === 'Deposit') byPanelName[key].deposit += r.amt;
    else if (r.type === 'Withdrawal') byPanelName[key].withdrawal += r.amt;
  }
  for (const k of Object.keys(byPanelName)) {
    const e = byPanelName[k];
    if (!panels[e.panel]) continue;
    panels[e.panel].entries.push(e);
    panels[e.panel].totalDeposit += e.deposit;
    panels[e.panel].totalWithdrawal += e.withdrawal;
  }

  // Bank/Exp ledger: bank_charge txns + expenses with category
  const charges = db.prepare(`
    SELECT amt, detail FROM bank_txns
    WHERE business_date = ? AND category = 'charge'
  `).all(business_date);
  const exps = db.prepare(`
    SELECT amt, category, remark, employee FROM expenses WHERE business_date = ?
  `).all(business_date);
  const bankExp = [];
  for (const c of charges) bankExp.push({ debit: c.amt, debitDetails: 'BANK CHG' });
  for (const e of exps) {
    const cat = M.CATEGORIES[e.category];
    if (!cat || cat.block !== 'BANK_EXP') continue;
    const side = cat.side;
    let label = cat.label;
    if (e.category === 'atm' && e.employee) label += ' (' + e.employee + ')';
    if (e.remark) label += ' - ' + e.remark;
    bankExp.push({ [side]: e.amt, [side + 'Details']: label });
  }

  const parking = [];
  for (const e of exps) {
    const cat = M.CATEGORIES[e.category];
    if (!cat || cat.block !== 'PARKING') continue;
    parking.push({ [cat.side]: e.amt, [cat.side + 'Details']: cat.label + (e.remark ? ' - ' + e.remark : '') });
  }

  return { banks: bankRows, panels, bankExp, parking };
}

// Render the same data as a 2D JS array [rows][cols] — used by the live
// Google-Sheets-like viewer in the web app. Mirrors writeWorkbook's layout.
// Cache of {colors, merges, colWidths} extracted from the master template.
// Read once, reused on every /grid request — keeps the live view ditto-styled
// without re-parsing the workbook on each call.
// Multi-entry style cache (keyed by templatePath + mtime) so each branch's
// uploaded template gets its own warmed-up entry. Without this, switching
// branches would invalidate the cache on every change.
const _styleCacheMap = new Map();
let _styleCache = null; // legacy alias kept for clarity in returns
function loadTemplateStyles(templatePath) {
  let mtime = 0;
  try { mtime = require('fs').statSync(templatePath).mtimeMs | 0; } catch (_) {}
  const key = templatePath + '|' + mtime;
  const hit = _styleCacheMap.get(key);
  if (hit) { _styleCache = hit; return hit; }
  try {
    const wb = XLSX.readFile(templatePath, { cellStyles: true });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const range = XLSX.utils.decode_range(ws['!ref'] || 'A1:A1');
    // Determine the actual content extent — find last row/col that has any text/color
    let lastRow = 0, lastCol = 0;
    const HARD_MAX_ROW = Math.min(range.e.r, 120);  // sheet has 1000 rows of empty noise
    // Master template has 50 banks × 8 cols starting at col 38 → real content
    // ends near col PV (438). Cap generously; per-row trim still drops empties.
    const HARD_MAX_COL = Math.min(range.e.c, 460);
    for (let r = 0; r <= HARD_MAX_ROW; r++) {
      for (let c = 0; c <= HARD_MAX_COL; c++) {
        const cell = ws[XLSX.utils.encode_cell({ r, c })];
        if (cell && (cell.v != null || (cell.s && cell.s.patternType === 'solid'))) {
          if (r > lastRow) lastRow = r;
          if (c > lastCol) lastCol = c;
        }
      }
    }
    const ROWS = lastRow + 2;
    const COLS = lastCol + 2;
    const colors     = Array.from({ length: ROWS }, () => Array(COLS).fill(''));
    const fontColors = Array.from({ length: ROWS }, () => Array(COLS).fill(''));
    const fontBold   = Array.from({ length: ROWS }, () => Array(COLS).fill(false));
    const tplValues  = Array.from({ length: ROWS }, () => Array(COLS).fill(''));
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const a = XLSX.utils.encode_cell({ r, c });
        const cell = ws[a];
        if (!cell) continue;
        if (cell.v != null) tplValues[r][c] = cell.v;
        if (!cell.s) continue;
        const fg = cell.s.fgColor;
        if (fg && fg.rgb && cell.s.patternType === 'solid') {
          const hex = fg.rgb.length >= 8 ? fg.rgb.slice(2) : fg.rgb.padStart(6, '0');
          if (hex !== 'FFFFFF' && hex !== '000000') colors[r][c] = '#' + hex;
        }
        const ft = cell.s.color;
        if (ft && ft.rgb) {
          const hex = ft.rgb.length >= 8 ? ft.rgb.slice(2) : ft.rgb.padStart(6, '0');
          fontColors[r][c] = '#' + hex;
        }
        if (cell.s.bold || (cell.s.font && cell.s.font.bold)) fontBold[r][c] = true;
      }
    }
    // Filter merges to those within our trimmed range
    const merges = (ws['!merges'] || [])
      .filter(m => m.e.r < ROWS && m.e.c < COLS)
      .map(m => ({ r1: m.s.r, c1: m.s.c, r2: m.e.r, c2: m.e.c }));
    const colWidths = (ws['!cols'] || []).slice(0, COLS).map(c => c && c.wpx ? c.wpx : 0);
    const entry = { _path: templatePath, colors, fontColors, fontBold, tplValues, merges, colWidths, rows: ROWS, cols: COLS };
    _styleCacheMap.set(key, entry);
    if (_styleCacheMap.size > 12) {
      const firstKey = _styleCacheMap.keys().next().value;
      _styleCacheMap.delete(firstKey);
    }
    _styleCache = entry;
    return entry;
  } catch (e) {
    return { colors: [], fontColors: [], fontBold: [], tplValues: [], merges: [], colWidths: [], rows: 0, cols: 0 };
  }
}
function buildGrid(data, branchCode) {
  const branch = branchCode ? M.getBranch(branchCode) : null;
  const PANELS = branch ? (branch.is_aggregate ? M.getBranch('MAIN').panels : branch.panels) : M.PANELS;
  const ROWS = Math.max(M.BANK.lastRow, M.PANEL_FIRST_ROW + 60, M.BANK_EXP.lastRow) + 2;
  const COLS = Math.max(...PANELS.map(p => p.col + 3), 14) + 1;
  const grid = Array.from({ length: ROWS }, () => Array(COLS).fill(''));
  const set = (r, c, v) => { if (v === undefined || v === null || v === '') return; grid[r][c] = v; };

  // Header labels
  set(0, M.BANK.cols.sr, 'Sr');
  set(0, M.BANK.cols.name, 'Bank');
  set(0, M.BANK.cols.holder, 'Holder');
  set(0, M.BANK.cols.open, 'Open');
  set(0, M.BANK.cols.credit, 'Credit');
  set(0, M.BANK.cols.debit, 'Debit');
  set(0, M.BANK.cols.closing, 'Closing');
  // Panel header row
  PANELS.forEach(p => {
    set(0, p.col + M.PANEL_COL.deposit, p.slug + ' DEP');
    set(0, p.col + M.PANEL_COL.freeChips, p.slug + ' FC');
    set(0, p.col + M.PANEL_COL.withdrawal, p.slug + ' WDL');
  });

  // Banks
  (data.banks || []).forEach((b, i) => {
    const r = M.BANK.firstRow + i;
    if (r > M.BANK.lastRow) return;
    set(r, M.BANK.cols.sr, i + 1);
    set(r, M.BANK.cols.name, b.name || '');
    set(r, M.BANK.cols.holder, b.holder || '');
    set(r, M.BANK.cols.open, Number(b.open) || 0);
    set(r, M.BANK.cols.credit, Number(b.credit) || 0);
    set(r, M.BANK.cols.debit, Number(b.debit) || 0);
    set(r, M.BANK.cols.closing, Number(b.closing) || 0);
  });

  // Panel entries + summaries
  if (data.panels) {
    PANELS.forEach((p, pi) => {
      const pd = data.panels[p.slug];
      if (!pd) return;
      (pd.entries || []).forEach((e, i) => {
        const r = M.PANEL_FIRST_ROW + i;
        if (Number(e.deposit))    set(r, p.col + M.PANEL_COL.deposit, Number(e.deposit));
        if (Number(e.freeChips))  set(r, p.col + M.PANEL_COL.freeChips, Number(e.freeChips));
        if (Number(e.withdrawal)) set(r, p.col + M.PANEL_COL.withdrawal, Number(e.withdrawal));
      });
      const sRow = M.DW_SUMMARY.firstRow + pi;
      set(sRow, M.DW_SUMMARY.cols.panel, p.slug);
      set(sRow, M.DW_SUMMARY.cols.totalDeposit, Number(pd.totalDeposit) || 0);
      set(sRow, M.DW_SUMMARY.cols.totalWithdrawal, Number(pd.totalWithdrawal) || 0);
      set(sRow, M.DW_SUMMARY.cols.diff, (Number(pd.totalDeposit) || 0) - (Number(pd.totalWithdrawal) || 0));
    });
  }

  // Ledgers
  (data.bankExp || []).forEach((row, i) => {
    const r = M.BANK_EXP.firstRow + i;
    set(r, M.BANK_EXP.cols.sr, i + 1);
    if (Number(row.credit))  { set(r, M.BANK_EXP.cols.credit, Number(row.credit));  set(r, M.BANK_EXP.cols.creditDetails, row.creditDetails || ''); }
    if (Number(row.debit))   { set(r, M.BANK_EXP.cols.debit,  Number(row.debit));   set(r, M.BANK_EXP.cols.debitDetails,  row.debitDetails  || ''); }
  });
  (data.parking || []).forEach((row, i) => {
    const r = M.PARKING.firstRow + i;
    if (Number(row.credit))  { set(r, M.PARKING.cols.credit, Number(row.credit));  set(r, M.PARKING.cols.creditDetails, row.creditDetails || ''); }
    if (Number(row.debit))   { set(r, M.PARKING.cols.debit,  Number(row.debit));   set(r, M.PARKING.cols.debitDetails,  row.debitDetails  || ''); }
  });

  return { grid, cols: COLS, rows: ROWS };
}

// Render the master template as a styled HTML <table> for the Live Sheet.
// Uses SheetJS's sheet_to_html for the exact structure (colspan/rowspan,
// cell values, IDs), then injects background-color + font-color + bold
// per cell from the workbook's cellStyles. Result: a 1:1 visual of the
// original .xlsx, ready to drop into the page.
//
// Optional overlays:
//   liveValues — Map of "r,c" -> computed live value (overwrites template)
//   overrides  — Map of "r,c" -> manual override (overwrites both)
//   editable   — if true, every cell gets contenteditable="true" + data-r/data-c
function renderTemplateAsHtml(templatePath, opts = {}) {
  const wb = XLSX.readFile(templatePath, { cellStyles: true });
  const ws = wb.Sheets[wb.SheetNames[0]];

  // Apply live values & overrides into cell `.v` so sheet_to_html prints them
  const liveValues = opts.liveValues || {};
  const overrides  = opts.overrides  || {};
  for (const key of Object.keys(liveValues)) {
    const [r, c] = key.split(',').map(Number);
    const a = XLSX.utils.encode_cell({ r, c });
    const cell = ws[a] || (ws[a] = { t: 's' });
    const v = liveValues[key];
    if (typeof v === 'number') { cell.t = 'n'; cell.v = v; }
    else if (v !== '' && v != null) { cell.t = 's'; cell.v = v; }
  }
  for (const key of Object.keys(overrides)) {
    const [r, c] = key.split(',').map(Number);
    const a = XLSX.utils.encode_cell({ r, c });
    const cell = ws[a] || (ws[a] = { t: 's' });
    const v = overrides[key];
    const num = Number(v);
    if (v !== '' && /^-?\d+(\.\d+)?$/.test(String(v))) { cell.t = 'n'; cell.v = num; }
    else if (v != null) { cell.t = 's'; cell.v = String(v); }
  }

  // ── Lightweight formula re-evaluation for SINGLE-CELL references ────
  // Cheap pass for `=A1`-style mirror cells (bank-card labels copied into
  // summary columns). Done before the heavyweight HyperFormula pass so the
  // engine sees the freshest leaf values.
  for (const a of Object.keys(ws)) {
    if (a.startsWith('!')) continue;
    const cell = ws[a];
    if (!cell || !cell.f) continue;
    const m = String(cell.f).match(/^([A-Z]+\d+)$/);
    if (!m) continue;
    const tgt = ws[m[1]];
    if (!tgt) continue;
    if (tgt.v != null && tgt.v !== '') {
      cell.v = tgt.v;
      cell.t = tgt.t || (typeof tgt.v === 'number' ? 'n' : 's');
    }
  }

  // ── Multi-cell formula re-evaluation (SUM, arithmetic) ───────────────
  // Without this, the "Total Bank Balance", "Bank Balance Error Chek" and
  // panel-totals rows show whatever Excel last cached when the template
  // was uploaded — totally wrong once live values land in the source
  // cells. We feed the worksheet to HyperFormula, recompute every formula
  // against the LIVE cell values, and copy the results back into `cell.v`.
  try {
    recomputeFormulas(ws);
  } catch (e) {
    console.warn('[xlsx] formula recompute failed (using cached values):', e.message);
  }

  // Trim to content extent so the HTML isn't 23 MB of empties
  let lastR = 0, lastC = 0;
  const range = XLSX.utils.decode_range(ws['!ref'] || 'A1');
  // Template defines 50 banks × ~8 cols each starting at col 38, plus the
  // left summary + 6 panel columns. Real content extends to column ~PV (438).
  // Cap generously so all 50 banks render; rendering trims later anyway.
  const HARD_R = Math.min(range.e.r, 250), HARD_C = Math.min(range.e.c, 460);
  for (let r = 0; r <= HARD_R; r++) {
    for (let c = 0; c <= HARD_C; c++) {
      const cell = ws[XLSX.utils.encode_cell({ r, c })];
      if (cell && (cell.v != null || (cell.s && cell.s.patternType === 'solid'))) {
        if (r > lastR) lastR = r;
        if (c > lastC) lastC = c;
      }
    }
  }
  const orig_ref = ws['!ref'];
  ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: lastR, c: lastC } });

  const html = XLSX.utils.sheet_to_html(ws, { editable: false });
  ws['!ref'] = orig_ref;

  // Replace each <td …> with a clean version: strip data-t/data-v/data-z
  // (we don't need them client-side), keep colspan/rowspan, add bg/font
  // styling from cell.s, plus contenteditable + data-r/data-c.
  const styled = html.replace(/<td([^>]*)>/g, (full, attrs) => {
    const idM = attrs.match(/id="sjs-([A-Z]+)(\d+)"/);
    if (!idM) return full;
    const colLetters = idM[1], rowNum = idM[2];
    const r = parseInt(rowNum, 10) - 1;
    let c = 0; for (const ch of colLetters) c = c * 26 + (ch.charCodeAt(0) - 64); c -= 1;
    const cell = ws[XLSX.utils.encode_cell({ r, c })];
    const styles = [];
    if (cell && cell.s) {
      const fg = cell.s.fgColor;
      if (fg && fg.rgb && cell.s.patternType === 'solid') {
        const hex = fg.rgb.length >= 8 ? fg.rgb.slice(2) : fg.rgb.padStart(6, '0');
        if (hex !== 'FFFFFF' && hex !== '000000') {
          styles.push(`background:#${hex}`);
          const r2 = parseInt(hex.slice(0,2),16), gg = parseInt(hex.slice(2,4),16), bb = parseInt(hex.slice(4,6),16);
          const lum = 0.299*r2 + 0.587*gg + 0.114*bb;
          styles.push(`color:${lum > 140 ? '#000' : '#fff'}`);
        }
      }
      const ft = cell.s.color;
      if (ft && ft.rgb) {
        const hex = ft.rgb.length >= 8 ? ft.rgb.slice(2) : ft.rgb.padStart(6, '0');
        styles.push(`color:#${hex}`);
      }
      if (cell.s.bold || (cell.s.font && cell.s.font.bold)) styles.push('font-weight:600');
    }
    // Keep only colspan/rowspan from original attrs
    const keep = (attrs.match(/colspan="\d+"/) || [''])[0] + ' ' + (attrs.match(/rowspan="\d+"/) || [''])[0];
    const editAttr = opts.editable ? ' contenteditable="true"' : '';
    const styleAttr = styles.length ? ` style="${styles.join(';')}"` : '';
    return `<td ${keep.trim()} data-r="${r}" data-c="${c}"${editAttr}${styleAttr}>`;
  });

  // Strip the <html><head>… wrapper — we only want the <table>.
  const tableMatch = styled.match(/<table[\s\S]*<\/table>/);
  return tableMatch ? tableMatch[0] : styled;
}

module.exports = { writeWorkbook, buildDataForDate, buildGrid, loadTemplateStyles, renderTemplateAsHtml };
