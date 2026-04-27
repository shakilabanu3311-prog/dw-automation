"""B2C Hisab — Freeplay24 Scraper, desktop GUI.

For end-users. No cmd, no env files. Just:
    py -3.12 -m scraper.gui    (or double-click run-gui.bat)

Features:
    • Settings panel (Backend URL, ingest token, Freeplay creds, master override).
      Saved to scraper/.env automatically.
    • One-click "Get token" — logs into the SPA with admin creds, mints a token,
      auto-fills the field.
    • Big Start / Stop button. While running, it scrapes every POLL_SECONDS
      and posts to the backend. Live status panel: last sync time, deposits
      pushed, withdrawals pushed, errors.
    • "Sync now" button for manual one-shot.
    • "Manual mode" checkbox — opens a visible Chromium so you can solve
      captchas / pick the right menu yourself.
    • System tray support (minimise to tray, keep scraping in background).
"""
from __future__ import annotations

import os
import queue
import sys
import threading
import time
import tkinter as tk
import traceback
from pathlib import Path
from tkinter import messagebox, ttk

import requests
from dotenv import load_dotenv

from .freeplay24 import Freeplay24Scraper, to_payload
from .ingest import push
from .panels import (
    PanelCred, enabled_panels, load_panels, save_panels,
    panels_missing_password,
)


HERE = Path(__file__).resolve().parent
ENV_PATH = HERE / ".env"


# ── .env read/write helpers ──────────────────────────────────────────
def load_env() -> dict:
    load_dotenv(ENV_PATH)
    return {
        "BACKEND_URL": os.getenv("BACKEND_URL", ""),
        "INGEST_TOKEN": os.getenv("INGEST_TOKEN", ""),
        "FREEPLAY_URL": os.getenv("FREEPLAY_URL", "https://panel.freeplay24.com/"),
        "FREEPLAY_USER": os.getenv("FREEPLAY_USER", ""),
        "FREEPLAY_PASS": os.getenv("FREEPLAY_PASS", ""),
        "MASTER_OVERRIDE": os.getenv("MASTER_OVERRIDE", ""),
        "POLL_SECONDS": os.getenv("POLL_SECONDS", "60"),
    }


def save_env(values: dict) -> None:
    """Rewrite scraper/.env preserving any other lines."""
    keep_keys = set(values.keys())
    out_lines: list[str] = []
    seen = set()
    if ENV_PATH.exists():
        for line in ENV_PATH.read_text(encoding="utf-8").splitlines():
            stripped = line.strip()
            if stripped and not stripped.startswith("#") and "=" in stripped:
                k = stripped.split("=", 1)[0].strip()
                if k in keep_keys:
                    out_lines.append(f"{k}={values[k]}")
                    seen.add(k)
                    continue
            out_lines.append(line)
    for k in keep_keys - seen:
        out_lines.append(f"{k}={values[k]}")
    ENV_PATH.write_text("\n".join(out_lines) + "\n", encoding="utf-8")


