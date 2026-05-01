'use strict';
// Cell-coordinate map for "DW SHEET DEMO NEW 11-03-26.xlsx" (tab: DEMO).
// All rows/cols are 0-indexed. Convert to A1 via XLSX.utils.encode_cell({r,c}).
// This is the single source of truth for both the .xlsx writer and the
// Google Sheets writer — both consume the same coordinate objects.

const PANELS = [
  { slug: '1XBET0001', col: 14 }, // O = deposit, P = free chips, Q = withdrawal, R = blank
  { slug: '1XBET0002', col: 18 },
  { slug: '1XBET0003', col: 22 },
  { slug: '1XBET0004', col: 26 },
  { slug: '1XBET0005', col: 30 },
  { slug: '1XBET0006', col: 34 },
];
// Per-panel column offsets from the panel's base col:
const PANEL_COL = { deposit: 0, freeChips: 1, withdrawal: 2 };
// CRITICAL: row 2 (0-indexed = Excel row 3) holds the panel's "Total" SUM
// formula like =SUM(O4:O1000). Writers MUST start at row 3 (Excel row 4)
// or they will overwrite the formula with a literal value, breaking every
// downstream cell that depends on the per-column sum.
const PANEL_FIRST_ROW = 3;    // 0-indexed → Excel row 4 (first cell BELOW the SUM total)
const PANEL_LAST_ROW  = 500;  // 0-indexed → Excel row 501; template sums up to 1000 so plenty of headroom

// Banks block: cols A..H is a SUMMARY MIRROR. The actual per-bank ledger
// blocks live at cols AM(38) onward — see BANK_LEDGER below. The A..H
// cells pull values from each bank's slot via formulas like `=AN1`
// (slot 1's name), `=AU4` (slot 2's open) etc., so writing into the
// per-bank slot makes A..H update automatically.
//
// Kept here only for legacy code paths; writers should NOT touch it.
const BANK = {
  firstRow: 3, lastRow: 52,
  cols: { sr: 0, name: 1, holder: 2, open: 3, credit: 4, debit: 6, closing: 7 },
};

// Per-bank LEDGER blocks. Each bank gets its own 8-col block. Bank slot N
// (1-indexed) starts at col `firstSlotCol + (N-1) * blockWidth`.
//   slot 1 → col 38 (AM)   slot 2 → col 46 (AU)   slot 3 → col 54 (BC)
//   ... up to slot 50 → col 430 (PO).
// Column offsets within each block:
//   +0 Open Bank Balance   (literal at totals row; running formula on txn rows)
//   +1 Cradit Amt          (per-txn credit; SUM at totals row)
//   +2 Cr Details          (per-txn credit detail)
//   +3 Dabit Amt           (per-txn debit;  SUM at totals row)
//   +4 D Bank Chg          (per-txn charge; SUM at totals row)
//   +5 Dr Details          (per-txn debit/charge detail)
//   +6 Closing Bank Balance (formula = open + credit − debit − charge)
//   +7 (gap before next bank)
const BANK_LEDGER = {
  firstSlotCol: 38,
  blockWidth: 8,
  maxSlots: 50,
  totalsRow: 2,    // 0-indexed → Excel row 3
  firstTxnRow: 3,  // 0-indexed → Excel row 4
  lastTxnRow: 52,  // 0-indexed → Excel row 53 (50 rows of txns)
  cols: { open: 0, credit: 1, creditDetails: 2, debit: 3, charge: 4, debitDetails: 5, closing: 6 },
};
function bankBlockBaseCol(slot) {
  return BANK_LEDGER.firstSlotCol + (Number(slot) - 1) * BANK_LEDGER.blockWidth;
}

// DW summary (panel totals) — rows 6..11 (one per panel), cols J..M.
const DW_SUMMARY = {
  firstRow: 6,
  cols: { panel: 9, totalDeposit: 10, totalWithdrawal: 11, diff: 12 },
  totalRow: 12,
};
// Chips summary — rows 17..22.
const CHIPS_SUMMARY = {
  firstRow: 17,
  cols: { panel: 9, openChips: 10, closeChips: 11, diff: 12 },
  totalRow: 23,
};

