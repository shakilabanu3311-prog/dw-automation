'use strict';
// Generic multi-bank PDF statement parser.
// Handles statements with one transaction per line where the line ends in
// "<amt><amt><bal>" (all concatenated) OR has space-separated numerics.
// Covers: DCB, Vasai Vikas Sahakari, Co-op banks, HDFC/ICICI/SBI/Axis/Kotak
// ATM narrations, and most typical Indian bank formats.

const pdfParse = require('pdf-parse');
const { businessDate } = require('../lib/businessDate');

const MONTHS = { jan:'01',feb:'02',mar:'03',apr:'04',may:'05',jun:'06',jul:'07',aug:'08',sep:'09',oct:'10',nov:'11',dec:'12' };

function parseAmt(s) {
  if (s == null) return 0;
  const n = parseFloat(String(s).replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
}

// Date parser — supports: 04/Mar/2026, 04-03-2026, 04/03/26, 2026-03-04
function parseDate(raw) {
  if (!raw) return null;
  const s = String(raw).trim().replace(/^'/, '');
  let m = s.match(/(\d{1,2})[\/\-](\d{1,2}|[A-Za-z]{3})[\/\-](\d{2,4})/);
  if (m) {
    let [, dd, mon, yy] = m;
    mon = /^\d+$/.test(mon) ? mon.padStart(2, '0') : (MONTHS[mon.toLowerCase().slice(0,3)] || null);
    if (!mon) return null;
    if (yy.length === 2) yy = (Number(yy) > 50 ? '19' : '20') + yy;
    return `${yy}-${mon}-${String(dd).padStart(2,'0')}`;
  }
  m = s.match(/(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`;
  return null;
}

// Line-level classification heuristics.
// CHARGE_RE was too narrow — generic narrations like "IMPS CHG", "NEFT CHG",
// "MAB CHG", "DCBCWD CHG", any mention of "CHARGE", "CHG", "FEE", or tax
// categories should all flow into the BANK_EXP ledger as bank charge.
const CHARGE_RE   = /\b(?:CHARGES?|CHG|CHGS|CHRG|FEE|FEES|PENALTY|FINE|LEVY|LEVIED|COMMISSION|COMM|GST|SGST|CGST|IGST|TDS|MIN[\s\-]*BAL|MAB|AMB|NMC|SMS\s*CHARG|SERVICE\s*CHARG|SERV\s*TAX|MAINT(?:ENANCE)?\s*CHG)\b/i;
const ATM_WD_RE   = /\bATM[\/\-]/i;
const UPI_RE      = /\bUPI\b/i;
const IMPS_RE     = /\bIMPS\b/i;
const NEFT_RE     = /\bNEFT\b/i;
const RTGS_RE     = /\bRTGS\b/i;

// Try to pull a counterparty name from narration.
function extractName(narr) {
  if (!narr) return '';
  const s = String(narr).replace(/\s+/g, ' ');
  // Vasai/Co-op style: IMPS/<ref>/<NAME>/<IFSC>/<...>
  let m = s.match(/(?:IMPS|NEFT|RTGS|UPI)[:\/]+\d+\/([A-Za-z][A-Za-z .&_\-]{2,50}?)\/[A-Z]{4}/);
  if (m) return m[1].trim();
  // DCB style: UPI:REC:<ref>/<NAME>
  m = s.match(/(?:UPI|IMPS):(?:REC|PAY):\d+\/([A-Za-z][A-Za-z .&_\-]{2,50}?)(?:\/|\s|$)/i);
  if (m) return m[1].trim().replace(/^MB\s+/i, '');
  // NEFT/IMPS TO NAME
  m = s.match(/(?:to|from)\s+([A-Z][A-Z .&_\-]{3,40})/i);
  if (m) return m[1].trim();
  return '';
}

function extractUtr(narr) {
  if (!narr) return '';
  const s = String(narr).toUpperCase();
  // Prefer a labeled UTR (UTR/Ref/Txn/RRN) — these are unambiguous and
  // accept alphanumeric values (NEFT/RTGS UTRs commonly start with an
  // alpha bank code like "AXISN12345678" or "HDFCH012345678").
  let m = s.match(/\b(?:UTR|REF(?:\s*NO)?|TXN|RRN|TRANSACTION\s*ID)[:\s\-#]*([A-Z0-9]{10,22})/);
  if (m) return m[1];
  // No label — accept any 10–18 alphanumeric chunk that has at least one
  // digit (so we don't grab plain English words). Falls back to digits-only
  // match for the common UPI/IMPS reference numbers.
  m = s.match(/\b(?=[A-Z0-9]{10,18}\b)(?=[^\s]*\d)([A-Z0-9]{10,18})\b/);
  if (m) return m[1];
  m = s.match(/\b(\d{10,18})\b/);
  return m ? m[1] : '';
}

function detectMode(narr) {
  if (UPI_RE.test(narr))  return 'UPI';
  if (IMPS_RE.test(narr)) return 'IMPS';
  if (NEFT_RE.test(narr)) return 'NEFT';
  if (RTGS_RE.test(narr)) return 'RTGS';
  if (ATM_WD_RE.test(narr)) return 'ATM';
  return null;
}

// Given a line or joined block of text that represents one row, extract:
//   { date, narration, debit, credit, balance }
// The Vasai Vikas format looks like:
//   1'04/Mar/2026CSH/CASA_Cr/Txn Br:3 by cash0000000.001000.001000.00
// i.e. Sr + Date + narration + (13-digit zero-padded amt or 0000000.00) + debit + credit + balance.
// We look for the LAST THREE numerics at end of the line and call them debit/credit/balance.
// For other formats (DCB), we look for two trailing amounts (amt, balance) using the
// existing dcb_pdf parser. So this function tries the three-number variant first.
function parseRowsFromText(text) {
  const rawLines = text.split(/\r?\n/).map(l => l.replace(/\s+$/, ''));
  // Stitch multi-line rows: a row starts at a line containing a date pattern.
  const dateRe = /(\d{1,2}[\/\-](?:\d{1,2}|[A-Za-z]{3})[\/\-]\d{2,4})/;
  // Rebuild logical rows by gluing lines until we see a row-end (line ending
  // with 2+ numerics) or the next date-line.
  const logical = [];
  let buf = '';
  for (const line of rawLines) {
    if (!line.trim()) continue;
    if (dateRe.test(line) && buf) { logical.push(buf); buf = line; }
    else buf = buf ? (buf + ' ' + line) : line;
  }
  if (buf) logical.push(buf);

  const rows = [];
  for (let raw of logical) {
    const dm = raw.match(dateRe);
    if (!dm) continue;
    const dateISO = parseDate(dm[1]);
    if (!dateISO) continue;
    // Strip leading "1'" sr number
    raw = raw.replace(/^\s*\d+['`]?\s*/, '');

    // Pull all decimal numerics from the tail.
    const nums = [...raw.matchAll(/(-?\d[\d,]*\.\d{2})/g)];
    if (nums.length < 2) continue;

    // Vasai-style: last three are debit/credit/balance.
    // DCB-style:   last two are amount/balance.
    let debit = 0, credit = 0, balance, narrEnd;
    if (nums.length >= 3) {
      const [d, c, b] = nums.slice(-3).map(m => parseAmt(m[1]));
      // Heuristic: if exactly one of d/c is nonzero, we're in Vasai-style.
      if ((d > 0 && c === 0) || (c > 0 && d === 0) || (d === 0 && c === 0)) {
        debit = d; credit = c; balance = b;
        narrEnd = nums[nums.length - 3].index;
      } else {
        // Looks like 2-number pattern with a spurious earlier numeric; fall to amt/bal
        const [amt, bal] = nums.slice(-2).map(m => parseAmt(m[1]));
        balance = bal; narrEnd = nums[nums.length - 2].index;
        // direction left unknown; will be inferred from balance delta
        debit = amt; credit = 0; // temporary
      }
    } else {
      const [amt, bal] = nums.slice(-2).map(m => parseAmt(m[1]));
      balance = bal; narrEnd = nums[nums.length - 2].index;
      debit = amt; credit = 0;
    }

    let narration = raw.slice(0, narrEnd).trim();
    // Strip the date from the narration
    narration = narration.replace(dm[1], '').trim();
    narration = narration.replace(/\s+/g, ' ');

    rows.push({
      date: dateISO,
      narration,
      debit,
      credit,
      balance,
    });
  }

  // If any row has debit>0 but credit===0 ambiguity (DCB-style), use balance delta
  let prevBal = null;
  for (const r of rows) {
    if (r.credit === 0 && r.debit > 0 && prevBal != null) {
      const delta = +(r.balance - prevBal).toFixed(2);
      if (Math.abs(delta - r.debit) < 0.02) { r.credit = r.debit; r.debit = 0; }
      else if (Math.abs(delta + r.debit) < 0.02) { /* debit confirmed */ }
      else { /* leave as debit guess */ }
    }
    prevBal = r.balance;
  }
  return rows;
}

function classify(r) {
  const narr = r.narration;
  if (CHARGE_RE.test(narr)) return { entryKind: 'bank_charge', category: 'charge' };
  if (ATM_WD_RE.test(narr)) return { entryKind: 'bank_debit',  category: 'bank' };
  if (/(?:IMPS|NEFT|RTGS|UPI)/i.test(narr)) {
    return { entryKind: r.credit > 0 ? 'dw_deposit' : 'dw_withdrawal', category: 'bank' };
  }
  return { entryKind: r.credit > 0 ? 'bank_credit' : 'bank_debit', category: 'bank' };
}

async function parseGenericBankPdf(buffer) {
  const data = await pdfParse(buffer);
  const text = data.text || '';
  const raw = parseRowsFromText(text);
  const rows = raw.filter(r => {
    const amt = r.credit > 0 ? r.credit : r.debit;
    // Sanity: drop rows where balance is absurd (likely page-footer glue)
    if (!Number.isFinite(r.balance)) return false;
    if (amt <= 0) return false;
    if (amt > 1e8) return false;
    return true;
  }).map(r => {
    const cls = classify(r);
    const amt = r.credit > 0 ? r.credit : r.debit;
    const type = r.credit > 0 ? 'credit' : 'debit';
    const name = extractName(r.narration);
    const utr = extractUtr(r.narration);
    const mode = detectMode(r.narration);
    // Canonical UTR-keyed ext_ref so PDF + SMS + paste-text rows for the
    // same transaction collapse onto a single bank_txns row.
    const ext_ref = utr ? `utr:${String(utr).trim().toUpperCase()}` : `pdf:${r.date}|${amt.toFixed(2)}|${r.narration.slice(0, 40)}`;
    return {
      business_date: businessDate(r.date + 'T12:00:00+05:30') || r.date,
      date: r.date,
      narration: r.narration,
      amt, type,
      balance: r.balance,
      debit: r.debit, credit: r.credit,
      name, utr, mode,
      category: cls.category,
      entryKind: cls.entryKind,
      ext_ref,
    };
  });
  return { pages: data.numpages, rows, text };
}

module.exports = { parseGenericBankPdf, parseRowsFromText, parseDate };