# ── background worker thread ─────────────────────────────────────────
class ScraperWorker(threading.Thread):
    """Runs the scrape loop on its own thread so the UI stays responsive."""

    def __init__(self, cfg: dict, log: queue.Queue, manual: bool = False):
        super().__init__(daemon=True)
        self.cfg = cfg
        self.log = log
        self.manual = manual
        self._stop = threading.Event()
        self._once = threading.Event()  # set by main UI for "Sync now"

    def stop(self):
        self._stop.set()

    def trigger_once(self):
        self._once.set()

    def _emit(self, kind: str, **fields):
        self.log.put({"kind": kind, "ts": time.time(), **fields})

    def run(self):
        try:
            self._loop()
        except Exception as e:
            self._emit("error", msg=f"worker crashed: {e}",
                       trace=traceback.format_exc())

    def _loop(self):
        cfg = self.cfg
        poll = max(15, int(cfg.get("POLL_SECONDS") or 60))
        # First tick immediately — don't wait POLL_SECONDS to scrape on Start.
        last = 0.0
        while not self._stop.is_set():
            now = time.time()
            if self._once.is_set() or (now - last) >= poll:
                self._once.clear()
                last = now
                self._do_one()
            time.sleep(0.5)

    def _do_one(self):
        """One cycle = log into every enabled panel in turn, scrape each,
        post each to the backend. Each panel is independent — one failing
        does not stop the rest."""
        cfg = self.cfg
        panels = enabled_panels()
        if not panels:
            self._emit("status", msg="no enabled panels in panels.json")
            return
        self._emit("status", msg=f"running {len(panels)} panel(s) …")
        total_dep = total_wd = total_ins = total_skip = 0
        skipped_panels = 0
        for pc in panels:
            if not pc.password:
                self._emit("panel_error", name=pc.name,
                           msg="no password set — double-click this panel "
                               "in the Panels list to add it")
                skipped_panels += 1
                continue
            self._emit("status", msg=f"[{pc.name}] login …")
            s = Freeplay24Scraper(
                url=cfg["FREEPLAY_URL"],
                user=pc.user,
                password=pc.password,
                headless=not self.manual,
                master_override=pc.master,
            )
            try:
                s.start()
                s.login()
                res = s.scrape() if not self.manual else s.scrape_manual()
                payload = to_payload(res)
                dep = len(payload["deposits"])
                wd = len(payload["withdrawals"])
                if not (dep or wd):
                    self._emit("panel_done", name=pc.name, master=res.master,
                               deposits=0, withdrawals=0, inserted=0,
                               skipped=0, slug="", mapped=False,
                               note="no rows")
                    continue
                r = push(cfg["BACKEND_URL"], cfg["INGEST_TOKEN"], payload)
                ins = r.get("inserted", 0)
                skp = r.get("skipped", 0)
                total_dep += dep; total_wd += wd
                total_ins += ins; total_skip += skp
                self._emit("panel_done",
                           name=pc.name, master=res.master,
                           deposits=dep, withdrawals=wd,
                           inserted=ins, skipped=skp,
                           slug=r.get("panel_slug", ""),
                           mapped=r.get("mapped", False))
            except Exception as e:
                self._emit("panel_error", name=pc.name, msg=str(e))
            finally:
                try: s.close()
                except Exception: pass
            if self._stop.is_set():
                break
        self._emit("cycle_done", panels=len(panels),
                   deposits=total_dep, withdrawals=total_wd,
                   inserted=total_ins, skipped=total_skip)


