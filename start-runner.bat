@echo off
chcp 65001 >nul
title DARK CODE Runner (127.0.0.1:8797)
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo [DARK CODE] Node.js 가 없습니다. start-darkcode-core.bat 를 먼저 실행하면 자동 설치됩니다.
  pause
  exit /b 1
)
echo [DARK CODE] 코드 실행기 시작 · 실행 요청마다 이 창에서 y/N 으로 승인합니다
echo             (승인 없이 자동 실행: start-runner.bat --auto · 게이트웨이 8787 과는 별개 창입니다)
node runner\runner.js %*
pause
