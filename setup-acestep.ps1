# DARK CODE · 음악 엔진 ACE-Step 1.5 설치 (Windows, NVIDIA GPU 권장)
# 공식 설치 절차(uv) 그대로: https://github.com/ace-step/ACE-Step-1.5#-quick-start
# 1) uv 설치  2) 소스 내려받기  3) uv sync (Python·PyTorch 자동, 수 GB)  4) 8GB GPU 설정  5) darkcode-core .env 에 경로 등록
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}
$ProgressPreference = 'SilentlyContinue'
function Say($m, $c = 'Green') { Write-Host $m -ForegroundColor $c }

$core = Split-Path -Parent $MyInvocation.MyCommand.Path
$base = Join-Path $env:LOCALAPPDATA 'DarkCode'
$dir  = Join-Path $base 'ACE-Step-1.5'
New-Item -ItemType Directory -Force -Path $base | Out-Null

Say '=============================================='
Say '   DARK CODE  ::  음악 엔진 ACE-Step 1.5 설치'
Say '=============================================='

Say "`n[1/5] uv 확인" 'Cyan'
if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
  Say '  uv 설치 중...' 'Yellow'
  Invoke-RestMethod https://astral.sh/uv/install.ps1 | Invoke-Expression
  $env:Path = "$env:USERPROFILE\.local\bin;$env:Path"
}
uv --version

Say "`n[2/5] ACE-Step 1.5 소스" 'Cyan'
if (-not (Test-Path (Join-Path $dir 'pyproject.toml'))) {
  $zip = Join-Path $env:TEMP 'ace-step-1.5.zip'
  Say '  GitHub 에서 내려받는 중...' 'Yellow'
  Invoke-WebRequest -UseBasicParsing 'https://github.com/ace-step/ACE-Step-1.5/archive/refs/heads/main.zip' -OutFile $zip
  Expand-Archive $zip -DestinationPath $base -Force
  if (Test-Path $dir) { Remove-Item $dir -Recurse -Force }
  Rename-Item (Join-Path $base 'ACE-Step-1.5-main') 'ACE-Step-1.5'
} else { Say '  이미 있음 → 건너뜀' }

Say "`n[3/5] 의존성 설치 (uv sync · Python + PyTorch, 처음 한 번 수 GB · 10분 이상 걸릴 수 있어요)" 'Cyan'
Push-Location $dir
try { uv sync } finally { Pop-Location }

Say "`n[4/5] 8GB GPU 설정 (.env)" 'Cyan'
$envFile = Join-Path $dir '.env'
if (-not (Test-Path $envFile)) {
  @(
    'ACESTEP_API_HOST=127.0.0.1',
    'ACESTEP_API_PORT=8001',
    'ACESTEP_CONFIG_PATH=acestep-v15-turbo',
    'ACESTEP_LM_MODEL_PATH=acestep-5Hz-lm-0.6B',
    'ACESTEP_LM_BACKEND=pt',
    'ACESTEP_OFFLOAD_TO_CPU=true'
  ) | Set-Content -Encoding UTF8 $envFile
  Say "  작성: $envFile"
} else { Say '  기존 .env 유지' }

Say "`n[5/5] darkcode-core 에 엔진 경로 등록" 'Cyan'
$coreEnv = Join-Path $core '.env'
if (-not (Test-Path $coreEnv) -and (Test-Path (Join-Path $core '.env.example'))) { Copy-Item (Join-Path $core '.env.example') $coreEnv }
$lines = @(); if (Test-Path $coreEnv) { $lines = Get-Content $coreEnv -Encoding UTF8 | Where-Object { $_ -notmatch '^\s*ACESTEP_DIR\s*=' } }
$lines += "ACESTEP_DIR=$dir"
$lines | Set-Content -Encoding UTF8 $coreEnv
Say "  ACESTEP_DIR=$dir"

Write-Host ''
Say '=============================================='
Say '   설치 완료!'
Say '   start-darkcode-core.bat 를 (다시) 실행하면 됩니다.'
Say '   첫 노래를 만들 때 모델(수 GB)을 자동으로 받느라'
Say '   몇 분 걸리고, 그다음부터는 수십 초 안에 나옵니다.'
Say '=============================================='
