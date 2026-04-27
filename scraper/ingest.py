"""POST scraped rows to the b2c_hisab backend.

Talks to /api/ingest/panel which already exists and is what the (broken)
Chrome extension was supposed to call. Auth is a Bearer token created in
the SPA's Settings tab.
"""
from __future__ import annotations

import requests


def push(backend_url: str, token: str, payload: dict, timeout: int = 30) -> dict:
    if not backend_url:
        raise ValueError("BACKEND_URL is required")
    if not token:
        raise ValueError("INGEST_TOKEN is required (create in Settings → Ingest token)")
    url = backend_url.rstrip("/") + "/api/ingest/panel"
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }
    r = requests.post(url, json=payload, headers=headers, timeout=timeout)
    # Surface server-side errors with status + body so the operator can see
    # what's wrong (e.g. token bad, panel_map missing the master).
    if not r.ok:
        raise RuntimeError(f"ingest failed: HTTP {r.status_code} — {r.text[:400]}")
    return r.json()
