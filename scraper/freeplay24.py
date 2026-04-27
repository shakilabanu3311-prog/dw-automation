"""Freeplay24 deposit / withdrawal scraper.

Why Python + Playwright instead of the Chrome extension?
  The Chrome MV3 extension's content script runs in an isolated world and
  cannot see the page's `window.jQuery`, so the DataTables API path always
  came back empty and the DOM-walk fallback only ever saw the first visible
  page (often "No Data Available In Table" before AJAX completes).

  Playwright drives a real Chromium and runs `page.evaluate(...)` *in the
  page world*, so jQuery + DataTables API are directly accessible. We also
  intercept XHR responses as a belt-and-braces fallback — every approach
  is tried in order and we keep whichever returns the most rows.
"""
from __future__ import annotations

import json
import os
import re
import time
from dataclasses import dataclass, field
from typing import Any

from playwright.sync_api import (
    BrowserContext,
    Page,
    Playwright,
    Response,
    sync_playwright,
)


# ─── Status filter (mirrors the JS extension exactly) ───────────────────
APPROVED_RE = re.compile(
    r"\b(approv(?:ed|al)?|success(?:ful)?|complet(?:e|ed)|done|paid|"
    r"credit(?:ed)?|settled|confirm(?:ed)?|accept(?:ed)?|verified)\b",
    re.I,
)
REJECT_RE = re.compile(
    r"\b(reject|fail|cancel|pending|void|hold|declin|retry|review|"
    r"unpaid|dispute|refund|new|open|process)\b",
    re.I,
)


@dataclass
class Row:
    ts: str
    amount: float
    name: str
    utr: str
    bank: str
    status: str
    raw: dict = field(default_factory=dict)


@dataclass
class ScrapeResult:
    site: str
    master: str
    deposits: list[Row]
    withdrawals: list[Row]


# ─── Helpers ──────────────────────────────────────────────────────────
def parse_amt(s: Any) -> float:
    if s is None:
        return 0.0
    txt = re.sub(r"[^0-9.\-]", "", str(s).replace(",", ""))
    try:
        return float(txt) if txt else 0.0
    except ValueError:
        return 0.0


def clean_iso_ts(s: str) -> str:
    """Best-effort ISO timestamp with IST tz so the server's businessDate()
    helper lands the row in the correct book around the 05:30 cutoff.

    Freeplay24 renders date cells via inline scripts that look like:
        document.write(moment.unix('1777217474').utc().local().format(...))
    The unix seconds are right there — pull them out before anything else.
    """
    if not s:
        return time.strftime("%Y-%m-%dT12:00:00+05:30")
    s = s.strip()
    m_unix = re.search(r"moment\.unix\(\s*['\"]?(\d{9,11})['\"]?\s*\)", s)
    if m_unix:
        ts = int(m_unix.group(1))
        # Convert to IST (+05:30). time.gmtime is UTC; add 5h30m.
        from datetime import datetime, timezone, timedelta
        ist = timezone(timedelta(hours=5, minutes=30))
        dt = datetime.fromtimestamp(ts, tz=ist)
        return dt.strftime("%Y-%m-%dT%H:%M:%S+05:30")
    # Plain unix seconds (10-digit number alone in the cell)
    if re.fullmatch(r"\d{10}", s):
        from datetime import datetime, timezone, timedelta
        ist = timezone(timedelta(hours=5, minutes=30))
        return datetime.fromtimestamp(int(s), tz=ist).strftime(
            "%Y-%m-%dT%H:%M:%S+05:30")
    # YYYY-MM-DD HH:MM:SS  or  DD-MM-YYYY HH:MM
    m = re.match(
        r"(\d{2,4})[-/](\d{1,2})[-/](\d{2,4})[ T]?"
        r"(\d{1,2})?:?(\d{2})?:?(\d{2})?\s*(AM|PM|am|pm)?",
        s,
    )
    if not m:
        return f"{s.split()[0]}T12:00:00+05:30"
    a, b, c, hh, mm, ss, ap = m.groups()
    if len(a) == 4:
        y, mo, d = a, b, c
    else:
        d, mo, y = a, b, c if len(c) == 4 else f"20{c}"
    h = int(hh) if hh else 12
    if ap and ap.lower() == "pm" and h < 12:
        h += 12
    if ap and ap.lower() == "am" and h == 12:
        h = 0
    return (
        f"{y}-{int(mo):02d}-{int(d):02d}T"
        f"{h:02d}:{int(mm or 0):02d}:{int(ss or 0):02d}+05:30"
    )


