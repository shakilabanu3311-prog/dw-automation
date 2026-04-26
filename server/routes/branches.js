'use strict';
// Multi-branch "data center" — list branches, list/assign banks per branch,
// and resolve which branch a given panel slug belongs to. The branches list
// is seeded from sheetMap.BRANCHES at bootstrap; admin may rename them or
// reassign banks here without touching code.

const express = require('express');
const { db, audit } = require('../lib/db');
const A = require('../lib/auth');
const M = require('../lib/sheetMap');

const router = express.Router();

// GET /api/branches → [{code, name, panel_slugs, is_aggregate, banks:[{id,name}]}]
router.get('/', A.requireAuth, (req, res) => {
  const rows = db.prepare('SELECT code, name, panel_slugs, is_aggregate, sort_order FROM branches ORDER BY sort_order, code').all();
  const banks = db.prepare('SELECT id, name, holder, branch_code FROM banks ORDER BY id').all();
  const out = rows.map(r => ({
    code: r.code,
    name: r.name,
    panel_slugs: JSON.parse(r.panel_slugs || '[]'),
    is_aggregate: !!r.is_aggregate,
    banks: banks.filter(b => (b.branch_code || '') === r.code),
  }));
  // Banks not yet assigned to any branch
  const unassigned = banks.filter(b => !b.branch_code);
  res.json({ ok: true, branches: out, unassigned_banks: unassigned });
});

// PATCH /api/branches/:code  { name? }
router.patch('/:code', A.requireAuth, A.requireAdmin, (req, res) => {
  const code = String(req.params.code || '').toUpperCase();
  const { name } = req.body || {};
  if (name) db.prepare('UPDATE branches SET name = ? WHERE code = ?').run(name, code);
  audit(req.user.id, 'update', 'branch', code, { name });
  res.json({ ok: true });
});

// POST /api/branches/assign-bank  { bank_id, branch_code }
router.post('/assign-bank', A.requireAuth, A.requireAdmin, (req, res) => {
  const { bank_id, branch_code } = req.body || {};
  if (!bank_id) return res.status(400).json({ ok: false, error: 'bank_id required' });
  const code = branch_code ? String(branch_code).toUpperCase() : null;
  if (code && !db.prepare('SELECT 1 FROM branches WHERE code = ?').get(code)) {
    return res.status(400).json({ ok: false, error: 'unknown branch_code' });
  }
  db.prepare('UPDATE banks SET branch_code = ? WHERE id = ?').run(code, bank_id);
  audit(req.user.id, 'assign', 'bank_branch', bank_id, { branch_code: code });
  res.json({ ok: true });
});

// GET /api/branches/resolve?panel=1XBET0001 → { branch_code, name }
router.get('/resolve', A.requireAuth, (req, res) => {
  const slug = String(req.query.panel || '').toUpperCase();
  if (!slug) return res.json({ ok: true, branch_code: null });
  for (const b of M.BRANCHES) {
    if (b.is_aggregate) continue;
    if (b.panels.some(p => p.slug.toUpperCase() === slug)) {
      return res.json({ ok: true, branch_code: b.code, name: b.name });
    }
  }
  res.json({ ok: true, branch_code: null });
});

module.exports = router;