# ── main GUI ──────────────────────────────────────────────────────────
class App(tk.Tk):
    PAD = 8

    def __init__(self):
        super().__init__()
        self.title("B2C Hisab — Freeplay24 Scraper")
        self.geometry("700x620")
        self.minsize(620, 520)

        self.cfg = load_env()
        self.worker: ScraperWorker | None = None
        self.log_q: queue.Queue = queue.Queue()

        self._build_settings()
        self._build_panels()
        self._build_controls()
        self._build_log()
        self._tick_log()

    # ── settings panel ─────────────────────────────────────────────
    def _build_settings(self):
        f = ttk.LabelFrame(self, text="Settings", padding=self.PAD)
        f.pack(fill="x", padx=self.PAD, pady=(self.PAD, 0))

        rows = [
            ("Backend URL",     "BACKEND_URL",     False),
            ("Ingest token",    "INGEST_TOKEN",    True),
            ("Freeplay URL",    "FREEPLAY_URL",    False),
            ("Poll seconds",    "POLL_SECONDS",    False),
        ]
        self.vars: dict[str, tk.StringVar] = {}
        for i, (label, key, secret) in enumerate(rows):
            ttk.Label(f, text=label).grid(row=i, column=0, sticky="w",
                                          padx=4, pady=2)
            v = tk.StringVar(value=self.cfg.get(key, ""))
            self.vars[key] = v
            e = ttk.Entry(f, textvariable=v, width=60,
                          show="•" if secret else "")
            e.grid(row=i, column=1, sticky="ew", padx=4, pady=2)
        f.columnconfigure(1, weight=1)

        btns = ttk.Frame(f)
        btns.grid(row=len(rows), column=0, columnspan=2,
                  sticky="ew", pady=(self.PAD, 0))
        ttk.Button(btns, text="Save settings", command=self._save).pack(
            side="left")
        ttk.Button(btns, text="Get ingest token …",
                   command=self._mint_token).pack(side="left", padx=(8, 0))

    # ── panels list manager ───────────────────────────────────────
    def _build_panels(self):
        f = ttk.LabelFrame(self, text="Panels (one Freeplay24 login per row)",
                           padding=self.PAD)
        f.pack(fill="both", expand=False, padx=self.PAD, pady=(self.PAD, 0))

        cols = ("enabled", "name", "user", "password", "master")
        self.tree = ttk.Treeview(f, columns=cols, show="headings", height=8)
        for c, w in zip(cols, (60, 220, 140, 140, 100)):
            self.tree.heading(c, text=c.title())
            self.tree.column(c, width=w, stretch=(c == "name"))
        self.tree.pack(fill="both", expand=True)
        self.tree.bind("<Double-1>", lambda *_: self._edit_panel())
        self._refresh_panels()

        bar = ttk.Frame(f)
        bar.pack(fill="x", pady=(self.PAD, 0))
        ttk.Button(bar, text="Add",   command=self._add_panel).pack(side="left")
        ttk.Button(bar, text="Edit",  command=self._edit_panel).pack(side="left", padx=4)
        ttk.Button(bar, text="Toggle on/off",
                   command=self._toggle_panel).pack(side="left", padx=4)
        ttk.Button(bar, text="Delete",
                   command=self._del_panel).pack(side="left", padx=4)
        ttk.Label(bar, text="(double-click a row to edit)",
                  foreground="#888").pack(side="left", padx=8)

    def _refresh_panels(self):
        self.tree.delete(*self.tree.get_children())
        for i, p in enumerate(load_panels()):
            self.tree.insert(
                "", "end", iid=str(i),
                values=(
                    "✓" if p.enabled else "—",
                    p.name,
                    p.user,
                    "•" * len(p.password) if p.password else "(empty)",
                    p.master,
                ),
            )

    def _selected_panel_idx(self):
        sel = self.tree.selection()
        return int(sel[0]) if sel else None

    def _add_panel(self):
        d = PanelDialog(self, PanelCred(name="", user="", password=""))
        self.wait_window(d)
        if d.result:
            ps = load_panels()
            ps.append(d.result)
            save_panels(ps)
            self._refresh_panels()

    def _edit_panel(self):
        i = self._selected_panel_idx()
        if i is None: return
        ps = load_panels()
        d = PanelDialog(self, ps[i])
        self.wait_window(d)
        if d.result:
            ps[i] = d.result
            save_panels(ps)
            self._refresh_panels()

    def _toggle_panel(self):
        i = self._selected_panel_idx()
        if i is None: return
        ps = load_panels()
        ps[i].enabled = not ps[i].enabled
        save_panels(ps)
        self._refresh_panels()

    def _del_panel(self):
        i = self._selected_panel_idx()
        if i is None: return
        if not messagebox.askyesno("Delete panel",
                                   "Remove this panel from the list?"):
            return
        ps = load_panels()
        del ps[i]
        save_panels(ps)
        self._refresh_panels()

    # ── control panel ─────────────────────────────────────────────
    def _build_controls(self):
        f = ttk.LabelFrame(self, text="Control", padding=self.PAD)
        f.pack(fill="x", padx=self.PAD, pady=self.PAD)

        self.status_var = tk.StringVar(value="idle")
        self.last_var = tk.StringVar(value="never")
        self.deposits_var = tk.StringVar(value="0")
        self.withdrawals_var = tk.StringVar(value="0")

        grid = ttk.Frame(f)
        grid.pack(fill="x")
        for col, (lbl, var) in enumerate([
            ("Status",      self.status_var),
            ("Last sync",   self.last_var),
            ("Deposits",    self.deposits_var),
            ("Withdrawals", self.withdrawals_var),
        ]):
            ttk.Label(grid, text=lbl, foreground="#888").grid(
                row=0, column=col, sticky="w", padx=8)
            ttk.Label(grid, textvariable=var, font=("Segoe UI", 11, "bold")).grid(
                row=1, column=col, sticky="w", padx=8)

        btns = ttk.Frame(f)
        btns.pack(fill="x", pady=(self.PAD, 0))
        self.manual_var = tk.BooleanVar(value=False)
        ttk.Checkbutton(btns, text="Manual mode (visible browser; pick menus by hand)",
                        variable=self.manual_var).pack(side="left")
        self.start_btn = ttk.Button(btns, text="Start", command=self._start)
        self.start_btn.pack(side="right")
        self.stop_btn = ttk.Button(btns, text="Stop", command=self._stop,
                                   state="disabled")
        self.stop_btn.pack(side="right", padx=(0, 8))
        self.once_btn = ttk.Button(btns, text="Sync now", command=self._once,
                                   state="disabled")
        self.once_btn.pack(side="right", padx=(0, 8))

    # ── log panel ─────────────────────────────────────────────────
    def _build_log(self):
        f = ttk.LabelFrame(self, text="Activity", padding=self.PAD)
        f.pack(fill="both", expand=True, padx=self.PAD, pady=(0, self.PAD))
        self.log = tk.Text(f, height=12, wrap="word",
                           background="#111", foreground="#cfd",
                           insertbackground="#cfd",
                           font=("Consolas", 9))
        self.log.pack(fill="both", expand=True)
        self.log.configure(state="disabled")

    def _append(self, txt: str):
        self.log.configure(state="normal")
        self.log.insert("end", txt + "\n")
        self.log.see("end")
        self.log.configure(state="disabled")

    # ── actions ───────────────────────────────────────────────────
    def _save(self):
        for k, v in self.vars.items():
            self.cfg[k] = v.get().strip()
        save_env(self.cfg)
        self._append("[settings] saved to scraper/.env")

    def _mint_token(self):
        # Modal asking for admin creds → hits /api/auth/login → /api/auth/tokens.
        backend = self.vars["BACKEND_URL"].get().strip()
        if not backend:
            messagebox.showerror("Missing", "Set Backend URL first, then Save.")
            return
        d = TokenDialog(self, backend)
        self.wait_window(d)
        if d.token:
            self.vars["INGEST_TOKEN"].set(d.token)
            self._save()
            self._append("[token] saved")

    def _start(self):
        self._save()
        if not self.cfg["BACKEND_URL"] or not self.cfg["INGEST_TOKEN"]:
            messagebox.showerror("Missing config",
                                 "Backend URL and Ingest token are required.")
            return
        eps = enabled_panels()
        if not eps:
            messagebox.showerror(
                "No panels",
                "No enabled panels.\n"
                "Toggle some panels on in the Panels list above.")
            return
        missing = panels_missing_password()
        if missing:
            names = "\n  • ".join(p.name for p in missing)
            ans = messagebox.askyesno(
                "Missing passwords",
                f"These enabled panels have NO password set:\n\n"
                f"  • {names}\n\n"
                f"They will be skipped with an error each cycle.\n"
                f"Double-click a row in the Panels list to set its "
                f"password.\n\nStart anyway?")
            if not ans:
                return
        if self.worker and self.worker.is_alive():
            return
        self.worker = ScraperWorker(self.cfg, self.log_q,
                                    manual=self.manual_var.get())
        self.worker.start()
        self.start_btn.configure(state="disabled")
        self.stop_btn.configure(state="normal")
        self.once_btn.configure(state="normal")
        self.status_var.set("starting …")
        self._append("[run] started")

    def _stop(self):
        if self.worker:
            self.worker.stop()
        self.start_btn.configure(state="normal")
        self.stop_btn.configure(state="disabled")
        self.once_btn.configure(state="disabled")
        self.status_var.set("stopping …")
        self._append("[run] stop requested")

    def _once(self):
        if self.worker:
            self.worker.trigger_once()
            self._append("[run] manual sync requested")

    # ── log pump ──────────────────────────────────────────────────
    def _tick_log(self):
        try:
            while True:
                ev = self.log_q.get_nowait()
                k = ev.get("kind")
                tstxt = time.strftime("%H:%M:%S", time.localtime(ev.get("ts")))
                if k == "ok":
                    self.status_var.set("ok")
                    self.last_var.set(tstxt)
                    self.deposits_var.set(str(ev.get("deposits", 0)))
                    self.withdrawals_var.set(str(ev.get("withdrawals", 0)))
                    self._append(
                        f"{tstxt}  ✓  master={ev.get('master')}  "
                        f"deposits={ev.get('deposits')} withdrawals={ev.get('withdrawals')}  "
                        f"inserted={ev.get('inserted')} skipped={ev.get('skipped')}  "
                        f"slug={ev.get('slug')} mapped={ev.get('mapped')}"
                    )
                elif k == "status":
                    self.status_var.set(ev.get("msg", ""))
                    self._append(f"{tstxt}  …  {ev.get('msg')}")
                elif k == "panel_done":
                    note = ev.get("note", "")
                    self._append(
                        f"{tstxt}  ▸  [{ev.get('name')}] master={ev.get('master')}  "
                        f"dep={ev.get('deposits')} wd={ev.get('withdrawals')}  "
                        f"ins={ev.get('inserted')} skp={ev.get('skipped')}  "
                        f"slug={ev.get('slug')} mapped={ev.get('mapped')}"
                        + (f"  ({note})" if note else "")
                    )
                elif k == "panel_error":
                    self._append(
                        f"{tstxt}  ✗  [{ev.get('name')}] {ev.get('msg')}")
                elif k == "cycle_done":
                    self.status_var.set("ok")
                    self.last_var.set(tstxt)
                    self.deposits_var.set(str(ev.get("deposits", 0)))
                    self.withdrawals_var.set(str(ev.get("withdrawals", 0)))
                    self._append(
                        f"{tstxt}  ✓ cycle done — {ev.get('panels')} panels  "
                        f"dep={ev.get('deposits')} wd={ev.get('withdrawals')}  "
                        f"ins={ev.get('inserted')} skp={ev.get('skipped')}"
                    )
                elif k == "error":
                    self.status_var.set("error")
                    self._append(f"{tstxt}  ✗  {ev.get('msg')}")
                    if ev.get("trace"):
                        self._append(ev["trace"])
        except queue.Empty:
            pass
        self.after(250, self._tick_log)


