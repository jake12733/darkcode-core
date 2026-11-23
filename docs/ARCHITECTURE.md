# DARK CODE Core — 아키텍처

목표: 여러 추론 엔진(llama.cpp · Ollama · LM Studio · LocalAI · vLLM · SGLang)을 역할별로 배치하되, 앞단(DARK CODE 워크스페이스·외부 클라이언트)에서는 **하나의 엔드포인트, 하나의 세션, 하나의 응답 흐름**으로 보이게 한다.

```
 ┌──────────────────────── 3층  워크스페이스 (얼굴) ────────────────────────┐
 │ DARK CODE (github.io)  ·  CORE 모드  ·  스트림/로그/코드/미리보기/스냅샷 │
 │ 그 밖의 OpenAI 호환 클라이언트 (Cursor, Continue, curl …)                 │
 └───────────────┬───────────────────────────────┬──────────────────────────┘
                 │ POST /dc/run (SSE 이벤트)       │ POST /v1/chat/completions
 ┌───────────────▼───────────────────────────────▼──────────────────────────┐
 │ 2층  라우터·파이프라인 (신경망)   src/pipeline · src/router · src/store   │
 │  CACHE → CONTEXT → ROUTE → STRATEGIST → IMPLEMENTER → CRITIC/VERIFY      │
 │        → GATE(승격) → RENDER          세션·스냅샷·로그·캐시 = SQLite 1개  │
 │  역할(role) 단위 호출: router / strategist / implementer.<분야> / critic  │
 └───────────────┬──────────────────────────────────────────────────────────┘
                 │ RoleRouter: 역할 → [후보 엔진:모델 …] (프로필 필터 · 헬스 · 폴백)
 ┌───────────────▼──────────────────────────────────────────────────────────┐
 │ 1층  실행·서빙 엔진 (근육)        src/adapters · src/engines             │
 │  EngineManager: 풀(GPU 동시 실행 제한) · 온디맨드 기동 · 유휴 종료 · 헬스  │
 │  어댑터 2종: OllamaAdapter(/api/chat) · OpenAIAdapter(/v1/chat/...)       │
 │   └ Ollama        └ llama.cpp · LM Studio · LocalAI · vLLM · SGLang       │
 └──────────────────────────────────────────────────────────────────────────┘
```

## 1층 — 어댑터 계약 (src/adapters/base.js)

모든 엔진은 같은 4개 메서드만 노출한다.

| 메서드 | 설명 |
|-|-|
| `health()` | `{ ok, detail }` — 헬스 캐시 10초 |
| `models()` | 모델 id 목록 |
| `chat({model, messages, params, json, signal})` | `AsyncGenerator` — `{type:'delta', content?, thinking?}` … `{type:'done', finishReason, usage}` |
| `unload(model)` | VRAM 해제 (Ollama: `keep_alive:0`) |

- `params` 는 공통 이름(`temperature, top_p, max_tokens, stop, seed, think`)으로 받고 어댑터가 엔진 방언으로 바꾼다. (Ollama `num_predict`, OpenAI `max_tokens`, Qwen 계열 생각 끄기 `chat_template_kwargs.enable_thinking=false`)
- `json` 은 `true`(JSON 모드) 또는 JSON 스키마 객체. Ollama `format`, OpenAI `response_format.json_schema` 로 변환 → 라우터·검수자 출력 형식이 엔진과 무관하게 고정된다.
- 생각(reasoning) 출력은 `thinking` 채널로 분리: vLLM/SGLang `reasoning_content`, Ollama `message.thinking`, 그 외 본문 `<think>…</think>` 를 스트림 경계 안전하게 잘라낸다.

**새 엔진 추가 = 설정 한 블록.** OpenAI 호환이면 코드 수정 없이 `engines` 에 `type: "openai"` 로 넣는다. 비호환 엔진만 어댑터 파일을 하나 추가한다.

## 1층 — 자원 관리 (src/engines/manager.js)

- **풀(pool)**: 엔진마다 소속 풀을 둔다. `gpu0` (로컬 GPU 1장) 는 `concurrency:1, exclusive:true` → 한 번에 한 엔진/모델만. `server` 풀은 vLLM/SGLang 처럼 배치 처리를 하므로 동시 16.
- **exclusive 풀 교체**: 다른 엔진/모델로 바꿀 때 이전 것을 내린다 (Ollama `keep_alive:0` 언로드 / 관리 프로세스 kill).
- **온디맨드 기동**: `launch` 가 있는 엔진(llama-server, `lms server start` 등)은 요청이 올 때만 띄우고 `/models` 가 응답할 때까지 대기, `idleStopSec` 동안 안 쓰면 종료.
- **헬스 기반 후보 제외**: 응답 없는 엔진은 후보에서 빠지고 다음 후보로 간다 (launch 가능한 엔진은 예외 — 띄워서 쓴다).

## 2층 — 라우팅

