'use strict';
// Given raw PDF/CSV text, figure out which bank issued the statement
// and which row in the `banks` table it belongs to.

const { BANK_SIGNATURES } = require('./sms');
const { ALL_BANKS } = require('./banksRegistry');
const { db } = require('../lib/db');

// Extra signatures for statement headers (logos/boilerplate usually mention
// the full legal name or IFSC code prefix). Ordered by specificity.
const EXTRA = [
  { re: /DCB\s+BANK/i, bank: 'DCB' },
  { re: /HDFC\s+BANK/i, bank: 'HDFC' },
  { re: /ICICI\s+BANK/i, bank: 'ICICI' },
  { re: /STATE\s+BANK\s+OF\s+INDIA|\bSBIN\b/i, bank: 'SBI' },
  { re: /AXIS\s+BANK|\bUTIB\b/i, bank: 'AXIS' },
  { re: /KOTAK\s+MAHINDRA|\bKKBK\b/i, bank: 'KOTAK' },
  { re: /YES\s+BANK|\bYESB\b/i, bank: 'YES' },
  { re: /INDUSIND\s+BANK|\bINDB\b/i, bank: 'INDUSIND' },
  { re: /PUNJAB\s+NATIONAL|\bPUNB\b/i, bank: 'PNB' },
  { re: /BANK\s+OF\s+BARODA|\bBARB\b/i, bank: 'BOB' },
  { re: /CANARA\s+BANK|\bCNRB\b/i, bank: 'CANARA' },
  { re: /UNION\s+BANK|\bUBIN\b/i, bank: 'UNION' },
  { re: /IDFC\s+(FIRST\s+)?BANK|\bIDFB\b/i, bank: 'IDFC' },
  { re: /\bRBL\s+BANK\b|\bRATN\b/i, bank: 'RBL' },
  { re: /FEDERAL\s+BANK|\bFDRL\b/i, bank: 'FEDERAL' },
  { re: /\bIDBI\s+BANK\b|\bIBKL\b/i, bank: 'IDBI' },
  { re: /BANK\s+OF\s+INDIA|\bBKID\b/i, bank: 'BOI' },
  { re: /UCO\s+BANK|\bUCBA\b/i, bank: 'UCO' },
  { re: /VASAI\s+VIKAS\s+SAHAKARI|\bVVSB\b/i, bank: 'VASAI VIKAS' },
  { re: /SARASWAT\s+CO.?OPERATIVE|\bSRCB\b/i, bank: 'SARASWAT' },
  { re: /SVC\s+CO.?OPERATIVE|\bSVCB\b/i, bank: 'SVC' },
  { re: /\bTJSB\b|THANE\s+JANATA/i, bank: 'TJSB' },
  { re: /ABHYUDAYA\s+CO.?OPERATIVE/i, bank: 'ABHYUDAYA' },
  { re: /COSMOS\s+CO.?OPERATIVE|\bCOSB\b/i, bank: 'COSMOS' },
  { re: /NKGSB\s+CO.?OPERATIVE/i, bank: 'NKGSB' },
  { re: /PUNJAB\s+(?:&|AND)\s+MAHARASHTRA|\bPMCB\b/i, bank: 'PMC' },
  { re: /CO.?OPERATIVE\s+BANK/i, bank: 'COOP' }, // generic co-op fallback
];

// Detect bank code from a chunk of statement text.
// Uses the full banks registry (every Indian bank) first, then the legacy tables.
// Two-pass: (1) header/footer (first + last 3k) which usually has the bank's
// legal name; (2) full transaction body — UPI/IMPS narrations typically embed
// IFSC prefixes (HDFCN, ICIC, UTIB, KKBK, ...) which are rock-solid identifiers.
// We tally hits from the body so a noisy header doesn't lose to one transaction
// that happens to mention a different bank.
function detectBankCode(text) {
  if (!text) return null;
  const head = text.slice(0, 4000);
  const tail = text.slice(-2000);
  const headTail = head + ' ' + tail;
  // Always score every bank instead of returning the first regex hit. The
  // old "first-hit-wins" pass was order-dependent — common short codes like
  // \bDCB\b would fire on substrings in unrelated statements and ship the
  // wrong bank to commit. Scoring fixes the misdetect by letting the
  // highest-mentioned bank win, with a heavy bonus for header/footer
  // matches (where the bank's legal name actually lives).
  const tally = new Map();
  const bump = (code, n) => tally.set(code, (tally.get(code) || 0) + n);
  const countAll = (re, body) => {
    try {
      const flags = re.flags.includes('g') ? re.flags : re.flags + 'g';
      const m = body.match(new RegExp(re.source, flags));
      return m ? m.length : 0;
    } catch (_) { return 0; }
  };

  // 1. Header/footer pass — heavy weight (5x). The bank's full legal name,
  //    address, and IFSC prefix usually appear at the very top or in the
  //    statement footer.
  for (const [code, re] of ALL_BANKS) {
    const n = countAll(re, headTail);
    if (n) bump(code, n * 5);
  }
  for (const s of EXTRA) {
    const n = countAll(s.re, headTail);
    if (n) bump(s.bank, n * 5);
  }

  // 2. Full-body pass — light weight (1x). Adds confidence when the same
  //    bank's IFSC/UPI prefix is repeated in transactions.
  for (const [code, re] of ALL_BANKS) {
    const n = countAll(re, text);
    if (n) bump(code, n);
  }
  for (const s of EXTRA) {
    const n = countAll(s.re, text);
    if (n) bump(s.bank, n);
  }

  if (!tally.size) return null;
  // Tie-break: longer/more-specific bank codes win when scores match. This
  // keeps "DCB" from beating "ICICI" or "HDFC" on a draw.
  const ranked = [...tally.entries()].sort((a, b) => {
    if (b[1] !== a[1]) return b[1] - a[1];
    return b[0].length - a[0].length;
  });
  return ranked[0][0];
}

