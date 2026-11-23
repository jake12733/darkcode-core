@echo off
chcp 65001 >nul
title DARK CODE - ACE-Step 1.5 Setup
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup-acestep.ps1"
pause
