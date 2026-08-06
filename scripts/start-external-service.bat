@echo off
REM ============================================================
REM  start-external-service.bat
REM  Start local external services:
REM    1. standalone web mode (proxy 11444 + management 11544)
REM    2. frpc tunnel (expose 11444/11544 to public via frps)
REM
REM  Design:
REM    - standalone uses a separate CCP_HOME (~\.claude-code-proxy-standalone)
REM      to avoid port conflict with VS Code extension mode
REM      (default ~/.claude-code-proxy, ports 11434/11534).
REM    - Port config lives in the separate CCP_HOME proxy-config.json (listenPort=11444).
REM    - Services run in new foreground windows; closing window = stop service.
REM ============================================================

setlocal

REM --- Path config (edit to match your environment) ---
set "PROJECT_DIR=D:\work_dir\claude-code-proxy"
set "STANDALONE_HOME=%USERPROFILE%\.claude-code-proxy-standalone"
set "FRPC_EXE=C:\frp\frpc.exe"
set "FRPC_CONF=C:\frp\frpc.toml"

REM --- Check paths exist ---
if not exist "%PROJECT_DIR%\standalone\cli.js" (
    echo [ERROR] standalone\cli.js not found: %PROJECT_DIR%\standalone\cli.js
    echo         Edit PROJECT_DIR at the top of this script.
    pause & exit /b 1
)
if not exist "%FRPC_EXE%" (
    echo [ERROR] frpc.exe not found: %FRPC_EXE%
    echo         Edit FRPC_EXE at the top of this script.
    pause & exit /b 1
)
if not exist "%FRPC_CONF%" (
    echo [ERROR] frpc.toml not found: %FRPC_CONF%
    pause & exit /b 1
)

REM --- Check port 11444 not already in use (avoid duplicate start) ---
netstat -ano | findstr ":11444 " | findstr "LISTENING" >nul
if %errorlevel%==0 (
    echo [WARN] Port 11444 already in use. standalone may already be running.
    echo        Run stop-external-service.bat first to restart.
    pause & exit /b 1
)

REM --- Ensure separate CCP_HOME exists (config must be created beforehand) ---
if not exist "%STANDALONE_HOME%\proxy-config.json" (
    echo [ERROR] Separate CCP_HOME config not found:
    echo         %STANDALONE_HOME%\proxy-config.json
    echo         Create it first with listenPort=11444. See docs/frp-tunnel-deploy.md.
    pause & exit /b 1
)

echo ============================================================
echo  Starting external services
echo  - standalone web:  http://127.0.0.1:11444 (console)
echo                     http://127.0.0.1:11544 (management)
echo  - frpc tunnel:     connects to public frps, exposes via subdomains
echo ============================================================

REM --- Start standalone (new window, foreground; close window = stop) ---
echo [1/2] Starting standalone web service...
start "CCP-Standalone" cmd /k ""%~dp0run-standalone.bat" "%STANDALONE_HOME%" "%PROJECT_DIR%""

REM --- Wait for standalone to listen on 11444 ---
echo       Waiting for web service to be ready...
set /a TRIES=0
:WAIT_WEB
ping -n 2 127.0.0.1 >nul
netstat -ano | findstr ":11444 " | findstr "LISTENING" >nul
if %errorlevel%==0 goto WEB_OK
set /a TRIES+=1
if %TRIES% lss 10 goto WAIT_WEB
echo [ERROR] standalone did not listen on 11444 within 20s. Check CCP-Standalone window log.
pause & exit /b 1

:WEB_OK
echo       standalone ready (11444/11544)

REM --- Start frpc (new window, foreground) ---
echo [2/2] Starting frpc tunnel...
start "CCP-Frpc" cmd /k ""%FRPC_EXE%" -c "%FRPC_CONF%""

REM --- Wait for frpc to connect ---
ping -n 3 127.0.0.1 >nul
echo.
echo ============================================================
echo  External services started
echo  - Close the CCP-Standalone / CCP-Frpc windows to stop
echo  - Or run stop-external-service.bat
echo ============================================================
echo.
if /i not "%~1"=="nopause" pause
endlocal
