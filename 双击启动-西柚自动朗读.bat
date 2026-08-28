@echo off
REM ============================================================
REM  Xiyou English homework auto-read launcher
REM  Double-click to run.
REM  It starts the Xiyou client (with debug port), waits for you
REM  to open the homework in the Xiyou window, then reads it aloud.
REM ============================================================
setlocal
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo   === Xiyou English auto-read launcher ===
echo.
echo   Step 1: a Xiyou client window opens (or is already open).
echo   Step 2: in that window, manually open the homework (Word/Text reading).
echo   Step 3: this launcher auto-detects the reading screen and reads it.
echo.
echo   Starting...
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0xiyou-launch.ps1" -Auto
echo.
echo   Finished. Press any key to close this window.
pause >nul
