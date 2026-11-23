// AstraUnifiedEngine v2 · 단일 타겟 잠금 · 0원 폴백 · 에러 로그 재시도 · 관측 출력 기반 VERIFIED · runs/committed 원장
// 원본: darkcode-core/runner/astra-unified-engine.js (브라우저 배포본: darkcode-ai/assets/astra-unified-engine.js 와 동일 파일)
// 실행기: darkcode-core/runner/runner.js (기본 http://127.0.0.1:8797/run, 게이트웨이 8787 과 분리)
//
// v1 대비 수정 (공개 API 유지, 필드만 추가)
//  1 runnerUrl 순수 URL · 8797 전용 실행기        5 committed 에 code + codeHash 보관
//  2 VERIFIED = executed && exitCode===0 && stdout && !fallbackUsed   6 탭 간 잠금(Web Locks) + 저장 전 최신 원장 병합 + storage 이벤트 동기화
//  3 실행기 연결 실패/HTTP 오류/승인 거부 → 재시도 없이 즉시 중단   7 코드 펜스 추출: CRLF · 모든 언어 태그 · 여러 블록 중 실행 언어 우선
//  4 재시도 프롬프트에 원래 요청·타겟 유지 · 같은 코드/같은 에러 반복 시 중단   8 실행기 쪽 안전장치는 runner.js (Origin/Host 검사 · 셸 미사용 · 타임아웃 · 작업 폴더 · 승인)

const FENCE = /```[ \t]*([\w#+.-]*)[^\r\n]*\r?\n([\s\S]*?)(?:\r?\n)?```/g;
const LANG_ALIAS = { js: 'javascript', javascript: 'javascript', mjs: 'javascript', node: 'javascript', nodejs: 'javascript', ecmascript: 'javascript', py: 'python', python: 'python', python3: 'python', sh: 'shell', bash: 'shell', shell: 'shell', zsh: 'shell', ts: 'typescript', typescript: 'typescript', html: 'html', css: 'css', json: 'json' };
// 실행기 문제(코드를 고쳐도 해결 안 됨) → 즉시 중단
const RUNNER_LEVEL = new Set(['approval_denied', 'spawn_error', 'busy', 'runner_http', 'runner_unreachable', 'runner_bad_response']);

const fnv = (s) => { let h = 0x811c9dc5; const t = String(s); for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(16).padStart(8, '0'); };

