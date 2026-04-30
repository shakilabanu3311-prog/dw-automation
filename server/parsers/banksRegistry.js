'use strict';
// Complete Indian bank registry — every RBI-licensed scheduled bank in use in 2026,
// plus major co-operative banks, small finance banks, and payments banks.
// Used by SMS parser + statement PDF bank-detect.
//
// Format per row: [code, regex, categories]
//   code        — short identifier (HDFC, ICICI, SBI, ...)
//   regex       — header / SMS sender / narration pattern
//   category    — 'psu' | 'private' | 'sfb' | 'payments' | 'coop' | 'foreign'
//
// Regex is run against (sender + ' ' + body) for SMS and first 3k chars of PDF.

const ALL_BANKS = [
  // ───────────── Public-sector / nationalised ─────────────
  ['SBI',        /STATE\s+BANK\s+OF\s+INDIA|\bSBIINB\b|\bSBIUPI\b|\bSBIN0/i, 'psu'],
  ['PNB',        /PUNJAB\s+NATIONAL\s+BANK|\bPUNB0/i, 'psu'],
  ['BOB',        /BANK\s+OF\s+BARODA|\bBARB0/i, 'psu'],
  ['CANARA',     /CANARA\s+BANK|\bCNRB\b/i, 'psu'],
  ['UNION',      /UNION\s+BANK\s+OF\s+INDIA|\bUBIN\b|UNION\s+BANK/i, 'psu'],
  ['BOI',        /BANK\s+OF\s+INDIA|\bBKID\b/i, 'psu'],
  ['INDIANBK',   /INDIAN\s+BANK|\bIDIB\b/i, 'psu'],
  ['CENTRAL',    /CENTRAL\s+BANK\s+OF\s+INDIA|\bCBIN\b/i, 'psu'],
  ['IOB',        /INDIAN\s+OVERSEAS\s+BANK|\bIOBA\b|\bIOB\b/i, 'psu'],
  ['UCO',        /UCO\s+BANK|\bUCBA\b/i, 'psu'],
  ['BOM',        /BANK\s+OF\s+MAHARASHTRA|\bMAHB\b/i, 'psu'],
  ['PSB',        /PUNJAB\s+&\s+SIND\s+BANK|\bPSIB\b/i, 'psu'],

  // ───────────── Private-sector ────────────────────────────
  // Removed bare-code fallbacks (\bHDFC\b, \bDCB\b, etc.) — they triggered
  // false-positive matches on substrings appearing in unrelated statements.
  // The bank's full name OR its IFSC prefix is unique enough.
  ['HDFC',       /HDFC\s+BANK|\bHDFCN\d|\bHDFC0/i, 'private'],
  ['ICICI',      /ICICI\s+BANK|\bICIC0/i, 'private'],
  ['AXIS',       /AXIS\s+BANK|\bUTIB0|\bAXISBK\b/i, 'private'],
  ['KOTAK',      /KOTAK\s+MAHINDRA|KOTAK\s+BANK|\bKKBK0/i, 'private'],
  ['INDUSIND',   /INDUSIND\s+BANK|\bINDB0/i, 'private'],
  ['YES',        /YES\s+BANK|\bYESB0/i, 'private'],
  ['IDFC',       /IDFC\s+(?:FIRST\s+)?BANK|\bIDFB0/i, 'private'],
  ['FEDERAL',    /FEDERAL\s+BANK|\bFDRL0/i, 'private'],
  ['RBL',        /\bRBL\s+BANK\b|\bRATN0/i, 'private'],
  ['IDBI',       /\bIDBI\s+BANK\b|\bIBKL0/i, 'private'],
  ['SOUTHIND',   /SOUTH\s+INDIAN\s+BANK|\bSIBL0/i, 'private'],
  ['KARURVYSYA', /KARUR\s+VYSYA|\bKVBL0/i, 'private'],
  ['KARNATAKA',  /KARNATAKA\s+BANK|\bKARB0/i, 'private'],
  ['CITYUNION',  /CITY\s+UNION\s+BANK|\bCIUB0/i, 'private'],
  // DCB requires "DCB BANK" together (drops bare \bDCB\b that misfired on
  // unrelated codes).
  ['DCB',        /\bDCB\s+BANK\b|\bDCBL0/i, 'private'],
  ['TMB',        /TAMILNAD\s+MERCANTILE|\bTMBL\b/i, 'private'],
  ['DHANLAXMI',  /DHANLAXMI\s+BANK|\bDLXB\b/i, 'private'],
  ['JAMMUKASHMIR', /JAMMU\s+AND\s+KASHMIR|J\s?&\s?K\s+BANK|\bJAKA\b/i, 'private'],
  ['BANDHAN',    /BANDHAN\s+BANK|\bBDBL\b/i, 'private'],
  ['CSBFBL',     /CSB\s+BANK|\bCSBK\b/i, 'private'],
  ['NAINITAL',   /NAINITAL\s+BANK|\bNTBL\b/i, 'private'],

  // ───────────── Small Finance Banks ───────────────────────
  ['AUSFB',      /AU\s+SMALL\s+FINANCE|\bAUBL\b/i, 'sfb'],
  ['EQUITAS',    /EQUITAS\s+SMALL|\bESFB\b/i, 'sfb'],
  ['UJJIVAN',    /UJJIVAN\s+SMALL|\bUJVN\b/i, 'sfb'],
  ['JANA',       /JANA\s+SMALL|\bJSFB\b/i, 'sfb'],
  ['ESAF',       /ESAF\s+SMALL|\bESMF\b/i, 'sfb'],
  ['FINCARE',    /FINCARE\s+SMALL|\bFSFB\b/i, 'sfb'],
  ['NORTHEAST',  /NORTH\s+EAST\s+SMALL|\bNESF\b/i, 'sfb'],
  ['SURYODAY',   /SURYODAY\s+SMALL|\bSURY\b/i, 'sfb'],
  ['UTKARSH',    /UTKARSH\s+SMALL|\bUTKS\b/i, 'sfb'],
  ['CAPITALSFB', /CAPITAL\s+SMALL|\bCLBL\b/i, 'sfb'],
  ['SHIVALIK',   /SHIVALIK\s+SMALL/i, 'sfb'],
  ['UNITYSFB',   /UNITY\s+SMALL/i, 'sfb'],

  // ───────────── Payments Banks ────────────────────────────
  ['PAYTMPB',    /PAYTM\s+PAYMENTS|\bPYTM\b/i, 'payments'],
  ['AIRTELPB',   /AIRTEL\s+PAYMENTS|\bAIRP\b/i, 'payments'],
  ['INDIAPOSTPB',/INDIA\s+POST\s+PAYMENTS|\bIPOS\b/i, 'payments'],
  ['FINOPB',     /FINO\s+PAYMENTS|\bFINO\b/i, 'payments'],
  ['JIOPB',      /JIO\s+PAYMENTS|\bJIOP\b/i, 'payments'],

  // ───────────── Foreign banks (retail) ────────────────────
  ['CITI',       /\bCITIBANK\b|\bCITI\s+BANK\b|\bCITI\b/i, 'foreign'],
  ['HSBC',       /\bHSBC\b/i, 'foreign'],
  ['SC',         /STANDARD\s+CHARTERED|\bSCBL\b/i, 'foreign'],
  ['DBS',        /\bDBS\s+BANK\b|\bDBSS\b/i, 'foreign'],
  ['DEUTSCHE',   /DEUTSCHE\s+BANK|\bDEUT\b/i, 'foreign'],
  ['BARCLAYS',   /\bBARCLAYS\b|\bBARC\b/i, 'foreign'],

  // ───────────── Major Co-operative Banks ──────────────────
  ['SARASWAT',   /SARASWAT\s+CO.?OPERATIVE|SARASWAT\s+BANK|\bSRCB\b/i, 'coop'],
  ['SVC',        /SVC\s+CO.?OPERATIVE|\bSVCB\b/i, 'coop'],
  ['TJSB',       /\bTJSB\b|THANE\s+JANATA\s+SAHAKARI/i, 'coop'],
  ['ABHYUDAYA',  /ABHYUDAYA\s+CO.?OPERATIVE/i, 'coop'],
  ['COSMOS',     /COSMOS\s+CO.?OPERATIVE|\bCOSB\b/i, 'coop'],
  ['NKGSB',      /NKGSB\s+CO.?OPERATIVE/i, 'coop'],
  ['APNA',       /APNA\s+SAHAKARI/i, 'coop'],
  ['JNATAS',     /JANATA\s+SAHAKARI/i, 'coop'],
  ['KALYAN',     /KALYAN\s+JANATA\s+SAHAKARI|\bKJSB\b/i, 'coop'],
  ['DOMBIVLI',   /DOMBIVLI\s+NAGARI\s+SAHAKARI/i, 'coop'],
  ['BHARATCOOP', /BHARAT\s+CO.?OPERATIVE/i, 'coop'],
  ['NUTAN',      /NUTAN\s+NAGARIK\s+SAHAKARI/i, 'coop'],
  ['SANGLI',     /SANGLI\s+URBAN\s+CO.?OPERATIVE/i, 'coop'],
  ['AHMEDABADMC',/AHMEDABAD\s+MERCANTILE\s+CO.?OPERATIVE/i, 'coop'],
  ['PUNEMSB',    /PUNE\s+CO.?OPERATIVE/i, 'coop'],
  ['VASAIVIKAS', /VASAI\s+VIKAS\s+SAHAKARI|\bVVSB\b/i, 'coop'],
  ['MEHSANA',    /MEHSANA\s+URBAN\s+CO.?OPERATIVE/i, 'coop'],
  ['SURATNGC',   /SURAT\s+NATIONAL\s+CO.?OPERATIVE/i, 'coop'],
  ['KARNATAKAGV',/KARNATAKA\s+GRAMIN/i, 'coop'],
  ['RAJASTHANMG',/RAJASTHAN\s+MARUDHARA\s+GRAMIN/i, 'coop'],
  ['NEBKGB',     /NAGALAND\s+GRAMEEN/i, 'coop'],
  ['PRATHAMA',   /PRATHAMA\s+(?:UP|BANK)/i, 'coop'],
  ['BARODAUP',   /BARODA\s+UP\s+GRAMIN/i, 'coop'],
  ['ANDHRAGV',   /ANDHRA\s+PRAGATHI\s+GRAMEENA/i, 'coop'],
  ['KARURVKB',   /KARUR\s+TOWN\s+CO.?OPERATIVE/i, 'coop'],
  ['SURYODAYACOOP',/SURYODAYA\s+CO.?OPERATIVE/i, 'coop'],
  ['SHAMRAO',    /SHAMRAO\s+VITHAL\s+CO.?OPERATIVE/i, 'coop'],
  ['GSB',        /\bGSB\s+SAHAKARI/i, 'coop'],
  // Catch-all generic co-op fallback — keep LAST so more specific match wins
  ['COOP',       /CO.?OPERATIVE\s+BANK|\bSAHAKARI\b|\bGRAMIN\b|\bGRAMEEN\b/i, 'coop'],
];

