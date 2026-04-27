"""Multi-panel config — read/write scraper/panels.json.

Replaces the old single FREEPLAY_USER/FREEPLAY_PASS in .env. The user
runs ten panels (Branch 1: 1XBET0001..0004, Branch 2: LASER0001..0003 + RADHE,
Branch 3: TIGEREXCH0001 + 1XCLUB0001), each with its own Freeplay24 login
and master code. The scraper logs into each enabled entry every cycle.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, asdict
from pathlib import Path

PANELS_PATH = Path(__file__).resolve().parent / "panels.json"


@dataclass
class PanelCred:
    name: str
    user: str
    password: str
    master: str = ""
    enabled: bool = True
    note: str = ""

    @classmethod
    def from_dict(cls, d: dict) -> "PanelCred":
        return cls(
            name=str(d.get("name", d.get("user", "(unnamed)"))),
            user=str(d.get("user", "")),
            password=str(d.get("password", "")),
            master=str(d.get("master", "")).upper(),
            enabled=bool(d.get("enabled", True)),
            note=str(d.get("note", "")),
        )


def load_panels() -> list[PanelCred]:
    if not PANELS_PATH.exists():
        return []
    try:
        raw = json.loads(PANELS_PATH.read_text(encoding="utf-8"))
    except Exception:
        return []
    if not isinstance(raw, list):
        return []
    return [PanelCred.from_dict(d) for d in raw if isinstance(d, dict)]


def save_panels(panels: list[PanelCred]) -> None:
    PANELS_PATH.write_text(
        json.dumps([asdict(p) for p in panels], indent=2, ensure_ascii=False),
        encoding="utf-8",
    )


def enabled_panels() -> list[PanelCred]:
    """All toggled-on panels with a user. Password may still be empty —
    the GUI surfaces that as a visible error per panel rather than
    silently dropping the row (which made the app look 'not fetching')."""
    return [p for p in load_panels() if p.enabled and p.user]


def panels_missing_password() -> list[PanelCred]:
    return [p for p in load_panels() if p.enabled and p.user and not p.password]