def classify(status_text: str, row_text: str) -> str:
    st = (status_text or "").strip().lower()
    if st:
        if REJECT_RE.search(st):
            return "rejected"
        if APPROVED_RE.search(st):
            return "approved"
        return "unknown"
    if REJECT_RE.search(row_text or ""):
        return "rejected"
    if APPROVED_RE.search(row_text or ""):
        return "approved"
    return "unknown"


# ─── Page-world readers ────────────────────────────────────────────────
# Run inside page.evaluate(). Using the live jQuery DataTables API gives
# us EVERY row across all pages, not just the visible page. This is the
# step the Chrome extension couldn't do.
DATATABLES_READER = r"""
() => {
  const out = [];
  const $ = window.jQuery || window.$;
  if (!$ || !$.fn || !$.fn.DataTable) return { ok: false, reason: 'no-datatables' };
  // Some cells embed inline <script>document.write(moment.unix(...)…)</script>
  // which we want to PRESERVE so the Python side can extract the unix
  // timestamp. We just unwrap simple <span>/<b>/<a> wrappers — anything
  // with a "moment.unix(" call we keep verbatim so timestamp parsing works.
  const stripHtml = (s) => {
    const str = String(s == null ? '' : s);
    if (str.includes("moment.unix(")) return str;
    if (!/<[^>]+>/.test(str)) return str;
    const d = document.createElement('div'); d.innerHTML = str;
    return (d.textContent || '').trim();
  };
  $('table').each((_, t) => {
    if (!$.fn.DataTable.isDataTable(t)) return;
    const api = $(t).DataTable();
    const headers = [];
    api.columns().every(function () {
      const th = this.header();
      headers.push((th && th.textContent || '').trim());
    });
    const rows = [];
    api.rows({ search: 'applied' }).data().each(function (rd) {
      if (Array.isArray(rd)) {
        rows.push(rd.map(c => stripHtml(String(c == null ? '' : c)).trim()));
      } else if (rd && typeof rd === 'object') {
        rows.push(headers.map((_, i) => stripHtml(String(rd[i] == null ? '' : rd[i])).trim()));
      }
    });
    if (rows.length) out.push({ headers, rows });
  });
  return { ok: true, tables: out };
}
"""


# DOM-walk fallback (visible page only). Used if DataTables isn't loaded.
DOM_READER = r"""
() => {
  const out = [];
  document.querySelectorAll('table').forEach(t => {
    const ths = [...t.querySelectorAll('thead th, thead td')];
    const headers = (ths.length ? ths : [...(t.querySelector('tr')||{children:[]}).children])
      .map(h => (h.textContent||'').trim());
    const body = t.querySelector('tbody') || t;
    const rows = [...body.querySelectorAll('tr')].map(tr =>
      [...tr.querySelectorAll('td,th')].map(c => (c.textContent||'').trim())
    ).filter(r => r.length === headers.length && r.some(Boolean));
    if (rows.length) out.push({ headers, rows });
  });
  return { ok: true, tables: out };
}
"""


# ─── Header → column-index detection ───────────────────────────────────
def col_idx(headers: list[str], pattern: str) -> int:
    rx = re.compile(pattern, re.I)
    for i, h in enumerate(headers):
        if rx.search(h or ""):
            return i
    return -1


def normalize_table(table: dict) -> tuple[str, list[Row]]:
    """Detect column layout, return (kind, rows) where kind is
    'deposit' | 'withdrawal' | 'mixed' | 'unknown'."""
    headers = table["headers"]
    raw_rows = table["rows"]

    ci = {
        "date":   col_idx(headers, r"^(date|datetime|created|time|txn.?date|request)"),
        "name":   col_idx(headers, r"^(name|user|member|client|username|player|account(?!.*no))"),
        "amount": col_idx(headers, r"^(amount|amt|total|sum|value)$"),
        "type":   col_idx(headers, r"^(type|txn.?type|kind)$"),
        "status": col_idx(headers, r"^(status|state|approval|result)$"),
        "utr":    col_idx(headers, r"^(utr|ref|txn.?id|transaction|reference)"),
        "bank":   col_idx(headers, r"^(bank|upi|ifsc|method|channel)"),
    }
    kind = "unknown"
    blob = " ".join(headers).lower()
    if "deposit" in blob and "withdraw" not in blob:
        kind = "deposit"
    elif "withdraw" in blob and "deposit" not in blob:
        kind = "withdrawal"
    elif ci["type"] >= 0:
        kind = "mixed"

    out: list[Row] = []
    for cells in raw_rows:
        if not cells:
            continue
        cells = list(cells) + [""] * (len(headers) - len(cells))
        status_text = cells[ci["status"]] if ci["status"] >= 0 else ""
        row_text = " | ".join(cells)
        status = classify(status_text, row_text)
        if status != "approved":
            continue  # skip rejected/pending/unknown
        out.append(Row(
            ts=clean_iso_ts(cells[ci["date"]] if ci["date"] >= 0 else ""),
            amount=parse_amt(cells[ci["amount"]] if ci["amount"] >= 0 else ""),
            name=(cells[ci["name"]] if ci["name"] >= 0 else "").strip(),
            utr=(cells[ci["utr"]] if ci["utr"] >= 0 else "").strip(),
            bank=(cells[ci["bank"]] if ci["bank"] >= 0 else "").strip(),
            status=status,
            raw={"headers": headers, "cells": cells, "type_col":
                 (cells[ci["type"]] if ci["type"] >= 0 else "")},
        ))
    return kind, out


