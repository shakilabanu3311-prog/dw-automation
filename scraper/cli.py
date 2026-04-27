"""b2c_hisab Freeplay24 scraper CLI.

Usage:
  # one-shot: scrape and post once
  python -m scraper.cli

  # one-shot, just print what we'd post (no upload)
  python -m scraper.cli --dry-run

  # watch mode: scrape every POLL_SECONDS forever
  python -m scraper.cli --watch

  # show the browser (useful first run / debugging)
  python -m scraper.cli --headed --dry-run
"""
from __future__ import annotations

import argparse
import os
import sys
import time
from pathlib import Path

from dotenv import load_dotenv

from .freeplay24 import Freeplay24Scraper, dump_summary, to_payload
from .ingest import push


def main(argv: list[str] | None = None) -> int:
    here = Path(__file__).resolve().parent
    load_dotenv(here / ".env")

    p = argparse.ArgumentParser(prog="scraper")
    p.add_argument("--dry-run", action="store_true",
                   help="print payload, do not POST to backend")
    p.add_argument("--headed", action="store_true",
                   help="show the Chromium window (overrides HEADLESS env)")
    p.add_argument("--watch", action="store_true",
                   help="run forever every POLL_SECONDS")
    p.add_argument("--manual", action="store_true",
                   help="open browser, you click the deposit/withdrawal "
                        "menu yourself, scraper just reads (forces --headed)")
    p.add_argument("--no-login", action="store_true",
                   help="skip auto-login; use with --manual when you want "
                        "to log in by hand (e.g. captcha/2fa)")
    p.add_argument("--once-then-exit", action="store_true",
                   help=argparse.SUPPRESS)  # for tests
    args = p.parse_args(argv)

    cfg = {
        "url": os.getenv("FREEPLAY_URL", "https://panel.freeplay24.com/"),
        "user": os.getenv("FREEPLAY_USER", ""),
        "pwd":  os.getenv("FREEPLAY_PASS", ""),
        "headless": (os.getenv("HEADLESS", "1") not in ("0", "false", "no", "")) and not args.headed and not args.manual,
        "master_override": os.getenv("MASTER_OVERRIDE", ""),
        "backend": os.getenv("BACKEND_URL", "http://localhost:3000"),
        "token":   os.getenv("INGEST_TOKEN", ""),
        "poll":    int(os.getenv("POLL_SECONDS", "60") or 60),
    }
    if not cfg["user"] or not cfg["pwd"]:
        print("ERROR: FREEPLAY_USER / FREEPLAY_PASS missing in scraper/.env",
              file=sys.stderr)
        return 2

    s = Freeplay24Scraper(
        url=cfg["url"],
        user=cfg["user"],
        password=cfg["pwd"],
        headless=cfg["headless"],
        master_override=cfg["master_override"],
    )

    def run_once() -> int:
        s.start()
        try:
            if args.no_login:
                print(f"[scrape] opening {cfg['url']} — log in by hand, then press Enter")
                s._page.goto(cfg["url"], wait_until="domcontentloaded", timeout=60_000)
                input(">>> Press Enter once you're logged in … ")
            else:
                print(f"[scrape] login {cfg['url']}")
                s.login()
            if args.manual:
                print("[scrape] manual-nav mode: click the menus yourself")
                res = s.scrape_manual()
            else:
                print("[scrape] logged in, reading reports …")
                res = s.scrape()
            print("[scrape] result:")
            print(dump_summary(res))
            if args.dry_run:
                return 0
            payload = to_payload(res)
            if not (payload["deposits"] or payload["withdrawals"]):
                print("[scrape] no rows — nothing to push")
                return 0
            r = push(cfg["backend"], cfg["token"], payload)
            print(f"[scrape] backend OK: {r}")
            return 0
        finally:
            s.close()

    if not args.watch:
        return run_once()

    while True:
        try:
            run_once()
        except Exception as e:
            print(f"[scrape] error: {e}", file=sys.stderr)
        if args.once_then_exit:
            return 0
        time.sleep(cfg["poll"])


if __name__ == "__main__":
    raise SystemExit(main())
