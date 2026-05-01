'use strict';
// Multi-bank SMS/notification parser. Input: { sender, body, ts }.
// Output: { bank, type: 'credit'|'debit', amt, balance?, utr?, counterparty?, category?, mode? } or null.
//
// Covers the major Indian banks. Add more regexes as new formats turn up.

const BANK_SIGNATURES = [
  { re: /HDFC/i,    bank: 'HDFC' },
  { re: /ICICI/i,   bank: 'ICICI' },
  { re: /SBI|SBIINB|SBIUPI/i, bank: 'SBI' },
  { re: /AXIS|AXISBK/i, bank: 'AXIS' },
  { re: /KOTAK/i,   bank: 'KOTAK' },
  { re: /DCB/i,     bank: 'DCB' },
  { re: /YES\s*BANK|YESBNK/i, bank: 'YES' },
  { re: /INDUSIND|INDUSB/i, bank: 'INDUSIND' },
  { re: /PNB/i,     bank: 'PNB' },
  { re: /BOB|BARODA/i, bank: 'BOB' },
  { re: /CANARA/i,  bank: 'CANARA' },
  { re: /UNION/i,   bank: 'UNION' },
  { re: /IDFC/i,    bank: 'IDFC' },
  { re: /RBL/i,     bank: 'RBL' },
  { re: /FEDERAL/i, bank: 'FEDERAL' },
  { re: /IDBI/i,    bank: 'IDBI' },
  { re: /BOI|BANKIN/i, bank: 'BOI' },
  { re: /UCO/i,     bank: 'UCO' },
];

const CREDIT_WORDS = /\b(credited|deposited|received|credit|cr\b|cr\.)/i;
const DEBIT_WORDS  = /\b(debited|withdrawn|paid|spent|debit|dr\b|dr\.|txn\s+of|purchase|sent)/i;
// Widened to match the PDF-parser coverage so SMS-side detection doesn't
// miss charges that the PDF parser would catch (and vice versa). Keeps
// SMS-derived bank_txns rows landing in the BANK_EXP ledger ("BANK CHG ...")
// section of the sheet instead of the bank's plain debit column.
const CHARGE_WORDS = /\b(charges?|chg|chgs|chrg|fee|fees|gst|cgst|sgst|igst|penalty|fine|levy|levied|commission|comm|tds|min[\s\-]*bal|mab|amb|nmc|sms\s*charg|service\s*charg|serv\s*tax|maint(?:enance)?\s*chg|annual\s*fee|maintenance)\b/i;
const BAL_RE       = /\b(?:bal|balance|avl\s*bal|a\/c\s*bal)[^0-9]{0,8}(?:inr|rs\.?)?\s*([0-9,]+\.?\d*)/i;
const AMT_RE       = /\b(?:inr|rs\.?|₹)\s*([0-9,]+\.?\d*)|\b([0-9,]+\.?\d*)\s*(?:inr|rs)\b/i;
const UTR_RE       = /\b(?:UTR[:\s-]*|Ref[:\s-]+(?:No[:\s-]*)?|Txn[:\s#-]+|RRN[:\s-]*)([A-Z0-9]{10,22})/i;
// Counterparty: "to XYZ", "from XYZ", "VPA xyz@bank", "UPI/xyz/..."
const TO_FROM_RE   = /\b(?:to|from)\s+([A-Z][A-Z0-9 .&_\-]{2,40}?)(?=\s+(?:on|Ref|UTR|Txn|bal|avl|a\/c|[.,]|$))/i;
const VPA_RE       = /([a-zA-Z0-9._\-]{2,}@[a-zA-Z]{2,})/;
// UPI/ALICE KUMAR/...  — first segment after UPI/ must be a name (letters+spaces, no digits)
const UPI_NAME_RE  = /UPI[\/:]\s*([A-Z][A-Z .&_\-]{2,40}?)(?=[\/,.;]|\s{2,}|$)/i;

function parseNumber(s) {
  if (!s) return null;
  const n = Number(String(s).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

function detectBank(sender = '', body = '') {
  // Prefer full registry (complete Indian banks list)
  try {
    const { detectBankCode, detectBankFromSender } = require('./banksRegistry');
    const bySender = detectBankFromSender(sender);
    if (bySender) return bySender;
    const byText = detectBankCode((sender + ' ' + body).toUpperCase());
    if (byText) return byText;
  } catch (_) {}
  const hay = (sender + ' ' + body).toUpperCase();
  for (const s of BANK_SIGNATURES) if (s.re.test(hay)) return s.bank;
  return null;
}

function detectDirection(body) {
  if (CHARGE_WORDS.test(body) && DEBIT_WORDS.test(body)) return { type: 'debit', category: 'charge' };
  if (CHARGE_WORDS.test(body)) return { type: 'debit', category: 'charge' };
  if (CREDIT_WORDS.test(body) && !DEBIT_WORDS.test(body)) return { type: 'credit' };
  if (DEBIT_WORDS.test(body)) return { type: 'debit' };
  return null;
}

function detectMode(body) {
  if (/UPI/i.test(body)) return 'UPI';
  if (/IMPS/i.test(body)) return 'IMPS';
  if (/NEFT/i.test(body)) return 'NEFT';
  if (/RTGS/i.test(body)) return 'RTGS';
  if (/ATM|CASH\s+WD/i.test(body)) return 'ATM';
  if (/POS|DEBIT\s+CARD|CREDIT\s+CARD/i.test(body)) return 'CARD';
  return null;
}

function extractCounterparty(body) {
  const upi = body.match(UPI_NAME_RE);
  if (upi) return upi[1].trim();
  const tf = body.match(TO_FROM_RE);
  if (tf) return tf[1].trim();
  const vpa = body.match(VPA_RE);
  if (vpa) return vpa[1].trim();
  return null;
}

// Build a stable dedupe key. When a UTR is present we use the SOURCE-
// INDEPENDENT canonical form `utr:<UTR>` so the same UTR arriving via
// SMS, PDF statement, or paste-text all collapse onto a single bank_txns
// row (UNIQUE constraint on ext_ref does the work). When no UTR is
// available, fall back to a per-source composite key so distinct rows
// don't collapse onto each other.
function makeExtRef({ bank, ts, amt, utr, direction }) {
  if (utr) return `utr:${String(utr).trim().toUpperCase()}`;
  return `sms:${bank}:${direction}:${amt}:${ts || ''}`;
}

function parseSms({ sender = '', body = '', ts = null }) {
  if (!body) return null;
  const bank = detectBank(sender, body);
  const dir = detectDirection(body);
  if (!dir) return null;
  const amtMatch = body.match(AMT_RE);
  const amt = parseNumber(amtMatch && (amtMatch[1] || amtMatch[2]));
  if (!amt) return null;
  const balMatch = body.match(BAL_RE);
  const balance = parseNumber(balMatch && balMatch[1]);
  const utrMatch = body.match(UTR_RE);
  const utr = utrMatch ? utrMatch[1] : null;
  const counterparty = extractCounterparty(body);
  const mode = detectMode(body);

  return {
    bank,
    type: dir.type,
    category: dir.category || (mode === 'ATM' ? 'atm' : null),
    amt,
    balance,
    utr,
    counterparty,
    mode,
    ts,
    ext_ref: makeExtRef({ bank: bank || 'UNK', ts, amt, utr, direction: dir.type }),
    raw: { sender, body },
  };
}

module.exports = { parseSms, detectBank, detectDirection, BANK_SIGNATURES };
