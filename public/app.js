'use strict';
(function () {
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
  const fmt = (n) => (Math.round((Number(n) || 0) * 100) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  let ME = null;
  let BD = null;

  function toast(msg, isErr) {
    const t = $('#toast');
    t.textContent = msg;
    t.style.borderColor = isErr ? 'var(--err)' : 'var(--accent)';
    t.style.display = 'block';
    clearTimeout(window._tt);
    window._tt = setTimeout(() => { t.style.display = 'none'; }, 3000);
  }

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      method: opts.method || 'GET',
      headers: opts.body ? { 'Content-Type': 'application/json' } : {},
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      credentials: 'include',
    });
    let data = null;
    try { data = await res.json(); } catch (e) {}
    if (!res.ok) throw new Error((data && data.error) || ('HTTP ' + res.status));
    return data;
  }

  async function apiUpload(path, file) {
    const fd = new FormData();
    fd.append('file', file);
    const res = await fetch(path, { method: 'POST', body: fd, credentials: 'include' });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error((data && data.error) || ('HTTP ' + res.status));
    return data;
  }

  // ── Auth ────────────────────────────────────────────────────
  async function checkAuth() {
    try {
      const r = await api('/api/auth/me');
      ME = r.user;
      showApp();
    } catch (e) {
      showLogin();
    }
  }

  function showLogin() {
    $('#loginScreen').classList.add('show');
    $('#appScreen').classList.remove('show');
    setTimeout(() => $('#li-user').focus(), 100);
  }

  function showApp() {
    $('#loginScreen').classList.remove('show');
    $('#appScreen').classList.add('show');
    $('#whoami').textContent = `${ME.username} · ${ME.role}`;
    if (ME.role !== 'admin') $('#userAdminCard').style.display = 'none';
    applyRoleGating();
    initApp();
  }

  // Hide tabs the user's role doesn't have. admin/manager see everything.
  function applyRoleGating() {
    const caps = (ME && ME.caps) || {};
    const isFull = caps.all;
    // tab-name -> required capability key
    const GATES = {
      hisab:     isFull,
      dw:        isFull || caps.dw,
      gpay:      isFull,
      banks:     isFull,
      banktxn:   isFull,
      uploads:   isFull,
      panels:    isFull,
      sheet:     isFull,
      live:      isFull || caps.dw || caps.freeplay, // live view for anyone who has any data
      freeplay:  isFull || caps.freeplay || caps.deposit || caps.withdrawal,
      expenses:  isFull,
      reconcile: isFull,
      admin:     isFull,
    };
    document.querySelectorAll('nav button[data-tab]').forEach(btn => {
      const t = btn.dataset.tab;
      if (!GATES[t]) btn.style.display = 'none';
    });
    // For deposit-only / withdrawal-only operators, auto-filter Freeplay view
    if (!isFull && caps.deposit && !caps.withdrawal) document.body.dataset.fpOnly = 'dep';
    if (!isFull && caps.withdrawal && !caps.deposit) document.body.dataset.fpOnly = 'wdl';
    // Jump to first visible tab
    const firstVisible = [...document.querySelectorAll('nav button[data-tab]')].find(b => b.style.display !== 'none');
    if (firstVisible && !isFull) firstVisible.click();
  }

  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#loginErr').textContent = '';
    try {
      const r = await api('/api/auth/login', { method: 'POST', body: {
        username: $('#li-user').value.trim(),
        password: $('#li-pass').value,
        remember: $('#li-remember').checked,
      } });
      ME = r.user;
      showApp();
    } catch (err) {
      $('#loginErr').textContent = err.message;
    }
  });

  $('#btnLogout').addEventListener('click', async () => {
    await api('/api/auth/logout', { method: 'POST' });
    ME = null;
    location.reload();
  });

  $('#btnChangePw').addEventListener('click', () => {
    const cur = prompt('Current password:');
    if (!cur) return;
    const nx = prompt('New password (min 6):');
    if (!nx) return;
    api('/api/auth/change-password', { method: 'POST', body: { current: cur, next: nx } })
      .then(() => { toast('Password changed. Please log in again.'); setTimeout(() => location.reload(), 1200); })
      .catch(e => toast(e.message, true));
  });

  // ── Tabs ────────────────────────────────────────────────────
  $$('#tabnav button').forEach(b => {
    b.addEventListener('click', () => {
      $$('#tabnav button').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      const t = b.dataset.tab;
      $$('.tabpanel').forEach(p => p.classList.remove('active'));
      $('#tab-' + t).classList.add('active');
      onTabChange(t);
    });
  });

  function onTabChange(t) {
    if (t === 'hisab') loadHisab();
    if (t === 'dw') loadDw();
    if (t === 'gpay') loadGpay();
    if (t === 'banks') loadBanks();
    if (t === 'banktxn') loadBankTxns();
    if (t === 'panels') { loadPanels(); loadPanelStatus(); }
    if (t === 'sheet') initSheetTab();
    if (t === 'live') initLiveTab();
    if (t === 'freeplay') initFreeplayTab();
    if (t === 'expenses') initExpensesTab();
    if (t === 'reconcile') initReconcileTab();
    if (t === 'admin') { loadUsers(); loadTokens(); }
  }

  // ── Live Sheet tab (Google-Sheets-like grid) ────────────────
  let liveTimer = null;
  function initLiveTab() {
    $('#live-date').value = BD;
    // Show admin-only controls
    if (ME && ME.role === 'admin') $('#adminControls').style.display = 'block';
    // Date nav wiring (idempotent)
    ['liveDatePrev','liveDateNext','liveDateToday','liveDateHist'].forEach(id => {
      const el = $('#' + id); if (!el || el._wired) return; el._wired = true;
    });
    // Load history options
    api('/api/sheet/dates').then(r => {
      const h = $('#liveDateHist');
      if (!h) return;
      h.innerHTML = '<option value="">— history —</option>' +
        (r.rows || []).map(x => `<option value="${x.business_date}">${x.business_date} · ${x.entries} rows</option>`).join('');
    }).catch(()=>{});
    // Rollover banner tick
    tickRolloverBanner();
    if (!window._rolloverTick) {
      window._rolloverTick = setInterval(tickRolloverBanner, 1000);
    }
    // Wire view-switcher
    const viewSel = $('#liveView');
    if (viewSel && !viewSel._wired) {
      viewSel._wired = true;
      viewSel.addEventListener('change', applyLiveView);
    }
    applyLiveView();
    if (liveTimer) clearInterval(liveTimer);
    liveTimer = setInterval(() => {
      if (!$('#tab-live').classList.contains('active')) return;
      if ($('#liveView').value === 'local' && $('#liveAuto').checked) renderLiveGrid(true);
    }, 10000);
  }
  // Rollover banner: shows countdown to next 05:30 IST + last-rollover info.
  let rolloverCache = null;
  async function tickRolloverBanner() {
    try {
      // Only refetch every ~10s; between ticks, recompute countdown locally.
      if (!rolloverCache || Date.now() - rolloverCache._at > 10_000) {
        const r = await api('/api/sheet/rollover/status');
        rolloverCache = { ...r, _at: Date.now(), _serverMs: r.next_ms, _serverLocalAt: Date.now() };
      }
      if (!rolloverCache) return;
      const elapsed = Date.now() - rolloverCache._serverLocalAt;
      const remaining = Math.max(0, rolloverCache._serverMs - elapsed);
      const h = Math.floor(remaining / 3_600_000);
      const m = Math.floor((remaining % 3_600_000) / 60_000);
      const s = Math.floor((remaining % 60_000) / 1000);
      if ($('#bdNow')) $('#bdNow').textContent = rolloverCache.current_business_date;
      if ($('#bdCountdown')) $('#bdCountdown').textContent = `${h}h ${m}m ${s}s`;
      if ($('#bdNext')) $('#bdNext').textContent = rolloverCache.next_business_date;
      if ($('#bdLast') && rolloverCache.last_rollover_ts) {
        $('#bdLast').textContent = 'Last rollover: ' + new Date(rolloverCache.last_rollover_ts).toLocaleString();
      }
      // Auto-jump to new date if system rolled over while the user was on the page
      if (rolloverCache.current_business_date !== BD && $('#tab-live').classList.contains('active')) {
        BD = rolloverCache.current_business_date;
        $('#live-date').value = BD;
        if ($('#liveView').value === 'local') renderLiveGrid(true);
        toast('New business date: ' + BD);
      }
    } catch (_) {}
  }

  async function applyLiveView() {
    const v = $('#liveView').value;
    if (v === 'google') {
      try {
        const s = await api('/api/sheet/google/status');
        if (!s.configured || !s.sheet_id) {
          $('#liveGrid').style.display = 'none';
          $('#liveIframe').style.display = 'none';
          $('#liveStatus').innerHTML = '<span class="pill err">Google Sheet not configured — set GOOGLE_SHEET_ID env var, then refresh</span>';
          return;
        }
        const url = `https://docs.google.com/spreadsheets/d/${s.sheet_id}/edit?rm=embedded` + (s.tab ? `&gid=0` : '');
        $('#liveIframe').src = url;
        $('#liveIframe').style.display = 'block';
        $('#liveGrid').style.display = 'none';
        $('#liveOpenGS').href = `https://docs.google.com/spreadsheets/d/${s.sheet_id}`;
        $('#liveOpenGS').style.display = 'inline-block';
        $('#liveStatus').textContent = 'Live Google Sheet — scroll inside the embed';
      } catch (e) { $('#liveStatus').textContent = 'Error: ' + e.message; }
    } else {
      $('#liveIframe').style.display = 'none';
      $('#liveOpenGS').style.display = 'none';
      $('#liveGrid').style.display = 'block';
      renderLiveGrid();
    }
  }
  async function renderLiveGrid(silent) {
    // Make sure we're in the local-grid view
    const view = $('#liveView') && $('#liveView').value;
    if (view === 'google') return;
    $('#liveGrid').style.display = 'block';
    $('#liveIframe').style.display = 'none';
    const d = $('#live-date').value || BD;
    if (!silent) $('#liveStatus').textContent = 'Loading…';
    // ── New: render the actual xlsx template as styled HTML (ditto layout)
    try {
      const branch = ($('#liveBranch') && $('#liveBranch').value) || 'MAIN';
      const r = await api('/api/sheet/html?date=' + encodeURIComponent(d) + '&branch=' + encodeURIComponent(branch));
      $('#liveGrid').innerHTML = '<div class="sheet-html-wrap">' + r.html + '</div>';
      $('#liveStatus').textContent = 'Last updated ' + new Date().toLocaleTimeString() + ' · click any cell to edit';
      // Wire contenteditable blur → POST manual override
      $$('#liveGrid td[contenteditable]').forEach(td => {
        const orig = td.textContent;
        td._orig = orig;
        td.addEventListener('blur', async () => {
          const newVal = td.textContent.trim();
          if (newVal === td._orig) return;
          const r2 = +td.dataset.r, c2 = +td.dataset.c;
          try {
            await api('/api/sheet/cell', { method: 'POST', body: { date: d, row: r2, col: c2, value: newVal } });
            td._orig = newVal;
            td.style.outline = '2px solid #29d08c';
            setTimeout(() => { td.style.outline = ''; }, 800);
          } catch (e) { toast('Save failed: ' + e.message, true); td.textContent = orig; }
        });
        td.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); td.blur(); }
          if (e.key === 'Escape') { td.textContent = td._orig; td.blur(); }
        });
      });
      return;
    } catch (e) {
      console.warn('html render failed, falling back:', e.message);
    }
    // Fallback: legacy 2D grid renderer
    try {
      const branch2 = ($('#liveBranch') && $('#liveBranch').value) || 'MAIN';
      const r = await api('/api/sheet/grid?date=' + encodeURIComponent(d) + '&branch=' + encodeURIComponent(branch2));
      const g = r.grid || [];
      const colors = r.colors || [];
      const fontColors = r.fontColors || [];
      const fontBold = r.fontBold || [];
      const merges = r.merges || [];
      const colWidths = r.colWidths || [];
      const COL_LETTERS = (n) => { let s=''; while (n>=0){ s=String.fromCharCode(65+(n%26))+s; n=Math.floor(n/26)-1; } return s; };
      // Find last non-empty row and column to trim display, but extend
      // through any styled (colored) area so the template look-and-feel
      // is preserved even where data is missing.
      let lastR = 0, lastC = 0;
      g.forEach((row, ri) => row.forEach((v, ci) => { if (v !== '' && v != null) { if (ri > lastR) lastR = ri; if (ci > lastC) lastC = ci; } }));
      colors.forEach((row, ri) => row.forEach((c, ci) => { if (c) { if (ri > lastR) lastR = ri; if (ci > lastC) lastC = ci; } }));
      // Use full template extent (already trimmed server-side)
      lastR = Math.max(lastR, (r.rows || 0) - 1);
      lastC = Math.max(lastC, (r.cols || 0) - 1);
      // Merge map: any cell hidden by a merge anchor gets skipped
      const skip = new Set();
      const span = {}; // 'r,c' -> {rs, cs}
      merges.forEach(m => {
        span[`${m.r1},${m.c1}`] = { rs: m.r2 - m.r1 + 1, cs: m.c2 - m.c1 + 1 };
        for (let rr = m.r1; rr <= m.r2; rr++) for (let cc = m.c1; cc <= m.c2; cc++) {
          if (rr === m.r1 && cc === m.c1) continue;
          skip.add(`${rr},${cc}`);
        }
      });
      let html = '<table class="live"><colgroup><col style="width:38px"/>';
      for (let c = 0; c <= lastC; c++) {
        const w = colWidths[c] || 90;
        html += `<col style="width:${Math.max(40, Math.min(220, w))}px"/>`;
      }
      html += '</colgroup><thead><tr><th class="rowh"></th>';
      for (let c = 0; c <= lastC; c++) html += `<th>${COL_LETTERS(c)}</th>`;
      html += '</tr></thead><tbody>';
      for (let ri = 0; ri <= lastR; ri++) {
        html += `<tr><th class="rowh">${ri+1}</th>`;
        for (let c = 0; c <= lastC; c++) {
          if (skip.has(`${ri},${c}`)) continue;
          const v = g[ri] ? g[ri][c] : '';
          const bg = (colors[ri] && colors[ri][c]) || '';
          const fc = (fontColors[ri] && fontColors[ri][c]) || '';
          const cls = (typeof v === 'number') ? 'num' : '';
          const disp = (typeof v === 'number') ? v.toLocaleString('en-IN') : (v == null ? '' : String(v));
          const sp = span[`${ri},${c}`];
          const attrs = [];
          if (sp && sp.rs > 1) attrs.push(`rowspan="${sp.rs}"`);
          if (sp && sp.cs > 1) attrs.push(`colspan="${sp.cs}"`);
          const styles = [];
          if (bg) styles.push(`background:${bg}`);
          if (fc) styles.push(`color:${fc}`);
          // Auto-pick black/white text for readability against bg
          if (bg && !fc) {
            const hex = bg.slice(1);
            const r2 = parseInt(hex.slice(0,2),16), gg = parseInt(hex.slice(2,4),16), bb = parseInt(hex.slice(4,6),16);
            const lum = (0.299*r2 + 0.587*gg + 0.114*bb);
            styles.push(`color:${lum > 140 ? '#000' : '#fff'}`);
          }
          if (fontBold[ri] && fontBold[ri][c]) styles.push('font-weight:600');
          const styleAttr = styles.length ? ` style="${styles.join(';')}"` : '';
          // Editable cells: mark with data-r/data-c so we can persist edits
          const editAttr = ` contenteditable="true" data-r="${ri}" data-c="${c}"`;
          html += `<td class="${cls}"${attrs.length?' '+attrs.join(' '):''}${styleAttr}${editAttr}>${esc(disp)}</td>`;
        }
        html += '</tr>';
      }
      html += '</tbody></table>';
      $('#liveGrid').innerHTML = html;
      $('#liveStatus').textContent = 'Last updated ' + new Date().toLocaleTimeString() + ' · click any cell to edit';
      // Wire contenteditable blur → POST manual override
      $$('#liveGrid td[contenteditable]').forEach(td => {
        const orig = td.textContent;
        td._orig = orig;
        td.addEventListener('blur', async () => {
          const newVal = td.textContent.trim();
          if (newVal === td._orig) return;
          const r2 = +td.dataset.r, c2 = +td.dataset.c;
          try {
            await api('/api/sheet/cell', { method: 'POST', body: { date: d, row: r2, col: c2, value: newVal } });
            td._orig = newVal;
            td.style.outline = '2px solid #29d08c';
            setTimeout(() => { td.style.outline = ''; }, 800);
          } catch (e) { toast('Save failed: ' + e.message, true); td.textContent = orig; }
        });
        td.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); td.blur(); }
          if (e.key === 'Escape') { td.textContent = td._orig; td.blur(); }
        });
      });
    } catch (e) { $('#liveStatus').textContent = 'Error: ' + e.message; }
  }

  // ── Freeplay D/W tab ────────────────────────────────────────
  let fpTimer = null;
  function initFreeplayTab() {
    $('#fp-date').value = BD;
    loadFreeplay();
    if (fpTimer) clearInterval(fpTimer);
    fpTimer = setInterval(() => { if ($('#tab-freeplay').classList.contains('active')) loadFreeplay(); }, 15000);
  }
  async function loadFreeplay() {
    const d = $('#fp-date').value || BD;
    try {
      const r = await api(`/api/dw?business_date=${encodeURIComponent(d)}`);
      const all = r.rows || [];
      // Match Freeplay rows broadly: (a) panel_slug contains 'freeplay',
      // (b) source='extension' (any extension-fed row goes here unless we
      // explicitly route it elsewhere), or (c) remark mentions freeplay.
      const isFp = x => {
        const s = (x.panel_slug || '').toLowerCase();
        if (s.includes('freeplay')) return true;
        if (x.source === 'extension') return true;
        if (((x.remark || '') + (x.name || '')).toLowerCase().includes('freeplay')) return true;
        return false;
      };
      const deps = all.filter(x => isFp(x) && x.type === 'Deposit');
      const wdls = all.filter(x => isFp(x) && x.type === 'Withdrawal');
      const sum = arr => arr.reduce((a, b) => a + (Number(b.amt) || 0), 0);
      $('#fpDepTotal').textContent = `· ${deps.length} · ₹${sum(deps).toLocaleString('en-IN')}`;
      $('#fpWdlTotal').textContent = `· ${wdls.length} · ₹${sum(wdls).toLocaleString('en-IN')}`;
      const cols = ['ts','name','amt','utr','source','remark'];
      const render = arr => arr.length
        ? tableOf(arr, cols)
        : '<div class="mute">No approved rows yet — load the freeplay panel in Chrome with the extension installed, then click Sync now in the popup.</div>';
      $('#fpDepTable').innerHTML = render(deps);
      $('#fpWdlTable').innerHTML = render(wdls);
      // Role-based hide
      const fpOnly = document.body.dataset.fpOnly;
      if (fpOnly === 'dep') $('#fpWdlTable').parentElement.style.display = 'none';
      if (fpOnly === 'wdl') $('#fpDepTable').parentElement.style.display = 'none';
      try {
        const s = await api('/api/ingest/panel/status');
        const fp = s.last_sync && s.last_sync.freeplay24;
        $('#fpLastSync').textContent = fp ? 'Last ext sync: ' + new Date(fp).toLocaleString() : 'No extension sync yet';
      } catch {}
    } catch (e) { /* silent during auto-refresh */ }
  }

  // ── ATM / Expenses tab ──────────────────────────────────────
  function initExpensesTab() {
    // Populate bank dropdown for ATM
    const sel = $('#atm-bank');
    if (sel && sel.options.length <= 1) {
      api('/api/banks').then(r => {
        sel.innerHTML = '<option value="">— bank (optional) —</option>' +
          (r.rows || []).map(b => `<option value="${b.id}">${esc(b.name)}</option>`).join('');
      }).catch(()=>{});
    }
    loadExpenses();
  }
  async function loadExpenses() {
    try {
      const r = await api('/api/expenses?business_date=' + encodeURIComponent(BD));
      $('#expTable').innerHTML = tableOf(r.rows || [],
        ['category','amt','employee','remark','detail'],
        (row) => `<button class="danger" data-del="/api/expenses/${row.id}">del</button>`);
      wireDel('#expTable', loadExpenses);
    } catch {}
  }
  function shiftDate(iso, delta) {
    const d = new Date(iso + 'T12:00:00');
    d.setDate(d.getDate() + delta);
    return d.toISOString().slice(0, 10);
  }

  document.addEventListener('click', async (e) => {
    if (e.target.id === 'liveRefresh') {
      if ($('#liveView').value === 'google') applyLiveView(); else renderLiveGrid();
    }
    if (e.target.id === 'liveBranch') { renderLiveGrid(); }
    if (e.target.id === 'liveDatePrev') {
      $('#live-date').value = shiftDate($('#live-date').value, -1);
      renderLiveGrid();
    }
    if (e.target.id === 'liveDateNext') {
      $('#live-date').value = shiftDate($('#live-date').value, 1);
      renderLiveGrid();
    }
    if (e.target.id === 'liveDateToday') {
      $('#live-date').value = BD;
      renderLiveGrid();
    }
    if (e.target.id === 'fpRefresh') loadFreeplay();

    // Admin controls
    if (e.target.id === 'btnForceRollover') {
      if (!confirm('Run rollover now? Archives today and marks the boundary.')) return;
      try {
        const r = await api('/api/sheet/rollover/run', { method: 'POST', body: {} });
        toast('Rollover done · archived ' + (r.info?.archived ? 'OK' : 'skipped (no template)'));
        rolloverCache = null; tickRolloverBanner();
      } catch (err) { toast(err.message, true); }
    }
    if (e.target.id === 'btnResetDate') {
      const d = $('#live-date').value;
      const typed = prompt(`WIPE ALL ENTRIES for ${d}? This cannot be undone. Type the date to confirm:`);
      if (typed !== d) return;
      try {
        const r = await api('/api/sheet/reset', { method: 'POST', body: { date: d, confirm: d } });
        toast(`Deleted: ${r.deleted.bank_txns} bank + ${r.deleted.dw} D/W + ${r.deleted.gpay} GPay + ${r.deleted.expenses} exp`);
        renderLiveGrid();
      } catch (err) { toast(err.message, true); }
    }
    if (e.target.id === 'btnArchiveXlsx') {
      const d = $('#live-date').value;
      window.open(`/api/sheet/xlsx?date=${encodeURIComponent(d)}`, '_blank');
    }
    if (e.target.id === 'btnPushGoogleNow') {
      const d = $('#live-date').value;
      try {
        const r = await api('/api/sheet/google', { method: 'POST', body: { date: d } });
        toast(`Pushed to Google Sheet — ${r.updated} cells in ${r.ranges} ranges`);
      } catch (err) { toast(err.message, true); }
    }
  });
  document.addEventListener('change', (e) => {
    if (e.target.id === 'liveDateHist' && e.target.value) {
      $('#live-date').value = e.target.value;
      renderLiveGrid();
    }
    if (e.target.id === 'live-date') {
      renderLiveGrid();
    }
    if (e.target.id === 'liveBranch') {
      renderLiveGrid();
    }
  });
  document.addEventListener('submit', async (e) => {
    if (e.target.id === 'atmForm') {
      e.preventDefault();
      const body = {
        business_date: BD, category: 'atm',
        amt: Number($('#atm-amt').value),
        employee: $('#atm-emp').value.trim(),
        remark: $('#atm-remark').value.trim(),
        detail: 'ATM' + ($('#atm-bank').value ? ' (bank #' + $('#atm-bank').value + ')' : ''),
      };
      if (!body.amt || !body.employee) return toast('amount + employee required', true);
      try {
        await api('/api/expenses', { method: 'POST', body });
        $('#atmForm').reset();
        toast('ATM withdrawal recorded');
        loadExpenses(); loadHisab();
      } catch (err) { toast(err.message, true); }
    }
    if (e.target.id === 'expForm') {
      e.preventDefault();
      const body = {
        business_date: BD, category: $('#exp-cat').value,
        amt: Number($('#exp-amt').value), remark: $('#exp-remark').value.trim(),
      };
      if (!body.amt) return toast('amount required', true);
      try {
        await api('/api/expenses', { method: 'POST', body });
        $('#expForm').reset();
        toast('Expense added');
        loadExpenses(); loadHisab();
      } catch (err) { toast(err.message, true); }
    }
  });

  // ── Reconcile tab ───────────────────────────────────────────
  function initReconcileTab() {
    $('#rc-from').value = BD;
    $('#rc-to').value = BD;
  }
  document.addEventListener('click', async (e) => {
    if (e.target.id === 'rcScan') {
      try {
        const r = await api(`/api/reconcile?from=${$('#rc-from').value}&to=${$('#rc-to').value}`);
        if (!r.gaps.length) {
          $('#rcResult').innerHTML = `<div class="pill ok">No gaps found (${r.scanned} SMS txns scanned).</div>`;
          return;
        }
        const head = '<tr><th>Bank</th><th>Between</th><th>Prev bal</th><th>Expected</th><th>Observed</th><th>Missing</th><th>Likely</th></tr>';
        const body = r.gaps.map(g => `<tr>
          <td>${esc(g.bank)}</td>
          <td class="mute" style="font-size:11px">${esc(g.between_ts[0]||'')}<br/>${esc(g.between_ts[1]||'')}</td>
          <td style="text-align:right">${g.prev_balance.toLocaleString('en-IN')}</td>
          <td style="text-align:right">${g.expected_balance.toLocaleString('en-IN')}</td>
          <td style="text-align:right">${g.observed_balance.toLocaleString('en-IN')}</td>
          <td style="text-align:right"><b style="color:${g.missing_amount>0?'var(--ok)':'var(--err)'}">${g.missing_amount>0?'+':''}${g.missing_amount.toLocaleString('en-IN')}</b></td>
          <td>${esc(g.likely)}</td>
        </tr>`).join('');
        $('#rcResult').innerHTML = `<div class="pill err">${r.gaps.length} gap(s) found</div>
          <table style="margin-top:10px">${head}${body}</table>`;
      } catch (err) { toast(err.message, true); }
    }
    if (e.target.id === 'btnPushGoogle') {
      try {
        $('#googleStatus').textContent = 'Pushing to Google Sheet…';
        const r = await api('/api/sheet/google', { method: 'POST', body: { date: BD } });
        $('#googleStatus').innerHTML = `<span class="pill ok">Updated ${r.updated} cells across ${r.ranges} ranges.</span>
          <a href="${r.url}" target="_blank" style="margin-left:8px">Open live sheet →</a>`;
      } catch (err) {
        $('#googleStatus').innerHTML = `<span class="pill err">${esc(err.message)}</span>`;
      }
    }
  });

  // ── Sheet tab ───────────────────────────────────────────────
  function initSheetTab() {
    const url = $('#serverUrl');
    if (url) url.textContent = location.origin;
    $('#sheetStatus').textContent = `Business date: ${BD}. Master template auto-registered from sheet.xlsx.`;
    api('/api/sheet/google/status').then(s => {
      const el = $('#googleStatus');
      if (s.configured) {
        el.innerHTML = `<span class="pill ok">Google Sheet connected</span> <a href="${s.url}" target="_blank">Open sheet →</a>`;
      } else {
        el.innerHTML = `<span class="mute">Google Sheet not configured. Set env vars <code>GOOGLE_SHEET_ID</code> + <code>GOOGLE_SERVICE_ACCOUNT_JSON</code> and share the sheet with the service account's email.</span>`;
      }
    }).catch(() => {});
  }
  document.addEventListener('click', async (e) => {
    if (e.target.id === 'btnDownloadXlsx') {
      window.location.href = `/api/sheet/xlsx?date=${encodeURIComponent(BD)}`;
    }
    if (e.target.id === 'btnPreviewSheet') {
      try {
        const r = await api(`/api/sheet/preview?date=${encodeURIComponent(BD)}`);
        const rows = r.rows || [];
        if (!rows.length) { $('#sheetPreview').innerHTML = '<span class="mute">No rows for this date yet.</span>'; return; }
        const head = '<tr><th>✓</th><th>Kind</th><th>Panel / Bank</th><th>Name / Details</th><th style="text-align:right">Amount</th></tr>';
        const body = rows.map((r, i) => {
          const where = r.panel || r.bank || '';
          const label = r.name || r.creditDetails || r.debitDetails || '';
          const amt = r.amt || r.credit || r.debit || 0;
          return `<tr><td><input type="checkbox" data-sr="${i}" ${r.selected ? 'checked' : ''}/></td>
            <td>${esc(r.kind)}</td><td>${esc(where)}</td><td>${esc(label)}</td>
            <td style="text-align:right">${Number(amt).toLocaleString('en-IN')}</td></tr>`;
        }).join('');
        $('#sheetPreview').innerHTML = `<table>${head}${body}</table>
          <div class="mute" style="margin-top:8px;font-size:12px">${rows.length} rows. Untick any row to exclude it (commit-with-selection coming next).</div>`;
      } catch (err) { toast(err.message, true); }
    }
  });

  // ── Business date ───────────────────────────────────────────
  async function initApp() {
    const h = await api('/api/health');
    BD = h.business_date;
    $('#bdPicker').value = BD;
    $('#bdInfo').textContent = '(day rolls over at 05:30 IST)';
    loadDropdowns();
    // Default tab = Live Sheet so the user always sees the sheet on login
    initLiveTab();
    loadHisab();
  }

  $('#bdPicker').addEventListener('change', (e) => {
    BD = e.target.value;
    const active = $$('#tabnav button').find(b => b.classList.contains('active')).dataset.tab;
    onTabChange(active);
  });
  $('#btnToday').addEventListener('click', async () => {
    const h = await api('/api/health');
    BD = h.business_date;
    $('#bdPicker').value = BD;
    const active = $$('#tabnav button').find(b => b.classList.contains('active')).dataset.tab;
    onTabChange(active);
  });

  // ── Dropdowns ───────────────────────────────────────────────
  async function loadDropdowns() {
    const [banks, panels] = await Promise.all([api('/api/banks'), api('/api/panels')]);
    const bopts = '<option value="">(bank)</option>' + banks.rows.map(b => `<option value="${b.id}">${esc(b.name)}</option>`).join('');
    const popts = '<option value="">(panel)</option>' + panels.rows.map(p => `<option value="${esc(p.slug)}">${esc(p.name)}</option>`).join('');
    $('#bt-bank').innerHTML = bopts;
    $('#gp-bank').innerHTML = bopts;
    const bsBank = $('#bs-bank');
    if (bsBank) {
      // User's banks first, then full Indian-banks registry as a separate optgroup
      let html = '<option value="">— select which bank this statement is for —</option>';
      if (banks.rows.length) {
        html += '<optgroup label="Your banks">';
        html += banks.rows.map(b => `<option value="${b.id}">${esc(b.name)} ${b.holder ? '· ' + esc(b.holder) : ''}</option>`).join('');
        html += '</optgroup>';
      }
      try {
        const reg = await api('/api/banks/registry');
        const haveCodes = new Set((banks.rows || []).map(b => (b.name || '').toUpperCase().split(/\s+/)[0]));
        const remaining = (reg.registry || []).filter(b => !haveCodes.has(b.code));
        const byCat = {};
        remaining.forEach(b => { (byCat[b.category] = byCat[b.category] || []).push(b); });
        const labels = { psu: 'Public-sector', private: 'Private', sfb: 'Small Finance', payments: 'Payments', foreign: 'Foreign', coop: 'Co-operative' };
        Object.entries(byCat).forEach(([cat, list]) => {
          html += `<optgroup label="${labels[cat] || cat} (auto-add)">`;
          html += list.map(b => `<option value="reg:${esc(b.code)}">${esc(b.code)}</option>`).join('');
          html += '</optgroup>';
        });
      } catch {}
      bsBank.innerHTML = html;
    }
    $('#dw-panel').innerHTML = popts;
    $('#gp-panel').innerHTML = popts;
  }

  // ── Hisab ──────────────────────────────────────────────────
  async function loadHisab() {
    $('#hisabDate').textContent = BD || '';
    try {
      const r = await api('/api/hisab?business_date=' + encodeURIComponent(BD));
      const t = r.totals;
      const box = (label, val, cls) => `<div class="stat ${cls||''}"><div class="label">${label}</div><div class="val">₹ ${fmt(val)}</div></div>`;
      $('#hisabTotals').innerHTML = [
        box('Bank Credit', t.bankCredit),
        box('Bank Debit', t.bankDebit),
        box('Bank Net', t.bankNet),
        box('Panel Deposits', t.panelDeposit),
        box('Panel Withdrawals', t.panelWithdraw),
        box('Panel Net', t.panelNet),
        box('GPay Received', t.gpayRecv),
        box('GPay Sent', t.gpaySent),
        box('Expenses', t.expenses),
        box('Free Chips', t.freeChips),
        box('HISAB', t.hisab, 'hisab'),
      ].join('');
    } catch (e) { toast(e.message, true); }
  }

  // ── D/W ─────────────────────────────────────────────────────
  $('#dwForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/api/dw', { method: 'POST', body: {
        business_date: BD,
        type: $('#dw-type').value,
        panel_slug: $('#dw-panel').value || null,
        amt: Number($('#dw-amt').value),
        name: $('#dw-name').value, chips: Number($('#dw-chips').value) || 0,
        utr: $('#dw-utr').value, remark: $('#dw-remark').value,
      } });
      e.target.reset();
      loadDw(); loadHisab();
    } catch (err) { toast(err.message, true); }
  });

  async function loadDw() {
    const r = await api('/api/dw?business_date=' + encodeURIComponent(BD));
    $('#dwTable').innerHTML = tableOf(r.rows,
      ['type','panel_slug','amt','name','chips','utr','remark','source'],
      (row) => `<button class="danger" data-del="/api/dw/${row.id}">del</button>`);
    wireDel('#dwTable', () => { loadDw(); loadHisab(); });
  }

  // ── GPay ────────────────────────────────────────────────────
  $('#gpayForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    await api('/api/gpay', { method: 'POST', body: {
      business_date: BD, type: $('#gp-type').value,
      amt: Number($('#gp-amt').value), name: $('#gp-name').value, utr: $('#gp-utr').value,
      panel_slug: $('#gp-panel').value || null, bank_id: Number($('#gp-bank').value) || null,
      remark: $('#gp-remark').value,
    } });
    e.target.reset(); loadGpay(); loadHisab();
  });
  async function loadGpay() {
    const r = await api('/api/gpay?business_date=' + encodeURIComponent(BD));
    $('#gpayTable').innerHTML = tableOf(r.rows,
      ['type','amt','name','utr','panel_slug','bank_id','remark','source'],
      (row) => `<button class="danger" data-del="/api/gpay/${row.id}">del</button>`);
    wireDel('#gpayTable', () => { loadGpay(); loadHisab(); });
  }

  // ── Banks ──────────────────────────────────────────────────
  $('#bankForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    await api('/api/banks', { method: 'POST', body: {
      name: $('#bk-name').value, holder: $('#bk-holder').value,
      acno: $('#bk-acno').value, open_balance: Number($('#bk-open').value) || 0,
    } });
    e.target.reset(); loadBanks(); loadDropdowns();
  });
  async function loadBanks() {
    const r = await api('/api/banks');
    $('#banksTable').innerHTML = tableOf(r.rows, ['name','holder','acno','open_balance'],
      (row) => `<button class="danger" data-del="/api/banks/${row.id}">del</button>`);
    wireDel('#banksTable', () => { loadBanks(); loadDropdowns(); });
  }

  // ── Bank txns ──────────────────────────────────────────────
  $('#bkTxnForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    await api('/api/bank-txns', { method: 'POST', body: {
      business_date: BD, bank_id: Number($('#bt-bank').value) || null,
      type: $('#bt-type').value, category: $('#bt-cat').value,
      amt: Number($('#bt-amt').value), detail: $('#bt-detail').value,
    } });
    e.target.reset(); loadBankTxns(); loadHisab();
  });
  async function loadBankTxns() {
    const r = await api('/api/bank-txns?business_date=' + encodeURIComponent(BD));
    $('#bkTxnTable').innerHTML = tableOf(r.rows,
      ['type','category','amt','detail','source','ext_ref'],
      (row) => `<button class="danger" data-del="/api/bank-txns/${row.id}">del</button>`);
    wireDel('#bkTxnTable', () => { loadBankTxns(); loadHisab(); });
  }

  // ── Uploads ────────────────────────────────────────────────
  $('#bsPreviewBtn').addEventListener('click', async () => {
    const f = $('#bsFile').files[0];
    if (!f) return toast('pick a PDF', true);
    $('#bsPreview').innerHTML = '<div class="mute" style="margin:10px 0">Parsing PDF — may take a few seconds for large statements…</div>';
    try {
      console.log('[preview] uploading', f.name, f.size, 'bytes');
      const r = await apiUpload('/api/ingest/preview/bank-statement', f);
      console.log('[preview] response', r);
      const det = r.detected || {};
      let bankId = det.bank_id || null;
      // Auto-fill the dropdown if present
      const sel = $('#bs-bank');
      if (sel && bankId) sel.value = String(bankId);
      // Let operator override if auto-detect failed or is wrong
      if (!bankId) {
        const manual = sel && sel.value ? Number(sel.value) : null;
        if (manual) bankId = manual;
      }
      const tag = det.auto_registered ? ' · NEW bank auto-added' : '';
      const label = det.bank_name
        ? `Detected: ${det.bank_name}${det.ac_last4 ? ' · a/c …' + det.ac_last4 : ''} (${det.confidence}${tag})`
        : (det.code ? `Detected code "${det.code}" but no matching bank row — add it first or pick manually.`
                    : 'Could not auto-detect bank from PDF. Pick manually.');
      if (det.auto_registered) { try { await loadDropdowns(); } catch {} }
      const banner = `<div class="mute" style="margin:6px 0;font-size:12px;${det.bank_id?'color:#7cffa2':'color:#ffc166'}">${label}</div>`;
      $('#bsPreview').innerHTML = banner;
      if (!r.rows || !r.rows.length) {
        $('#bsPreview').innerHTML = banner + '<div class="mute" style="margin-top:10px">No rows parsed from this PDF.</div>';
        return toast('No rows parsed — is this a supported bank statement PDF?', true);
      }
      if (!bankId) toast('Pick a bank from the dropdown before committing', true);
      // bank_id is read dynamically at commit time so user can pick after preview
      renderPreview('#bsPreview', r.rows, 'bank-statement', ['date','narration','amt','type','category','name','utr','entryKind','business_date','duplicate'], { _bankFromDropdown: '#bs-bank' }, banner);
    } catch (e) {
      console.error('[preview] failed', e);
      $('#bsPreview').innerHTML = `<div class="pill err" style="display:block;padding:10px;margin-top:10px">Preview failed: ${esc(e.message)}</div>`;
      toast(e.message, true);
    }
  });

  $('#gpPreviewBtn').addEventListener('click', async () => {
    const f = $('#gpFile').files[0];
    if (!f) return toast('pick a file', true);
    $('#gpPreview').innerHTML = '<div class="mute" style="margin:10px 0">Parsing…</div>';
    try {
      const r = await apiUpload('/api/ingest/preview/gpay-statement', f);
      renderPreview('#gpPreview', r.rows, 'gpay-statement', ['ts','type','amt','name','utr','business_date','duplicate']);
    } catch (e) {
      console.error('[gpay preview] failed', e);
      $('#gpPreview').innerHTML = `<div class="pill err" style="display:block;padding:10px;margin-top:10px">Preview failed: ${esc(e.message)}</div>`;
      toast(e.message, true);
    }
  });

  function renderPreview(sel, rows, kind, cols, extra = {}, prefix = '') {
    if (!rows || !rows.length) { $(sel).innerHTML = (prefix || '') + '<div class="mute" style="margin-top:10px">No rows parsed.</div>'; return; }
    const head = '<tr><th><input type="checkbox" id="chkAll" checked/></th>' + cols.map(c => `<th>${c}</th>`).join('') + '</tr>';
    const body = rows.map((r, i) => {
      const dup = r.duplicate ? '<span class="pill dup">dup</span>' : '';
      return `<tr>
        <td><input type="checkbox" class="rowchk" data-i="${i}" ${r.duplicate ? '' : 'checked'}/></td>
        ${cols.map(c => `<td>${c === 'duplicate' ? dup : esc(r[c])}</td>`).join('')}
      </tr>`;
    }).join('');
    $(sel).innerHTML = (prefix || '') + `
      <div style="margin-top:10px">
        <div class="row" style="margin-bottom:8px">
          <span class="mute">${rows.length} parsed · ${rows.filter(r => r.duplicate).length} dupes</span>
          <div class="spacer"></div>
          <button class="primary" id="commitBtn">Commit selected</button>
        </div>
        <div style="overflow:auto; max-height:50vh"><table>${head}${body}</table></div>
      </div>`;
    $(sel + ' #chkAll').addEventListener('change', (e) => {
      $$(sel + ' .rowchk').forEach(c => c.checked = e.target.checked);
    });
    $(sel + ' #commitBtn').addEventListener('click', async () => {
      const picks = new Set([...$$(sel + ' .rowchk')].filter(c => c.checked).map(c => +c.dataset.i));
      const payload = rows.map((r, i) => picks.has(i) ? r : { ...r, skip: true });
      // Resolve dynamic bank_id from a dropdown if requested
      const dynExtra = { ...extra };
      if (dynExtra._bankFromDropdown) {
        const v = $(dynExtra._bankFromDropdown) && $(dynExtra._bankFromDropdown).value;
        if (!v) return toast('Pick a bank in the dropdown first', true);
        // Registry-only entries: auto-create the bank row, then use its id
        if (String(v).startsWith('reg:')) {
          const code = String(v).slice(4);
          try {
            const created = await api('/api/banks', { method: 'POST', body: { name: code, holder: '', acno: '' } });
            dynExtra.bank_id = created.id;
            await loadDropdowns();
          } catch (err) { return toast('Could not auto-add bank: ' + err.message, true); }
        } else {
          dynExtra.bank_id = Number(v);
        }
        delete dynExtra._bankFromDropdown;
      }
      try {
        const res = await api('/api/ingest/commit/' + kind, { method: 'POST', body: { rows: payload, ...dynExtra } });
        toast(`Inserted ${res.insertedBank || res.inserted || 0} + ${res.insertedDw || 0}, skipped ${res.skipped || 0}`);
        $(sel).innerHTML = '';
        loadHisab();
      } catch (e) { toast(e.message, true); }
    });
  }

  // ── Panels ─────────────────────────────────────────────────
  $('#panelForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    await api('/api/panels', { method: 'POST', body: {
      name: $('#pn-name').value, slug: $('#pn-slug').value,
      url: $('#pn-url').value,
      open_chips: Number($('#pn-open').value) || 0, close_chips: Number($('#pn-close').value) || 0,
    } });
    e.target.reset(); loadPanels(); loadDropdowns();
  });
  async function loadPanels() {
    const r = await api('/api/panels');
    $('#panelsTable').innerHTML = tableOf(r.rows, ['name','slug','url','open_chips','close_chips'],
      (row) => `<button class="danger" data-del="/api/panels/${row.id}">del</button>`);
    wireDel('#panelsTable', loadPanels);
  }
  async function loadPanelStatus() {
    try {
      const r = await api('/api/ingest/panel/status');
      const entries = Object.entries(r.last_sync || {});
      $('#panelSyncInfo').innerHTML = entries.length
        ? entries.map(([k, v]) => `<div><b>${esc(k)}</b> — ${esc(v)}</div>`).join('')
        : '<span class="mute">no sync yet</span>';
    } catch (e) {}
  }

  // ── Admin: users ───────────────────────────────────────────
  $('#userForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/api/auth/users', { method: 'POST', body: {
        username: $('#u-name').value, password: $('#u-pass').value, role: $('#u-role').value
      } });
      e.target.reset(); loadUsers(); toast('User created');
    } catch (err) { toast(err.message, true); }
  });
  async function loadUsers() {
    if (!ME || ME.role !== 'admin') return;
    const r = await api('/api/auth/users');
    const html = `<table><tr><th>id</th><th>username</th><th>role</th><th>active</th><th>actions</th></tr>` +
      r.users.map(u => `<tr>
        <td>${u.id}</td><td>${esc(u.username)}</td><td>${u.role}</td><td>${u.is_active ? 'yes' : 'no'}</td>
        <td>
          <button class="ghost" data-toggle="${u.id}" data-active="${u.is_active}">${u.is_active ? 'disable' : 'enable'}</button>
          <button class="ghost" data-resetpw="${u.id}">reset pw</button>
        </td></tr>`).join('') + '</table>';
    $('#usersTable').innerHTML = html;
    $$('#usersTable [data-toggle]').forEach(b => b.addEventListener('click', async () => {
      const active = b.dataset.active === '1' || b.dataset.active === 'true';
      await api('/api/auth/users/' + b.dataset.toggle, { method: 'PATCH', body: { is_active: !active } });
      loadUsers();
    }));
    $$('#usersTable [data-resetpw]').forEach(b => b.addEventListener('click', async () => {
      const pw = prompt('New password:');
      if (!pw) return;
      await api('/api/auth/users/' + b.dataset.resetpw, { method: 'PATCH', body: { password: pw } });
      toast('Password reset');
    }));
  }

  // ── Admin: tokens ──────────────────────────────────────────
  $('#tokForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const r = await api('/api/auth/tokens', { method: 'POST', body: { label: $('#tok-label').value } });
    prompt('Copy this token now (shown only once):', r.token);
    $('#tok-label').value = '';
    loadTokens();
  });
  async function loadTokens() {
    const r = await api('/api/auth/tokens');
    $('#tokenList').innerHTML = r.tokens.length
      ? '<table><tr><th>id</th><th>label</th><th>created</th><th></th></tr>' +
        r.tokens.map(t => `<tr><td>${t.id}</td><td>${esc(t.label || '')}</td><td>${esc(t.created_at)}</td>
          <td><button class="danger" data-deltok="${t.id}">revoke</button></td></tr>`).join('') + '</table>'
      : '<span class="mute">no tokens</span>';
    $$('#tokenList [data-deltok]').forEach(b => b.addEventListener('click', async () => {
      await api('/api/auth/tokens/' + b.dataset.deltok, { method: 'DELETE' });
      loadTokens();
    }));
  }

  // ── Helpers ────────────────────────────────────────────────
  function tableOf(rows, cols, actions) {
    if (!rows || !rows.length) return '<div class="mute">no rows</div>';
    const head = '<tr>' + cols.map(c => `<th>${c}</th>`).join('') + (actions ? '<th></th>' : '') + '</tr>';
    const body = rows.map(r => '<tr>' + cols.map(c => `<td>${esc(r[c])}</td>`).join('') + (actions ? `<td>${actions(r)}</td>` : '') + '</tr>').join('');
    return `<div style="overflow:auto"><table>${head}${body}</table></div>`;
  }
  function wireDel(sel, after) {
    $$(`${sel} [data-del]`).forEach(b => b.addEventListener('click', async () => {
      if (!confirm('Delete row?')) return;
      await api(b.dataset.del, { method: 'DELETE' });
      after && after();
    }));
  }

  checkAuth();
})();
