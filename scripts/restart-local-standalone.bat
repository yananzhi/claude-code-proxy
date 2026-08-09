@echo off
REM ============================================================
REM  restart-local-standalone.bat
REM  Restart local standalone service (stop then start, localhost only)
REM ============================================================

setlocal
set "SCRIPT_DIR=%~dp0"

echo ============================================================
echo  Restart local standalone service
echo ============================================================
echo.

echo === Step 1: stop ===
call "%SCRIPT_DIR%stop-local-standalone.bat" nopause
echo.

echo === Step 2: start ===
call "%SCRIPT_DIR%start-local-standalone.bat" nopause

endlocal
