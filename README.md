# darkcode-core

DARK CODE AI의 백엔드 게이트웨이. 여러 추론 엔진을 역할별로 배치하고, 하나의 엔드포인트·세션·스트림으로 묶습니다.
외부 라이브러리 없이 Node.js 22.13+ 하나로 동작합니다 (세션 DB는 Node 내장 SQLite).

- 1층 엔진: Ollama · llama.cpp · LM Studio · LocalAI · vLLM · SGLang (어댑터 2종 뒤로 숨김)
- 2층 파이프라인: CACHE → CONTEXT → ROUTE → STRATEGIST → IMPLEMENTER → CRITIC/VERIFY → GATE → RENDER
- 3층 연결: DARK CODE 워크스페이스 CORE 모드 + OpenAI 호환 API

설계 상세: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

## 빠른 시작 (Windows, Phase 1)

1. Ollama 실행 중 + `qwen3:8b`, ai-* 모델 준비 (DARK CODE 원클릭 연결로 자동 설치 가능)
2. `start-darkcode-core.bat` 더블클릭 (Node 가 없으면 자동 설치)
3. https://jake12733.github.io/darkcode-ai/ → 입력창 모드에서 **CORE** 선택

## 연결 점검 (안 붙을 때)

`verify-core.bat` 더블클릭 → 게이트웨이가 꺼져 있으면 새 창으로 띄운 뒤 아래를 순서대로 확인하고 `data/doctor-report.txt` 에 남깁니다.

| 단계 | 확인 | 실패 시 안내 |
|-|-|-|
| 1 | Node 22.13+ | LTS 설치 |
| 2 | 설정 로드 · DC_TOKEN · server.cors 에 DARK CODE 주소 | .env / config 수정 |
| 3 | Ollama 응답 · 첫 테스트 모델(ai-qa) | Ollama 실행 · 원클릭 연결 |
| 4 | 포트 8787 기동/점유 | 점유 프로그램 종료 또는 DC_PORT 변경 |
| 5 | `/health` 응답 + CORS 헤더 | server.cors |
| 6 | 브라우저 프리플라이트 재현 (POST·Content-Type·사설망) | server.cors / 버전 |
| 7 | CORE 첫 요청 `/dc/run` (SSE `done` 까지) | 게이트웨이 창 로그 |

브라우저 쪽은 DARK CODE 상단 **CORE → [연결 진단]** 이 같은 요청을 실제 브라우저에서 보내고, 실패하면 "게이트웨이 미기동 / CORS 거부 / 브라우저의 localhost 차단" 중 어디인지 갈라서 알려 줍니다. 브라우저가 붙으면 게이트웨이 창에 `접속 GET /health ← https://jake12733.github.io` 가 찍힙니다.

## AI 작곡 (ACE-Step 1.5)

대충 친 한 줄 → 작곡 역할(qwen3:8b)이 제목·스타일 태그·가사·BPM·키·길이를 JSON 으로 설계 → [ACE-Step 1.5](https://github.com/ace-step/ACE-Step-1.5)(MIT, 보컬 포함, 50+ 언어, 4~8GB VRAM)가 실제 노래(mp3)를 생성 → `data/media/` 에 저장.

1. `setup-acestep.bat` 한 번 실행 (uv 설치 → 소스 → `uv sync` → 8GB GPU 설정 → `.env` 에 `ACESTEP_DIR` 등록)
2. `start-darkcode-core.bat` → 첫 곡 요청 때 ACE-Step 이 자동 기동 (모델 자동 다운로드로 첫 회는 수 분), 10분 유휴 시 자동 종료
3. https://jake12733.github.io/darkcode-ai/studio.html 또는 DARK CODE 입력창에 `/music 비 오는 밤 감성`

ACE-Step 이 없으면 작곡안 + Suno 붙여넣기용 스타일·가사만 반환합니다. 같은 GPU 풀(gpu0)이라 Ollama 와 동시에 올라가지 않습니다.

| 메서드 | 경로 | 설명 |
|-|-|-|
| POST | `/dc/music` | `{input, instrumental?, duration?, language?, lyrics?}` → SSE: `compose · progress · done{track, song, handoff}` |
| POST | `/dc/storyboard` | `{input, song, duration, format}` → 영상 장면 JSON (STUDIO 영상 탭) |
| GET | `/dc/media` · `/dc/media/:file` | 생성 음악 목록 / 파일 (Range 지원) |

## 테스트

```bash
node test/smoke.js                 # 가짜 엔진으로 전체 계약 검증 (GPU 불필요)
DC_LIVE=1 node test/smoke.js       # + 실제 Ollama 1건
node test/live-run.js "로그인 API 보안 점검해줘"   # 실제 엔진으로 파이프라인 1건, 로그 요약
```

## API

| 메서드 | 경로 | 설명 |
|-|-|-|
| GET | `/health` | 상태 + 엔진 UP/DOWN |
| GET | `/v1/models` | `dc-auto`, `dc-pipeline`, `role:*`, `<엔진>/<모델>` |
| POST | `/v1/chat/completions` | OpenAI 호환 (stream 지원). 세션: `X-DC-Session` 헤더 |
| POST | `/dc/run` | `{input, sessionId?, mode?: auto/fast/full, category?, noCache?}` → SSE 이벤트 |
| GET | `/dc/engines` | 엔진 상태 (헬스·풀·실행 중·마지막 모델) |
| POST | `/dc/engines/:id/start` · `/stop` | 관리형 엔진 수동 기동/정지 |
| GET | `/dc/sessions` · `/dc/sessions/:id` | 세션 목록 / 메시지·스냅샷·실행 기록 |
| GET | `/dc/runs/:id` | 실행 1건의 단계별 로그 |

SSE 이벤트: `run · stage · route · log · plan · draft · token · thinking · done · error`

## 설정 (darkcode.config.json)

- `profile`: `local` / `hybrid` / `server` — 역할 후보의 `profiles` 로 필터
- `engines`: `type`(ollama|openai) · `baseUrl` · `pool` · `launch`(온디맨드 기동) · `apiKey`
- `pools`: GPU 동시 실행 제한 (`exclusive:true` = 한 번에 한 모델)
- `roles`: 역할 → 후보 목록 (위에서부터 시도, 실패 시 다음)
- `categories`: 분류 키워드 + 파이프라인
- 비밀값은 `.env` 에 (`.env.example` 참고), 설정에서는 `${VAR}` 로 참조
