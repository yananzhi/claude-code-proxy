@echo off
REM ============================================================
REM  run-standalone.bat  (helper, called by start-external-service.bat)
REM  Starts standalone web service with the separate CCP_HOME.
REM  Using a separate script avoids nested-quote issues in the
REM  parent's `start cmd /k "..."` call.
REM ============================================================

REM --- CCP_HOME is passed in by the caller; quote it to avoid
REM     trailing-space being swallowed into the value ---
set "CCP_HOME=%~1"

REM --- cd to project dir (passed as 2nd arg) ---
cd /d "%~2"

node standalone/cli.js