def detect_master(tables: list[dict], page_text: str) -> str:
    """Most-frequent value of a 'master' column wins. Falls back to the
    first ALLCAPS+digits token in visible text (sidebar / topbar)."""
    for t in tables:
        idx = col_idx(t["headers"], r"^master\b")
        if idx < 0:
            continue
        counts: dict[str, int] = {}
        for r in t["rows"]:
            v = (r[idx] if idx < len(r) else "").strip().upper()
            if v and re.match(r"^[A-Z][A-Z0-9_-]{2,}", v):
                counts[v] = counts.get(v, 0) + 1
        if counts:
            return max(counts.items(), key=lambda kv: kv[1])[0]
    m = re.search(r"\b([A-Z]{2,}\d{2,6})\b", page_text or "")
    return m.group(1) if m else ""


# ─── The scraper ───────────────────────────────────────────────────────
class Freeplay24Scraper:
    def __init__(
        self,
        url: str,
        user: str,
        password: str,
        headless: bool = True,
        master_override: str = "",
    ) -> None:
        self.url = url.rstrip("/") + "/"
        self.user = user
        self.password = password
        self.headless = headless
        self.master_override = master_override.strip().upper()
        self._pw: Playwright | None = None
        self._ctx: BrowserContext | None = None
        self._page: Page | None = None
        # XHR fallback cache
        self._xhr_blobs: list[dict] = []

    # ── lifecycle ─────────────────────────────────────────────────────
    def start(self) -> None:
        self._pw = sync_playwright().start()
        browser = self._pw.chromium.launch(headless=self.headless)
        self._ctx = browser.new_context(viewport={"width": 1366, "height": 900})
        self._page = self._ctx.new_page()
        self._page.on("response", self._on_response)

    def close(self) -> None:
        try:
            if self._ctx:
                self._ctx.close()
        finally:
            if self._pw:
                self._pw.stop()
            self._pw = None
            self._ctx = None
            self._page = None

    # ── network sniffer (catches DataTables AJAX even if DOM read fails) ─
    def _on_response(self, resp: Response) -> None:
        try:
            ct = resp.headers.get("content-type", "")
            if "json" not in ct:
                return
            url = resp.url.lower()
            # Heuristic: DataTables server-side responses are usually called
            # something like ".../deposit/list" or contain ?draw=N&start=...
            if not (
                "deposit" in url or "withdraw" in url or "transaction" in url
                or "?draw=" in url or "/dt/" in url
            ):
                return
            data = resp.json()
            # DataTables shape: { draw, recordsTotal, data: [...] }
            if isinstance(data, dict) and "data" in data and isinstance(data["data"], list):
                self._xhr_blobs.append({"url": resp.url, "data": data["data"]})
        except Exception:
            pass

    # ── login ────────────────────────────────────────────────────────
    def login(self) -> None:
        page = self._page
        assert page
        page.goto(self.url, wait_until="domcontentloaded", timeout=60_000)
        # Generic credential-form filler — works whether the login is the
        # landing page or a dialog. Tries a few common selector patterns.
        user_sel = (
            "input[name='username'], input[name='user'], input[name='email'], "
            "input[type='text'][placeholder*='user' i], input[placeholder*='login' i]"
        )
        pass_sel = (
            "input[name='password'], input[type='password']"
        )
        try:
            page.wait_for_selector(user_sel, timeout=15_000)
        except Exception:
            return  # already logged in
        page.fill(user_sel, self.user)
        page.fill(pass_sel, self.password)
        # Submit: prefer the button next to the inputs, else press Enter.
        btn = page.query_selector(
            "button[type='submit'], input[type='submit'], "
            "button:has-text('Login'), button:has-text('Sign in')"
        )
        if btn:
            btn.click()
        else:
            page.press(pass_sel, "Enter")
        page.wait_for_load_state("networkidle", timeout=30_000)
        # Verify login actually succeeded — if a password input is still on
        # screen, credentials were rejected and we should fail loudly rather
        # than silently scraping an empty deposits page.
        try:
            still_on_login = page.query_selector(pass_sel) is not None
        except Exception:
            still_on_login = False
        if still_on_login:
            err = ""
            try:
                el = page.query_selector(
                    ".alert-danger, .invalid-feedback, .error, "
                    "[class*='error' i]"
                )
                if el:
                    err = (el.inner_text() or "").strip()[:160]
            except Exception:
                pass
            raise RuntimeError(
                f"login failed for user '{self.user}' "
                f"(wrong password or panel rejected it)"
                + (f": {err}" if err else "")
            )

    # ── visit a report page and read every row ────────────────────────
    def _read_page_tables(self) -> list[dict]:
        page = self._page
        assert page
        # Wait briefly so DataTables can finish its AJAX.
        try:
            page.wait_for_load_state("networkidle", timeout=15_000)
        except Exception:
            pass
        # Bump page-length to max so even DOM fallback gets all rows.
        try:
            page.evaluate(
                """() => {
                    const sel = document.querySelector(
                        "select[name$='_length'], .dataTables_length select");
                    if (!sel) return;
                    const opts = [...sel.options].map(o => parseInt(o.value, 10))
                        .filter(n => !isNaN(n));
                    if (!opts.length) return;
                    const max = Math.max(...opts);
                    if (max && Number(sel.value) !== max) {
                        sel.value = String(max);
                        sel.dispatchEvent(new Event('change', { bubbles: true }));
                    }
                }"""
            )
            page.wait_for_timeout(1500)
        except Exception:
            pass
        # 1. DataTables API — the gold path.
        try:
            res = page.evaluate(DATATABLES_READER)
            if res and res.get("ok") and res.get("tables"):
                return res["tables"]
        except Exception:
            pass
        # 2. DOM walk fallback.
        try:
            res = page.evaluate(DOM_READER)
            if res and res.get("ok") and res.get("tables"):
                return res["tables"]
        except Exception:
            pass
        return []

    def _navigate(self, *hints: str) -> bool:
        """Try every hint until one works. A hint is either a URL fragment
        (starts with '/') we navigate to directly, or a menu text that we
        try to click. We try multiple variants because Freeplay24 reshuffles
        its sidebar between releases."""
        page = self._page
        assert page
        for h in hints:
            if h.startswith("/"):
                try:
                    resp = page.goto(self.url.rstrip("/") + h,
                                     wait_until="networkidle", timeout=30_000)
                    # page.goto does NOT raise on 404 — explicitly reject
                    # error responses AND pages whose title says "Not Found"
                    # (Laravel's default 404 view) so we keep trying hints
                    # instead of scraping an empty 404 page.
                    if resp and resp.status >= 400:
                        continue
                    try:
                        title = (page.title() or "").lower()
                    except Exception:
                        title = ""
                    if "not found" in title or "404" in title:
                        continue
                    return True
                except Exception:
                    continue
            else:
                # Expand collapsed menu groups first (common in admin panels).
                for opener in page.query_selector_all(
                    "a.has-arrow, .sidebar .menu-toggle, .nav-item.has-children"
                ):
                    try:
                        opener.click(timeout=500)
                    except Exception:
                        pass
                # Try clicking anything that says the hint (case-insensitive).
                for sel in (
                    f"a:has-text('{h}')",
                    f"button:has-text('{h}')",
                    f"li:has-text('{h}') a",
                    f"[href*='{h.lower()}']",
                ):
                    nodes = page.query_selector_all(sel)
                    for el in nodes:
                        try:
                            el.click(timeout=2_000)
                            page.wait_for_load_state("networkidle",
                                                     timeout=20_000)
                            return True
                        except Exception:
                            continue
        return False

    # ── public: manual-nav scrape ────────────────────────────────────
    # Use when Freeplay24's menu text/URLs don't match our auto-nav
    # heuristics. The user logs in, clicks the deposit page, then
    # presses Enter in the cmd. Repeat for withdrawal.
    def scrape_manual(self) -> ScrapeResult:
        page = self._page
        assert page
        site = "freeplay24"

        input(
            "\n>>> In the Chromium window: open the DEPOSIT report page, "
            "wait until the table is fully loaded, then press Enter here … "
        )
        self._xhr_blobs.clear()
        dep_tables = self._read_page_tables()
        print(f"[manual] deposit page: read {len(dep_tables)} table(s)")

        input(
            "\n>>> Now open the WITHDRAWAL report page, wait for the table, "
            "then press Enter here … "
        )
        self._xhr_blobs.clear()
        wd_tables = self._read_page_tables()
        print(f"[manual] withdrawal page: read {len(wd_tables)} table(s)")

        page_text = page.evaluate("() => document.body.innerText.slice(0, 5000)")
        master = self.master_override or detect_master(
            dep_tables + wd_tables, page_text
        )
        return self._assemble(site, master, dep_tables, wd_tables)

    def _assemble(self, site, master, dep_tables, wd_tables):
        deposits: list[Row] = []
        withdrawals: list[Row] = []
        for t in dep_tables:
            kind, rows = normalize_table(t)
            for r in rows:
                if kind == "mixed":
                    tcol = (r.raw.get("type_col") or "").lower()
                    if "withdraw" in tcol or "wd" in tcol:
                        withdrawals.append(r)
                    else:
                        deposits.append(r)
                else:
                    deposits.append(r)
        for t in wd_tables:
            kind, rows = normalize_table(t)
            for r in rows:
                if kind == "mixed":
                    tcol = (r.raw.get("type_col") or "").lower()
                    if "deposit" in tcol or "dep" in tcol:
                        deposits.append(r)
                    else:
                        withdrawals.append(r)
                else:
                    withdrawals.append(r)

        def dedupe(rs: list[Row]) -> list[Row]:
            seen = set()
            out = []
            for r in rs:
                k = (r.ts[:10], round(r.amount, 2),
                     r.utr.lower().strip(), r.name.lower().strip())
                if k in seen:
                    continue
                seen.add(k)
                out.append(r)
            return out

        return ScrapeResult(
            site=site, master=master,
            deposits=dedupe(deposits), withdrawals=dedupe(withdrawals),
        )

    # ── public: scrape both reports ──────────────────────────────────
    def scrape(self) -> ScrapeResult:
        page = self._page
        assert page
        site = "freeplay24"

        # Real Freeplay24 routes (Laravel-style, confirmed from the live
        # panel sidebar): /deposits/history and /withdraws/history. The
        # older "request" / singular variants are kept as fallbacks for
        # other panel skins.
        # --- Deposit report ---
        self._xhr_blobs.clear()
        self._navigate(
            "/deposits/history", "/deposit/history",
            "/deposits", "/deposit-request", "/deposit",
            "Deposit", "History",
        )
        dep_url = page.url
        dep_tables = self._read_page_tables()

        # --- Withdrawal report ---
        self._xhr_blobs.clear()
        self._navigate(
            # Real Freeplay24 route — /withdrawals/history (NOT /withdraws/…)
            "/withdrawals/history",
            "/withdraws/history", "/withdraw/history",
            "/withdrawals", "/withdraws",
            "/withdraw-request", "/withdrawal", "/withdraw",
            "Withdraw", "History",
        )
        wd_url = page.url
        wd_tables = self._read_page_tables()

        # Safety check: if both navigations landed on the same URL the
        # withdraw nav silently failed — DON'T scrape the same rows twice
        # and tag them as withdrawals. Drop the second batch instead.
        if dep_url == wd_url:
            wd_tables = []

        # Detect master once from whichever set has data.
        page_text = page.evaluate("() => document.body.innerText.slice(0, 5000)")
        master = self.master_override or detect_master(
            dep_tables + wd_tables, page_text
        )
        return self._assemble(site, master, dep_tables, wd_tables)


# ─── CLI helpers ───────────────────────────────────────────────────────
def to_payload(res: ScrapeResult) -> dict:
    def pack(rs: list[Row]) -> list[dict]:
        return [
            {
                "ts": r.ts,
                "amount": r.amount,
                "name": r.name,
                "utr": r.utr,
                "bank": r.bank,
            }
            for r in rs
        ]

    return {
        "site": res.site,
        "master": res.master,
        "deposits": pack(res.deposits),
        "withdrawals": pack(res.withdrawals),
    }


def dump_summary(res: ScrapeResult) -> str:
    return json.dumps(
        {
            "site": res.site,
            "master": res.master,
            "deposits": len(res.deposits),
            "withdrawals": len(res.withdrawals),
            "sample_deposit": (
                to_payload(res)["deposits"][0] if res.deposits else None
            ),
            "sample_withdrawal": (
                to_payload(res)["withdrawals"][0] if res.withdrawals else None
            ),
        },
        indent=2,
        ensure_ascii=False,
    )
