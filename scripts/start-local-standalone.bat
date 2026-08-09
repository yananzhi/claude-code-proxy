@echo off
REM ============================================================
REM  start-local-standalone.bat
REM  Start local standalone web service (localhost only, no frpc tunnel):
REM    - proxy console  : http://127.0.0.1:11444
REM    - management page: http://127.0.0.1:11544
REM
REM  Uses a separate CCP_HOME (~\.claude-code-proxy-standalone) to avoid
REM  port conflict with VS Code extension mode (default ~/.claude-code-proxy,
REM  ports 11434/11534). Both can run at the same time.
REM  Port config lives in that CCP_HOME's proxy-config.json (listenPort=11444).
REM  Service runs in a foreground new window; closing the window = stop.
REM ============================================================

setlocal

REM --- Path config (edit to match your environment) ---
set "PROJECT_DIR=D:\work_dir\claude-code-proxy"
set "STANDALONE_HOME=%USERPROFILE%\.claude-code-proxy-standalone"

echo ============================================================
echo  Starting local standalone (localhost only)
echo ============================================================
echo PROJECT_DIR      = %PROJECT_DIR%
echo STANDALONE_HOME  = %STANDALONE_HOME%
echo.

REM --- Check project entry exists ---
if not exist "%PROJECT_DIR%\standalone\cli.js" (
    echo [ERROR] standalone\cli.js not found: %PROJECT_DIR%\standalone\cli.js
    echo         Edit PROJECT_DIR at the top of this script.
    pause & exit /b 1
)

REM --- Check port 11444 not already in use (avoid duplicate start) ---
netstat -ano | findstr ":11444 " | findstr "LISTENING" >nul
if %errorlevel%==0 (
    echo [WARN] Port 11444 already in use. standalone may already be running.
    echo        Run stop-local-standalone.bat first to restart.
    pause & exit /b 1
)
echo [OK] port 11444 free

REM --- Ensure separate CCP_HOME exists (config must be created beforehand) ---
if not exist "%STANDALONE_HOME%\proxy-config.json" (
    echo [ERROR] Separate CCP_HOME config not found:
    echo         %STANDALONE_HOME%\proxy-config.json
    echo         Create it first with listenPort=11444. See docs/frp-tunnel-deploy.md.
    pause & exit /b 1
)
echo [OK] standalone CCP_HOME config found
echo.

echo ============================================================
echo  Starting local standalone
echo  - console    : http://127.0.0.1:11444
echo  - management : http://127.0.0.1:11544
echo  - close the CCP-Local window to stop, or run stop-local-standalone.bat
echo ============================================================

REM --- Start standalone (new foreground window; close window = stop) ---
REM    Inline set CCP_HOME + cd + node. No helper script (the old
REM    run-standalone.bat was deleted: a missing arg made it fall back to
REM    the default port 11434 and collide with extension mode).
start "CCP-Local" cmd /k "set "CCP_HOME=%STANDALONE_HOME%" && cd /d "%PROJECT_DIR%" && node standalone/cli.js"

REM --- Wait for standalone to listen on 11444 ---
echo       waiting for web service to listen on 11444...
set /a TRIES=0
:WAIT_WEB
ping -n 2 127.0.0.1 >nul
netstat -ano | findstr ":11444 " | findstr "LISTENING" >nul
if %errorlevel%==0 goto WEB_OK
set /a TRIES+=1
echo       ...not ready yet (attempt %TRIES%/10)
if %TRIES% lss 10 goto WAIT_WEB
echo [ERROR] standalone did not listen on 11444 within 20s. Check CCP-Local window log.
pause & exit /b 1

:WEB_OK
echo [OK] standalone ready
echo   console    : http://127.0.0.1:11444
echo   management : http://127.0.0.1:11544
echo.
if /i not "%~1"=="nopause" pause
endlocal
