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

REM --- Public access URLs (frpc tunnel exposes these via subdomains) ---
set "PUBLIC_MGMT_URL=https://mgmt.aiguard.site/"
set "PUBLIC_TRACE_URL=https://trace.aiguard.site/"

REM --- Log helper: prints [HH:MM:SS] message to console ---
REM    (used so the window log shows a clear timeline of each step)
goto :START
:LOG
echo [%TIME:~0,2%:%TIME:~3,2%:%TIME:~6,2%] %*
goto :eof
:START

REM --- Path config (edit to match your environment) ---
set "PROJECT_DIR=D:\work_dir\claude-code-proxy"
set "STANDALONE_HOME=%USERPROFILE%\.claude-code-proxy-standalone"
set "FRPC_EXE=C:\frp\frpc.exe"
set "FRPC_CONF=C:\frp\frpc.toml"

call :LOG === start-external-service begin ===
call :LOG PROJECT_DIR      = %PROJECT_DIR%
call :LOG STANDALONE_HOME  = %STANDALONE_HOME%
call :LOG FRPC_EXE         = %FRPC_EXE%
call :LOG FRPC_CONF        = %FRPC_CONF%
call :LOG PUBLIC_MGMT_URL  = %PUBLIC_MGMT_URL%
call :LOG PUBLIC_TRACE_URL = %PUBLIC_TRACE_URL%

REM --- Check paths exist ---
if not exist "%PROJECT_DIR%\standalone\cli.js" (
    call :LOG [ERROR] standalone\cli.js not found: %PROJECT_DIR%\standalone\cli.js
    echo         Edit PROJECT_DIR at the top of this script.
    pause & exit /b 1
)
if not exist "%FRPC_EXE%" (
    call :LOG [ERROR] frpc.exe not found: %FRPC_EXE%
    echo         Edit FRPC_EXE at the top of this script.
    pause & exit /b 1
)
if not exist "%FRPC_CONF%" (
    call :LOG [ERROR] frpc.toml not found: %FRPC_CONF%
    pause & exit /b 1
)
call :LOG [OK] all paths exist

REM --- Check port 11444 not already in use (avoid duplicate start) ---
netstat -ano | findstr ":11444 " | findstr "LISTENING" >nul
if %errorlevel%==0 (
    call :LOG [WARN] Port 11444 already in use. standalone may already be running.
    echo        Run stop-external-service.bat first to restart.
    pause & exit /b 1
)
call :LOG [OK] port 11444 free

REM --- Ensure separate CCP_HOME exists (config must be created beforehand) ---
if not exist "%STANDALONE_HOME%\proxy-config.json" (
    echo [ERROR] Separate CCP_HOME config not found:
    echo         %STANDALONE_HOME%\proxy-config.json
    echo         Create it first with listenPort=11444. See docs/frp-tunnel-deploy.md.
    pause & exit /b 1
)

call :LOG [OK] standalone CCP_HOME config found
call :LOG standalone local console  = http://127.0.0.1:11444
call :LOG standalone local mgmt     = http://127.0.0.1:11544
echo ============================================================
echo  Starting external services
echo  - standalone web:  http://127.0.0.1:11444 (console)
echo                     http://127.0.0.1:11544 (management)
echo  - frpc tunnel:     connects to public frps, exposes via subdomains
echo  - public access:   %PUBLIC_MGMT_URL% (management)
echo                     %PUBLIC_TRACE_URL% (console)
echo ============================================================

REM --- Start standalone (new window, foreground; close window = stop) ---
REM    Inline set CCP_HOME + cd + node. No helper script (the old
REM    run-standalone.bat was deleted: a missing arg made it fall back to
REM    the default port 11434 and collide with extension mode).
call :LOG [1/2] starting standalone web service...
start "CCP-Standalone" cmd /k "set "CCP_HOME=%STANDALONE_HOME%" && cd /d "%PROJECT_DIR%" && node standalone/cli.js"

REM --- Wait for standalone to listen on 11444 ---
call :LOG       waiting for web service to listen on 11444...
set /a TRIES=0
:WAIT_WEB
ping -n 2 127.0.0.1 >nul
netstat -ano | findstr ":11444 " | findstr "LISTENING" >nul
if %errorlevel%==0 goto WEB_OK
set /a TRIES+=1
call :LOG       ...not ready yet (attempt %TRIES%/10)
if %TRIES% lss 10 goto WAIT_WEB
call :LOG [ERROR] standalone did not listen on 11444 within 20s. Check CCP-Standalone window log.
pause & exit /b 1

:WEB_OK
call :LOG [OK] standalone ready (11444 console / 11544 management)

REM --- Start frpc (new window, foreground) ---
call :LOG [2/2] starting frpc tunnel...
start "CCP-Frpc" cmd /k ""%FRPC_EXE%" -c "%FRPC_CONF%""

REM --- Wait for frpc to connect ---
ping -n 3 127.0.0.1 >nul
call :LOG [OK] frpc launched (see CCP-Frpc window for 'start proxy success')
call :LOG tunnel mapping:
call :LOG   mgmt  127.0.0.1:11544 -^> %PUBLIC_MGMT_URL%
call :LOG   trace 127.0.0.1:11444 -^> %PUBLIC_TRACE_URL%
echo.
echo ============================================================
echo  External services started
echo  - Close the CCP-Standalone / CCP-Frpc windows to stop
echo  - Or run stop-external-service.bat
echo ============================================================
echo  Public access (via frpc tunnel):
echo    Management : %PUBLIC_MGMT_URL%
echo    Console    : %PUBLIC_TRACE_URL%
echo ============================================================
echo.
call :LOG === start-external-service done — public: %PUBLIC_MGMT_URL% ===
if /i not "%~1"=="nopause" pause
endlocal
