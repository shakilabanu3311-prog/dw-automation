@echo off
REM One-time setup: pip install + playwright browser download.
cd /d "%~dp0"
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
python -m playwright install chromium
if not exist .env copy .env.example .env
echo.
echo --------------------------------------------------------
echo  setup done. edit scraper\.env with your credentials.
echo  then: scraper\run.bat --headed --dry-run   (first time)
echo --------------------------------------------------------
