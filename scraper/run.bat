@echo off
REM Windows launcher for the b2c_hisab Freeplay24 scraper.
REM First run: install.bat   (installs Playwright + Chromium)
REM Then run : run.bat        (one-shot)
REM Or:        run.bat --watch  (re-scrape every POLL_SECONDS)

cd /d "%~dp0\.."
python -m scraper.cli %*
