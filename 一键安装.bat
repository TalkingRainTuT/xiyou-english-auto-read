@echo off
rem 西柚英语自动朗读 一键安装入口
rem 检测/安装 VB-Cable、Node.js、.NET 6 SDK，并引导选择西柚客户端位置
chcp 65001 >nul
cd /d "%~dp0"
echo [西柚自动朗读] 开始一键安装检查...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0xiyou-install.ps1"
echo.
echo 安装脚本已结束。
pause
