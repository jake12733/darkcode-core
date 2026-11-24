// AstraUnifiedEngine v2 + runner.js 테스트
//   A. 엔진 로직 (가짜 실행기) · 어디서나
//   B. 실행기 HTTP 보안 검사 · 어디서나 (프로세스 생성 없음)
//   C. 실제 코드 실행 · 타임아웃 · 권한 격리 · 엔진 통합 · 자식 프로세스를 만들 수 있는 환경에서만
//      (CI 는 RUNNER_REQUIRE_SPAWN=1 → 못 만들면 실패 처리)
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { AstraUnifiedEngine, errorSignature } from '../runner/astra-unified-engine.js';
import { createRunner, detectPermissionFlag } from '../runner/runner.js';

const results = [];
async function t(name, fn) { const s = Date.now(); try { await fn(); results.push(['PASS', name, Date.now() - s]); } catch (e) { results.push(['FAIL', name, Date.now() - s, e.stack?.split('\n').slice(0, 3).join(' | ') || e.message]); } }
const skip = (name, why) => results.push(['SKIP', name, 0, why]);
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
const memStore = (limit = Infinity) => { const m = new Map(); return { m, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { if (String(v).length > limit) { const e = new Error('QuotaExceededError'); e.name = 'QuotaExceededError'; throw e; } m.set(k, String(v)); }, removeItem: (k) => m.delete(k) }; };
const fence = (code, lang = 'js') => '```' + lang + '\n' + code + '\n```';

// ---------- 가짜 실행기 (runner.js 응답 계약 그대로) ----------
const calls = [];
// 코드 안 표식으로 결과를 정한다 · entry 가 test.mjs 면 main.mjs 표식(PASS_ALL/FAIL_ONE/FAIL_EDGE/FAIL_ALL)으로 테스트 결과
const mockOne = (code, entry, b) => {
  code = String(code || '');
  if (entry === 'test.mjs') {
    if (code.includes('PASS_ALL')) return { executed: true, exitCode: 0, reason: 'ok', output: 'ok 1 - a\nok 2 - b\nok 3 - edge case\n# tests 3\n# pass 3\n# fail 0', stderr: '', tests: { total: 3, pass: 3, fail: 0, failed: [] } };
    if (code.includes('FAIL_EDGE') || code.includes('FAIL_ONE')) return { executed: true, exitCode: 1, reason: 'nonzero_exit', output: 'ok 1 - a\nok 2 - b\nnot ok 3 - edge case\n  ---\n  error: expected 0 got 1\n  ...\n# tests 3\n# pass 2\n# fail 1', stderr: '', tests: { total: 3, pass: 2, fail: 1, failed: ['edge case'] } };
    if (code.includes('FAIL_ALL')) return { executed: true, exitCode: 1, reason: 'nonzero_exit', output: 'not ok 1 - a\nnot ok 2 - b\nnot ok 3 - edge case\n# tests 3\n# pass 0\n# fail 3', stderr: '', tests: { total: 3, pass: 0, fail: 3, failed: ['a', 'b', 'edge case'] } };
    return { executed: true, exitCode: 0, reason: 'ok', output: '# tests 1\n# pass 1\n# fail 0', stderr: '', tests: { total: 1, pass: 1, fail: 0, failed: [] } };
  }
  if (code.includes('DENY_MARK')) return { executed: false, exitCode: null, reason: 'approval_denied', output: '', stderr: 'APPROVAL_DENIED (console)' };
  if (code.includes('THROW_MARK')) return { executed: true, exitCode: 1, reason: 'nonzero_exit', output: '', stderr: `TypeError: x is not a function\n    at file:///C:/ws/${b.runId}/main.mjs:${3 + calls.length}:5` };
  if (code.includes('SILENT_MARK')) return { executed: true, exitCode: 0, reason: 'ok', output: '', stderr: '' };
  if (code.includes('FALLBACK_STUB_READY')) return { executed: true, exitCode: 0, reason: 'ok', output: `FALLBACK_STUB_READY: ${b.targetModule}`, stderr: '' };
  if (code.includes('OUT_SAME')) return { executed: true, exitCode: 0, reason: 'ok', output: 'same', stderr: '' };
  if (code.includes('OK_MARK')) return { executed: true, exitCode: 0, reason: 'ok', output: 'RESULT 42', stderr: '' };
  return { executed: true, exitCode: 0, reason: 'ok', output: 'default', stderr: '' };
};
const mock = http.createServer(async (req, res) => {
  let raw = ''; for await (const c of req) raw += c;
  if (req.url !== '/run') { res.writeHead(404); return res.end('nope'); }
  const b = JSON.parse(raw); calls.push(b);
  const out = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ durationMs: 5, ...o })); };
  if (Array.isArray(b.jobs)) {
    if (b.jobs.some((j) => String((j.files && j.files['main.mjs']) || '').includes('DENY_MARK'))) return out(mockOne('DENY_MARK', 'main.mjs', b));
    return out({ batch: true, results: b.jobs.map((j) => ({ durationMs: 5, label: j.label, ...mockOne((j.files && j.files['main.mjs']) || j.code, j.entry, b) })) });
  }
  return out(mockOne(b.code, 'main.mjs', b));
});
const mockPort = await listen(mock);
const RUN = `http://127.0.0.1:${mockPort}/run`;
// 예전 실행기 흉내 (jobs 를 모르고 code 하나만 실행)
const legacy = http.createServer(async (req, res) => { let raw = ''; for await (const c of req) raw += c; const b = JSON.parse(raw); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ durationMs: 5, ...mockOne(b.code, 'main.mjs', b) })); });
const legacyPort = await listen(legacy);
// 기존(v2) 동작 테스트는 testsFirst 를 끄고, v3 기능은 아래 A17~ 에서 따로 검사
const engine = (o = {}) => new AstraUnifiedEngine({ runnerUrl: RUN, storage: memStore(), lockManager: null, testsFirst: false, ...o });
// 역할별 가짜 모델: tests/repair 는 호출 순서대로, code 는 후보 번호대로
const byRole = (map) => { const prompts = []; const counts = {}; const fn = async (p, ctx = {}) => { prompts.push({ p, ctx }); const r = ctx.role || 'code'; const list = map[r] || map.code; const k = r === 'code' ? (ctx.candidate || 0) : ((counts[r] = (counts[r] || 0) + 1) - 1); const o = Array.isArray(list) ? list[Math.min(k, list.length - 1)] : list; if (o instanceof Error) throw o; return o; }; fn.prompts = prompts; return fn; };
const TESTS_FENCE = '```js\nimport { test } from \'node:test\';\nimport assert from \'node:assert/strict\';\nimport { f } from \'./main.mjs\';\ntest(\'a\', () => assert.equal(f(1), 1));\ntest(\'b\', () => assert.equal(f(2), 2));\ntest(\'edge case\', () => assert.equal(f(0), 0));\n```';
const seq = (...outs) => { const prompts = []; let i = 0; const fn = async (p) => { prompts.push(p); const o = outs[Math.min(i++, outs.length - 1)]; if (o instanceof Error) throw o; return o; }; fn.prompts = prompts; return fn; };

