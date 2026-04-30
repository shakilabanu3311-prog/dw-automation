'use strict';
const pdfParse = require('pdf-parse');
const { businessDate } = require('../lib/businessDate');

function parseAmt(s) {
  if (!s) return 0;
  const n = parseFloat(String(s).replace(/,/g, ''));
  return isNaN(n) ? 0 : n;
}
function isoFromDdMmYyyy(s) {
  const m = String(s).match(/(\d{2})[\/\-](\d{2})[\/\-](\d{4})/);
  if (!m) return null;
  const [, dd, mm, yyyy] = m;
  return `${yyyy}-${mm}-${dd}`;
}

const CHARGE_KEYS = /\b(SGST|CGST|IGST|CHARGE|CHG|CHGS|FEE|FEES|COMMISSION|PENALTY|SMS\s*CHG|ATM\s*CHG|MIN\s*BAL|AMB\s*CHG|SERVICE)\b/i;
const CWD_KEYS = /\b(RUPAYCWD|DCBCWD|ATM\s*CWD)\b/i;

function extractParty(narr) {
  if (!narr) return { name: '', utr: '' };
  const s = String(narr).replace(/\s+/g, ' ').trim();
  // UPI/IMPS formats: TYPE:DIR:REF/NAME/BANK  or  TYPE:DIR:REF/NAME/XXNNN/suffix
  // REF can be alphanumeric (some UPI providers prepend a bank/PSP code).
  let m = s.match(/^(UPI|IMPS):(REC|PAY|REV):([A-Z0-9]{6,})\/([^\/]+?)(?:\s{2,}|\/|$)/i);
  if (m) return { name: m[4].trim().replace(/^MB\s+/i, ''), utr: m[3] };
  m = s.match(/^NEFT[:\/\-]?\s*([A-Z0-9]{6,})?[:\/\-]?\s*([A-Z][A-Z0-9 .&]{2,50})/i);
  if (m) return { name: (m[2] || '').trim(), utr: m[1] || '' };
  m = s.match(/\b([A-Z0-9]{10,})\b/);
  return { name: '', utr: m ? m[1] : '' };
}

function classifyDirection(narr) {
  if (!narr) return null;
  if (/:REC:/i.test(narr)) return 'credit';
  if (/:PAY:/i.test(narr)) return 'debit';
  if (/:REV:/i.test(narr)) return null;
  if (CHARGE_KEYS.test(narr)) return 'debit';
  if (CWD_KEYS.test(narr)) return 'debit';
  if (/\bNEFT\b.*(RECEIVED|CREDIT|REC)/i.test(narr)) return 'credit';
  if (/\bNEFT\b/i.test(narr)) return 'debit';
  if (/\bMBIFT\b/i.test(narr)) return 'debit';
  return null;
}

function classifyEntryKind(narr, type) {
  if (CHARGE_KEYS.test(narr)) return 'bank_charge';
  if (CWD_KEYS.test(narr)) return 'bank_debit';
  const hasParty = /:(REC|PAY):/i.test(narr) || /NEFT/i.test(narr);
  if (hasParty) return type === 'credit' ? 'dw_deposit' : 'dw_withdrawal';
  return type === 'credit' ? 'bank_credit' : 'bank_debit';
}

function parseLines(text) {
  const rawLines = text.split(/\r?\n/).map(l => l.replace(/\s+$/, ''));
  const dateRe = /^(\d{2}[-\/]\d{2}[-\/]\d{4})(.*)$/;

  // Parse opening balance line (looks like "Opening Balance22,550.99")
  let runningBal = null;
  for (const l of rawLines) {
    const m = l.match(/Opening Balance\s*([\d,]+\.\d{2})/i);
    if (m) { runningBal = parseAmt(m[1]); break; }
  }

  const rows = [];
  for (const line of rawLines) {
    const m = line.match(dateRe);
    if (!m) continue;
    const date = isoFromDdMmYyyy(m[1]);
    if (!date) continue;
    let rest = m[2];

    const nums = [...rest.matchAll(/([\d,]+\.\d{2})/g)].map(x => x[1]);
    if (nums.length < 2) continue;
    const balance = parseAmt(nums[nums.length - 1]);
    const amount = parseAmt(nums[nums.length - 2]);
    if (!amount) continue;

    // Narration = rest minus all trailing numerics
    let narration = rest;
    // Find the index of the second-to-last numeric match; strip from there
    const allMatches = [...rest.matchAll(/([\d,]+\.\d{2})/g)];
    if (allMatches.length >= 2) {
      const cutAt = allMatches[allMatches.length - 2].index;
      narration = rest.slice(0, cutAt).replace(/\s+$/, '').trim();
    }
    narration = narration.replace(/\s+/g, ' ');

    let direction = classifyDirection(narration);
    if (!direction && runningBal != null) {
      const delta = +(balance - runningBal).toFixed(2);
      if (Math.abs(Math.abs(delta) - amount) < 0.02) {
        direction = delta > 0 ? 'credit' : 'debit';
      }
    }
    if (!direction) continue;

    runningBal = balance;

    const entryKind = classifyEntryKind(narration, direction);
    const party = extractParty(narration);

    const ext_ref = party.utr ? `dcb:${party.utr}` : `dcb:${date}|${amount.toFixed(2)}|${narration.slice(0, 30)}`;
    rows.push({
      business_date: businessDate(date + 'T12:00:00+05:30') || date,
      date,
      narration,
      debit: direction === 'debit' ? amount : 0,
      credit: direction === 'credit' ? amount : 0,
      balance,
      amt: amount,
      type: direction,
      category: entryKind === 'bank_charge' ? 'charge' : 'bank',
      name: party.name,
      utr: party.utr,
      ext_ref,
      entryKind,
    });
  }
  return rows;
}

async function parseDcbPdf(buffer) {
  const data = await pdfParse(buffer);
  const rows = parseLines(data.text || '');
  return { pages: data.numpages, rows, text: data.text || '' };
}

module.exports = { parseDcbPdf, parseLines, extractParty, classifyDirection, classifyEntryKind };
