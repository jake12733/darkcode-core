// 스모크 테스트: 가짜 엔진으로 1층(어댑터·풀·폴백) / 2층(분류·파이프라인·검수 루프·캐시·세션) / HTTP 계약 검증
// 실행: node test/smoke.js      (실제 Ollama 까지 확인: DC_LIVE=1 node test/smoke.js)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { startMock } from './mock-engine.js';
import { createServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';
import { thinkSplitter } from '../src/adapters/base.js';
import { staticCheck } from '../src/pipeline/verify.js';

const results = [];
async function t(name, fn) {
  const s = Date.now();
  try { await fn(); results.push(['PASS', name, Date.now() - s]); }
  catch (e) { results.push(['FAIL', name, Date.now() - s, e.message]); }
}

// 테스트 설정: 실제 설정을 복제해 모든 역할을 mock 엔진으로 (첫 후보는 일부러 죽은 엔진 → 폴백 확인)
const base = JSON.parse(fs.readFileSync(new URL('../darkcode.config.json', import.meta.url), 'utf8'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-test-'));
base.server.port = 18787; base.server.token = '';
base.storage.path = path.join(tmp, 'test.db');
base.engines = {
  dead: { type: 'openai', enabled: true, baseUrl: 'http://127.0.0.1:18999/v1', pool: 'gpu0' },
  mock: { type: 'openai', enabled: true, baseUrl: 'http://127.0.0.1:18081/v1', pool: 'gpu0' },
};
for (const role of Object.keys(base.roles)) base.roles[role] = [{ engine: 'dead', model: 'x' }, { engine: 'mock', model: role === 'escalate' ? 'mock-big' : 'mock-small', system: role === 'strategist' ? 'prompts/strategist.md' : role === 'implementer.web' ? 'prompts/web.md' : undefined }].map((c) => (c.system ? c : { engine: c.engine, model: c.model }));
const cfgFile = path.join(tmp, 'config.json');
fs.writeFileSync(cfgFile, JSON.stringify(base));

const mock = await startMock(18081);
const server = createServer(loadConfig(cfgFile));
await new Promise((r) => server.listen(18787, '127.0.0.1', r));
const U = 'http://127.0.0.1:18787';
const J = async (p, o) => { const r = await fetch(U + p, o); return { status: r.status, body: await r.json() }; };

async function runSSE(payload) {
  const r = await fetch(U + '/dc/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  const text = await r.text();
  const events = text.split('\n\n').filter((b) => b.startsWith('event:')).map((b) => { const [e, d] = b.split('\n'); return { type: e.slice(7), data: JSON.parse(d.slice(6)) }; });
  return events;
}

await t('unit: <think> 분리 (조각 경계)', () => {
  const f = thinkSplitter(); const out = [...f('<th'), ...f('ink>생각'), ...f('중</thi'), ...f('nk>\n답'), ...f('변', true)];
  assert.equal(out.filter((e) => e.thinking).map((e) => e.thinking).join(''), '생각중');
  assert.equal(out.filter((e) => e.content).map((e) => e.content).join(''), '답변');
});
await t('unit: 정적 검증 (잘린 html·생략·JS 문법)', () => {
  assert.ok(staticCheck('```html\n<html><head><style>a{}', 'web').some((x) => /닫히지 않음|<style>/.test(x)));
  assert.ok(staticCheck('```js\nfunction(){ // 중략\n```', 'code').length >= 1);
  assert.equal(staticCheck('```js\nconst a = 1;\n```', 'code').length, 0);
});
await t('unit: 규칙 분류 (보안 점검+코드 → security, 페이지 제작 → web, 개념 질문 → general)', async () => {
  const { ruleScores } = await import('../src/router/classify.js');
  const top = (s) => Object.entries(ruleScores(s, base.categories)).sort((a, b) => b[1] - a[1])[0][0];
  assert.equal(top('이 Express 로그인 코드 보안 점검하고 고쳐줘:\n```js\napp.post("/login")\n```'), 'security');
  assert.equal(top('보안 회사 랜딩 페이지 만들어줘'), 'web');
  assert.equal(top('XSS가 뭐야?'), 'general');
  assert.equal(top('파이썬으로 로그 파일 파싱하는 스크립트 짜줘'), 'code');
});
await t('unit: 코드 블록 위 제목에서 파일명 추출', async () => {
  const { extractCode, toFiles } = await import('../src/pipeline/verify.js');
  const md = '### server.js\n```javascript\nconst a=1\n```\n\n**models/user.js**\n```js\nconst b=2\n```\n```js\nconst c=3\n```';
  assert.deepEqual(toFiles(extractCode(md)).map((f) => f.name), ['server.js', 'models/user.js', 'app.js']);
});
await t('GET /health', async () => { const r = await J('/health'); assert.equal(r.status, 200); assert.equal(r.body.ok, true); });
await t('GET /v1/models (엔진 모델 + 가상 모델)', async () => {
  const r = await J('/v1/models'); const ids = r.body.data.map((d) => d.id);
  assert.ok(ids.includes('dc-auto') && ids.includes('mock/mock-small') && ids.includes('role:critic'));
});
await t('POST /v1/chat/completions 직접 엔진 (non-stream)', async () => {
  const r = await J('/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'mock/mock-small', messages: [{ role: 'user', content: '안녕' }] }) });
  assert.equal(r.status, 200); assert.match(r.body.choices[0].message.content, /mock 답변/);
});
await t('POST /v1/chat/completions role:implementer.general (stream + 죽은 엔진 폴백)', async () => {
  const r = await fetch(U + '/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'role:implementer.general', stream: true, messages: [{ role: 'user', content: '스트림 테스트' }] }) });
  const txt = await r.text();
  const content = txt.split('\n').filter((l) => l.startsWith('data: {')).map((l) => JSON.parse(l.slice(6)).choices?.[0]?.delta?.content || '').join('');
  assert.match(content, /mock 답변: 스트림 테스트/); assert.ok(txt.includes('[DONE]'));
});
let sid;
await t('/dc/run 웹 요청: 규칙 분류 → full 파이프라인 → 검수 REVISE → 수정 → PASS → 파일 추출', async () => {
  const ev = await runSSE({ input: '보안 회사 랜딩 페이지 만들어줘' });
  const route = ev.find((e) => e.type === 'stage' && e.data.name === 'route' && e.data.status === 'done').data;
  assert.equal(route.category, 'web'); assert.equal(route.by, 'rules'); assert.equal(route.pipeline, 'full');
  const crit = ev.filter((e) => e.type === 'stage' && e.data.name === 'critic' && e.data.status === 'done').map((e) => e.data.verdict);
  assert.deepEqual(crit, ['REVISE', 'PASS']);
  assert.ok(ev.some((e) => e.type === 'thinking'), 'reasoning_content → thinking 이벤트');
  assert.ok(ev.filter((e) => e.type === 'route').every((e) => e.data.engine === 'mock'), '죽은 엔진(dead)은 후보에서 제외되고 mock 으로 폴백');
  const done = ev.find((e) => e.type === 'done').data;
  assert.deepEqual(done.files.map((f) => f.name), ['index.html']);
  assert.equal(done.revisions, 1);
  assert.match(done.snapshot.text, /\[최종 모델 & 라운드\]/);
  sid = done.sessionId;
});
await t('/dc/run 애매한 요청 → LLM 라우터(JSON 스키마) 분류', async () => {
  const ev = await runSSE({ input: '이거 좀 봐줘', sessionId: sid });
  const route = ev.find((e) => e.type === 'stage' && e.data.name === 'route' && e.data.status === 'done').data;
  assert.equal(route.by, 'llm'); assert.equal(route.category, 'general');
  assert.ok(ev.some((e) => e.type === 'log' && /상태 압축본|최근 2개/.test(e.data.msg)), '이전 세션 컨텍스트 사용');
});
await t('/dc/run 길이 한도(finish=length) → 자동 이어쓰기', async () => {
  const ev = await runSSE({ input: '파이썬 스크립트 짜줘 [[LENGTH]]', category: 'code', mode: 'fast' });
  const done = ev.find((e) => e.type === 'done').data;
  assert.ok(ev.some((e) => e.type === 'log' && /이어쓰기/.test(e.data.msg)));
  assert.match(done.final, /part1[\s\S]*part2/); assert.equal(done.files[0].name, 'main.py');
});
await t('캐시: 같은 요청 재실행 → 엔진 호출 0회', async () => {
  const ev = await runSSE({ input: '캐시 테스트 질문' });
  const ev2 = await runSSE({ input: '캐시 테스트 질문' });
  assert.ok(!ev.find((e) => e.type === 'done').data.cached);
  assert.ok(ev2.find((e) => e.type === 'done').data.cached);
});
await t('세션 조회 · 실행 로그 조회', async () => {
  const s = await J('/dc/sessions/' + sid); assert.equal(s.status, 200); assert.equal(s.body.messages.length, 4); assert.ok(s.body.snapshot.text);
  const r = await J('/dc/runs/' + s.body.runs[0].id); assert.ok(r.body.logs.length > 3);
});
await t('파이프라인 경유 OpenAI 호환 (model=dc-pipeline)', async () => {
  const r = await J('/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-DC-Session': 'oa-1' }, body: JSON.stringify({ model: 'dc-pipeline', messages: [{ role: 'user', content: '대시보드 페이지 만들어줘' }] }) });
  assert.equal(r.status, 200); assert.match(r.body.choices[0].message.content, /```html/); assert.equal(r.body.dc.category, 'web');
});
await t('CORS: 허용 origin 프리플라이트 + 차단 origin', async () => {
  const ok = await fetch(U + '/dc/run', { method: 'OPTIONS', headers: { Origin: 'https://jake12733.github.io', 'Access-Control-Request-Method': 'POST' } });
  assert.equal(ok.status, 204); assert.equal(ok.headers.get('access-control-allow-private-network'), 'true');
  const bad = await fetch(U + '/health', { headers: { Origin: 'https://evil.example' } });
  assert.equal(bad.status, 403);
});

if (process.env.DC_LIVE) {
  const live = createServer(loadConfig());
  await new Promise((r) => live.listen(18788, '127.0.0.1', r));
  await t('LIVE: 실제 Ollama 로 /dc/run (일반 질문, fast)', async () => {
    const r = await fetch('http://127.0.0.1:18788/dc/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input: 'TCP와 UDP 차이 짧게 알려줘' }) });
    const txt = await r.text(); assert.ok(txt.includes('event: done'), txt.slice(-300));
  });
  live.close();
}

server.close(); mock.close(); server.dc.engines.shutdown();
for (const [s, n, ms, err] of results) console.log(`${s === 'PASS' ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'} ${n} (${ms}ms)${err ? '\n     ' + err : ''}`);
const failed = results.filter((r) => r[0] === 'FAIL').length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