// ================= A. 엔진 로직 =================
await t('A1 extractCode: CRLF · python/html 태그 · 여러 블록 중 실행 언어 우선 · 펜스 없음 · 닫히지 않은 펜스', () => {
  const e = engine();
  assert.equal(e.extractCode('```js\r\nconsole.log(1)\r\n```'), 'console.log(1)');
  assert.equal(e.extractCode('설명\n```python\nprint(1)\n```\n```javascript\nconsole.log(2)\n```'), 'console.log(2)');
  assert.equal(e.extractCode('```python\nprint(1)\n```', 'python'), 'print(1)');
  assert.equal(e.extractCode('```html\n<b>x</b>\n```'), '<b>x</b>');
  assert.equal(e.extractCode('console.log(3)'), 'console.log(3)');
  assert.equal(e.extractCode('```js\nconsole.log(4)'), 'console.log(4)');
  assert.equal(e.extractCodeBlock('```node\nx\n```').language, 'javascript');
});
await t('A2 VERIFIED: exit 0 + 관측 출력 → committed 에 code 포함', async () => {
  calls.length = 0; const e = engine();
  const r = await e.runTask({ targetModule: 'calc', userPrompt: '42 출력', callModelFn: seq(fence('console.log("OK_MARK")')) });
  assert.equal(r.status, 'VERIFIED'); assert.equal(r.committed, true); assert.equal(r.observedOutput, 'RESULT 42'); assert.equal(r.stopReason, 'OK');
  assert.equal(e.ledger.committed[0].code, 'console.log("OK_MARK")'); assert.equal(e.ledger.committed[0].codeHash, r.codeHash);
  assert.equal(calls[0].language, 'javascript'); assert.ok(calls[0].runId.startsWith('run_'));
});
await t('A3 재시도: 2회차 프롬프트에 원래 요청·타겟·에러 로그 포함 → 수정 후 VERIFIED', async () => {
  const fn = seq(fence('THROW_MARK()'), fence('console.log("OK_MARK")'));
  const r = await engine().runTask({ targetModule: 'parser', userPrompt: 'CSV 파싱해서 합계 출력', callModelFn: fn });
  assert.equal(r.status, 'VERIFIED'); assert.equal(r.attempts, 2); assert.equal(r.patched, true);
  assert.match(fn.prompts[1], /원래 요청: CSV 파싱해서 합계 출력/); assert.match(fn.prompts[1], /타겟: parser/); assert.match(fn.prompts[1], /TypeError: x is not a function/);
});
await t('A4 0원 폴백: 모델 없음 → 스텁 실행돼도 VERIFIED/committed 아님 (FALLBACK_ONLY)', async () => {
  const e = engine();
  const r = await e.runTask({ targetModule: 'auth', userPrompt: '로그인' });
  assert.equal(r.fallbackUsed, true); assert.equal(r.verified, false); assert.equal(r.committed, false); assert.equal(r.stopReason, 'FALLBACK_ONLY');
  assert.equal(e.ledger.committed.length, 0); assert.equal(e.ledger.runs.length, 1);
});
await t('A5 실행기 꺼짐 → 재시도 없이 즉시 중단 (모델 1회만 호출)', async () => {
  const fn = seq(fence('THROW_MARK()'), fence('console.log("OK_MARK")'));
  const r = await engine({ runnerUrl: 'http://127.0.0.1:1/run', runnerTimeoutMs: 3000 }).runTask({ targetModule: 'm', userPrompt: 'x', callModelFn: fn });
  assert.equal(r.stopReason, 'RUNNER_UNREACHABLE'); assert.equal(fn.prompts.length, 1); assert.equal(r.attempts, 1); assert.equal(r.committed, false);
});
await t('A6 실행기 HTTP 오류(404, 잘못된 경로) → 즉시 중단', async () => {
  const fn = seq(fence('console.log("OK_MARK")'));
  const r = await engine({ runnerUrl: `http://127.0.0.1:${mockPort}/nope` }).runTask({ targetModule: 'm', userPrompt: 'x', callModelFn: fn });
  assert.equal(r.stopReason, 'RUNNER_HTTP_404'); assert.equal(fn.prompts.length, 1);
});
await t('A7 승인 거부 → 즉시 중단 (코드 수정 루프 안 돎)', async () => {
  const fn = seq(fence('DENY_MARK'), fence('console.log("OK_MARK")'));
  const r = await engine().runTask({ targetModule: 'm', userPrompt: 'x', callModelFn: fn });
  assert.equal(r.stopReason, 'APPROVAL_DENIED'); assert.equal(fn.prompts.length, 1);
});
await t('A8 같은 에러 반복(코드는 다름) → REPEATED_ERROR 로 중단', async () => {
  const fn = seq(fence('THROW_MARK(1)'), fence('THROW_MARK(2)'), fence('console.log("OK_MARK")'));
  const r = await engine().runTask({ targetModule: 'm', userPrompt: 'x', callModelFn: fn });
  assert.equal(r.stopReason, 'REPEATED_ERROR'); assert.equal(fn.prompts.length, 2); assert.equal(r.verified, false);
});
await t('A9 모델이 같은 코드를 다시 냄 → NO_NEW_PATCH, 같은 코드 재실행 안 함', async () => {
  calls.length = 0;
  const fn = seq(fence('THROW_MARK()'));
  const r = await engine().runTask({ targetModule: 'm', userPrompt: 'x', callModelFn: fn });
  assert.equal(r.stopReason, 'NO_NEW_PATCH'); assert.equal(calls.length, 1);
});
await t('A10 재시도 중 모델 실패 → 직전 실패 코드 재실행 없이 중단', async () => {
  calls.length = 0;
  const fn = seq(fence('THROW_MARK()'), new Error('MODEL_TIMEOUT'));
  const r = await engine().runTask({ targetModule: 'm', userPrompt: 'x', callModelFn: fn });
  assert.equal(r.stopReason, 'MODEL_FAILED_ON_RETRY'); assert.equal(calls.length, 1); assert.equal(r.fallbackUsed, false);
});
await t('A11 exit 0 인데 출력 없음 → 미검증, "console.log 로 출력" 지시로 재시도', async () => {
  const fn = seq(fence('SILENT_MARK'), fence('console.log("OK_MARK")'));
  const r = await engine().runTask({ targetModule: 'm', userPrompt: 'x', callModelFn: fn });
  assert.equal(r.status, 'VERIFIED'); assert.match(fn.prompts[1], /EXIT_0_BUT_NO_OUTPUT/);
});
await t('A12 같은 엔진 동시 실행 → SINGLE_TARGET_LOCKED', async () => {
  const e = engine();
  const slow = async () => { await new Promise((r) => setTimeout(r, 150)); return fence('console.log("OK_MARK")'); };
  const [a, b] = await Promise.all([e.runTask({ targetModule: 'one', userPrompt: 'x', callModelFn: slow }), new Promise((r) => setTimeout(r, 20)).then(() => e.runTask({ targetModule: 'two', userPrompt: 'y', callModelFn: slow }))]);
  assert.equal(a.status, 'VERIFIED'); assert.equal(b.status, 'SINGLE_TARGET_LOCKED'); assert.match(b.error, /one/);
});
await t('A13 탭 간 잠금(Web Locks 계약) → 다른 엔진 인스턴스도 SINGLE_TARGET_LOCKED', async () => {
  const held = new Set();
  const locks = { request: async (name, opt, cb) => { if (held.has(name)) return cb(null); held.add(name); try { return await cb({ name }); } finally { held.delete(name); } } };
  const store = memStore();
  const e1 = engine({ storage: store, lockManager: locks }); const e2 = engine({ storage: store, lockManager: locks });
  const slow = async () => { await new Promise((r) => setTimeout(r, 150)); return fence('console.log("OK_MARK")'); };
  const [a, b] = await Promise.all([e1.runTask({ targetModule: 'tabA', userPrompt: 'x', callModelFn: slow }), new Promise((r) => setTimeout(r, 30)).then(() => e2.runTask({ targetModule: 'tabB', userPrompt: 'y', callModelFn: slow }))]);
  assert.equal(a.status, 'VERIFIED'); assert.equal(b.status, 'SINGLE_TARGET_LOCKED'); assert.match(b.error, /tabA/);
});
await t('A14 원장 병합: 먼저 만든 탭이 나중에 저장해도 다른 탭 기록이 지워지지 않음', async () => {
  const store = memStore();
  const e1 = engine({ storage: store }); const e2 = engine({ storage: store });
  await e1.runTask({ targetModule: 'first', userPrompt: 'x', callModelFn: seq(fence('console.log("OK_MARK")')) });
  await e2.runTask({ targetModule: 'second', userPrompt: 'y', callModelFn: seq(fence('console.log("OK_MARK", 2)')) });
  const saved = JSON.parse(store.getItem('dc_astra_unified_ledger_v1'));
  assert.deepEqual(saved.runs.map((r) => r.targetModule).sort(), ['first', 'second']);
  assert.equal(saved.committed.length, 2);
});
await t('A15 저장 공간 부족 → 오래된 기록 정리 후 저장 + 경고', async () => {
  const store = memStore(6000);
  const e = engine({ storage: store });
  let last;
  for (let i = 0; i < 6; i++) last = await e.runTask({ targetModule: `big${i}`, userPrompt: 'x', callModelFn: seq(fence(`console.log("OK_MARK"); // ${'x'.repeat(1200)} ${i}`)) });
  assert.equal(last.committed, true); assert.match(last.ledgerWarning, /정리/);
  assert.ok(JSON.parse(store.getItem('dc_astra_unified_ledger_v1')).committed.length < 6);
});
await t('A16 에러 서명: 경로·줄번호가 달라도 같은 에러로 인식', () => {
  assert.equal(errorSignature('TypeError: a is not a function\n at file:///C:/x/a/main.mjs:3:5'), errorSignature('TypeError: a is not a function\n at file:///C:/y/b/main.mjs:9:1'));
});