# ── token mint dialog ────────────────────────────────────────────────
class TokenDialog(tk.Toplevel):
    def __init__(self, parent: App, backend: str):
        super().__init__(parent)
        self.title("Get ingest token")
        self.transient(parent)
        self.grab_set()
        self.resizable(False, False)
        self.token: str | None = None
        self.backend = backend.rstrip("/")

        f = ttk.Frame(self, padding=12)
        f.pack(fill="both", expand=True)
        ttk.Label(f, text=f"Backend:  {backend}").grid(
            row=0, column=0, columnspan=2, sticky="w", pady=(0, 8))
        ttk.Label(f, text="Admin user").grid(row=1, column=0, sticky="w")
        self.u = tk.StringVar(value="admin")
        ttk.Entry(f, textvariable=self.u, width=30).grid(
            row=1, column=1, sticky="ew", padx=4, pady=2)
        ttk.Label(f, text="Password").grid(row=2, column=0, sticky="w")
        self.p = tk.StringVar()
        ttk.Entry(f, textvariable=self.p, show="•", width=30).grid(
            row=2, column=1, sticky="ew", padx=4, pady=2)
        ttk.Button(f, text="Mint token", command=self._go).grid(
            row=3, column=0, columnspan=2, pady=(8, 0))
        f.columnconfigure(1, weight=1)
        self.bind("<Return>", lambda *_: self._go())

    def _go(self):
        try:
            s = requests.Session()
            r = s.post(f"{self.backend}/api/auth/login",
                       json={"username": self.u.get(),
                             "password": self.p.get()}, timeout=20)
            if not r.ok:
                messagebox.showerror("Login failed",
                                     f"HTTP {r.status_code}\n{r.text[:200]}")
                return
            r = s.post(f"{self.backend}/api/auth/tokens",
                       json={"label": "freeplay-scraper-gui"}, timeout=20)
            if not r.ok:
                messagebox.showerror("Token failed",
                                     f"HTTP {r.status_code}\n{r.text[:200]}")
                return
            body = r.json()
            tok = body.get("token") or body.get("raw") or body.get("api_token")
            if not tok:
                messagebox.showerror("No token",
                                     f"Unexpected response:\n{body}")
                return
            self.token = tok
            self.destroy()
        except Exception as e:
            messagebox.showerror("Error", str(e))


