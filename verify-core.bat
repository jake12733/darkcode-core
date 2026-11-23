@echo off
chcp 65001 >nul
title DARK CODE Core - 연결 점검
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo [DARK CODE] Node.js 가 없습니다. start-darkcode-core.bat 를 먼저 실행하면 자동 설치됩니다.
  pause
  exit /b 1
)
rem 게이트웨이가 꺼져 있으면 새 창으로 띄운 뒤 /health · CORS 프리플라이트 · CORE 첫 요청까지 점검
node scripts\doctor.js --start
echo.
echo 결과 보고서: %~dp0data\doctor-report.txt  (문제가 있으면 이 파일 내용을 그대로 보내 주세요)
pause