// ================= A (v3). 테스트 우선 · 후보 여러 개 · 분쟁 테스트 · 실패 기억 =================
await t('A17 테스트 우선: 요구사항 → 테스트 → 코드 · 테스트 통과해야 VERIFIED', async () => {
  const fn = byRole({ tests: TESTS_FENCE, code: [fence('export const f = (x) => x;\nconsole.log("OK_MARK") // PASS_ALL')] });
  const e = engine({ testsFirst: true });
  const r = await e.runTask({ targetModule: 'tf', userPrompt: 'f(x) 는 x 를 돌려준다', callModelFn: fn });
  assert.equal(r.status, 'VERIFIED', JSON.stringify(r.history)); assert.equal(r.verification, 'tests'); assert.equal(r.tests.passed, 3); assert.equal(r.tests.failed, 0);
  assert.equal(fn.prompts[0].ctx.role, 'tests'); assert.match(fn.prompts[1].p, /\[test\.mjs\]/); assert.match(fn.prompts[1].p, /pathToFileURL/);
  assert.ok(e.ledger.committed[0].testCode.includes('node:test'));
});
await t('A18 테스트 실패 → 실패한 테스트 내용으로 수정 → 통과', async () => {
  const fn = byRole({ tests: TESTS_FENCE, code: [fence('console.log("OK_MARK") // FAIL_ONE')], repair: [fence('console.log("OK_MARK") // PASS_ALL')] });
  const r = await engine({ testsFirst: true }).runTask({ targetModule: 'tf2', userPrompt: 'x', callModelFn: fn });
  assert.equal(r.status, 'VERIFIED'); assert.equal(r.attempts, 2);
  const rp = fn.prompts.find((x) => x.ctx.role === 'repair');
  assert.ok(rp && /\[테스트 실패\]/.test(rp.p) && /not ok 3 - edge case/.test(rp.p)); assert.equal(rp.ctx.deep, true);
});
await t('A19 후보 3개 → 테스트 가장 많이 통과한 후보 선택 (승인 한 번 묶음)', async () => {
  calls.length = 0;
  const fn = byRole({ tests: TESTS_FENCE, code: [fence('console.log("OK_MARK") // FAIL_ALL'), fence('console.log("OK_MARK") // PASS_ALL'), fence('console.log("OK_MARK") // FAIL_ONE')] });
  const r = await engine({ testsFirst: true, candidates: 3 }).runTask({ targetModule: 'bon', userPrompt: 'x', callModelFn: fn });
  assert.equal(r.status, 'VERIFIED'); assert.equal(r.chosenCandidate, 1); assert.equal(r.candidatesTried, 3); assert.equal(r.attempts, 1);
  assert.equal(calls.length, 1); assert.equal(calls[0].jobs.length, 6);
  const codeCtx = fn.prompts.filter((x) => x.ctx.role === 'code').map((x) => x.ctx);
  assert.deepEqual(codeCtx.map((c) => c.deep), [false, true, true]); assert.equal(new Set(codeCtx.map((c) => c.temperature)).size, 3);
});
await t('A20 분쟁 테스트: 모든 후보가 같은 출력으로 같은 테스트에서 실패 → 테스트 제외하고 판정', async () => {
  const fn = byRole({ tests: TESTS_FENCE, code: [fence('// v1 OUT_SAME FAIL_EDGE\nconsole.log("same")'), fence('// v2 OUT_SAME FAIL_EDGE\nconsole.log("same")')] });
  const r = await engine({ testsFirst: true, candidates: 2 }).runTask({ targetModule: 'disp', userPrompt: 'x', callModelFn: fn });
  assert.equal(r.status, 'VERIFIED', JSON.stringify(r.tests)); assert.deepEqual(r.tests.disputed, ['edge case']); assert.equal(r.tests.passed, 2);
});
await t('A21 실패 기억: 예전에 고친 같은 종류 에러면 수정 프롬프트에 해결 코드 참고로 첨부', async () => {
  const e = engine({ storage: memStore() });
  await e.runTask({ targetModule: 'm1', userPrompt: 'x', callModelFn: seq(fence('THROW_MARK()'), fence('console.log("OK_MARK") // fixed-v1')) });
  assert.ok((e.ledger.fixes || []).length >= 1);
  const fn2 = seq(fence('THROW_MARK(2)'), fence('console.log("OK_MARK") // fixed-v2'));
  const r2 = await e.runTask({ targetModule: 'm2', userPrompt: 'y', callModelFn: fn2 });
  assert.equal(r2.status, 'VERIFIED'); assert.match(fn2.prompts[1], /예전에 비슷한 에러를 고친 코드/); assert.match(fn2.prompts[1], /fixed-v1/);
});
await t('A22 테스트를 못 만들면 출력 검증으로 (verification=output-only)', async () => {
  const r = await engine({ testsFirst: true }).runTask({ targetModule: 'nt', userPrompt: 'x', callModelFn: byRole({ tests: '테스트는 못 씁니다', code: [fence('console.log("OK_MARK")')] }) });
  assert.equal(r.verification, 'output-only'); assert.equal(r.status, 'VERIFIED'); assert.equal(r.tests, null);
});
await t('A23 예전 실행기(묶음 미지원) → 테스트 없이 출력 검증으로 자동 전환', async () => {
  const fn = byRole({ tests: TESTS_FENCE, code: [fence('console.log("OK_MARK") // PASS_ALL')] });
  const r = await engine({ testsFirst: true, runnerUrl: `http://127.0.0.1:${legacyPort}/run` }).runTask({ targetModule: 'old', userPrompt: 'x', callModelFn: fn });
  assert.equal(r.verification, 'output-only'); assert.equal(r.status, 'VERIFIED'); assert.equal(r.observedOutput, 'RESULT 42');
});

