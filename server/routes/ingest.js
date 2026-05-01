'use strict';
const express = require('express');
const multer = require('multer');
const { db, audit } = require('../lib/db');
const A = require('../lib/auth');
const { businessDate, currentBusinessDate } = require('../lib/businessDate');
const { parseDcbPdf } = require('../parsers/dcb_pdf');
const { parseGenericBankPdf } = require('../parsers/generic_pdf');
const { parseGpayAuto } = require('../parsers/gpay');
const { parseSms } = require('../parsers/sms');
const { detectFromText, rememberOverride, loadOverrideMap, saveOverrideMap } = require('../parsers/bankDetect');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// ── PREVIEW: parse file, return rows, do NOT save ─────────────
router.post('/preview/bank-statement', A.requireAuth, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: 'no file' });
  try {
    // Try generic parser first (handles any bank). Fall back to DCB-specific
    // if generic finds nothing or obviously less than DCB would.
    let parsed;
    try { parsed = await parseGenericBankPdf(req.file.buffer); } catch (_) { parsed = { rows: [], text: '', pages: 0 }; }
    if (parsed.rows.length < 3) {
      const dcb = await parseDcbPdf(req.file.buffer);
      if (dcb.rows.length > parsed.rows.length) parsed = { ...dcb, text: dcb.text || parsed.text };
    }
    const existing = new Set(db.prepare('SELECT ext_ref FROM bank_txns WHERE ext_ref IS NOT NULL').all().map(r => r.ext_ref)
      .concat(db.prepare('SELECT ext_ref FROM dw WHERE ext_ref IS NOT NULL').all().map(r => r.ext_ref)));
    const rows = parsed.rows.map(r => ({ ...r, duplicate: existing.has(r.ext_ref) }));
    const detected = detectFromText(parsed.text || '', { autoRegister: true });
    res.json({ ok: true, pages: parsed.pages, rows, detected });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// Online portal / paste-text uploader.
// Body: { text: "<copy-pasted statement text or CSV>" }
// Reuses the same generic line parser used for PDFs, so portals that
// expose statements as plain text/CSV (or pages you copy with Ctrl+A)
// work without needing a PDF download. Returns the same shape as
// /preview/bank-statement so the UI can drop it into the same preview
// table — same dedupe, same per-row business_date, same bank detect.
router.post('/preview/bank-text', A.requireAuth, express.json({ limit: '5mb' }), async (req, res) => {
  const text = String(req.body?.text || '');
  if (!text.trim()) return res.status(400).json({ ok: false, error: 'text required' });
  try {
    const { parseRowsFromText } = require('../parsers/generic_pdf');
    const rows = parseRowsFromText(text) || [];
    const existing = new Set(db.prepare('SELECT ext_ref FROM bank_txns WHERE ext_ref IS NOT NULL').all().map(r => r.ext_ref));
    const out = rows.map(r => ({ ...r, duplicate: existing.has(r.ext_ref) }));
    const detected = detectFromText(text, { autoRegister: true });
    res.json({ ok: true, pages: 0, rows: out, detected, source: 'paste-text' });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

router.post('/commit/bank-statement', A.requireAuth, async (req, res) => {
  const { rows, bank_id, detected } = req.body || {};
  if (!Array.isArray(rows)) return res.status(400).json({ ok: false, error: 'rows required' });
  if (!bank_id) return res.status(400).json({ ok: false, error: 'bank_id required (which bank is this statement for?)' });
  // Teach the auto-detector if the operator picked a different bank than
  // what was suggested. Next statement from the same acLast4 (or with the
  // same detected bank code) will jump straight to this bank_id.
  try {
    if (detected && Number(bank_id)) {
      const sameAsDetected = detected.bank_id && Number(detected.bank_id) === Number(bank_id);
      if (!sameAsDetected) {
        rememberOverride({ code: detected.code, acLast4: detected.ac_last4 }, Number(bank_id));
      }
    }
  } catch (_) {}
  let insertedBank = 0, insertedDw = 0, skipped = 0;
  const insBank = db.prepare(`INSERT OR IGNORE INTO bank_txns(business_date, ts, bank_id, type, amt, detail, category, source, ext_ref, created_by)
                              VALUES (?,?,?,?,?,?,?,?,?,?)`);
  const insDw = db.prepare(`INSERT OR IGNORE INTO dw(business_date, ts, type, amt, name, utr, remark, source, ext_ref, created_by)
                            VALUES (?,?,?,?,?,?,?,?,?,?)`);
  // Per business rule, bank-statement rows NEVER create DW deposit /
  // withdrawal entries — only bank_txns. The Chrome extension (panel
  // scrape) is the single source of truth for D/W. Reconciliation
  // happens on the sheet, not at ingest time.
  const tombstoned = db.prepare(`SELECT 1 FROM deleted_ext_refs WHERE ext_ref = ?`);
  let tombstones = 0;
  const tx = db.transaction((items) => {
    for (const r of items) {
      if (r.skip) { skipped++; continue; }
      const bd = r.business_date || businessDate(r.date + 'T12:00:00+05:30') || currentBusinessDate();
      const type = (r.entryKind === 'bank_charge') ? 'debit' : r.type;
      const category = r.entryKind === 'bank_charge' ? 'charge' : 'bank';
      if (r.ext_ref && tombstoned.get(r.ext_ref)) { tombstones++; continue; }
      const info = insBank.run(bd, r.date || null, Number(bank_id), type, Number(r.amt) || 0, r.narration || '',
                               category, 'statement', r.ext_ref || null, req.user.id);
      if (info.changes) insertedBank++; else skipped++;
    }
  });
  tx(rows);
  audit(req.user.id, 'ingest', 'bank_statement', null, { bank_id, insertedBank, insertedDw, skipped, tombstones });
  res.json({ ok: true, insertedBank, insertedDw, skipped, tombstones });
});

// ── GPAY ─────────────────────────────────────────────────────
router.post('/preview/gpay-statement', A.requireAuth, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: 'no file' });
  try {
    const parsed = await parseGpayAuto(req.file.originalname, req.file.buffer);
    const existing = new Set(db.prepare('SELECT ext_ref FROM gpay WHERE ext_ref IS NOT NULL').all().map(r => r.ext_ref));
    const rows = parsed.rows.map(r => ({ ...r, duplicate: existing.has(r.ext_ref) }));
    res.json({ ok: true, pages: parsed.pages || null, rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

router.post('/commit/gpay-statement', A.requireAuth, (req, res) => {
  const { rows } = req.body || {};
  if (!Array.isArray(rows)) return res.status(400).json({ ok: false, error: 'rows required' });
  let inserted = 0, skipped = 0;
  const ins = db.prepare(`INSERT OR IGNORE INTO gpay(business_date, ts, type, amt, name, utr, remark, source, ext_ref, created_by)
                          VALUES (?,?,?,?,?,?,?,?,?,?)`);
  const tombstoned = db.prepare(`SELECT 1 FROM deleted_ext_refs WHERE ext_ref = ?`);
  let tombstones = 0;
  const tx = db.transaction((items) => {
    for (const r of items) {
      if (r.skip) { skipped++; continue; }
      const bd = r.business_date || currentBusinessDate();
      if (r.ext_ref && tombstoned.get(r.ext_ref)) { tombstones++; continue; }
      const info = ins.run(bd, r.ts || null, r.type, Number(r.amt) || 0, r.name || '', r.utr || '',
                           r.remark || '', 'statement', r.ext_ref || null, req.user.id);
      if (info.changes) inserted++; else skipped++;
    }
  });
  tx(rows);
  audit(req.user.id, 'ingest', 'gpay_statement', null, { inserted, skipped, tombstones });
  res.json({ ok: true, inserted, skipped, tombstones });
});

// ── PANEL (Chrome extension) ─────────────────────────────────
//
// Routing: each scrape carries `site` (freeplay24, testawl-admin, …) and
// optionally `master` (the sidebar account code, e.g. "MAHA0001"). We use
// settings.panel_map (JSON object) to translate `site:master` → the sheet's
// panel slug. Examples of valid map values:
//   { "freeplay24:MAHA0001": "1XBET0001" }
//   { "freeplay24:*":        "1XBET0001" }   ← wildcard master
//   { "freeplay24":          "1XBET0001" }   ← site-only fallback
// If nothing matches, the entry is stored with the raw `site:master` slug
// and the response includes `unmapped: true` so the UI can prompt for a map.
function resolvePanelSlug(site, master) {
  let map = {};
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key='panel_map'").get();
    if (row && row.value) map = JSON.parse(row.value) || {};
  } catch (_) {}
  const tryKeys = [
    master ? `${site}:${master}`.toLowerCase() : null,
    `${site}:*`.toLowerCase(),
    site.toLowerCase(),
  ].filter(Boolean);
  // case-insensitive lookup
  const lcMap = {};
  for (const k of Object.keys(map)) lcMap[k.toLowerCase()] = map[k];
  for (const k of tryKeys) if (lcMap[k]) return { slug: lcMap[k], mapped: true };
  // fallback: store raw so admin can later find + map it
  return { slug: master ? `${site}:${master}` : site, mapped: false };
}

router.post('/panel', A.requireAuthOrToken, (req, res) => {
  const { site, master, deposits, withdrawals } = req.body || {};
  if (!site) return res.status(400).json({ ok: false, error: 'site required' });

  const { slug, mapped } = resolvePanelSlug(site, master);

  const ins = db.prepare(`INSERT OR IGNORE INTO dw(business_date, ts, panel_slug, type, amt, name, utr, remark, source, ext_ref, created_by)
                          VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  const tombstoned = db.prepare(`SELECT 1 FROM deleted_ext_refs WHERE ext_ref = ?`);
  let inserted = 0, skipped = 0, tombstones = 0;
  const tx = db.transaction((items, type) => {
    for (const e of items) {
      // Prefer full ISO ts (date+time+TZ) sent by the extension; fall back
      // to a date-only string. businessDate() needs an ISO with TZ to land
      // in the right book around the 05:30 IST cutoff.
      let tsRaw = e.ts || e.date || null;
      let bd;
      if (tsRaw && /T\d{2}:\d{2}/.test(tsRaw)) bd = businessDate(tsRaw);
      else if (tsRaw) bd = businessDate(tsRaw + 'T12:00:00+05:30');
      else bd = currentBusinessDate();
      const utr = e.utr || '';
      // Dedupe key: prefer UTR (panel-side unique). Treat blank, "-", and
      // "0" as MISSING so panels that show "-" for non-UTR rows (eg. cash
      // settlements) don't all collapse onto the same ext_ref and get
      // dropped as duplicates of each other.
      const utrKey = (utr && utr.trim() && utr.trim() !== '-' && utr.trim() !== '0')
        ? utr.trim() : '';
      // Fall back to a composite (ts|amount|name) keyed per slug+type so the
      // same row doesn't ingest twice but distinct empty-UTR rows survive.
      const extRef = utrKey
        ? `${slug}:${utrKey}`
        : `${slug}:${type}:${tsRaw || ''}|${e.amount}|${(e.name || '').trim()}`;
      // Operator deleted this exact ext_ref before — DON'T re-insert.
      if (tombstoned.get(extRef)) { tombstones++; continue; }
      const info = ins.run(bd, tsRaw, slug, type, Number(e.amount) || 0, e.name || '', utr,
                           e.bank || '', 'extension', extRef, req.user.id);
      if (info.changes) inserted++; else skipped++;
    }
  });
  tx(deposits || [], 'Deposit');
  tx(withdrawals || [], 'Withdrawal');

  // Track per-source last sync (raw key, not the mapped slug — surfaces
  // unmapped sources so the admin knows what to add to panel_map).
  const sourceKey = master ? `${site}:${master}` : site;
  db.prepare(`INSERT INTO settings(key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .run(`panel_last_sync:${sourceKey}`, new Date().toISOString());

  audit(req.user.id, 'ingest', 'panel:' + sourceKey, null, { inserted, skipped, tombstones, slug, mapped });
  res.json({ ok: true, inserted, skipped, tombstones, panel_slug: slug, mapped, source: sourceKey });
});

// Admin: list / clear tombstones (un-suppress a previously-deleted ext_ref
// so the next ingest can re-insert it if needed).
router.get('/tombstones', A.requireAuth, (req, res) => {
  const rows = db.prepare(`SELECT ext_ref, table_name, deleted_at FROM deleted_ext_refs
                           ORDER BY deleted_at DESC LIMIT 500`).all();
  res.json({ ok: true, rows });
});
router.delete('/tombstones/:extRef', A.requireAuth, (req, res) => {
  db.prepare('DELETE FROM deleted_ext_refs WHERE ext_ref = ?').run(req.params.extRef);
  audit(req.user.id, 'untombstone', 'ext_ref', null, { ext_ref: req.params.extRef });
  res.json({ ok: true });
});

// ── Bank-detection overrides (manual teach map) ─────────────────────
// `bank_override_map` keys:
//   "ac:<last4>"   → bank_id    (most specific — wins over code)
//   "code:<CODE>"  → bank_id    (per detected bank code, e.g. DCB→bank 7)
// These are auto-recorded on commit when the operator picks a bank that
// differs from auto-detect. Surfaces here so the UI can show & clear them.
router.get('/bank-overrides', A.requireAuth, (req, res) => {
  const map = loadOverrideMap();
  const banks = db.prepare('SELECT id, name FROM banks').all();
  const byId = Object.fromEntries(banks.map(b => [b.id, b.name]));
  const rows = Object.entries(map).map(([k, bid]) => ({
    key: k, bank_id: bid, bank_name: byId[bid] || `(deleted #${bid})`,
  }));
  res.json({ ok: true, rows, banks });
});
router.post('/bank-overrides', A.requireAuth, (req, res) => {
  const { key, bank_id } = req.body || {};
  if (!key) return res.status(400).json({ ok: false, error: 'key required (e.g. "ac:1234" or "code:DCB")' });
  if (!Number(bank_id)) return res.status(400).json({ ok: false, error: 'bank_id required' });
  const map = loadOverrideMap();
  map[String(key)] = Number(bank_id);
  saveOverrideMap(map);
  audit(req.user.id, 'update', 'bank_override', null, { key, bank_id });
  res.json({ ok: true, map });
});
router.delete('/bank-overrides/:key', A.requireAuth, (req, res) => {
  const map = loadOverrideMap();
  delete map[req.params.key];
  saveOverrideMap(map);
  audit(req.user.id, 'delete', 'bank_override', null, { key: req.params.key });
  res.json({ ok: true, map });
});

// Read/write the panel_map settings entry. Used by the Settings UI.
router.get('/panel/map', A.requireAuth, (req, res) => {
  const row = db.prepare("SELECT value FROM settings WHERE key='panel_map'").get();
  let map = {};
  try { map = row && row.value ? JSON.parse(row.value) : {}; } catch (_) {}
  // Also include known sheet panel slugs and recently-seen sources so the UI
  // can render a nice mapper (no free-text typos).
  const M = require('../lib/sheetMap');
  // Use the full all-branches slug list for the UI mapper, not the legacy
  // 6-slug 1XBET-only M.PANELS — otherwise LASER/RADHE/TIGEREXCH/1XCLUB
  // wouldn't show up as valid map targets.
  const sheetSlugs = M.allPanelSlugs ? M.allPanelSlugs() : M.PANELS.map(p => p.slug);
  const seen = db.prepare(`SELECT key, value FROM settings WHERE key LIKE 'panel_last_sync:%'`).all()
    .map(r => ({ source: r.key.replace('panel_last_sync:', ''), last_sync: r.value }));
  res.json({ ok: true, map, sheet_slugs: sheetSlugs, recent_sources: seen });
});

router.post('/panel/map', A.requireAuth, (req, res) => {
  const map = (req.body && req.body.map) || {};
  if (typeof map !== 'object' || Array.isArray(map))
    return res.status(400).json({ ok: false, error: 'map must be an object' });
  // Light validation: values must be strings (sheet slugs)
  for (const k of Object.keys(map)) if (typeof map[k] !== 'string')
    return res.status(400).json({ ok: false, error: `value for ${k} must be a string` });
  db.prepare(`INSERT INTO settings(key, value) VALUES ('panel_map', ?)
              ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(JSON.stringify(map));
  audit(req.user.id, 'update', 'panel_map', null, map);
  res.json({ ok: true, map });
});

router.get('/panel/status', A.requireAuth, (req, res) => {
  const rows = db.prepare(`SELECT key, value FROM settings WHERE key LIKE 'panel_last_sync:%'`).all();
  const out = {};
  for (const r of rows) out[r.key.replace('panel_last_sync:', '')] = r.value;
  res.json({ ok: true, last_sync: out });
});

// ── SMS / NOTIFICATION INGEST (Android app) ───────────────────
// Accepts: { messages: [{ sender, body, ts, source?: 'sms'|'notif' }, ...] }
// Auth: bearer token (same as panel extension).
router.post('/sms', A.requireAuthOrToken, (req, res) => {
  const { messages } = req.body || {};
  if (!Array.isArray(messages)) return res.status(400).json({ ok: false, error: 'messages required' });

  // bank name → bank_id map (case-insensitive match on "name" column)
  let allBanks = db.prepare('SELECT id, name FROM banks').all();
  const bankIdFor = (code) => {
    if (!code) return null;
    const lc = code.toLowerCase();
    const hit = allBanks.find(b => (b.name || '').toLowerCase().includes(lc) ||
                                    lc.includes((b.name || '').toLowerCase()));
    if (hit) return hit.id;
    // Auto-create a new bank row when SMS references an unknown bank
    const info = db.prepare('INSERT INTO banks(name, holder, acno, open_balance) VALUES (?,?,?,?)')
                   .run(code, '', '', 0);
    allBanks = db.prepare('SELECT id, name FROM banks').all();
    return info.lastInsertRowid;
  };

  const insBank = db.prepare(`INSERT OR IGNORE INTO bank_txns(business_date, ts, bank_id, type, amt, detail, category, source, ext_ref, balance, mode, created_by)
                              VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insDw = db.prepare(`INSERT OR IGNORE INTO dw(business_date, ts, type, amt, name, utr, remark, source, ext_ref, created_by)
                            VALUES (?,?,?,?,?,?,?,?,?,?)`);

  let parsed = 0, unknownBank = 0, insertedBank = 0, insertedDw = 0, skipped = 0, ignored = 0;
  const unmapped = [];

  const tx = db.transaction((items) => {
    for (const m of items) {
      const p = parseSms(m);
      if (!p) { ignored++; continue; }
      parsed++;
      const bd = p.ts ? businessDate(new Date(p.ts).toISOString()) : currentBusinessDate();
      const bank_id = bankIdFor(p.bank);
      if (!bank_id && p.bank) { unknownBank++; unmapped.push(p.bank); }

      // NO MIRROR TO DW. Per business rule, the gaming panel (Freeplay /
      // Testawl247 via the Chrome extension) is the SOLE source of truth
      // for Deposit / Withdrawal rows. Bank credits/debits stay strictly
      // in bank_txns — the reconciliation step (panel deposit vs bank
      // credit) decides where the "leftover" credited amount lands
      // (B2C BANK & EXP DETAILS / parking / etc).
      const info = insBank.run(bd, p.ts || null, bank_id || null, p.type, p.amt,
                               (p.counterparty || p.raw.body.slice(0, 180)),
                               p.category || 'bank', 'sms', p.ext_ref,
                               p.balance, p.mode, req.user.id);
      if (info.changes) insertedBank++; else skipped++;
    }
  });
  tx(messages);

  audit(req.user.id, 'ingest', 'sms', null, { parsed, insertedBank, insertedDw, skipped, ignored, unknownBank });
  res.json({ ok: true, parsed, insertedBank, insertedDw, skipped, ignored, unknownBank,
             hint: unknownBank ? `Add banks to the Banks tab named like: ${[...new Set(unmapped)].join(', ')}` : null });
});

// Dry-run parser for debugging: POST {body, sender} → returns what would be inserted
router.post('/sms/parse', A.requireAuthOrToken, (req, res) => {
  const p = parseSms(req.body || {});
  res.json({ ok: true, parsed: p });
});

module.exports = router;
