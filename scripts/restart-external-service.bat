@echo off
REM ============================================================
REM  restart-external-service.bat
REM  一键重启对外服务（先 stop 再 start）
REM ============================================================

setlocal
set "SCRIPT_DIR=%~dp0"

echo ============================================================
echo  重启对外服务
echo ============================================================
echo.

echo === 第一步：停止 ===
call "%SCRIPT_DIR%stop-external-service.bat" nopause
echo.

echo === 第二步：启动 ===
call "%SCRIPT_DIR%start-external-service.bat" nopause

endlocal