// 에러 서명: 경로·줄/칸 번호·숫자를 지운 첫 의미 있는 줄 (같은 에러 반복 감지용)
export function errorSignature(text) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const key = lines.find((l) => /(Error|Exception|TIMEOUT|EXIT_|UNSUPPORTED)/.test(l)) || lines[0] || '';
  return key.replace(/[A-Za-z]:\\[^\s:'"]+|\/[^\s:'"]+/g, '<path>').replace(/:\d+(:\d+)?/g, '').replace(/\d+/g, '#').slice(0, 200);
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
  } = {}) {
    this.runnerUrl = String(runnerUrl).trim();
    this.maxRetries = Math.max(1, Number(maxRetries) || 3);
    this.storageKey = storageKey;
    this.runnerTimeoutMs = runnerTimeoutMs;
    this.storage = storage;
    this.lockManager = lockManager;
    this.onLedgerChange = onLedgerChange;
    this.activeLock = null;
    this.ledger = this._loadLedger();
    this._onStorage = (e) => { if (e.key === this.storageKey) { this.ledger = this._loadLedger(); this.onLedgerChange?.(this.ledger); } };
    if (typeof window !== 'undefined' && window.addEventListener) window.addEventListener('storage', this._onStorage);
  }

  dispose() { if (typeof window !== 'undefined' && window.removeEventListener) window.removeEventListener('storage', this._onStorage); }

  _loadLedger() {
    try {
      const raw = JSON.parse(this.storage.getItem(this.storageKey) || '{}');
      return { runs: Array.isArray(raw.runs) ? raw.runs : [], committed: Array.isArray(raw.committed) ? raw.committed : [] };
    } catch { return { runs: [], committed: [] }; }
  }

  reloadLedger() { this.ledger = this._loadLedger(); return this.ledger; }

  // 저장 직전에 최신 원장을 다시 읽어 runId 기준으로 합친다 (다른 탭 기록 보존). 용량 초과면 오래된 확정본부터 줄인다.
  _saveLedger(newRun, newCommit) {
    const merge = (list, item, cap) => { const m = new Map(list.map((r) => [r.runId, r])); if (item) m.set(item.runId, item); return [...m.values()].sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp))).slice(0, cap); };
    const latest = this._loadLedger();
    const next = { runs: merge(latest.runs, newRun, 100), committed: merge(latest.committed, newCommit, 50) };
    for (let i = 0; i < 60; i++) {
      try { this.storage.setItem(this.storageKey, JSON.stringify(next)); this.ledger = next; return { ok: true, trimmed: i }; }
      catch (e) {
        if (next.committed.length > 1) next.committed.pop();
        else if (next.runs.length > 1) next.runs.pop();
        else { this.ledger = next; return { ok: false, error: String(e?.message || e) }; }
      }
    }
    this.ledger = next;
    return { ok: false, error: 'LEDGER_SAVE_FAILED' };
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

  // 실행기 호출 → { executed, exitCode, output(stdout), stderr, reason, runnerLevel, httpStatus, durationMs }
  async runOnLocal(targetModule, code, command = '', { language = 'javascript', args, runId } = {}) {
    let res;
    try {
      res = await fetch(this.runnerUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runId, targetModule, language, code, command, args }),
        signal: AbortSignal.timeout(this.runnerTimeoutMs),
      });
    } catch (err) {
      return { executed: false, exitCode: null, output: '', stderr: `RUNNER_UNREACHABLE: ${String(err?.message || err)}`, reason: 'runner_unreachable', runnerLevel: true, httpStatus: 0 };
    }
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      return { executed: false, exitCode: null, output: '', stderr: `RUNNER_HTTP_${res.status} ${t.slice(0, 200)}`, reason: 'runner_http', runnerLevel: true, httpStatus: res.status };
    }
    let data;
    try { data = await res.json(); } catch { return { executed: false, exitCode: null, output: '', stderr: 'RUNNER_BAD_RESPONSE: JSON 아님', reason: 'runner_bad_response', runnerLevel: true, httpStatus: res.status }; }
    const reason = String(data?.reason || (data?.executed ? (data.exitCode === 0 ? 'ok' : 'nonzero_exit') : 'unknown'));
    return {
      executed: Boolean(data?.executed),
      exitCode: Number.isInteger(data?.exitCode) ? data.exitCode : null,
      output: String(data?.output ?? '').trim(),
      stderr: String(data?.stderr ?? '').trim(),
      reason,
      runnerLevel: RUNNER_LEVEL.has(reason),
      httpStatus: res.status,
      durationMs: data?.durationMs ?? null,
      codeHash: data?.codeHash || null,
    };
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

  async _runLocked({ targetModule, userPrompt, callModelFn, command = '', args, language = 'javascript', onProgress = () => {} }) {
    if (this.activeLock && this.activeLock.status === 'RUNNING') return { ok: false, status: 'SINGLE_TARGET_LOCKED', verified: false, committed: false, error: `현재 [${this.activeLock.targetModule}] (${this.activeLock.runId}) 작업 진행 중` };
    const runId = `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    this.activeLock = { runId, targetModule, status: 'RUNNING', startedAt: Date.now() };
    try { this.storage.setItem(`${this.storageKey}:active`, JSON.stringify(this.activeLock)); } catch { /* 표시용 */ }

    const lang = LANG_ALIAS[String(language).toLowerCase()] || 'javascript';
    const langRule = lang === 'python' ? 'Python 3 스크립트' : 'Node.js ESM(JavaScript, import/export 사용 가능)';
    let code = '', prevHash = '', lastError = '', lastSig = '', source = 'model', fallbackUsed = false, attemptsUsed = 0, stopReason = '';
    let exec = { executed: false, exitCode: null, output: '', stderr: '', reason: 'not_run' };
    const history = [];
    const emit = (p) => { try { onProgress({ targetModule, maxRetries: this.maxRetries, ...p }); } catch { /* UI 오류가 엔진을 멈추지 않게 */ } };

    try {
      for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
        attemptsUsed = attempt;
        const isRetry = attempt > 1;
        emit({ stage: isRetry ? 'patch' : 'think', attempt, message: isRetry ? `[${attempt}/${this.maxRetries}] 에러 로그 반영해 부분 수정 중...` : `[${attempt}/${this.maxRetries}] 단일 타겟 [${targetModule}] 생성 준비 중...` });

        const base = `타겟: ${targetModule}\n원래 요청: ${userPrompt}\n언어: ${langRule}\n규칙: 실행하면 결과를 표준 출력(console.log/print)으로 반드시 출력하고, 정상 종료(exit code 0)해야 합니다. 설명 없이 코드 블록 하나로만 답하세요.`;
        const prompt = !isRetry
          ? `요구사항에 맞는 실행 가능한 코드만 작성하세요.\n${base}`
          : `이전 코드 실행이 실패했습니다. 원래 요구사항을 유지한 채 에러만 고친 전체 코드를 다시 출력하세요.\n${base}\n\n[에러 로그]\n${lastError}\n\n[이전 코드]\n${code}`;

        let produced = false;
        try {
          if (typeof callModelFn !== 'function') throw new Error('NO_MODEL_FN');
          const rawOut = await callModelFn(prompt, { attempt, lastError, targetModule, userPrompt, language: lang });
          const extracted = this.extractCode(rawOut, lang);
          if (!extracted) throw new Error('EMPTY_MODEL_OUTPUT');
          code = extracted; source = 'model'; produced = true;
        } catch (modelErr) {
          const why = String(modelErr?.message || modelErr);
          if (isRetry) { stopReason = 'MODEL_FAILED_ON_RETRY'; lastError = `${lastError}\n[모델 재호출 실패] ${why}`.trim(); history.push({ attempt, source: 'model', error: why }); break; } // 같은 실패 코드 재실행 금지
          fallbackUsed = true; source = 'zero_cost_local_fallback';
          code = this.buildZeroCostStub(targetModule, why);
        }

        const hash = fnv(code);
        if (produced && isRetry && hash === prevHash) { stopReason = 'NO_NEW_PATCH'; history.push({ attempt, source, codeHash: hash, error: '모델이 같은 코드를 다시 냄' }); break; }
        prevHash = hash;
        emit({ stage: 'build', attempt, source, fallbackUsed, codeHash: hash, message: `[${attempt}/${this.maxRetries}] 산출물 준비 완료 (${source})` });

        emit({ stage: 'execute', attempt, message: `[${attempt}/${this.maxRetries}] 로컬 실행기(runner.js) 실행 중...` });
        exec = await this.runOnLocal(targetModule, code, command, { language: lang, args, runId });
        const okRun = exec.executed && exec.exitCode === 0 && exec.output.length > 0;
        history.push({ attempt, source, codeHash: hash, reason: exec.reason, exitCode: exec.exitCode, durationMs: exec.durationMs ?? null, error: okRun ? '' : (exec.stderr || exec.output).slice(0, 300) });
        emit({ stage: 'observe', attempt, reason: exec.reason, exitCode: exec.exitCode, outputPreview: exec.output.slice(0, 200), errorPreview: okRun ? '' : (exec.stderr || exec.output).slice(0, 200), message: `[${attempt}/${this.maxRetries}] 실행 결과: ${exec.reason}${exec.exitCode !== null ? ` · exit ${exec.exitCode}` : ''}` });

        if (exec.runnerLevel) { stopReason = exec.reason === 'runner_http' ? `RUNNER_HTTP_${exec.httpStatus}` : exec.reason.toUpperCase(); lastError = exec.stderr; break; }
        if (fallbackUsed) { stopReason = 'FALLBACK_ONLY'; lastError = okRun ? '모델 없이 0원 스텁만 실행됨 (실행기 경로 확인용, 확정 불가)' : (exec.stderr || exec.output); break; }
        if (okRun) { stopReason = 'OK'; break; }

        lastError = exec.executed && exec.exitCode === 0 && !exec.output
          ? 'EXIT_0_BUT_NO_OUTPUT: 정상 종료했지만 표준 출력이 비어 있습니다. 실행 결과를 console.log/print 로 출력하세요.'
          : [`REASON: ${exec.reason}${exec.exitCode !== null ? ` (exit ${exec.exitCode})` : ''}`, exec.stderr, exec.output && `STDOUT:\n${exec.output}`].filter(Boolean).join('\n').slice(0, 4000);
        const sig = errorSignature(lastError);
        if (sig && sig === lastSig) { stopReason = 'REPEATED_ERROR'; break; }
        lastSig = sig;
        if (attempt === this.maxRetries) stopReason = 'MAX_RETRIES';
      }

      const verified = Boolean(exec.executed && exec.exitCode === 0 && exec.output.length > 0 && !fallbackUsed && source === 'model');
      const status = verified ? 'VERIFIED' : 'UNVERIFIED_NEEDS_LOCAL_RUN';
      const codeHash = code ? fnv(code) : '';
      const record = {
        runId, targetModule, language: lang,
        attempts: attemptsUsed, source, fallbackUsed, patched: attemptsUsed > 1,
        executed: Boolean(exec.executed), exitCode: exec.exitCode, runnerReason: exec.reason,
        verified, status, stopReason,
        observedOutput: verified ? exec.output.slice(0, 2000) : '',
        lastError: verified ? '' : String(lastError || exec.stderr || '').slice(0, 2000),
        codeHash, history,
        timestamp: new Date().toISOString(),
      };
      const commitRecord = verified ? { ...record, code } : null;
      const saved = this._saveLedger(record, commitRecord);
      const committed = Boolean(verified && saved.ok);

      const finalResult = {
        ok: true, ...record, committed, code,
        ledgerWarning: saved.ok ? (saved.trimmed ? `저장 공간 부족으로 오래된 기록 ${saved.trimmed}건 정리` : '') : `원장 저장 실패: ${saved.error}`,
        commitReason: committed
          ? '실제 실행 성공(exit 0) + 관측 출력 확인 · committed 반영됨'
          : verified ? '검증은 통과했지만 원장 저장 실패 · committed 미반영'
          : `반영 보류 (${stopReason || status}) · 실제 실행/관측 출력 미확인 또는 실패`,
      };
      emit({ stage: 'commit', status, committed, stopReason, message: finalResult.commitReason });
      this.onLedgerChange?.(this.ledger);
      return finalResult;
    } finally {
      this.activeLock = null;
      try { this.storage.removeItem(`${this.storageKey}:active`); } catch { /* 표시용 */ }
    }
  }
}