// Cross-check: the detected bank should have at least a few txns whose
// narrations look like its IFSC prefix or name. Returns a small report.
function transactionBankSignals(text) {
  const counts = {};
  for (const [code, re] of ALL_BANKS) {
    const m = text.match(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'));
    if (m && m.length) counts[code] = m.length;
  }
  return counts;
}

// Pull an account number (last 4-16 digits) out of the text.
function extractAccountNo(text) {
  if (!text) return null;
  const head = text.slice(0, 5000);
  // Try several formats:
  //   "A/c No: XXXXXXXX1234" / "Account Number : 000123456789"
  //   "Account No :000320031005795" (no space after colon)
  const patterns = [
    /Account\s+No\.?\s*:?\s*([X\*0-9]{4,20})/i,
    /A\/c\s+No\.?\s*:?\s*([X\*0-9]{4,20})/i,
    /Account\s+Number\s*:?\s*([X\*0-9]{4,20})/i,
  ];
  for (const p of patterns) {
    const m = head.match(p);
    if (m) {
      const digits = m[1].replace(/[^0-9]/g, '');
      if (digits.length >= 4) return digits.slice(-4);
    }
  }
  return null;
}

// Match the detected bank against existing banks in DB.
// Priority: account-number last4 match > name contains code > holder matches.
function matchBankInDb(code, acLast4) {
  const rows = db.prepare('SELECT id, name, holder, acno FROM banks').all();
  if (acLast4) {
    for (const r of rows) {
      const digits = String(r.acno || '').replace(/[^0-9]/g, '');
      if (digits && digits.slice(-4) === acLast4) return { bank: r, confidence: 'high', via: 'acno' };
    }
  }
  if (code) {
    const lc = code.toLowerCase();
    for (const r of rows) {
      const nm = (r.name || '').toLowerCase();
      if (nm.includes(lc) || lc.includes(nm)) return { bank: r, confidence: acLast4 ? 'medium' : 'medium', via: 'name' };
    }
  }
  return null;
}

// Pull a likely account holder name from the header.
function extractHolder(text) {
  if (!text) return null;
  const head = text.slice(0, 3000);
  // Label-prefixed holder
  let m = head.match(/(?:Customer Name|Account Holder|A\/c Holder|Name of Account Holder|Name)\s*[:\-]\s*([A-Z][A-Z .&_\-]{2,60})/i);
  if (m) return m[1].trim().replace(/\s+/g, ' ');
  // Vasai-Vikas layout: "HARESH BHAGWANJI RATHODCustomer ID :..."
  m = head.match(/\n\s*([A-Z][A-Z ]{5,50}?)(?:Customer ID|Cust\s*ID|A\/c|Account)/);
  if (m) return m[1].trim().replace(/\s+/g, ' ');
  return null;
}

// Auto-create a bank row if the PDF clearly identifies one but no row exists.
// Returns { bank, created: bool } or null.
function autoRegister(code, acLast4, holder) {
  if (!code) return null;
  const name = code
    + (holder ? ` — ${holder.split(' ').slice(0,2).join(' ')}` : '')
    + (acLast4 ? ` ****${acLast4}` : '');
  const existing = db.prepare('SELECT id, name, holder, acno FROM banks WHERE name = ?').get(name);
  if (existing) return { bank: existing, created: false };
  const info = db.prepare('INSERT INTO banks(name, holder, acno, open_balance) VALUES (?,?,?,?)')
                 .run(name, holder || '', acLast4 ? `****${acLast4}` : '', 0);
  const bank = db.prepare('SELECT id, name, holder, acno FROM banks WHERE id = ?').get(info.lastInsertRowid);
  return { bank, created: true };
}

function detectFromText(text, opts = {}) {
  const code = detectBankCode(text);
  const acLast4 = extractAccountNo(text);
  const holder = extractHolder(text);
  const signals = transactionBankSignals(text);
  let match = matchBankInDb(code, acLast4);
  let created = false;
  if (!match && opts.autoRegister && code) {
    const reg = autoRegister(code, acLast4, holder);
    if (reg) { match = { bank: reg.bank, confidence: acLast4 ? 'high' : 'medium', via: 'auto-registered' }; created = reg.created; }
  }
  return {
    code,
    ac_last4: acLast4,
    holder,
    bank_id: match ? match.bank.id : null,
    bank_name: match ? match.bank.name : null,
    confidence: match ? match.confidence : (code ? 'low' : 'none'),
    via: match ? match.via : null,
    auto_registered: created,
    signals, // { HDFC: 12, ICIC: 1, ... } — for sanity checks in UI
  };
}

module.exports = { detectFromText, detectBankCode, extractAccountNo, extractHolder, matchBankInDb, autoRegister, transactionBankSignals };
