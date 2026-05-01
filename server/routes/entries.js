'use strict';
const express = require('express');
const { db, audit } = require('../lib/db');
const A = require('../lib/auth');
const { businessDate, currentBusinessDate } = require('../lib/businessDate');

const router = express.Router();
router.use(A.requireAuth);

function resolveDate(body) {
  if (body && body.business_date) return body.business_date;
  if (body && body.ts) return businessDate(body.ts);
  return currentBusinessDate();
}

// ── BANKS ────────────────────────────────────────────────────
router.get('/banks', (req, res) => {
  res.json({ ok: true, rows: db.prepare('SELECT * FROM banks ORDER BY id').all() });
});

// All-Indian-banks registry — full A-to-Z list for the upload dropdown.
// Lets the operator pick ANY bank (PSU, private, SFB, payments, foreign,
// co-op) even if it's not yet in the user's banks table — on commit, an
// unregistered code triggers an auto-register.
router.get('/banks/registry', (req, res) => {
  try {
    const { ALL_BANKS } = require('../parsers/banksRegistry');
    const list = ALL_BANKS.map(([code, , category]) => ({ code, category }));
    const userBanks = db.prepare('SELECT id, name, holder, acno FROM banks ORDER BY name').all();
    res.json({ ok: true, registry: list, banks: userBanks });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});
router.post('/banks', (req, res) => {
  const { name, holder, acno, open_balance, branch_code } = req.body || {};
  if (!name) return res.status(400).json({ ok: false, error: 'name required' });
  // Validate branch_code (B1/B2/B3 or empty). Anything else is rejected so a
  // typo doesn't silently strand the bank in a phantom branch where it
  // never appears on any sheet.
  const bc = String(branch_code || '').trim().toUpperCase();
  if (bc && !['B1','B2','B3'].includes(bc))
    return res.status(400).json({ ok: false, error: 'branch_code must be B1, B2, B3, or empty' });
  // Cap at 50 banks per branch — matches the master template's 50-row BANK
  // block (rows 3..52). More than 50 in one branch would overflow the sheet.
  if (bc) {
    const count = db.prepare('SELECT COUNT(*) AS n FROM banks WHERE branch_code = ?').get(bc).n;
    if (count >= 50) return res.status(400).json({ ok: false, error: `Branch ${bc} already has 50 banks (template max). Move some to another branch first.` });
  }
  // Auto-assign the lowest free sheet_slot (1..50) so the bank lands in
  // its own per-bank ledger block in the master template. Without this,
  // sheet_slot stays NULL and the writer wouldn't know where to put the
  // txns — they'd end up in slot 0/wrong block.
  const used = new Set(db.prepare('SELECT sheet_slot FROM banks WHERE sheet_slot IS NOT NULL').all().map(r => r.sheet_slot));
  let slot = null;
  for (let i = 1; i <= 50; i++) if (!used.has(i)) { slot = i; break; }
  if (!slot) return res.status(400).json({ ok: false, error: 'All 50 bank slots in the sheet are full. Delete a bank first.' });
  const info = db.prepare('INSERT INTO banks(name, holder, acno, open_balance, branch_code, sheet_slot) VALUES (?,?,?,?,?,?)')
    .run(name, holder || '', acno || '', Number(open_balance) || 0, bc || null, slot);
  audit(req.user.id, 'create', 'bank', info.lastInsertRowid, { name, branch_code: bc, sheet_slot: slot });
  res.json({ ok: true, id: info.lastInsertRowid, sheet_slot: slot });
});
router.patch('/banks/:id', (req, res) => {
  const id = Number(req.params.id);
  const { name, holder, acno, open_balance, branch_code, sheet_slot } = req.body || {};
  const cur = db.prepare('SELECT * FROM banks WHERE id = ?').get(id);
  if (!cur) return res.status(404).json({ ok: false, error: 'not found' });
  let bc = cur.branch_code;
  if (branch_code !== undefined) {
    bc = String(branch_code || '').trim().toUpperCase();
    if (bc && !['B1','B2','B3'].includes(bc))
      return res.status(400).json({ ok: false, error: 'branch_code must be B1, B2, B3, or empty' });
    if (bc && bc !== cur.branch_code) {
      const count = db.prepare('SELECT COUNT(*) AS n FROM banks WHERE branch_code = ? AND id != ?').get(bc, id).n;
      if (count >= 50) return res.status(400).json({ ok: false, error: `Branch ${bc} already has 50 banks (template max).` });
    }
  }
  // Allow operator to manually pin a bank to a specific sheet_slot (1..50).
  // Useful when the existing sheet has labels like "karnataka" hard-coded
  // at slot 2 and the operator wants the system bank to bind to that slot.
  // We refuse if the slot is already taken by a DIFFERENT bank — they need
  // to swap the other one out first.
  let slot = cur.sheet_slot;
  if (sheet_slot !== undefined) {
    const s = sheet_slot === null || sheet_slot === '' ? null : Number(sheet_slot);
    if (s != null && (!Number.isInteger(s) || s < 1 || s > 50))
      return res.status(400).json({ ok: false, error: 'sheet_slot must be an integer 1..50 (or null)' });
    if (s != null) {
      const taken = db.prepare('SELECT id, name FROM banks WHERE sheet_slot = ? AND id != ?').get(s, id);
      if (taken) return res.status(400).json({ ok: false, error: `Slot ${s} is already taken by "${taken.name}" (id ${taken.id}). Move that bank first.` });
    }
    slot = s;
  }
  db.prepare('UPDATE banks SET name=?, holder=?, acno=?, open_balance=?, branch_code=?, sheet_slot=? WHERE id=?')
    .run(name ?? cur.name, holder ?? cur.holder, acno ?? cur.acno,
         (open_balance === undefined ? cur.open_balance : Number(open_balance) || 0),
         bc || null, slot, id);
  audit(req.user.id, 'update', 'bank', id, { sheet_slot: slot });
  res.json({ ok: true, sheet_slot: slot });
});
router.delete('/banks/:id', (req, res) => {
  db.prepare('DELETE FROM banks WHERE id = ?').run(Number(req.params.id));
  audit(req.user.id, 'delete', 'bank', req.params.id);
  res.json({ ok: true });
});

// ── PANELS ───────────────────────────────────────────────────
router.get('/panels', (req, res) => {
  res.json({ ok: true, rows: db.prepare('SELECT * FROM panels ORDER BY id').all() });
});
router.post('/panels', (req, res) => {
  const { name, slug, url, open_chips, close_chips } = req.body || {};
  if (!name || !slug) return res.status(400).json({ ok: false, error: 'name and slug required' });
  try {
    const info = db.prepare('INSERT INTO panels(name, slug, url, open_chips, close_chips) VALUES (?,?,?,?,?)')
      .run(name, slug, url || '', Number(open_chips) || 0, Number(close_chips) || 0);
    audit(req.user.id, 'create', 'panel', info.lastInsertRowid);
    res.json({ ok: true, id: info.lastInsertRowid });
  } catch (e) { res.status(400).json({ ok: false, error: String(e.message) }); }
});
router.patch('/panels/:id', (req, res) => {
  const id = Number(req.params.id);
  const cur = db.prepare('SELECT * FROM panels WHERE id = ?').get(id);
  if (!cur) return res.status(404).json({ ok: false, error: 'not found' });
  const { name, url, open_chips, close_chips } = req.body || {};
  db.prepare('UPDATE panels SET name=?, url=?, open_chips=?, close_chips=? WHERE id=?')
    .run(name ?? cur.name, url ?? cur.url,
         (open_chips === undefined ? cur.open_chips : Number(open_chips) || 0),
         (close_chips === undefined ? cur.close_chips : Number(close_chips) || 0), id);
  audit(req.user.id, 'update', 'panel', id);
  res.json({ ok: true });
});
router.delete('/panels/:id', (req, res) => {
  db.prepare('DELETE FROM panels WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

// ── BANK TXNS ────────────────────────────────────────────────
router.get('/bank-txns', (req, res) => {
  const date = req.query.business_date || currentBusinessDate();
  const rows = db.prepare('SELECT * FROM bank_txns WHERE business_date = ? ORDER BY id').all(date);
  res.json({ ok: true, business_date: date, rows });
});
router.post('/bank-txns', (req, res) => {
  const b = req.body || {};
  if (!b.type || !b.amt) return res.status(400).json({ ok: false, error: 'type and amt required' });
  const bd = resolveDate(b);
  const info = db.prepare(`
    INSERT INTO bank_txns(business_date, ts, bank_id, type, amt, detail, category, source, ext_ref, created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?)
  `).run(bd, b.ts || null, b.bank_id || null, b.type, Number(b.amt) || 0,
         b.detail || '', b.category || null, b.source || 'manual', b.ext_ref || null, req.user.id);
  audit(req.user.id, 'create', 'bank_txn', info.lastInsertRowid);
  res.json({ ok: true, id: info.lastInsertRowid });
});
router.delete('/bank-txns/:id', (req, res) => {
  const id = Number(req.params.id);
  // Tombstone the ext_ref BEFORE delete so the next ingest cycle skips
  // re-inserting the same row (otherwise scrapers/uploaders silently undo
  // every delete).
  const row = db.prepare('SELECT ext_ref FROM bank_txns WHERE id = ?').get(id);
  if (row && row.ext_ref) {
    db.prepare(`INSERT OR IGNORE INTO deleted_ext_refs(ext_ref, table_name, deleted_by)
                VALUES (?,?,?)`).run(row.ext_ref, 'bank_txns', req.user.id);
  }
  db.prepare('DELETE FROM bank_txns WHERE id = ?').run(id);
  audit(req.user.id, 'delete', 'bank_txn', id);
  res.json({ ok: true });
});

// ── DW ───────────────────────────────────────────────────────
router.get('/dw', (req, res) => {
  const date = req.query.business_date || currentBusinessDate();
  const rows = db.prepare('SELECT * FROM dw WHERE business_date = ? ORDER BY id').all(date);
  res.json({ ok: true, business_date: date, rows });
});
router.post('/dw', (req, res) => {
  const b = req.body || {};
  if (!b.type || !b.amt) return res.status(400).json({ ok: false, error: 'type and amt required' });
  const bd = resolveDate(b);
  const info = db.prepare(`
    INSERT INTO dw(business_date, ts, panel_slug, type, amt, name, chips, utr, remark, source, ext_ref, created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(bd, b.ts || null, b.panel_slug || null, b.type, Number(b.amt) || 0,
         b.name || '', Number(b.chips) || 0, b.utr || '', b.remark || '',
         b.source || 'manual', b.ext_ref || null, req.user.id);
  audit(req.user.id, 'create', 'dw', info.lastInsertRowid);
  res.json({ ok: true, id: info.lastInsertRowid });
});
router.delete('/dw/:id', (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT ext_ref FROM dw WHERE id = ?').get(id);
  if (row && row.ext_ref) {
    db.prepare(`INSERT OR IGNORE INTO deleted_ext_refs(ext_ref, table_name, deleted_by)
                VALUES (?,?,?)`).run(row.ext_ref, 'dw', req.user.id);
  }
  db.prepare('DELETE FROM dw WHERE id = ?').run(id);
  audit(req.user.id, 'delete', 'dw', id);
  res.json({ ok: true });
});

// ── GPAY ─────────────────────────────────────────────────────
router.get('/gpay', (req, res) => {
  const date = req.query.business_date || currentBusinessDate();
  const rows = db.prepare('SELECT * FROM gpay WHERE business_date = ? ORDER BY id').all(date);
  res.json({ ok: true, business_date: date, rows });
});
router.post('/gpay', (req, res) => {
  const b = req.body || {};
  if (!b.type || !b.amt) return res.status(400).json({ ok: false, error: 'type and amt required' });
  const bd = resolveDate(b);
  const info = db.prepare(`
    INSERT INTO gpay(business_date, ts, type, amt, name, utr, panel_slug, bank_id, remark, source, ext_ref, created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(bd, b.ts || null, b.type, Number(b.amt) || 0, b.name || '', b.utr || '',
         b.panel_slug || null, b.bank_id || null, b.remark || '',
         b.source || 'manual', b.ext_ref || null, req.user.id);
  audit(req.user.id, 'create', 'gpay', info.lastInsertRowid);
  res.json({ ok: true, id: info.lastInsertRowid });
});
router.delete('/gpay/:id', (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT ext_ref FROM gpay WHERE id = ?').get(id);
  if (row && row.ext_ref) {
    db.prepare(`INSERT OR IGNORE INTO deleted_ext_refs(ext_ref, table_name, deleted_by)
                VALUES (?,?,?)`).run(row.ext_ref, 'gpay', req.user.id);
  }
  db.prepare('DELETE FROM gpay WHERE id = ?').run(id);
  audit(req.user.id, 'delete', 'gpay', id);
  res.json({ ok: true });
});

// ── EXPENSES ─────────────────────────────────────────────────
router.get('/expenses', (req, res) => {
  const date = req.query.business_date || currentBusinessDate();
  const rows = db.prepare('SELECT * FROM expenses WHERE business_date = ? ORDER BY id').all(date);
  res.json({ ok: true, rows });
});
router.post('/expenses', (req, res) => {
  const b = req.body || {};
  const bd = resolveDate(b);
  const info = db.prepare(
    'INSERT INTO expenses(business_date, detail, amt, category, remark, employee, created_by) VALUES (?,?,?,?,?,?,?)'
  ).run(bd, b.detail || '', Number(b.amt) || 0, b.category || null, b.remark || '', b.employee || '', req.user.id);
  audit(req.user.id, 'create', 'expense', info.lastInsertRowid, { category: b.category });
  res.json({ ok: true, id: info.lastInsertRowid });
});
router.delete('/expenses/:id', (req, res) => {
  db.prepare('DELETE FROM expenses WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

// ── FREE CHIPS ───────────────────────────────────────────────
router.get('/free-chips', (req, res) => {
  const date = req.query.business_date || currentBusinessDate();
  const rows = db.prepare('SELECT * FROM free_chips WHERE business_date = ? ORDER BY id').all(date);
  res.json({ ok: true, rows });
});
router.post('/free-chips', (req, res) => {
  const b = req.body || {};
  const bd = resolveDate(b);
  const info = db.prepare('INSERT INTO free_chips(business_date, panel_slug, amt, remark, created_by) VALUES (?,?,?,?,?)')
    .run(bd, b.panel_slug || null, Number(b.amt) || 0, b.remark || '', req.user.id);
  res.json({ ok: true, id: info.lastInsertRowid });
});
router.delete('/free-chips/:id', (req, res) => {
  db.prepare('DELETE FROM free_chips WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

// ── HISAB SUMMARY ────────────────────────────────────────────
router.get('/hisab', (req, res) => {
  const date = req.query.business_date || currentBusinessDate();
  const q = (sql) => db.prepare(sql).all(date);

  const banks = db.prepare('SELECT * FROM banks').all();
  const panels = db.prepare('SELECT * FROM panels').all();
  const bankTxns = q('SELECT * FROM bank_txns WHERE business_date = ?');
  const dw = q('SELECT * FROM dw WHERE business_date = ?');
  const gpay = q('SELECT * FROM gpay WHERE business_date = ?');
  const expenses = q('SELECT * FROM expenses WHERE business_date = ?');
  const free_chips = q('SELECT * FROM free_chips WHERE business_date = ?');

  const sum = (arr, f = e => e.amt) => arr.reduce((s, e) => s + (Number(f(e)) || 0), 0);
  const bankCredit = sum(bankTxns.filter(t => t.type === 'credit'));
  const bankDebit = sum(bankTxns.filter(t => t.type === 'debit'));
  const panelDeposit = sum(dw.filter(t => /deposit/i.test(t.type)));
  const panelWithdraw = sum(dw.filter(t => /withdraw/i.test(t.type)));
  const gpayRecv = sum(gpay.filter(t => /recv|received|credit/i.test(t.type)));
  const gpaySent = sum(gpay.filter(t => /sent|debit/i.test(t.type)));
  const expTotal = sum(expenses);
  const fcTotal = sum(free_chips);

  const bankNet = bankCredit - bankDebit;
  const panelNet = panelDeposit - panelWithdraw;
  const hisab = bankNet - panelNet - gpayRecv + gpaySent + fcTotal + expTotal;

  res.json({
    ok: true, business_date: date,
    banks, panels, bankTxns, dw, gpay, expenses, free_chips,
    totals: {
      bankCredit, bankDebit, bankNet,
      panelDeposit, panelWithdraw, panelNet,
      gpayRecv, gpaySent,
      expenses: expTotal, freeChips: fcTotal,
      hisab,
    },
  });
});

// ── RECONCILE: bank credit vs panel deposit ──────────────────
// Per business rule: the panel is the source of truth for D/W. Bank
// statements show all credits; only some of those credits map to a panel
// deposit (same name + amount). Anything CREDITED but NOT matched to a
// panel deposit is a "leftover" that belongs in the B2C BANK & EXP
// DETAILS section as an extra payment (or in PARKING if explicitly tagged).
//
// GET /api/reconcile-dw?date=YYYY-MM-DD            → returns matches/leftovers
// POST /api/reconcile-dw/apply  { date, mode: 'extra_payment'|'parking' }
//   → writes leftover bank credits to expenses table with the chosen
//     category. Idempotent — uses ext_ref so repeats don't double-write.
function reconcileFor(date) {
  const banks = db.prepare('SELECT * FROM banks').all();
  const credits = db.prepare(
    `SELECT * FROM bank_txns WHERE business_date = ? AND type = 'credit'
       AND COALESCE(category,'bank') NOT IN ('charge','reconciled')`
  ).all(date);
  const debits = db.prepare(
    `SELECT * FROM bank_txns WHERE business_date = ? AND type = 'debit'
       AND COALESCE(category,'bank') NOT IN ('charge','reconciled')`
  ).all(date);
  const dwDeposits = db.prepare(
    `SELECT * FROM dw WHERE business_date = ? AND type LIKE 'Deposit%'`
  ).all(date);
  const dwWithdrawals = db.prepare(
    `SELECT * FROM dw WHERE business_date = ? AND type LIKE 'Withdraw%'`
  ).all(date);

  function normName(s) { return String(s || '').replace(/[^a-z0-9]/gi, '').toLowerCase(); }
  function findMatch(bank, panel) {
    return panel.find(p => !p._taken && Math.abs(Number(p.amt) - Number(bank.amt)) < 0.5
      && (normName(p.name) === normName(bank.detail) || normName(p.utr) === normName(bank.ext_ref)));
  }
  for (const c of credits) {
    const m = findMatch(c, dwDeposits); if (m) { m._taken = true; c._matched = m.id; }
  }
  for (const d of debits) {
    const m = findMatch(d, dwWithdrawals); if (m) { m._taken = true; d._matched = m.id; }
  }
  const leftoverCredit = credits.filter(c => !c._matched);
  const leftoverDebit  = debits.filter(d => !d._matched);
  return { banks, credits, debits, dwDeposits, dwWithdrawals, leftoverCredit, leftoverDebit };
}

router.get('/reconcile-dw', (req, res) => {
  const date = req.query.business_date || currentBusinessDate();
  const r = reconcileFor(date);
  res.json({ ok: true, business_date: date,
    matched: { credit: r.credits.filter(c => c._matched).length, debit: r.debits.filter(d => d._matched).length },
    leftover: { credit: r.leftoverCredit, debit: r.leftoverDebit } });
});

router.post('/reconcile-dw/apply', (req, res) => {
  const b = req.body || {};
  const date = b.date || currentBusinessDate();
  const mode = (b.mode === 'parking') ? 'parking_in' : 'extra_payment';
  const r = reconcileFor(date);
  let written = 0;
  const ins = db.prepare(
    'INSERT INTO expenses(business_date, detail, amt, category, remark, created_by) VALUES (?,?,?,?,?,?)'
  );
  const markBank = db.prepare(
    "UPDATE bank_txns SET category = 'reconciled' WHERE id = ?"
  );
  const tx = db.transaction(() => {
    for (const c of r.leftoverCredit) {
      ins.run(date, c.detail || `bank credit ${c.id}`, Number(c.amt) || 0,
              mode, `From bank #${c.bank_id} txn id=${c.id}`, req.user.id);
      markBank.run(c.id);
      written++;
    }
  });
  tx();
  audit(req.user.id, 'reconcile', 'bank_txns', null, { date, mode, written });
  res.json({ ok: true, written, mode });
});

// ── INTERNAL BANK-TO-BANK TRANSFERS ───────────────────────────
// When you're short of funds at one bank, you transfer money in from another
// of YOUR banks (same branch or cross-branch). This is NOT external income/
// expense — money is just moving inside the system. Each transfer creates
// two paired bank_txns rows:
//   • debit on the FROM bank
//   • credit on the TO  bank
// Both share an ext_ref like 'xfer:<uuid>:from' / 'xfer:<uuid>:to' so
// deleting one cleans both up (via the existing tombstone path), and so
// they don't double-trigger dedupe against external SMS/PDF rows.
// Category = 'internal_transfer' — this falls OUTSIDE the 'charge' filter,
// so the credit/debit rolls into each bank's daily Credit Amt / Debit Amt
// totals on the sheet (exactly what we want: source bank balance goes
// down, destination goes up — no money created or destroyed).
router.post('/transfers', (req, res) => {
  const { from_bank_id, to_bank_id, amt, remark, ts, business_date } = req.body || {};
  if (!Number(from_bank_id) || !Number(to_bank_id))
    return res.status(400).json({ ok: false, error: 'from_bank_id and to_bank_id required' });
  if (Number(from_bank_id) === Number(to_bank_id))
    return res.status(400).json({ ok: false, error: 'from and to banks must differ' });
  const amount = Number(amt);
  if (!Number.isFinite(amount) || amount <= 0)
    return res.status(400).json({ ok: false, error: 'amt must be a positive number' });
  const date = resolveDate({ business_date, ts });
  const fromBank = db.prepare('SELECT id, name, branch_code FROM banks WHERE id = ?').get(Number(from_bank_id));
  const toBank   = db.prepare('SELECT id, name, branch_code FROM banks WHERE id = ?').get(Number(to_bank_id));
  if (!fromBank || !toBank)
    return res.status(404).json({ ok: false, error: 'one of the banks not found' });
  const xferId = require('crypto').randomBytes(8).toString('hex');
  const baseLabel = (remark && String(remark).trim()) ? String(remark).trim() : 'Internal Transfer';
  const fromDetail = `${baseLabel} → ${toBank.name}${toBank.branch_code ? ` [${toBank.branch_code}]` : ''}`;
  const toDetail   = `${baseLabel} ← ${fromBank.name}${fromBank.branch_code ? ` [${fromBank.branch_code}]` : ''}`;
  const ins = db.prepare(`INSERT INTO bank_txns(business_date, ts, bank_id, type, amt, detail, category, source, ext_ref, created_by)
                          VALUES (?,?,?,?,?,?,?,?,?,?)`);
  const tx = db.transaction(() => {
    ins.run(date, ts || null, fromBank.id, 'debit',  amount, fromDetail, 'internal_transfer', 'transfer', `xfer:${xferId}:from`, req.user.id);
    ins.run(date, ts || null, toBank.id,   'credit', amount, toDetail,   'internal_transfer', 'transfer', `xfer:${xferId}:to`,   req.user.id);
  });
  tx();
  audit(req.user.id, 'create', 'transfer', null, {
    from_bank_id: fromBank.id, to_bank_id: toBank.id, amt: amount,
    cross_branch: fromBank.branch_code !== toBank.branch_code,
    xfer_id: xferId, business_date: date,
  });
  res.json({ ok: true, xfer_id: xferId, business_date: date,
             from: fromBank.name, to: toBank.name,
             cross_branch: fromBank.branch_code !== toBank.branch_code });
});

// List transfers for a date — paired into one row per transfer for the UI.
router.get('/transfers', (req, res) => {
  const date = req.query.date || currentBusinessDate();
  const rows = db.prepare(`
    SELECT t.id, t.business_date, t.ts, t.bank_id, t.type, t.amt, t.detail, t.ext_ref,
           b.name AS bank_name, b.branch_code
    FROM bank_txns t LEFT JOIN banks b ON b.id = t.bank_id
    WHERE t.business_date = ? AND t.category = 'internal_transfer'
      AND t.ext_ref LIKE 'xfer:%'
    ORDER BY t.id DESC
  `).all(date);
  const grouped = {};
  for (const r of rows) {
    const m = r.ext_ref && r.ext_ref.match(/^xfer:([a-f0-9]+):(from|to)$/);
    if (!m) continue;
    const id = m[1];
    grouped[id] = grouped[id] || { xfer_id: id, business_date: r.business_date, amt: r.amt, ts: r.ts };
    if (m[2] === 'from') grouped[id].from = { bank_id: r.bank_id, bank_name: r.bank_name, branch_code: r.branch_code, detail: r.detail, leg_id: r.id };
    else                 grouped[id].to   = { bank_id: r.bank_id, bank_name: r.bank_name, branch_code: r.branch_code, detail: r.detail, leg_id: r.id };
  }
  res.json({ ok: true, rows: Object.values(grouped) });
});

// Delete a transfer by xfer_id — removes BOTH legs and tombstones their
// ext_refs so any future re-import (e.g. an SMS like "you sent ₹500 to
// bank A") doesn't resurrect a transfer the operator deliberately removed.
router.delete('/transfers/:xferId', (req, res) => {
  const xferId = req.params.xferId;
  const fromRef = `xfer:${xferId}:from`, toRef = `xfer:${xferId}:to`;
  const tombstone = db.prepare(`INSERT OR IGNORE INTO deleted_ext_refs(ext_ref, table_name, deleted_at)
                                VALUES (?, 'bank_txns', datetime('now'))`);
  const del = db.prepare('DELETE FROM bank_txns WHERE ext_ref = ?');
  let removed = 0;
  const tx = db.transaction(() => {
    tombstone.run(fromRef); tombstone.run(toRef);
    removed += del.run(fromRef).changes;
    removed += del.run(toRef).changes;
  });
  tx();
  audit(req.user.id, 'delete', 'transfer', null, { xfer_id: xferId, removed });
  res.json({ ok: true, removed });
});

module.exports = router;
