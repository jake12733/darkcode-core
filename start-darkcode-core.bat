@echo off
chcp 65001 >nul
title DARK CODE Core Gateway
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [DARK CODE] Node.js 가 없어 설치합니다 ^(LTS^)...
  winget install -e --id OpenJS.NodeJS.LTS --silent --accept-source-agreements --accept-package-agreements
  set "PATH=%PATH%;%ProgramFiles%\nodejs"
)

node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)"
if errorlevel 1 (
  echo [DARK CODE] Node.js 22.13 이상이 필요합니다. https://nodejs.org 에서 LTS 를 설치한 뒤 다시 실행하세요.
  pause
  exit /b 1
)

if not exist .env if exist .env.example copy .env.example .env >nul
echo [DARK CODE] 게이트웨이 시작: http://127.0.0.1:8787   ^(종료: Ctrl+C^)
node src\server.js
pause