# ── add/edit-panel dialog ────────────────────────────────────────────
class PanelDialog(tk.Toplevel):
    """Modal for adding or editing one panel row."""

    def __init__(self, parent: App, p: PanelCred):
        super().__init__(parent)
        self.title("Panel")
        self.transient(parent)
        self.grab_set()
        self.resizable(False, False)
        self.result: PanelCred | None = None

        f = ttk.Frame(self, padding=12)
        f.pack(fill="both", expand=True)

        self.name = tk.StringVar(value=p.name)
        self.user = tk.StringVar(value=p.user)
        self.password = tk.StringVar(value=p.password)
        self.master = tk.StringVar(value=p.master)
        self.enabled = tk.BooleanVar(value=p.enabled)
        self.note = tk.StringVar(value=p.note)

        rows = [
            ("Name (label)",          self.name,     False),
            ("Freeplay24 user",       self.user,     False),
            ("Freeplay24 password",   self.password, True),
            ("Master code",           self.master,   False),
            ("Note (optional)",       self.note,     False),
        ]
        for i, (lbl, var, secret) in enumerate(rows):
            ttk.Label(f, text=lbl).grid(row=i, column=0, sticky="w", pady=2)
            ttk.Entry(f, textvariable=var, width=36,
                      show="•" if secret else "").grid(
                row=i, column=1, sticky="ew", padx=6, pady=2)
        ttk.Checkbutton(f, text="Enabled (include in scrape cycles)",
                        variable=self.enabled).grid(
            row=len(rows), column=0, columnspan=2, sticky="w", pady=(6, 0))

        bar = ttk.Frame(f)
        bar.grid(row=len(rows) + 1, column=0, columnspan=2,
                 sticky="ew", pady=(10, 0))
        ttk.Button(bar, text="Cancel", command=self.destroy).pack(side="right")
        ttk.Button(bar, text="OK", command=self._ok).pack(
            side="right", padx=(0, 6))
        f.columnconfigure(1, weight=1)
        self.bind("<Return>", lambda *_: self._ok())
        self.bind("<Escape>", lambda *_: self.destroy())

    def _ok(self):
        if not self.user.get().strip():
            messagebox.showerror("Missing", "User is required.")
            return
        self.result = PanelCred(
            name=self.name.get().strip() or self.user.get().strip(),
            user=self.user.get().strip(),
            password=self.password.get(),
            master=self.master.get().strip().upper(),
            enabled=bool(self.enabled.get()),
            note=self.note.get().strip(),
        )
        self.destroy()


def main() -> int:
    app = App()
    app.mainloop()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
