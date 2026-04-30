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
  const { name, holder, acno, open_balance } = req.body || {};
  if (!name) return res.status(400).json({ ok: false, error: 'name required' });
  const info = db.prepare('INSERT INTO banks(name, holder, acno, open_balance) VALUES (?,?,?,?)')
    .run(name, holder || '', acno || '', Number(open_balance) || 0);
  audit(req.user.id, 'create', 'bank', info.lastInsertRowid, { name });
  res.json({ ok: true, id: info.lastInsertRowid });
});
router.patch('/banks/:id', (req, res) => {
  const id = Number(req.params.id);
  const { name, holder, acno, open_balance } = req.body || {};
  const cur = db.prepare('SELECT * FROM banks WHERE id = ?').get(id);
  if (!cur) return res.status(404).json({ ok: false, error: 'not found' });
  db.prepare('UPDATE banks SET name=?, holder=?, acno=?, open_balance=? WHERE id=?')
    .run(name ?? cur.name, holder ?? cur.holder, acno ?? cur.acno,
         (open_balance === undefined ? cur.open_balance : Number(open_balance) || 0), id);
  audit(req.user.id, 'update', 'bank', id);
  res.json({ ok: true });
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

module.exports = router;