// ================= B. 실행기 HTTP 보안 =================
const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-runner-ws-'));
let denyCalls = 0;
const denyRunner = createRunner({ approver: async () => { denyCalls++; return { ok: false, by: 'test' }; }, permissionFlag: null, workspace: ws, logFile: path.join(ws, 'runner.log'), log: () => {} });
const dPort = await listen(denyRunner);
const req = (port, method, p, { headers = {}, body } = {}) => new Promise((resolve, reject) => { const r = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: d })); }); r.on('error', reject); if (body) r.write(body); r.end(); });
await t('B1 /health 계약', async () => {
  const r = await req(dPort, 'GET', '/health'); const j = JSON.parse(r.body);
  assert.equal(r.status, 200); assert.equal(j.name, 'darkcode-runner'); assert.deepEqual(j.languages, ['javascript']); assert.ok(j.features.includes('jobs') && j.features.includes('files'));
});
await t('B2 허용 안 된 Origin → 403 · 허용 Origin 프리플라이트 → 204 + 사설망 허용', async () => {
  assert.equal((await req(dPort, 'POST', '/run', { headers: { Origin: 'https://evil.example' }, body: '{}' })).status, 403);
  const p = await req(dPort, 'OPTIONS', '/run', { headers: { Origin: 'https://jake12733.github.io', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Private-Network': 'true' } });
  assert.equal(p.status, 204); assert.equal(p.headers['access-control-allow-origin'], 'https://jake12733.github.io'); assert.equal(p.headers['access-control-allow-private-network'], 'true');
});
await t('B3 DNS 리바인딩(Host 위조) → 403', async () => { assert.equal((await req(dPort, 'GET', '/health', { headers: { Host: 'evil.example:80' } })).status, 403); });
await t('B4 요청 검증: JSON 오류 400 · code 없음 400 · args 형식 400 · 너무 큰 code 413', async () => {
  assert.equal((await req(dPort, 'POST', '/run', { body: '{bad' })).status, 400);
  assert.equal((await req(dPort, 'POST', '/run', { body: '{}' })).status, 400);
  assert.equal((await req(dPort, 'POST', '/run', { body: JSON.stringify({ code: 'x', args: [1, 2] }) })).status, 400);
  assert.equal((await req(dPort, 'POST', '/run', { body: JSON.stringify({ code: 'x'.repeat(210000) }) })).status, 413);
});
await t('B5 지원 안 하는 언어 → 실행 없이 unsupported_language (코드 수준 실패로 재시도 대상)', async () => {
  const j = JSON.parse((await req(dPort, 'POST', '/run', { body: JSON.stringify({ code: 'echo hi', language: 'bash' }) })).body);
  assert.equal(j.reason, 'unsupported_language'); assert.equal(j.executed, false);
});
await t('B6 승인 거부 → approval_denied + 로그 파일 기록', async () => {
  const j = JSON.parse((await req(dPort, 'POST', '/run', { body: JSON.stringify({ code: 'console.log(1)', targetModule: 'denyme' }) })).body);
  assert.equal(j.reason, 'approval_denied');
  assert.match(fs.readFileSync(path.join(ws, 'runner.log'), 'utf8'), /"targetModule":"denyme".*"reason":"approval_denied"/);
});
await t('B7 files · jobs 검증: 잘못된 파일 이름 400 · entry 없음 400 · jobs 9개 400', async () => {
  assert.equal((await req(dPort, 'POST', '/run', { body: JSON.stringify({ files: { '../x.mjs': 'a' } }) })).status, 400);
  assert.equal((await req(dPort, 'POST', '/run', { body: JSON.stringify({ files: { 'main.mjs': 'a' }, entry: 'test.mjs' }) })).status, 400);
  assert.equal((await req(dPort, 'POST', '/run', { body: JSON.stringify({ jobs: Array.from({ length: 9 }, () => ({ code: 'x' })) }) })).status, 400);
});
await t('B8 묶음 실행은 승인 한 번 (거부하면 통째로 approval_denied)', async () => {
  const before = denyCalls;
  const j = JSON.parse((await req(dPort, 'POST', '/run', { body: JSON.stringify({ targetModule: 'batch', jobs: [{ code: 'console.log(1)' }, { files: { 'main.mjs': 'export const a = 1;', 'test.mjs': 'import { a } from "./main.mjs"; console.log(a);' }, entry: 'test.mjs' }] }) })).body);
  assert.equal(j.reason, 'approval_denied'); assert.equal(denyCalls - before, 1);
});
denyRunner.close();

// ================= C. 실제 실행 (자식 프로세스 필요) =================
const canSpawn = (() => { try { return spawnSync(process.execPath, ['-e', '0'], { stdio: 'ignore', timeout: 8000 }).status === 0; } catch { return false; } })();
if (!canSpawn) {
  const why = '이 환경은 자식 프로세스 생성 불가 (spawn EPERM)';
  if (process.env.RUNNER_REQUIRE_SPAWN) results.push(['FAIL', 'C 실제 실행', 0, why]);
  else ['C1 실제 실행 성공', 'C2 비정상 종료', 'C3 타임아웃 강제 종료', 'C4 권한 격리', 'C5 출력 상한', 'C6 엔진+실제 실행기 통합', 'C7 여러 파일 + node:test 결과 파싱', 'C8 묶음 실행 (승인 한 번)', 'C9 엔진 테스트 우선 + 실제 실행기', 'C10 엔진 best-of-N + 실제 실행기'].forEach((n) => skip(n, why));
} else {
  const perm = detectPermissionFlag();
  const runner = createRunner({ approval: 'auto', permissionFlag: perm, workspace: ws, logFile: path.join(ws, 'runner.log'), log: () => {}, maxOutputBytes: 2000 });
  const rPort = await listen(runner);
  const run = async (body) => JSON.parse((await req(rPort, 'POST', '/run', { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).body);
  await t('C1 실제 실행 성공: stdout · exit 0 · ESM export 문법', async () => {
    const j = await run({ targetModule: 'c1', code: 'export const v = 6 * 7;\nconsole.log("answer", v);' });
    assert.equal(j.reason, 'ok'); assert.equal(j.exitCode, 0); assert.equal(j.output, 'answer 42');
  });
  await t('C2 비정상 종료: exit 1 + stderr', async () => {
    const j = await run({ targetModule: 'c2', code: 'console.error("boom"); process.exit(3);' });
    assert.equal(j.reason, 'nonzero_exit'); assert.equal(j.exitCode, 3); assert.match(j.stderr, /boom/);
  });
  await t('C3 타임아웃: 무한 루프를 제한 시간 뒤 강제 종료', async () => {
    const t0 = Date.now(); const j = await run({ targetModule: 'c3', code: 'while (true) {}', timeoutMs: 1500 });
    assert.equal(j.reason, 'timeout'); assert.ok(Date.now() - t0 < 15000, `너무 늦게 종료: ${Date.now() - t0}ms`);
  });
  await t(`C4 권한 격리(${perm || '미지원'}): 작업 폴더 밖 읽기 차단 · 안쪽 쓰기 허용 · 자식 프로세스 차단`, async () => {
    if (!perm) throw new Error('이 Node 는 권한 모델 플래그를 지원하지 않음');
    const outside = path.join(os.tmpdir(), `dc-outside-${Date.now()}.txt`); fs.writeFileSync(outside, 'secret');
    const j = await run({ targetModule: 'c4', code: `import fs from 'node:fs';\nlet a='ALLOWED';try{fs.readFileSync(${JSON.stringify(outside)});}catch(e){a='BLOCKED:'+e.code}\nlet b='FAIL';try{fs.writeFileSync('inside.txt','ok');b='OK'}catch(e){b='FAIL:'+e.code}\nlet c='ALLOWED';try{(await import('node:child_process')).execSync('echo x')}catch(e){c='BLOCKED:'+e.code}\nconsole.log(a, b, c);` });
    fs.rmSync(outside, { force: true });
    assert.equal(j.reason, 'ok', JSON.stringify(j)); assert.match(j.output, /^BLOCKED:\S+ OK BLOCKED:\S+$/, j.output);
  });
  await t('C5 출력 상한 → truncated', async () => {
    const j = await run({ targetModule: 'c5', code: 'console.log("x".repeat(10000))' });
    assert.equal(j.truncated, true); assert.ok(j.output.length <= 2000);
  });
  await t('C6 엔진+실제 실행기: 버그 코드 → 에러 로그 → 수정 → VERIFIED · 스텁은 미확정', async () => {
    const e = new AstraUnifiedEngine({ runnerUrl: `http://127.0.0.1:${rPort}/run`, storage: memStore(), lockManager: null, testsFirst: false });
    const fn = seq(fence('const nums = [1,2,3];\nconsole.log(nums.sumAll());'), fence('const nums = [1,2,3];\nconsole.log(nums.reduce((a,b)=>a+b,0));'));
    const r = await e.runTask({ targetModule: 'sum', userPrompt: '배열 합 출력', callModelFn: fn });
    assert.equal(r.status, 'VERIFIED', JSON.stringify(r.history)); assert.equal(r.observedOutput, '6'); assert.equal(r.attempts, 2); assert.match(fn.prompts[1], /TypeError/);
    const s = await e.runTask({ targetModule: 'nomodel', userPrompt: 'x' });
    assert.equal(s.executed, true); assert.equal(s.exitCode, 0); assert.equal(s.verified, false); assert.equal(s.stopReason, 'FALLBACK_ONLY');
  });
  const PT = (fnName, body) => "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { " + fnName + " } from './main.mjs';\n" + body;
  await t('C7 여러 파일 + node:test 결과 파싱 (TAP/spec)', async () => {
    const j = await run({ targetModule: 'c7', files: { 'main.mjs': 'export const add = (a, b) => a + b;', 'test.mjs': PT('add', "test('adds', () => assert.equal(add(1, 2), 3));\ntest('adds zero', () => assert.equal(add(0, 5), 5));\ntest('fails on purpose', () => assert.equal(add(1, 1), 3));") }, entry: 'test.mjs' });
    assert.ok(j.tests, JSON.stringify(j).slice(0, 600)); assert.equal(j.tests.pass, 2); assert.equal(j.tests.fail, 1); assert.deepEqual(j.tests.failed, ['fails on purpose']); assert.notEqual(j.exitCode, 0);
  });
  await t('C8 묶음 실행 (승인 한 번 · 작업별 결과)', async () => {
    let n = 0;
    const r2 = createRunner({ approver: async () => { n++; return { ok: true, by: 'test' }; }, permissionFlag: perm, workspace: ws, logFile: path.join(ws, 'runner.log'), log: () => {} });
    const p2 = await listen(r2);
    const body = { targetModule: 'c8', jobs: [{ label: 'run', files: { 'main.mjs': 'console.log("hi")' }, entry: 'main.mjs' }, { label: 'test', files: { 'main.mjs': 'export const one = () => 1;', 'test.mjs': PT('one', "test('one', () => assert.equal(one(), 1));") }, entry: 'test.mjs' }] };
    const j = JSON.parse((await req(p2, 'POST', '/run', { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).body);
    r2.close();
    assert.equal(n, 1); assert.equal(j.batch, true); assert.equal(j.results.length, 2); assert.equal(j.results[0].output, 'hi'); assert.equal(j.results[1].tests.pass, 1, JSON.stringify(j.results[1]).slice(0, 400));
  });
  const PRIME_TESTS = fence(PT('countPrimes', "test('to 10', () => assert.equal(countPrimes(10), 4));\ntest('to 100', () => assert.equal(countPrimes(100), 25));\ntest('to 1', () => assert.equal(countPrimes(1), 0));"));
  const primeCode = (extra) => fence("import { pathToFileURL } from 'node:url';\nexport function countPrimes(n) { let c = 0; for (let i = 2; i <= n; i++) { let p = true; for (let d = 2; d * d <= i; d++) if (i % d === 0) { p = false; break; } if (p) c++; } return c" + extra + "; }\nif (import.meta.url === pathToFileURL(process.argv[1]).href) console.log(countPrimes(100));");
  await t('C9 엔진 테스트 우선 + 실제 실행기 → VERIFIED(tests)', async () => {
    const e = new AstraUnifiedEngine({ runnerUrl: `http://127.0.0.1:${rPort}/run`, storage: memStore(), lockManager: null, testsFirst: true });
    const r = await e.runTask({ targetModule: 'primes', userPrompt: 'countPrimes(n): n 이하 소수 개수', callModelFn: byRole({ tests: PRIME_TESTS, code: [primeCode('')] }) });
    assert.equal(r.status, 'VERIFIED', JSON.stringify(r.history)); assert.equal(r.verification, 'tests'); assert.equal(r.tests.passed, 3); assert.equal(r.observedOutput, '25');
  });
  await t('C10 엔진 best-of-N + 실제 실행기: 틀린 후보 대신 맞는 후보 선택', async () => {
    const e = new AstraUnifiedEngine({ runnerUrl: `http://127.0.0.1:${rPort}/run`, storage: memStore(), lockManager: null, testsFirst: true, candidates: 2 });
    const r = await e.runTask({ targetModule: 'primes2', userPrompt: 'countPrimes(n)', callModelFn: byRole({ tests: PRIME_TESTS, code: [primeCode(' + 1'), primeCode('')] }) });
    assert.equal(r.status, 'VERIFIED', JSON.stringify(r.history)); assert.equal(r.chosenCandidate, 1); assert.equal(r.tests.passed, 3);
  });
  runner.close();
}

mock.close();
legacy.close();
try { fs.rmSync(ws, { recursive: true, force: true }); } catch { /* 윈도우 파일 잠금 */ }
for (const [s, n, ms, err] of results) console.log(`${s === 'PASS' ? '\x1b[32mPASS\x1b[0m' : s === 'SKIP' ? '\x1b[2mSKIP\x1b[0m' : '\x1b[31mFAIL\x1b[0m'} ${n} (${ms}ms)${err ? '\n     ' + err : ''}`);
const failed = results.filter((r) => r[0] === 'FAIL').length;
console.log(`\n${results.filter((r) => r[0] === 'PASS').length} passed · ${results.filter((r) => r[0] === 'SKIP').length} skipped · ${failed} failed`);
process.exit(failed ? 1 : 0);
