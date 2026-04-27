@echo off
REM Double-click this to launch the B2C Hisab Freeplay24 Scraper GUI.
REM No cmd skills needed — settings, start/stop, status are all in the window.
cd /d "%~dp0"
py -3.12 -m scraper.gui
if errorlevel 1 pause
