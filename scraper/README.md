# Freeplay24 scraper (Python + Playwright)

Replaces the Chrome extension's broken Freeplay24 path with a real browser
driver that **can** read jQuery DataTables (which MV3 isolated-world content
scripts cannot). It also intercepts the panel's XHR responses as a fallback,
so you get every approved deposit/withdrawal row across every page —
not just the visible page.

## Setup (one-time)

```bat
cd scraper
install.bat
```

This installs `playwright`, `requests`, downloads Chromium, and copies
`.env.example` → `.env`. Open `scraper\.env` and fill in:

```
FREEPLAY_USER=Maha0001
FREEPLAY_PASS=Asdf@1234
BACKEND_URL=http://localhost:3000        # or your Railway URL
INGEST_TOKEN=…                           # Settings → Ingest token in the SPA
```

## Run

```bat
REM first time — see what the browser sees, don't post yet
scraper\run.bat --headed --dry-run

REM normal one-shot — scrape and post
scraper\run.bat

REM background loop — scrape every POLL_SECONDS
scraper\run.bat --watch
```

## How it works

1. Playwright launches Chromium and logs into `panel.freeplay24.com`.
2. Clicks the Deposit / Withdrawal menu items.
3. Bumps the DataTables page-length dropdown to its max so all rows render.
4. Reads rows in this order (keeps whichever wins):
   - **`page.evaluate(jQuery.fn.dataTable.tables(...).rows().data())`** —
     gets *every page* of *every* DataTables instance. (This is the path
     the Chrome extension couldn't take.)
   - **DOM walk** of `<table>` elements (visible page only).
   - **XHR sniffer** — JSON responses to URLs containing `deposit`,
     `withdraw`, `transaction`, or `?draw=` are stashed during scraping.
5. For each row:
   - Filters by status: only `approved` (regex matches the JS extension exactly).
   - Detects master/account from the `MASTER` column (most-frequent value),
     falling back to a sidebar/topbar `XXXX0000` token.
   - Normalises date → ISO with IST tz so the server's `businessDate()` lands
     it in the correct book around the 05:30 cutoff.
6. POSTs `{ site, master, deposits, withdrawals }` to
   `/api/ingest/panel` with `Authorization: Bearer <INGEST_TOKEN>`.

## Mapping panels

The backend has a `panel_map` setting that maps `freeplay24:<MASTER>` →
sheet slug (e.g. `1XBET0001`). If the scraper finds a master that isn't
mapped, the row still ingests with slug `freeplay24:<MASTER>` and shows up
in Settings → Panel Mapping as an unmapped source. Add the mapping there.

## Watch mode + auto-restart

Run inside any process supervisor (Task Scheduler, NSSM, `pm2 start
run.bat --name freeplay-scraper`, etc.). `--watch` already retries on its
own loop and prints errors to stderr without crashing.
