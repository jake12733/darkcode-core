// AstraUnifiedEngine v3 · 테스트 우선 검증 · 후보 여러 개(best-of-N) · 생각 모드 신호 · 실패 기억 · 단일 타겟 잠금 · 0원 폴백 · runs/committed 원장
// 원본: darkcode-core/runner/astra-unified-engine.js (브라우저 배포본: darkcode-ai/assets/astra-unified-engine.js 와 동일 파일)
// 실행기: darkcode-core/runner/runner.js 0.2+ (기본 http://127.0.0.1:8797/run · files/jobs/TAP 지원, 예전 실행기면 출력 검증으로 자동 전환)
//
// v3 추가 (v2 공개 API 그대로, 옵션·필드만 추가)
//  1 testsFirst(기본 켜짐): 코드보다 먼저 요구사항만 보고 node:test 테스트(test.mjs)를 만든다 → 실행기에서 코드+테스트를 함께 돌려
//    "실행됨"이 아니라 "테스트 통과"일 때만 VERIFIED (테스트를 못 만들면 v2 와 같은 출력 검증 · result.verification 으로 구분)
//  2 candidates(기본 1, 최대 4): 후보 코드를 여러 개 만들어 승인 한 번에 묶음 실행 → 테스트를 가장 많이 통과한 후보만 수정
//  3 분쟁 테스트: 모든 후보가 같은 테스트에서 실패하고 2개 이상 후보의 출력이 같으면, 테스트 쪽 오류로 보고 제외 (result.tests.disputed 에 기록)
//  4 생각 모드 신호: callModelFn ctx 에 role('tests'|'code'|'repair') · candidate · deep(재시도·추가 후보) · temperature 를 넘긴다
//  5 실패 기억: 재시도로 고친 에러는 원장 fixes 에 저장 → 같은 종류 에러가 나오면 수정 프롬프트에 예전 해결 코드를 참고로 붙인다
// v2 유지: 실행기 실패(연결·HTTP·승인 거부)는 즉시 중단 · 같은 코드/같은 에러 반복 중단 · 폴백 스텁은 절대 확정 안 함 · 탭 간 잠금 · 원장 병합

const FENCE = /```[ \t]*([\w#+.-]*)[^\r\n]*\r?\n([\s\S]*?)(?:\r?\n)?```/g;
const LANG_ALIAS = { js: 'javascript', javascript: 'javascript', mjs: 'javascript', node: 'javascript', nodejs: 'javascript', ecmascript: 'javascript', py: 'python', python: 'python', python3: 'python', sh: 'shell', bash: 'shell', shell: 'shell', zsh: 'shell', ts: 'typescript', typescript: 'typescript', html: 'html', css: 'css', json: 'json' };
// 실행기 문제(코드를 고쳐도 해결 안 됨) → 즉시 중단
const RUNNER_LEVEL = new Set(['approval_denied', 'spawn_error', 'busy', 'runner_http', 'runner_unreachable', 'runner_bad_response', 'aborted']);
const TEMPS = [0.4, 0.8, 1.0, 0.6];

const fnv = (s) => { let h = 0x811c9dc5; const t = String(s); for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(16).padStart(8, '0'); };

