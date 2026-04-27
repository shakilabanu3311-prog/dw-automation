"""One-shot helper to mint an ingest token.

Logs into the b2c_hisab SPA with admin credentials and calls
POST /api/auth/tokens to create a Bearer token labelled "freeplay-scraper".
Prints the raw token — paste it into scraper/.env as INGEST_TOKEN.

Usage:
    python -m scraper.get_token
    python -m scraper.get_token --backend https://<app>.up.railway.app \
                                --user admin --password admin123
"""
from __future__ import annotations

import argparse
import getpass
import os
import sys
from pathlib import Path

import requests
from dotenv import load_dotenv


def main(argv: list[str] | None = None) -> int:
    here = Path(__file__).resolve().parent
    load_dotenv(here / ".env")

    p = argparse.ArgumentParser(prog="get_token")
    p.add_argument("--backend",
                   default=os.getenv("BACKEND_URL", "http://localhost:3000"))
    p.add_argument("--user", default=os.getenv("ADMIN_USER", "admin"))
    p.add_argument("--password", default=os.getenv("ADMIN_PASS", ""))
    p.add_argument("--label", default="freeplay-scraper")
    args = p.parse_args(argv)

    pwd = args.password or getpass.getpass(f"Password for {args.user}: ")

    s = requests.Session()
    base = args.backend.rstrip("/")

    r = s.post(f"{base}/api/auth/login",
               json={"username": args.user, "password": pwd},
               timeout=20)
    if not r.ok:
        print(f"login failed: HTTP {r.status_code} {r.text[:300]}",
              file=sys.stderr)
        return 1

    r = s.post(f"{base}/api/auth/tokens", json={"label": args.label},
               timeout=20)
    if not r.ok:
        print(f"token mint failed: HTTP {r.status_code} {r.text[:300]}",
              file=sys.stderr)
        return 1

    body = r.json()
    token = body.get("token") or body.get("raw") or body.get("api_token")
    if not token:
        # Different shape — print whatever the server returned so we can see.
        print("server response (look for the token):")
        print(body)
        return 1

    print()
    print("=" * 60)
    print("INGEST_TOKEN =", token)
    print("=" * 60)
    print()
    print("Paste that into scraper/.env on the INGEST_TOKEN= line.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