// For SMS sender codes (6-char alphanumeric), shortest-match first
const SENDER_MAP = {
  HDFCBK: 'HDFC', HDFCBN: 'HDFC', HDFC: 'HDFC',
  ICICIB: 'ICICI', ICICI: 'ICICI',
  SBIUPI: 'SBI', SBIPSG: 'SBI', SBIINB: 'SBI', SBI: 'SBI',
  AXISBK: 'AXIS', AXIS: 'AXIS',
  KOTAKB: 'KOTAK', KOTAK: 'KOTAK',
  INDBNK: 'INDUSIND', INDUSB: 'INDUSIND',
  YESBNK: 'YES',
  IDFCFB: 'IDFC',
  FEDBNK: 'FEDERAL',
  RBLBNK: 'RBL',
  IDBIBK: 'IDBI',
  PNBSMS: 'PNB', PNB: 'PNB',
  BOIIND: 'BOI', BOI: 'BOI',
  CANBNK: 'CANARA',
  UNIONB: 'UNION',
  CENTBK: 'CENTRAL',
  UCOBK:  'UCO',
  BOBSMS: 'BOB', BARODA: 'BOB',
  BOMBK:  'BOM',
  IOBMSG: 'IOB',
  AUBANK: 'AUSFB',
  EQSMBK: 'EQUITAS',
  UJVNSF: 'UJJIVAN',
  PAYTMB: 'PAYTMPB',
  AIRTEL: 'AIRTELPB',
  DBSSMS: 'DBS',
  CITIBK: 'CITI',
  HSBCIN: 'HSBC',
  SCBANK: 'SC',
  BANDHN: 'BANDHAN',
};

function detectBankCode(hay) {
  if (!hay) return null;
  for (const [code, re] of ALL_BANKS) {
    if (re.test(hay)) return code;
  }
  return null;
}

function detectBankFromSender(sender) {
  if (!sender) return null;
  // Strip common prefixes like "VM-", "AD-", "VK-"
  const s = String(sender).toUpperCase().replace(/^[A-Z]{2}-/, '');
  // Last 6 chars often
  const tail = s.slice(-6);
  if (SENDER_MAP[tail]) return SENDER_MAP[tail];
  if (SENDER_MAP[s]) return SENDER_MAP[s];
  // partial startswith
  for (const k of Object.keys(SENDER_MAP)) {
    if (s.includes(k)) return SENDER_MAP[k];
  }
  return null;
}

module.exports = { ALL_BANKS, SENDER_MAP, detectBankCode, detectBankFromSender };