// B2C Bank & Expense ledger — rows 61..110 (growable), cols B..E.
// Categories written into the "Details" col: BANK CHG, FREE CHIPS, SALARY,
// EXTRA PAYMENT, ATM — a credit or debit row depending on sign.
const BANK_EXP = {
  firstRow: 61, lastRow: 110,
  cols: { sr: 0, credit: 1, creditDetails: 2, debit: 3, debitDetails: 4 },
};
// Parking Payment Transfer ledger — same row range, cols G..K.
const PARKING = {
  firstRow: 61, lastRow: 110,
  cols: { sr: 0 /* no Sr col in parking block — reuse BANK_EXP Sr */,
          credit: 6, creditDetails: 7, debit: 9, debitDetails: 10 },
};

// Categories that flow into the bank-exp ledger (left-side bottom block).
// Each maps to the side (credit / debit) the entry is written on.
const CATEGORIES = {
  bank_charge:    { block: 'BANK_EXP', side: 'debit', label: 'BANK CHG' },
  free_chips:     { block: 'BANK_EXP', side: 'debit', label: 'FREE CHIPS' },
  salary:         { block: 'BANK_EXP', side: 'debit', label: 'SALARY' },
  extra_payment:  { block: 'BANK_EXP', side: 'debit', label: 'EXTRA PAYMENT' },
  atm:            { block: 'BANK_EXP', side: 'debit', label: 'ATM' },
  parking_in:     { block: 'PARKING',  side: 'credit', label: 'PARKING IN' },
  parking_out:    { block: 'PARKING',  side: 'debit',  label: 'PARKING OUT' },
};

// ── Multi-branch sheet configuration ──────────────────────────────────
// Each branch is a separate "sheet" with its own panel column layout.
// MAIN is the aggregator: its panels are the union of all branches'.
// Per-branch panels start at the same PANEL_FIRST_ROW; their `col` offsets
// are reused from the same 4-column block (deposit/freechips/withdrawal/blank).
// The xlsx writer / google-sheet writer / live-grid pick up `panels` from the
// branch named by ?branch=… in API calls, falling back to MAIN.
function panelsAt(slugs, startCol = 14) {
  return slugs.map((slug, i) => ({ slug, col: startCol + i * 4 }));
}
const BRANCHES = [
  {
    code: 'B1', name: 'Branch 1 — 1XBET',
    panels: panelsAt(['1XBET0001', '1XBET0002', '1XBET0003', '1XBET0004']),
  },
  {
    code: 'B2', name: 'Branch 2 — Laser',
    panels: panelsAt(['LASER0001', 'LASER0002', 'LASER0003', 'RADHE']),
  },
  {
    code: 'B3', name: 'Branch 3 — Tiger / 1X Club',
    panels: panelsAt(['TIGEREXCH0001', '1XCLUB0001']),
  },
  {
    code: 'MAIN', name: 'Main (aggregate)',
    is_aggregate: true,
    // MAIN uses the canonical 6 1XBET slots that match the master template
    // labels (O = 1XBET0001, S = 1XBET0002, ..., AI = 1XBET0006). Panels
    // beyond col 34 in the template are BANK BLOCKS, not panel slots —
    // writing LASER/RADHE/TIGEREXCH/1XCLUB into cols 38+ would CORRUPT
    // the bank-tracking blocks (Open Bank Balance / Cradit Amt / Closing).
    // When the user uploads separate templates for B2/B3 with their own
    // labelled panel columns, switch the branch dropdown to view those.
    panels: PANELS,
  },
];
function getBranch(code) {
  const c = String(code || 'MAIN').toUpperCase();
  const b = BRANCHES.find(x => x.code === c);
  if (!b) return getBranch('MAIN');
  if (b.is_aggregate && !b.panels) {
    // Build a fresh panels array spanning every non-aggregate branch.
    const all = [];
    for (const x of BRANCHES) if (!x.is_aggregate) all.push(...x.panels.map(p => p.slug));
    return { ...b, panels: panelsAt(all) };
  }
  return b;
}
function allPanelSlugs() {
  const out = [];
  for (const b of BRANCHES) if (!b.is_aggregate) out.push(...b.panels.map(p => p.slug));
  return out;
}

module.exports = {
  PANELS, PANEL_COL, PANEL_FIRST_ROW, PANEL_LAST_ROW,
  BANK, BANK_LEDGER, bankBlockBaseCol,
  DW_SUMMARY, CHIPS_SUMMARY, BANK_EXP, PARKING, CATEGORIES,
  BRANCHES, getBranch, allPanelSlugs, panelsAt,
};