1. **0토큰 규칙 분류** (`router/classify.js`): 카테고리별 키워드 점수 + 의도 패턴("~페이지 만들어" → web, "~가 뭐야" → general). 1등이 기준점 이상이고 2등과 2점 이상 차이 나면 확정.
2. **애매하면 LLM 라우터**: `router` 역할(기본 qwen3:8b + prompts/router.md)에 JSON 스키마(enum)를 걸어 호출 → 형식 오류가 구조적으로 불가능.
3. 실패 시 규칙 최고점 또는 `general`.

카테고리 → `implementer.<카테고리>` 역할 + 파이프라인(`fast`/`full`) 이 설정으로 매핑된다.

| 카테고리 | 기본 파이프라인 | 로컬 기본 엔진 |
|-|-|-|
| code | full | ollama ai-dev (생각 모드) |
| security | full | ollama qwen3:8b + prompts/security.md (방어·허가 범위) |
| web | full | ollama ai-dev |
| prompt | fast | ollama ai-media |
| general | fast | ollama ai-qa |

## 2층 — 파이프라인 (src/pipeline/run.js)

| 단계 | 하는 일 | 비용 |
|-|-|-|
| CACHE | 입력 + 세션 스냅샷 해시로 조회 (TTL 24h) | 0 |
| CONTEXT | 최근 N개 메시지(토큰 예산 내) + 그 이전은 4줄 상태 압축본만 | 0 |
| ROUTE | 규칙 → (애매하면) LLM 라우터 | 0~1 호출 |
| STRATEGIST | full 만. 8줄 설계 | 1 호출 |
| IMPLEMENTER | 스트리밍 생성, `finish=length` 면 끊긴 곳부터 최대 2회 이어쓰기 | 1~3 호출 |
| CRITIC / VERIFY | 정적 검사(잘린 HTML·생략·JS/JSON 문법·한자 혼입) + 검수자(JSON 스키마) → REVISE 면 지적만 반영해 재생성 (최대 `maxRevisions`) | 0~N 호출 |
| GATE | 그래도 REVISE 면 `escalate` 역할(상위 엔진, 예: 서버 vLLM 32B)로 1회 승격. 없으면 남은 이슈를 기록하고 확정 | 0~1 호출 |
| RENDER | 코드 블록 → 파일, 4줄 상태 압축, 메시지·스냅샷·로그·캐시 저장 | 0 |

모든 단계는 SSE 이벤트(`run, stage, route, log, plan, draft, token, thinking, done, error`)로 실시간 송출되고, 같은 내용이 SQLite `logs` 에 남는다 → 화면의 로그와 DB 기록이 항상 같다.

## 3층 — 연결 방식

- **DARK CODE CORE 모드**: `POST /dc/run` SSE 를 기존 실행 카드(단계 칩·로그·코드 비)와 우측 패널(문서·코드·미리보기·스냅샷)에 매핑.
- **OpenAI 호환**: `model` 을 `dc-auto`(fast 파이프라인) · `dc-pipeline`(full) · `role:<역할>` · `<엔진>/<모델>` 로 지정. 세션은 `X-DC-Session` 헤더.
- 브라우저가 Ollama 를 직접 부르지 않으므로 `OLLAMA_ORIGINS` 설정이 필요 없다 (게이트웨이가 CORS 허용 목록을 관리).

## 단계별 로드맵

### Phase 1 — PC 최소 작동 버전 (지금)
- 구성: darkcode-core(127.0.0.1:8787) + Ollama(기존 ai-* 6모델 + qwen3:8b)
- 실행: `start-darkcode-core.bat` → DARK CODE 에서 CORE 모드 선택
- 검증: `node test/smoke.js` (가짜 엔진, GPU 불필요) · `DC_LIVE=1 node test/smoke.js` (실제 Ollama)

### Phase 2 — PC 다중 엔진
- `engines.llamacpp.enabled=true` + GGUF 경로 지정 → 코드 역할이 llama-server 로 (요청 시 기동, 5분 유휴 시 종료)
- `engines.lmstudio` 로 LM Studio 모델 사용, LocalAI 로 여러 백엔드를 한 엔드포인트로 묶기
- 같은 `gpu0` 풀 안에서는 자동으로 하나씩만 올라간다

### Phase 3 — GPU 서버 확장
- `deploy/docker-compose.server.yml` 로 vLLM(+선택 SGLang) + core 배포, `.env` 에 키/토큰
- PC 의 core 는 `DC_PROFILE=hybrid`: 무거운 역할(strategist/implementer/escalate)은 서버, 가벼운 역할(router/critic)은 로컬 Ollama
- 서버의 core 를 직접 쓰려면 `DC_PROFILE=server`, `DC_HOST=0.0.0.0`, `DC_TOKEN` 필수 + HTTPS 리버스 프록시

## 운영 메모
- 설정 오류는 시작 시점에 전부 검증해서 한 번에 보여준다 (없는 엔진/프롬프트 파일/풀).
- 비밀값은 `.env` (git 제외). 설정 파일엔 `${VAR}` 로만 참조.
- 보안 역할 프롬프트는 방어·허가 범위로 제한되어 있다 (prompts/security.md). 범위를 넓히지 말 것.
