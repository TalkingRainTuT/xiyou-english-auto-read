@echo off
REM ============================================================
REM  Xiyou English auto-read - one-click installer
REM  Detects / installs VB-Cable, Node.js, .NET 6 SDK (skips if
REM  present), then guides you to pick the Xiyou client exe path.
REM  Double-click to run.
REM ============================================================
setlocal
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo   === Xiyou English auto-read installer ===
echo.
echo   Checking VB-Cable / Node.js / .NET6 ... (already installed is skipped)
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0xiyou-install.ps1"
echo.
echo   Installer finished. Press any key to close this window.
pause >nul