// 에러 서명: 경로·줄/칸 번호·숫자를 지운 첫 의미 있는 줄 (같은 에러 반복 감지용)
export function errorSignature(text) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const key = lines.find((l) => /(Error|Exception|TIMEOUT|EXIT_|UNSUPPORTED|not ok)/.test(l)) || lines[0] || '';
  return key.replace(/[A-Za-z]:\\[^\s:'"]+|\/[^\s:'"]+/g, '<path>').replace(/:\d+(:\d+)?/g, '').replace(/\d+/g, '#').slice(0, 200);
}

// node:test 결과 요약 (TAP 또는 spec 리포터) → { total, pass, fail, failed:[이름] } · 요약 줄이 없으면 null
export function parseTestReport(text) {
  const t = String(text || '');
  const num = (k) => { const m = t.match(new RegExp(`^\\s*[#ℹ]\\s*${k}\\s+(\\d+)`, 'm')); return m ? Number(m[1]) : null; };
  const pass = num('pass'), fail = num('fail'), total = num('tests');
  if (pass === null && fail === null) return null;
  const failed = [...t.matchAll(/^\s*not ok \d+ - (.+?)\s*$/gm)].map((m) => m[1].replace(/\s+#\s.*$/, '').trim());
  if (!failed.length) for (const m of t.matchAll(/^\s*✖\s+(.+?)\s+\(\d/gm)) failed.push(m[1].trim());
  return { total: total ?? (pass || 0) + (fail || 0), pass: pass || 0, fail: fail || 0, failed: [...new Set(failed)].slice(0, 50) };
}
// 테스트 파일에서 test('이름') / it('이름') 목록
export function testNames(code) { return [...String(code || '').matchAll(/\b(?:test|it)\s*\(\s*(['"`])((?:(?!\1).){1,120})\1/g)].map((m) => m[2]); }
function testFailureText(run) {
  const out = `${run.output || ''}\n${run.stderr || ''}`;
  const i = out.search(/^\s*not ok /m);
  return (i >= 0 ? out.slice(i) : out).slice(0, 1800).trim();
}

function memoryStorage() { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; }

export class AstraUnifiedEngine {
  constructor({
    runnerUrl = 'http://127.0.0.1:8797/run',
    maxRetries = 3,
    storageKey = 'dc_astra_unified_ledger_v1',
    runnerTimeoutMs = 120000,        // 실행기 승인 대기(60초) + 실행 시간 제한을 덮는 값
    storage = (typeof localStorage !== 'undefined' ? localStorage : memoryStorage()),
    lockManager = (typeof navigator !== 'undefined' && navigator.locks ? navigator.locks : null),
    onLedgerChange = null,
    candidates = 1,
    testsFirst = true,
  } = {}) {
    this.runnerUrl = String(runnerUrl).trim();
    this.maxRetries = Math.max(1, Number(maxRetries) || 3);
    this.storageKey = storageKey;
    this.runnerTimeoutMs = runnerTimeoutMs;
    this.storage = storage;
    this.lockManager = lockManager;
    this.onLedgerChange = onLedgerChange;
    this.candidates = Math.max(1, Math.min(4, Number(candidates) || 1));
    this.testsFirst = testsFirst !== false;
    this.activeLock = null;
    this._pendingFixes = null;
    this.ledger = this._loadLedger();
    this._onStorage = (e) => { if (e.key === this.storageKey) { this.ledger = this._loadLedger(); this.onLedgerChange?.(this.ledger); } };
    if (typeof window !== 'undefined' && window.addEventListener) window.addEventListener('storage', this._onStorage);
  }

  dispose() { if (typeof window !== 'undefined' && window.removeEventListener) window.removeEventListener('storage', this._onStorage); }

  _loadLedger() {
    try {
      const raw = JSON.parse(this.storage.getItem(this.storageKey) || '{}');
      return { runs: Array.isArray(raw.runs) ? raw.runs : [], committed: Array.isArray(raw.committed) ? raw.committed : [], fixes: Array.isArray(raw.fixes) ? raw.fixes : [] };
    } catch { return { runs: [], committed: [], fixes: [] }; }
  }

  reloadLedger() { this.ledger = this._loadLedger(); return this.ledger; }

  // 저장 직전에 최신 원장을 다시 읽어 runId 기준으로 합친다 (다른 탭 기록 보존). 용량 초과면 오래된 확정본부터 줄인다.
  _saveLedger(newRun, newCommit) {
    const merge = (list, item, cap) => { const m = new Map(list.map((r) => [r.runId, r])); if (item) m.set(item.runId, item); return [...m.values()].sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp))).slice(0, cap); };
    const latest = this._loadLedger();
    const fixes = (this._pendingFixes || latest.fixes || []).slice(0, 30);
    this._pendingFixes = null;
    const next = { runs: merge(latest.runs, newRun, 100), committed: merge(latest.committed, newCommit, 50), fixes };
    for (let i = 0; i < 60; i++) {
      try { this.storage.setItem(this.storageKey, JSON.stringify(next)); this.ledger = next; return { ok: true, trimmed: i }; }
      catch (e) {
        if (next.committed.length > 1) next.committed.pop();
        else if (next.runs.length > 1) next.runs.pop();
        else if (next.fixes.length) next.fixes.pop();
        else { this.ledger = next; return { ok: false, error: String(e?.message || e) }; }
      }
    }
    this.ledger = next;
    return { ok: false, error: 'LEDGER_SAVE_FAILED' };
  }

  // 실패 기억: 같은 서명의 에러를 예전에 고친 코드 앞부분
  _fixHint(sig) { const f = sig && (this.ledger.fixes || []).find((x) => x.sig === sig); return f ? f.snippet : ''; }
  _rememberFix(sig, code) {
    if (!sig || !code) return;
    const base = this._pendingFixes || this._loadLedger().fixes || [];
    this._pendingFixes = [{ sig, snippet: String(code).slice(0, 400), at: new Date().toISOString() }, ...base.filter((x) => x.sig !== sig)].slice(0, 30);
  }

  // v1 호환: 코드 문자열만 반환
  extractCode(rawText, preferLanguage = 'javascript') { return this.extractCodeBlock(rawText, preferLanguage).code; }

  // { code, language, blocks } · CRLF 정규화, 모든 언어 태그, 여러 블록이면 실행 언어 우선, 닫히지 않은 펜스도 처리
  extractCodeBlock(rawText, preferLanguage = 'javascript') {
    const text = String(rawText ?? '').replace(/\r\n?/g, '\n');
    const blocks = [];
    let m; FENCE.lastIndex = 0;
    while ((m = FENCE.exec(text))) blocks.push({ language: LANG_ALIAS[m[1].toLowerCase()] || (m[1].toLowerCase() || null), code: m[2].trim() });
    const want = LANG_ALIAS[String(preferLanguage).toLowerCase()] || preferLanguage;
    let pick = blocks.find((b) => b.language === want && b.code) || blocks.find((b) => !b.language && b.code) || blocks.find((b) => b.code);
    if (!pick) {
      const open = text.match(/```[ \t]*([\w#+.-]*)[^\n]*\n([\s\S]*)$/); // 닫는 펜스 없이 끊긴 출력
      if (open) pick = { language: LANG_ALIAS[open[1].toLowerCase()] || null, code: open[2].replace(/```\s*$/, '').trim() };
      else pick = { language: null, code: text.split('\n').filter((l) => !/^\s*```/.test(l)).join('\n').trim() };
    }
    return { code: pick.code, language: pick.language || want, blocks: blocks.length };
  }

  buildZeroCostStub(targetModule, reason = 'MODEL_UNAVAILABLE') {
    const safeFn = String(targetModule || 'module').replace(/[^a-zA-Z0-9_]/g, '_') || 'module';
    return [
      `// [ZERO-COST FALLBACK :: ${targetModule} :: ${reason}]`,
      `export const moduleReady = true;`,
      `export function run_${safeFn}(input = {}) {`,
      `  return { ok: true, fallback: true, targetModule: ${JSON.stringify(targetModule)}, input };`,
      `}`,
      `console.log("FALLBACK_STUB_READY:", ${JSON.stringify(targetModule)});`,
    ].join('\n');
  }

  _normalizeExec(data, httpStatus = 200) {
    const reason = String(data?.reason || (data?.executed ? (data.exitCode === 0 ? 'ok' : 'nonzero_exit') : 'unknown'));
    return {
      executed: Boolean(data?.executed),
      exitCode: Number.isInteger(data?.exitCode) ? data.exitCode : null,
      output: String(data?.output ?? '').trim(),
      stderr: String(data?.stderr ?? '').trim(),
      reason,
      runnerLevel: RUNNER_LEVEL.has(reason),
      httpStatus,
      durationMs: data?.durationMs ?? null,
      codeHash: data?.codeHash || null,
      tests: data?.tests || null,
      label: data?.label || '',
    };
  }

  async _post(body, extraMs = 0) {
    let res;
    try {
      res = await fetch(this.runnerUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(this.runnerTimeoutMs + extraMs) });
    } catch (err) {
      return { fail: { executed: false, exitCode: null, output: '', stderr: `RUNNER_UNREACHABLE: ${String(err?.message || err)}`, reason: 'runner_unreachable', runnerLevel: true, httpStatus: 0 } };
    }
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      return { fail: { executed: false, exitCode: null, output: '', stderr: `RUNNER_HTTP_${res.status} ${t.slice(0, 200)}`, reason: 'runner_http', runnerLevel: true, httpStatus: res.status } };
    }
    try { return { data: await res.json(), status: res.status }; }
    catch { return { fail: { executed: false, exitCode: null, output: '', stderr: 'RUNNER_BAD_RESPONSE: JSON 아님', reason: 'runner_bad_response', runnerLevel: true, httpStatus: res.status } }; }
  }

  // 실행기 호출 (단일) → { executed, exitCode, output(stdout), stderr, reason, runnerLevel, httpStatus, durationMs, tests }
  async runOnLocal(targetModule, code, command = '', { language = 'javascript', args, runId, files, entry } = {}) {
    const r = await this._post({ runId, targetModule, language, code, command, args, ...(files ? { files, entry } : {}) });
    return r.fail || this._normalizeExec(r.data, r.status);
  }

  // 실행기 묶음 호출 (후보 코드 + 테스트 · 승인 한 번) → { results:[...] } | { runnerFailure } · 예전 실행기면 첫 작업만 돌고 legacy:true
  async runJobs(targetModule, jobs, { language = 'javascript', runId, command = '' } = {}) {
    const first = jobs[0] || {};
    const main = (first.files && (first.files['main.mjs'] || first.files['main.py'])) || first.code || '';
    const r = await this._post({ runId, targetModule, language, code: main, command, jobs }, jobs.length * 20000);
    if (r.fail) return { runnerFailure: r.fail };
    if (r.data && r.data.batch && Array.isArray(r.data.results)) {
      const results = r.data.results.map((x) => this._normalizeExec(x, r.status));
      const lvl = results.find((x) => x.runnerLevel);
      return lvl ? { runnerFailure: lvl } : { results, batch: true };
    }
    const one = this._normalizeExec(r.data, r.status);
    return one.runnerLevel ? { runnerFailure: one } : { results: [one], batch: false, legacy: true };
  }

  // 같은 탭(메모리) + 다른 탭(Web Locks API) 모두 단일 타겟 보장
  async runTask(opts) {
    const lockedResult = () => {
      let info = this.activeLock;
      if (!info) { try { info = JSON.parse(this.storage.getItem(`${this.storageKey}:active`) || 'null'); } catch { info = null; } }
      return { ok: false, status: 'SINGLE_TARGET_LOCKED', verified: false, committed: false, error: info ? `현재 [${info.targetModule}] (${info.runId}) 작업 진행 중` : '다른 탭에서 작업 진행 중' };
    };
    if (this.activeLock && this.activeLock.status === 'RUNNING') return lockedResult();
    if (this.lockManager?.request) {
      return this.lockManager.request(`${this.storageKey}:single-target`, { ifAvailable: true }, (lock) => (lock ? this._runLocked(opts) : lockedResult()));
    }
    return this._runLocked(opts);
  }

  async _runLocked({ targetModule, userPrompt, callModelFn, command = '', args, language = 'javascript', onProgress = () => {}, candidates, testsFirst }) {
    if (this.activeLock && this.activeLock.status === 'RUNNING') return { ok: false, status: 'SINGLE_TARGET_LOCKED', verified: false, committed: false, error: `현재 [${this.activeLock.targetModule}] (${this.activeLock.runId}) 작업 진행 중` };
    const runId = `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    this.activeLock = { runId, targetModule, status: 'RUNNING', startedAt: Date.now() };
    try { this.storage.setItem(`${this.storageKey}:active`, JSON.stringify(this.activeLock)); } catch { /* 표시용 */ }

    const lang = LANG_ALIAS[String(language).toLowerCase()] || 'javascript';
    const isJs = lang === 'javascript';
    const mainName = isJs ? 'main.mjs' : 'main.py';
    const nCand = Math.max(1, Math.min(4, Number(candidates ?? this.candidates) || 1));
    const wantTests = (testsFirst ?? this.testsFirst) && isJs && typeof callModelFn === 'function';
    const langRule = lang === 'python' ? 'Python 3 스크립트' : 'Node.js ESM(JavaScript, import/export 사용 가능)';
    const base = `타겟: ${targetModule}\n원래 요청: ${userPrompt}\n언어: ${langRule}`;
    let tests = null; // { code, names }
    let verification = 'output-only';
    let code = '', prevHash = '', lastError = '', lastSig = '', source = 'model', fallbackUsed = false, attemptsUsed = 0, stopReason = '';
    let exec = { executed: false, exitCode: null, output: '', stderr: '', reason: 'not_run' };
    let testRes = null; let disputed = []; let candidatesTried = 0; let chosenCandidate = 0;
    const history = [];
    const emit = (p) => { try { onProgress({ targetModule, maxRetries: this.maxRetries, ...p }); } catch { /* UI 오류가 엔진을 멈추지 않게 */ } };
    const testsPassed = (t) => Boolean(t && t.pass >= 1 && (t.fail === 0 || (t.failed.length === t.fail && t.failed.every((n) => disputed.includes(n)))));

    try {
      // 0) 테스트 먼저 (요구사항만 보고)
      if (wantTests) {
        emit({ stage: 'tests', attempt: 0, message: '요구사항만 보고 테스트를 먼저 작성 중...' });
        const tp = `아래 요구사항을 검증하는 Node.js 테스트 파일(test.mjs)만 작성하세요. 구현 코드는 아직 없고 main.mjs 에 들어갈 예정입니다.\n${base}\n규칙:\n- import { test } from 'node:test'; import assert from 'node:assert/strict'; 그리고 import { 함수이름 } from './main.mjs';\n- 요구사항에 함수 이름이 있으면 그대로 쓰고, 없으면 기능을 잘 나타내는 영어 함수 이름 1~3개를 정해서 쓰세요.\n- 테스트 3~6개. 입력과 기대값이 분명한 것만 (네트워크·파일·현재 시각·난수에 의존하지 않게).\n- 기대값은 직접 계산해서 확실한 것만 쓰세요.\n- 설명 없이 코드 블록 하나로만 답하세요.`;
        try {
          const raw = await callModelFn(tp, { role: 'tests', attempt: 0, candidate: 0, deep: false, temperature: 0.2, lastError: '', targetModule, userPrompt, language: lang });
          const t = this.extractCode(raw, 'javascript');
          if (/node:test/.test(t) && /from\s+['"]\.\/main\.mjs['"]/.test(t)) tests = { code: t, names: testNames(t) };
        } catch { /* 테스트 없이 진행 */ }
        if (tests) verification = 'tests';
        emit({ stage: 'tests', attempt: 0, tests: tests ? tests.names : [], message: tests ? `테스트 ${tests.names.length || '여러'}개 준비 (요구사항 기준)` : '테스트를 만들지 못함 → 실행 출력으로만 확인' });
      }
      const codeRule = () => (tests
        ? `규칙: 파일 이름은 main.mjs. 아래 테스트(test.mjs)가 import 하는 함수를 같은 이름으로 export 하고, 직접 실행했을 때는 결과를 console.log 로 출력한 뒤 정상 종료(exit 0)해야 합니다. 직접 실행 여부는 이렇게 판단하세요: import { pathToFileURL } from 'node:url'; if (import.meta.url === pathToFileURL(process.argv[1]).href) { ... } 설명 없이 코드 블록 하나로만 답하세요.\n\n[test.mjs]\n${tests.code}`
        : '규칙: 실행하면 결과를 표준 출력(console.log/print)으로 반드시 출력하고, 정상 종료(exit code 0)해야 합니다. 설명 없이 코드 블록 하나로만 답하세요.');

      for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
        attemptsUsed = attempt;
        const isRetry = attempt > 1;
        const want = isRetry ? 1 : nCand;
        emit({ stage: isRetry ? 'patch' : 'think', attempt, candidates: want, message: isRetry ? `[${attempt}/${this.maxRetries}] 실패 내용 반영해 수정 중...` : `[${attempt}/${this.maxRetries}] 단일 타겟 [${targetModule}] 후보 ${want}개 생성 중...` });

        // 1) 후보 코드 생성
        const hint = isRetry ? this._fixHint(lastSig) : '';
        const gens = [];
        for (let c = 0; c < want; c++) {
          const prompt = !isRetry
            ? `요구사항에 맞는 실행 가능한 코드만 작성하세요.\n${base}\n${codeRule()}`
            : `이전 코드가 실패했습니다. 원래 요구사항을 유지한 채 실패 원인만 고친 전체 코드를 다시 출력하세요.\n${base}\n${codeRule()}\n\n[실패 내용]\n${lastError}${hint ? `\n\n[예전에 비슷한 에러를 고친 코드 (참고)]\n${hint}` : ''}\n\n[이전 코드]\n${code}`;
          try {
            if (typeof callModelFn !== 'function') throw new Error('NO_MODEL_FN');
            const raw = await callModelFn(prompt, { role: isRetry ? 'repair' : 'code', attempt, candidate: c, deep: isRetry || c > 0, temperature: isRetry ? 0.3 : (TEMPS[c] ?? 0.7), lastError, targetModule, userPrompt, language: lang });
            const ex = this.extractCode(raw, lang);
            if (!ex) throw new Error('EMPTY_MODEL_OUTPUT');
            gens.push({ code: ex, source: 'model', candidate: c });
          } catch (e) { gens.push({ error: String(e?.message || e), candidate: c }); }
        }
        let good = gens.filter((g) => g.code);
        if (!good.length) {
          const why = (gens[0] && gens[0].error) || 'MODEL_UNAVAILABLE';
          if (isRetry) { stopReason = 'MODEL_FAILED_ON_RETRY'; lastError = `${lastError}\n[모델 재호출 실패] ${why}`.trim(); history.push({ attempt, source: 'model', error: why }); break; } // 같은 실패 코드 재실행 금지
          fallbackUsed = true; source = 'zero_cost_local_fallback';
          good = [{ code: this.buildZeroCostStub(targetModule, why), source: 'zero_cost_local_fallback', candidate: 0 }];
        }
        const seen = new Set();
        good = good.filter((g) => { g.hash = fnv(g.code); if (seen.has(g.hash)) return false; seen.add(g.hash); return true; });
        if (isRetry && good.length === 1 && good[0].hash === prevHash) { stopReason = 'NO_NEW_PATCH'; history.push({ attempt, source: 'model', codeHash: prevHash, error: '모델이 같은 코드를 다시 냄' }); break; }
        candidatesTried += good.length;
        emit({ stage: 'build', attempt, source: good[0].source, fallbackUsed, candidates: good.length, codeHash: good[0].hash, message: `[${attempt}/${this.maxRetries}] 후보 ${good.length}개 준비 (${good[0].source})` });

        // 2) 실행 (후보마다 실행 + 테스트 · 승인 한 번)
        const withTests = Boolean(tests) && !fallbackUsed;
        const jobs = [];
        for (const g of good) {
          jobs.push({ label: `c${g.candidate}:run`, files: { [mainName]: g.code }, entry: mainName, ...(args ? { args } : {}) });
          if (withTests) jobs.push({ label: `c${g.candidate}:test`, files: { 'main.mjs': g.code, 'test.mjs': tests.code }, entry: 'test.mjs' });
        }
        emit({ stage: 'execute', attempt, candidates: good.length, message: `[${attempt}/${this.maxRetries}] 로컬 실행기에서 후보 ${good.length}개 실행${withTests ? ' + 테스트' : ''} (승인 한 번)...` });
        let results;
        if (jobs.length === 1) {
          const one = await this.runOnLocal(targetModule, good[0].code, command, { language: lang, args, runId });
          if (one.runnerLevel) { exec = one; code = good[0].code; prevHash = good[0].hash; history.push({ attempt, reason: one.reason, error: one.stderr.slice(0, 300) }); stopReason = one.reason === 'runner_http' ? `RUNNER_HTTP_${one.httpStatus}` : one.reason.toUpperCase(); lastError = one.stderr; break; }
          results = [one];
        } else {
          const b = await this.runJobs(targetModule, jobs, { language: lang, runId, command });
          if (b.runnerFailure) { exec = b.runnerFailure; code = good[0].code; prevHash = good[0].hash; history.push({ attempt, reason: exec.reason, error: exec.stderr.slice(0, 300) }); stopReason = exec.reason === 'runner_http' ? `RUNNER_HTTP_${exec.httpStatus}` : exec.reason.toUpperCase(); lastError = exec.stderr; break; }
          results = b.results;
          if (b.legacy) { tests = null; verification = 'output-only'; emit({ stage: 'observe', attempt, message: '실행기가 예전 버전 (묶음 실행 미지원) → 테스트 없이 첫 후보만 출력으로 확인 · darkcode-core 최신본 권장' }); }
        }

        // 3) 채점 → 가장 좋은 후보
        const scored = good.map((g) => {
          const ri = jobs.findIndex((j) => j.label === `c${g.candidate}:run`);
          const ti = jobs.findIndex((j) => j.label === `c${g.candidate}:test`);
          const run = results[ri] || (ri === 0 ? results[0] : null);
          const tr = tests && ti >= 0 ? results[ti] || null : null;
          const t = tr ? (tr.tests || parseTestReport(`${tr.output}\n${tr.stderr}`)) : null;
          const runOk = Boolean(run && run.executed && run.exitCode === 0 && run.output.length > 0);
          const score = (t ? t.pass * 10 - t.fail * 3 : 0) + (runOk ? 5 : 0) + (run && run.executed && run.exitCode === 0 ? 1 : 0);
          return { ...g, run, testRun: tr, tests: t, runOk, score };
        }).sort((a, b) => b.score - a.score);
        // 테스트 파일 자체가 깨진 경우 (문법 오류) → 테스트를 버리고 출력 검증으로
        if (tests && scored.every((s) => !s.tests && s.testRun && /test\.mjs/.test(s.testRun.stderr) && /SyntaxError/.test(s.testRun.stderr))) {
          tests = null; verification = 'output-only';
          emit({ stage: 'observe', attempt, message: '생성된 테스트 파일에 문법 오류 → 테스트를 버리고 실행 출력으로 확인' });
        }
        // 분쟁 테스트: 모든 후보가 같은 테스트에서 실패 + 2개 이상 후보 출력이 같음 → 테스트 쪽 오류로 보고 제외
        if (tests && scored.length >= 2) {
          const outs = scored.filter((s) => s.runOk).map((s) => s.run.output.trim());
          if (outs.length >= 2 && outs.some((o, i) => outs.indexOf(o) !== i) && scored.every((s) => s.tests)) {
            const sets = scored.map((s) => new Set(s.tests.failed || []));
            const common = [...sets[0]].filter((n) => sets.every((st) => st.has(n)));
            if (common.length) { disputed = [...new Set([...disputed, ...common])]; emit({ stage: 'observe', attempt, disputed, message: `분쟁 테스트 ${common.length}개 제외 (모든 후보가 같은 출력으로 같은 테스트에서 실패)` }); }
          }
        }
        const best = scored[0];
        chosenCandidate = best.candidate; code = best.code; source = best.source; prevHash = best.hash;
        exec = best.run ? { ...best.run } : { executed: false, exitCode: null, output: '', stderr: 'RUN_RESULT_MISSING', reason: 'runner_bad_response' };
        testRes = tests && best.tests ? { total: best.tests.total, pass: best.tests.pass, fail: best.tests.fail, failed: best.tests.failed || [] } : null;
        const okRun = Boolean(exec.executed && exec.exitCode === 0 && exec.output.length > 0);
        const passNow = verification === 'tests' && !fallbackUsed ? Boolean(exec.executed && exec.exitCode === 0 && testsPassed(testRes)) : okRun;
        const failText = !passNow ? [exec.stderr, best.testRun && !testsPassed(testRes) ? testFailureText(best.testRun) : ''].filter(Boolean).join('\n').slice(0, 300) : '';
        history.push({ attempt, source, codeHash: best.hash, chosen: best.candidate, candidates: scored.map((s) => ({ c: s.candidate, hash: s.hash, exit: s.run ? s.run.exitCode : null, pass: s.tests ? s.tests.pass : null, fail: s.tests ? s.tests.fail : null })), reason: exec.reason, exitCode: exec.exitCode, durationMs: exec.durationMs ?? null, error: failText || (passNow ? '' : exec.output.slice(0, 300)) });
        emit({ stage: 'observe', attempt, reason: exec.reason, exitCode: exec.exitCode, tests: testRes, disputed, chosen: best.candidate, outputPreview: exec.output.slice(0, 200), errorPreview: passNow ? '' : (failText || exec.output).slice(0, 200), message: `[${attempt}/${this.maxRetries}] 실행 결과: ${exec.reason}${exec.exitCode !== null ? ` · exit ${exec.exitCode}` : ''}${testRes ? ` · 테스트 ${testRes.pass}/${testRes.total} 통과` : ''}${good.length > 1 ? ` · 후보 ${best.candidate + 1}번 선택` : ''}` });

        if (fallbackUsed) { stopReason = 'FALLBACK_ONLY'; lastError = okRun ? '모델 없이 0원 스텁만 실행됨 (실행기 경로 확인용, 확정 불가)' : (exec.stderr || exec.output); break; }
        if (passNow) { stopReason = 'OK'; if (isRetry && lastSig) this._rememberFix(lastSig, code); break; }

        // 4) 실패 내용 정리 → 다음 시도
        const tf = best.testRun && !testsPassed(testRes) ? testFailureText(best.testRun) : '';
        lastError = exec.executed && exec.exitCode === 0 && !exec.output && verification !== 'tests'
          ? 'EXIT_0_BUT_NO_OUTPUT: 정상 종료했지만 표준 출력이 비어 있습니다. 실행 결과를 console.log/print 로 출력하세요.'
          : [`REASON: ${exec.reason}${exec.exitCode !== null ? ` (exit ${exec.exitCode})` : ''}`, exec.stderr, tf && `[테스트 실패]\n${tf}`, exec.output && `STDOUT:\n${exec.output}`].filter(Boolean).join('\n').slice(0, 4000);
        const sig = errorSignature(tf || lastError);
        if (sig && sig === lastSig) { stopReason = 'REPEATED_ERROR'; break; }
        lastSig = sig;
        if (attempt === this.maxRetries) stopReason = testRes ? 'TESTS_FAILED' : 'MAX_RETRIES';
      }

      const gate = verification === 'tests' ? testsPassed(testRes) : exec.output.length > 0;
      const verified = Boolean(exec.executed && exec.exitCode === 0 && gate && !fallbackUsed && source === 'model');
      const status = verified ? 'VERIFIED' : 'UNVERIFIED_NEEDS_LOCAL_RUN';
      const codeHash = code ? fnv(code) : '';
      const record = {
        runId, targetModule, language: lang,
        attempts: attemptsUsed, source, fallbackUsed, patched: attemptsUsed > 1,
        executed: Boolean(exec.executed), exitCode: exec.exitCode, runnerReason: exec.reason,
        verified, status, stopReason, verification,
        tests: testRes ? { total: testRes.total, passed: testRes.pass, failed: testRes.fail, failedNames: testRes.failed, disputed } : null,
        candidatesTried, chosenCandidate,
        observedOutput: verified ? exec.output.slice(0, 2000) : '',
        lastError: verified ? '' : String(lastError || exec.stderr || '').slice(0, 2000),
        codeHash, history,
        timestamp: new Date().toISOString(),
      };
      const commitRecord = verified ? { ...record, code, testCode: tests ? tests.code : undefined } : null;
      const saved = this._saveLedger(record, commitRecord);
      const committed = Boolean(verified && saved.ok);

      const finalResult = {
        ok: true, ...record, committed, code, testCode: tests ? tests.code : '',
        ledgerWarning: saved.ok ? (saved.trimmed ? `저장 공간 부족으로 오래된 기록 ${saved.trimmed}건 정리` : '') : `원장 저장 실패: ${saved.error}`,
        commitReason: committed
          ? (verification === 'tests' ? `테스트 ${testRes.pass}/${testRes.total} 통과 + 실제 실행 성공(exit 0) · committed 반영됨` : '실제 실행 성공(exit 0) + 관측 출력 확인 · committed 반영됨')
          : verified ? '검증은 통과했지만 원장 저장 실패 · committed 미반영'
          : `반영 보류 (${stopReason || status}) · 실제 실행/테스트 통과 미확인 또는 실패`,
      };
      emit({ stage: 'commit', status, committed, stopReason, verification, tests: record.tests, message: finalResult.commitReason });
      this.onLedgerChange?.(this.ledger);
      return finalResult;
    } finally {
      this.activeLock = null;
      try { this.storage.removeItem(`${this.storageKey}:active`); } catch { /* 표시용 */ }
    }
  }
}
