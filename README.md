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
