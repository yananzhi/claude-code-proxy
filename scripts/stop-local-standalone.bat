@echo off
REM ============================================================
REM  stop-local-standalone.bat
REM  Stop local standalone web service (11444/11544).
REM
REM  Precision stop: look up PID by port 11444/11544, kill only
REM  the standalone node.exe process, never touch VS Code extension
REM  (which runs on 11434/11534).
REM ============================================================

setlocal enabledelayedexpansion

echo ============================================================
echo  Stopping local standalone (11444/11544)
echo ============================================================

set "KILLED="
for %%P in (11444 11544) do (
    for /f "tokens=5" %%N in ('netstat -ano ^| findstr ":%%P " ^| findstr "LISTENING"') do (
        if not "%%N"=="0" (
            tasklist /fi "PID eq %%N" | findstr /i "node.exe" >nul
            if !errorlevel!==0 (
                taskkill /F /PID %%N >nul 2>&1
                echo       Stopped node (PID %%N, port %%P)
                set "KILLED=1"
            )
        )
    )
)

if not defined KILLED (
    echo       standalone not running (no node on 11444/11544)
)

echo.
echo ============================================================
echo  Local standalone stopped
echo  - VS Code extension mode (11434/11534) unaffected
echo ============================================================
echo.
if /i not "%~1"=="nopause" pause
endlocal
