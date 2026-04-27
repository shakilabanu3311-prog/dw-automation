'use strict';
/**
 * B2C DW Sync — content script.
 *
 * Scrapes deposit/withdrawal request tables from gaming panels, keeps only
 * APPROVED rows (skips rejected/pending/cancelled), auto-refreshes on a
 * configurable interval, dedupes client-side so we don't spam the server, and
 * shows a floating badge with live status + errors.
 *
 * Self-adapting: works against any table with a date/name/amount/status column
 * layout. If the structure is unknown, the "Diagnose" popup button dumps the
 * table shape so we can tune it.
 */
(function () {
  const HOST = location.hostname;
  const POLL_MS = 15_000;                 // auto-refresh every 15s
  const BADGE_ID = 'b2c-badge';
  const DEBUG_KEY = 'b2cDebug';

  // ─── Per-site config ──────────────────────────────────────────────────
  const SITES = {
    'freeplay24':    { slug: 'freeplay24',    label: 'Freeplay24' },
    'testawl-admin': { slug: 'testawl-admin', label: 'Testawl Admin' },
    'testawl-main':  { slug: 'testawl-main',  label: 'Testawl' },
  };
  function getSite() {
    // Freeplay24 is handled by the Python Playwright scraper (scraper/),
    // because its jQuery DataTables can't be read from MV3's isolated world.
    // The extension intentionally does nothing on freeplay24.com.
    if (HOST.includes('freeplay24'))   return 'unknown';
    if (HOST.includes('admin.testawl'))return 'testawl-admin';
    if (HOST.includes('testawl247'))   return 'testawl-main';
    return 'unknown';
  }

  // ─── Status classification (APPROVED vs others) ───────────────────────
  // Fintech panels label these differently — cover the common variants.
  // Anything that isn't clearly approved is SKIPPED (we never enter rejected).
  // APPROVED only. "done/paid/credited/success/accept/confirm/settled/verified/approv"
  // must match — we do NOT auto-accept "ok" (too ambiguous).
  const APPROVED_RE = /\b(approv(?:ed|al)?|success(?:ful)?|complet(?:e|ed)|done|paid|credit(?:ed)?|settled|confirm(?:ed)?|accept(?:ed)?|verified)\b/i;
  const REJECT_RE   = /\b(reject|fail|cancel|pending|void|hold|declin|retry|review|unpaid|dispute|refund|new|open|process)\b/i;

  function classifyStatus(row) {
    // 1. Look at a dedicated status cell if headers identified one.
    // Status column is authoritative — if it says rejected/pending/cancelled
    // we never treat the row as approved even if other cells contain "approved" text.
    const statusText = (row._statusText || '').toString().toLowerCase().trim();
    if (statusText) {
      if (REJECT_RE.test(statusText)) return 'rejected';
      if (APPROVED_RE.test(statusText)) return 'approved';
      // Status column present but value is something else → "unknown",
      // never fall back to row-text scan for these rows.
      return 'unknown';
    }
    // 2. Fallback: any cell text.
    const all = (row._rowText || '').toString();
    if (REJECT_RE.test(all)) return 'rejected';
    if (APPROVED_RE.test(all)) return 'approved';
    // 3. Colour heuristic — green usually = approved, red = rejected.
    const colour = (row._colour || '').toLowerCase();
    if (/#00[89a-f]|green|success/.test(colour)) return 'approved';
    if (/#[d-f][0-9a-f]{2}|red|danger/.test(colour)) return 'rejected';
    return 'unknown';
  }

  // ─── Helpers ──────────────────────────────────────────────────────────
  function parseAmt(s) {
    if (s == null) return 0;
    const n = parseFloat(String(s).replace(/,/g, '').replace(/[^0-9.\-]/g, ''));
    return isNaN(n) ? 0 : n;
  }
  function cleanDate(s) {
    if (!s) return new Date().toISOString().slice(0, 10);
    const m = String(s).match(/(\d{2,4})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
    if (m) {
      const [, a, b, c] = m;
      if (a.length === 4) return `${a}-${String(b).padStart(2,'0')}-${String(c).padStart(2,'0')}`;
      if (c.length === 4) return `${c}-${String(b).padStart(2,'0')}-${String(a).padStart(2,'0')}`;
    }
    return String(s).trim().split(' ')[0];
  }
  function rowColour(tr) {
    try {
      const cs = getComputedStyle(tr);
      // status chip often has its own colour inside a <span>
      const chip = tr.querySelector('.badge, .label, .status, .chip, span[class*="success"], span[class*="approved"], span[class*="danger"]');
      if (chip) {
        const cs2 = getComputedStyle(chip);
        return (cs2.backgroundColor || '') + ' ' + (cs2.color || '') + ' ' + chip.className;
      }
      return (cs.backgroundColor || '') + ' ' + (cs.color || '') + ' ' + tr.className;
    } catch (_) { return ''; }
  }

  // ─── The actual scraper ───────────────────────────────────────────────
  function classifyTable(headers) {
    const idx = (re) => headers.findIndex(h => re.test(h));
    return {
      date:    idx(/^(date|datetime|created|time|txn.?date|request)/i),
      name:    idx(/^(name|user|member|client|username|player|account(?!.*no))/i),
      amount:  idx(/^(amount|amt|total|sum|value)$/i),
      deposit: idx(/^(deposit|credit|in)$/i),
      wd:      idx(/^(withdraw|withdrawal|debit|out)$/i),
      type:    idx(/^(type|txn.?type|kind)$/i),
      status:  idx(/^(status|state|approval|result)$/i),
      utr:     idx(/^(utr|ref|txn.?id|transaction|reference)/i),
      bank:    idx(/^(bank|upi|ifsc|method|channel)/i),
    };
  }

  // Collect candidate "tables" — either real <table> elements, or repeating
  // div-grids that look table-like (common in modern admin dashboards).
  function collectCandidates() {
    const tables = [...document.querySelectorAll('table')];
    // DIV-grid fallback: look for containers with many children that share
    // the same class and contain an amount-looking child.
    const gridSelectors = [
      '[role="table"]', '[role="grid"]',
      '.table', '.data-table', '.grid-table', '.list-table',
      '.ant-table', '.mat-table', '.MuiTable-root', '.rt-table',
      '.dataTables_wrapper', 'tbody',
    ];
    for (const sel of gridSelectors) {
      document.querySelectorAll(sel).forEach(el => {
        if (el.tagName === 'TABLE' || el.closest('table')) return;
        if (!tables.includes(el)) tables.push(el);
      });
    }
    return tables;
  }

  // Extract row-like children from either a <table> or a div-grid container.
  function rowsFrom(el) {
    if (el.tagName === 'TABLE') {
      const body = el.querySelector('tbody') || el;
      return [...body.querySelectorAll('tr')];
    }
    // Prefer explicit row roles
    let rs = [...el.querySelectorAll('[role="row"]')];
    if (rs.length >= 2) return rs;
    // Direct children with cells-like subchildren
    const kids = [...el.children];
    rs = kids.filter(c => c.children.length >= 3);
    return rs.length >= 2 ? rs : [];
  }
  function cellsFrom(row) {
    if (row.tagName === 'TR') return [...row.querySelectorAll('td,th')].map(c => (c.textContent||'').trim());
    const cs = [...row.querySelectorAll('[role="cell"],[role="gridcell"]')];
    if (cs.length) return cs.map(c => (c.textContent||'').trim());
    return [...row.children].map(c => (c.textContent||'').trim());
  }
  function headersFrom(el) {
    if (el.tagName === 'TABLE') {
      const ths = [...el.querySelectorAll('thead th, thead td')];
      if (ths.length) return ths.map(h => (h.textContent||'').trim());
      const tr = el.querySelector('tr');
      return tr ? [...tr.children].map(c => (c.textContent||'').trim()) : [];
    }
    const hdrRow = el.querySelector('[role="row"]') ||
                   el.querySelector('.thead, .table-header, .header-row');
    if (hdrRow) return [...hdrRow.children].map(c => (c.textContent||'').trim());
    // fallback: first row's cells
    const first = el.children[0];
    return first ? [...first.children].map(c => (c.textContent||'').trim()) : [];
  }

  // Detect the master/account label. Strategy hierarchy (most reliable first):
  //  1. The MASTER column of the data table — every row carries the master,
  //     so the most-frequent value there is definitive (won't be confused
  //     with stray "ROUND01" / status badges / version strings).
  //  2. The sidebar / topbar — works on the dashboard before any data loads.
  //  3. Whole-body text fallback as last resort.
  function detectMaster(tableData) {
    // 1) Most-common value of a "master" column across visible rows.
    if (tableData && tableData.length) {
      for (const t of tableData) {
        const idx = t.headers.findIndex(h => /^master\b/i.test(h));
        if (idx < 0) continue;
        const counts = {};
        for (const row of t.rows) {
          const v = (row[idx] || '').trim();
          if (!v || !/^[A-Z][A-Z0-9_-]{2,}/i.test(v)) continue;
          const k = v.toUpperCase();
          counts[k] = (counts[k] || 0) + 1;
        }
        const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
        if (sorted.length) return sorted[0][0];
      }
    }
    // 2) Sidebar / topbar.
    const candidates = [];
    document.querySelectorAll('aside, .sidebar, .side-bar, .navbar, .topbar, .user-info, h1, h2, h3, h4').forEach(el => {
      const txt = (el.textContent || '').trim();
      if (txt && txt.length < 60) candidates.push(txt);
    });
    for (const t of candidates) {
      const m = t.match(/\b([A-Z]{2,}\d{2,6})\b/);
      if (m) return m[1].toUpperCase();
    }
    // 3) Whole-body fallback.
    const all = (document.body && document.body.innerText) ? document.body.innerText.slice(0, 4000) : '';
    const m = all.match(/\b([A-Z]{2,}\d{2,6})\b/);
    return m ? m[1].toUpperCase() : '';
  }

  // ─── Pagination: pull ALL rows including hidden pages ─────────────────
  // Strategy hierarchy:
  //  1. If jQuery DataTables is loaded (Freeplay24 uses it), read its
  //     internal data via the public API — gets every row across all pages
  //     without disturbing the user's view.
  //  2. Otherwise try to set the page-length dropdown to its maximum value
  //     and let the next poll cycle pick up the now-larger visible set.
  //  3. Fall back to whatever's currently visible.
  function readDataTablesAllRows() {
    const out = [];
    try {
      const $ = window.jQuery || window.$;
      if (!$ || !$.fn || !$.fn.DataTable) return out;
      const tables = $.fn.dataTable && $.fn.dataTable.tables ? $.fn.dataTable.tables({ visible: true, api: true }) : null;
      const apis = tables ? tables : $('table').filter((_, t) => $.fn.DataTable.isDataTable(t)).map((_, t) => $(t).DataTable()).get();
      const list = (tables && tables.tables) ? tables.tables(true).toArray ? tables.tables(true).toArray() : [tables] : apis;
      for (const api of list) {
        try {
          const headers = [];
          api.columns().every(function () {
            const th = this.header();
            headers.push((th && th.textContent || '').trim());
          });
          const rows = [];
          api.rows({ search: 'applied' }).data().each(function (rowData) {
            // rowData might be array (DOM-sourced) or object (AJAX-sourced)
            if (Array.isArray(rowData)) {
              rows.push(rowData.map(c => stripHtml(String(c || '')).trim()));
            } else if (rowData && typeof rowData === 'object') {
              rows.push(headers.map((_, i) => stripHtml(String(rowData[i] != null ? rowData[i] : '')).trim()));
            }
          });
          if (rows.length) out.push({ headers, rows });
        } catch (_) {}
      }
    } catch (_) {}
    return out;
  }

  function stripHtml(s) {
    if (!/<[^>]+>/.test(s)) return s;
    const d = document.createElement('div');
    d.innerHTML = s;
    return (d.textContent || d.innerText || '').trim();
  }

  // Try once, on each scrape, to bump the DataTables page-length to the max
  // so even if the API path fails, the next visible-scrape sees more rows.
  let _bumpedLength = false;
  function bumpDataTablesLength() {
    if (_bumpedLength) return;
    try {
      const sel = document.querySelector('select[name$="_length"], select.length-dropdown, .dataTables_length select');
      if (!sel) return;
      const opts = [...sel.options].map(o => parseInt(o.value, 10)).filter(n => !isNaN(n));
      if (!opts.length) return;
      const max = Math.max(...opts);
      if (max && Number(sel.value) !== max) {
        sel.value = String(max);
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        _bumpedLength = true;
      }
    } catch (_) {}
  }

  // Combine separate Date + Time columns into a single ISO timestamp when
  // both exist. Some panels split them.
  function rowTimestamp(cells, headers, ci) {
    const datePart = ci.date >= 0 ? cells[ci.date] : '';
    let timePart = '';
    const tIdx = headers.findIndex(h => /^(time|hour)$/i.test(h));
    if (tIdx >= 0) timePart = cells[tIdx] || '';
    const isoDate = cleanDate(datePart);
    if (timePart && /\d{1,2}:\d{2}/.test(timePart)) {
      const m = timePart.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM|am|pm)?/);
      if (m) {
        let h = parseInt(m[1], 10);
        const mn = m[2], s = m[3] || '00';
        if ((m[4] || '').toLowerCase() === 'pm' && h < 12) h += 12;
        if ((m[4] || '').toLowerCase() === 'am' && h === 12) h = 0;
        return `${isoDate}T${String(h).padStart(2,'0')}:${mn}:${s}+05:30`;
      }
    }
    return `${isoDate}T12:00:00+05:30`;
  }

  // Build a normalized list of {headers, rows[]} tables — preferring the
  // DataTables API (all-pages) if available, falling back to a DOM walk.
  function gatherTables() {
    const dt = readDataTablesAllRows();
    if (dt.length) return dt;
    // DOM walk fallback
    const tables = [];
    collectCandidates().forEach(el => {
      const headers = headersFrom(el);
      if (!headers.length) return;
      const rs = rowsFrom(el).map(tr => cellsFrom(tr));
      // Drop the header row if it slipped in (first row equals headers)
      const dataRows = rs.filter(cells =>
        !(cells.length === headers.length && cells.every((c, i) => c === headers[i])));
      tables.push({ headers, rows: dataRows, _el: el });
    });
    return tables;
  }

  function scrapeAll() {
    bumpDataTablesLength(); // try to expand the visible page (best-effort)
    const site = getSite();
    const tables = gatherTables();
    const master = detectMaster(tables);
    const out = {
      site, master, deposits: [], withdrawals: [],
      url: location.href, ts: new Date().toISOString(),
      skippedRejected: 0, skippedUnknown: 0, totalRowsSeen: 0,
      tablesScanned: 0,
    };

    tables.forEach(table => {
      const headers = table.headers;
      if (!headers.length) return;

      const ci = classifyTable(headers.map(h => h.toLowerCase()));
      // Accept the table even if the amount column isn't obvious — we'll try
      // to find a numeric cell per row. But require SOME headers to look
      // transactional (date/name/status/amount).
      const looksTxn = ci.deposit >= 0 || ci.wd >= 0 || ci.amount >= 0 ||
                       (ci.date >= 0 && (ci.name >= 0 || ci.status >= 0));
      if (!looksTxn) return;
      out.tablesScanned++;

      table.rows.forEach((cells) => {
        if (!cells || cells.length < 2) return;
        out.totalRowsSeen++;

        const rowMeta = {
          _rowText: cells.join(' | '),
          _statusText: ci.status >= 0 ? cells[ci.status] : '',
          _colour: '', // colour heuristic only available in DOM mode; status text is enough for Freeplay
        };
        const status = classifyStatus(rowMeta);
        if (status === 'rejected') { out.skippedRejected++; return; }
        if (status === 'unknown')  { out.skippedUnknown++;  return; }

        // UTR fallback: scan every cell for a 10–22 digit/alnum string that
        // looks like a UTR/ref id when the column-index detection missed it.
        let utrVal = ci.utr >= 0 ? (cells[ci.utr] || '') : '';
        if (!utrVal) {
          for (const cell of cells) {
            const m = String(cell || '').match(/\b([A-Z0-9]{10,22})\b/);
            if (m && /\d/.test(m[1])) { utrVal = m[1]; break; }
          }
        }
        const ts = rowTimestamp(cells, headers, ci);
        const entry = {
          date: cleanDate(ci.date >= 0 ? cells[ci.date] : cells[0]),
          ts,
          name: ci.name >= 0 ? cells[ci.name] : '',
          utr:  utrVal,
          bank: ci.bank >= 0 ? cells[ci.bank] : '',
        };
        const dep = ci.deposit >= 0 ? parseAmt(cells[ci.deposit]) : 0;
        const wd  = ci.wd      >= 0 ? parseAmt(cells[ci.wd])      : 0;
        let gen = ci.amount  >= 0 ? parseAmt(cells[ci.amount])  : 0;
        // Fallback: pick the largest plausible numeric cell
        if (!dep && !wd && !gen) {
          const nums = cells.map(parseAmt).filter(n => n > 0);
          if (nums.length) gen = Math.max(...nums);
        }
        const typeStr = (ci.type >= 0 ? cells[ci.type] : '').toLowerCase();

        if (dep > 0) out.deposits.push({ ...entry, amount: dep });
        else if (wd > 0) out.withdrawals.push({ ...entry, amount: wd });
        else if (gen > 0) {
          if (/deposit|credit|\bin\b/.test(typeStr)) out.deposits.push({ ...entry, amount: gen });
          else if (/withdraw|debit|\bout\b/.test(typeStr)) out.withdrawals.push({ ...entry, amount: gen });
          // URL-based fallback — panels often use separate pages for dep/wd
          else if (/deposit|credit/i.test(location.pathname)) out.deposits.push({ ...entry, amount: gen });
          else if (/withdraw|debit|wd/i.test(location.pathname)) out.withdrawals.push({ ...entry, amount: gen });
        }
      });
    });

    return out;
  }

  // ─── Badge (floating status box) ──────────────────────────────────────
  function badge(text, kind) {
    let b = document.getElementById(BADGE_ID);
    if (!b) {
      b = document.createElement('div');
      b.id = BADGE_ID;
      b.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:2147483647;font:12px/1.3 monospace;padding:8px 14px;border-radius:7px;cursor:pointer;max-width:360px;box-shadow:0 2px 10px rgba(0,0,0,0.4);transition:opacity .25s;';
      b.onclick = () => (b.style.opacity = '0');
      document.body.appendChild(b);
    }
    const colours = {
      ok:   ['#060d1a', '#00d4ff'],
      warn: ['#221700', '#ffb13b'],
      err:  ['#220a0a', '#ff5569'],
    }[kind || 'ok'];
    b.style.background = colours[0];
    b.style.border = '1px solid ' + colours[1];
    b.style.color = colours[1];
    b.style.opacity = '1';
    b.textContent = text;
    clearTimeout(b._to);
    b._to = setTimeout(() => (b.style.opacity = '0.25'), 8000);
  }

  // ─── Client-side dedupe so we don't re-send the same rows every 30s ──
  const lastSentKeys = new Set();
  function dedupe(rows, kind) {
    return rows.filter(r => {
      const key = `${kind}|${r.utr || ''}|${r.date || ''}|${r.amount}|${(r.name || '').trim()}`;
      if (lastSentKeys.has(key)) return false;
      lastSentKeys.add(key);
      return true;
    });
  }

  // ─── Send to background (which posts to the server) ──────────────────
  function send(data, { silent } = {}) {
    try {
      chrome.runtime.sendMessage({ type: 'PANEL_DATA', payload: data }, (res) => {
        if (chrome.runtime.lastError) {
          badge('B2C: ' + chrome.runtime.lastError.message, 'err');
          return;
        }
        if (!res) { if (!silent) badge('B2C: no response from background', 'warn'); return; }
        if (res.ok) {
          const target = res.panel_slug ? ` → ${res.panel_slug}` : '';
          const unmapped = res.mapped === false ? ' ⚠ unmapped' : '';
          const text = `✓ ${data.site}${data.master ? '/' + data.master : ''}${target}${unmapped}: +${res.inserted || 0} new · skipped ${res.skipped || 0}` +
                       (data.skippedRejected ? ` · ${data.skippedRejected} rejected` : '');
          badge(text, res.mapped === false ? 'warn' : 'ok');
        } else badge('B2C: ' + (res.error || 'error'), 'err');
      });
    } catch (e) {
      badge('B2C crash: ' + e.message, 'err');
    }
  }

  // ─── Auto-refresh loop ───────────────────────────────────────────────
  let polling = false;
  async function runOnce({ silent } = {}) {
    try {
      const all = scrapeAll();
      // Apply client-side dedupe so /sync calls only carry new rows.
      const payload = {
        ...all,
        deposits: dedupe(all.deposits, 'd'),
        withdrawals: dedupe(all.withdrawals, 'w'),
      };
      if (payload.deposits.length || payload.withdrawals.length) {
        send(payload, { silent });
      } else if (!silent) {
        if (all.totalRowsSeen === 0) badge(`B2C: no txn table visible on this page`, 'warn');
        else if (all.skippedRejected + all.skippedUnknown === all.totalRowsSeen)
          badge(`B2C: ${all.totalRowsSeen} rows, 0 approved (skipped ${all.skippedRejected} rejected, ${all.skippedUnknown} unclear)`, 'warn');
        else badge(`B2C: no new rows since last sync`, 'ok');
      }
    } catch (e) {
      badge('B2C scrape error: ' + e.message, 'err');
      console.error('[B2C]', e);
    }
  }
  // Wait until at least one txn-looking table has data rows. DataTables-style
  // panels (like Freeplay24) load via AJAX after the page renders, so an early
  // scrape sees only "No Data Available In Table". Retry every 800ms up to 12s.
  function waitForData(maxWaitMs = 12000, intervalMs = 800) {
    return new Promise((resolve) => {
      const start = Date.now();
      const tick = () => {
        const cands = collectCandidates();
        for (const t of cands) {
          const headers = headersFrom(t);
          if (!headers.length) continue;
          const ci = classifyTable(headers.map(h => h.toLowerCase()));
          if (ci.amount < 0 && ci.deposit < 0 && ci.wd < 0) continue;
          const rs = rowsFrom(t);
          // skip header-only and "no data" placeholder rows
          const dataRows = rs.filter(r => {
            const txt = (r.textContent || '').toLowerCase();
            return r !== rs[0] && !/no data|no record|no entries/i.test(txt) && txt.trim().length > 5;
          });
          if (dataRows.length) return resolve(true);
        }
        if (Date.now() - start >= maxWaitMs) return resolve(false);
        setTimeout(tick, intervalMs);
      };
      tick();
    });
  }

  function startPolling() {
    if (polling) return;
    polling = true;
    // Verify config before polling. If server URL or token are missing, surface
    // a loud red badge so the user fixes it instead of seeing silent failures.
    chrome.runtime.sendMessage({ type: 'GET_CFG' }, async (r) => {
      const cfg = (r && r.cfg) || {};
      if (!cfg.serverUrl || !cfg.token) {
        badge('B2C: Not configured. Click extension icon → Settings → set Server URL + Token.', 'err');
        return;
      }
      badge(`B2C: waiting for table data…`, 'warn');
      const had = await waitForData();
      if (!had) badge(`B2C: no data on this page (yet). Open Deposits/Withdrawals history.`, 'warn');
      else badge(`B2C: auto-sync ON · approved-only · every ${POLL_MS/1000}s`, 'ok');
      runOnce({ silent: true });
      setInterval(() => runOnce({ silent: true }), POLL_MS);
    });
  }

  // ─── Diagnose: dump table shapes to console (popup can show this) ────
  function diagnose() {
    const cands = collectCandidates();
    const report = cands.map((t, i) => {
      const headers = headersFrom(t);
      const rs = rowsFrom(t);
      const first = rs.length ? cellsFrom(rs[0]).map(c => c.slice(0, 30)) : [];
      return {
        idx: i,
        tag: t.tagName + (t.className ? '.' + String(t.className).split(' ').slice(0, 2).join('.') : ''),
        headers: headers.slice(0, 12),
        rows: rs.length,
        sampleFirstRow: first.slice(0, 12),
      };
    });
    // Also dump URL/title so user can paste back which page they're on
    const meta = { url: location.href, title: document.title, site: getSite() };
    console.log('[B2C] diagnose meta', meta);
    console.log('[B2C] diagnose tables', report);
    badge(`B2C diagnose: ${report.length} candidate(s), see console`, 'warn');
    return report;
  }

  // ─── Message handlers (popup / background) ──────────────────────────
  chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
    if (msg.type === 'SCRAPE_NOW')  { runOnce({ silent: false });   sendResponse({ ok: true }); }
    if (msg.type === 'DIAGNOSE')    { sendResponse({ ok: true, report: diagnose() }); }
    if (msg.type === 'PING')        { sendResponse({ ok: true, site: getSite(), url: location.href }); }
    return true;
  });

  // ─── Boot ────────────────────────────────────────────────────────────
  const isLogin = /login|signin|auth/i.test(location.pathname);
  if (!isLogin && getSite() !== 'unknown') {
    if (document.readyState === 'complete') setTimeout(startPolling, 1500);
    else window.addEventListener('load', () => setTimeout(startPolling, 1500));

    // SPA navigation handler
    let lastUrl = location.href;
    new MutationObserver(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        lastSentKeys.clear();
        setTimeout(() => runOnce({ silent: true }), 2000);
      }
    }).observe(document.documentElement, { subtree: true, childList: true });
  }
})();
