#!/usr/bin/env node
// DARK CODE 코드 생성 평가 (eval) · 숨긴 테스트로 "실제로 맞게 동작하는 비율"을 잰다 · 외부 의존성 0
//   node scripts/eval.js --validate                           평가 세트 자체 검증 (정답 코드가 숨긴 테스트를 통과하는지)
//   node scripts/eval.js --model mock                         하네스 동작 확인 (정답을 내는 가짜 모델)
//   node scripts/eval.js --model ollama:qwen3:8b              로컬 Ollama 로 실제 평가
//   node scripts/eval.js --model gateway:role:implementer.code  darkcode-core 게이트웨이 경유
//   옵션: --candidates 2 · --retries 3 · --tasks withholding,slugify · --no-tests (테스트 우선 끄기) · --min 0.8 (기준 미달이면 종료 코드 1)
// 엔진은 숨긴 테스트를 절대 보지 못한다. 엔진이 끝난 뒤 최종 코드를 숨긴 테스트로 따로 채점한다.
// 보고서: data/eval-report.md (통과율 · 거짓 확정(엔진은 VERIFIED 인데 숨긴 테스트 실패) · 평균 시도 · 시간)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRunner } from '../runner/runner.js';
import { AstraUnifiedEngine } from '../runner/astra-unified-engine.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const val = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : d; };

export function loadTasks(file = path.join(ROOT, 'eval', 'tasks.txt')) {
  const text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const tasks = [];
  for (const chunk of text.split(/^=== TASK /m).slice(1)) {
    const id = chunk.slice(0, chunk.indexOf('\n')).trim();
    const part = (name) => { const m = chunk.match(new RegExp(`^--- ${name}\\n([\\s\\S]*?)(?=^--- |$(?![\\s\\S]))`, 'm')); return m ? m[1].replace(/\n+$/, '') + '\n' : ''; };
    tasks.push({ id, prompt: part('prompt').trim(), reference: part('reference'), test: part('test') });
  }
  return tasks;
}

const memStore = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };

function adapter(spec, tasks) {
  if (spec === 'mock') {
    // 테스트는 만들지 않고(출력 검증) 정답 코드를 돌려준다 → 하네스·실행기·채점 경로 확인용
    return async (prompt, ctx) => { if (ctx.role === 'tests') return '테스트 없음'; const t = tasks.find((x) => prompt.includes(x.prompt)); return '```js\n' + (t ? t.reference : 'console.log(1)') + '\n```'; };
  }
  if (spec.startsWith('ollama:')) {
    const model = spec.slice(7);
    const host = (process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/+$/, '');
    return async (prompt, ctx) => {
      const body = { model, stream: false, think: Boolean(ctx.deep), options: { temperature: ctx.temperature ?? 0.4 }, messages: [{ role: 'user', content: prompt }] };
      let r = await fetch(host + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!r.ok) { const t = await r.text(); if (/think/i.test(t)) { delete body.think; r = await fetch(host + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); } else throw new Error(`ollama HTTP ${r.status}`); }
      if (!r.ok) throw new Error(`ollama HTTP ${r.status}`);
      const j = await r.json();
      return String((j.message && j.message.content) || '').replace(/<think>[\s\S]*?<\/think>/g, '');
    };
  }
  if (spec.startsWith('gateway:')) {
    const model = spec.slice(8);
    const base = (process.env.DC_CORE || 'http://127.0.0.1:8787').replace(/\/+$/, '');
    return async (prompt, ctx) => {
      const r = await fetch(base + '/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(process.env.DC_TOKEN ? { Authorization: `Bearer ${process.env.DC_TOKEN}` } : {}) }, body: JSON.stringify({ model, temperature: ctx.temperature ?? 0.4, messages: [{ role: 'user', content: prompt }] }) });
      if (!r.ok) throw new Error(`gateway HTTP ${r.status}`);
      const j = await r.json();
      return (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
    };
  }
  throw new Error('--model 은 mock | ollama:<모델> | gateway:<모델> 중 하나');
}

async function main() {
  const all = loadTasks();
  const only = val('--tasks', '') ? val('--tasks').split(',').map((s) => s.trim()) : null;
  const tasks = only ? all.filter((t) => only.includes(t.id)) : all;
  if (!tasks.length) { console.error('평가할 과제가 없습니다'); process.exit(2); }

  const work = path.join(ROOT, 'data', 'eval-workspace');
  fs.mkdirSync(work, { recursive: true });
  const runner = createRunner({ approval: 'auto', log: () => {}, workspace: work, logFile: path.join(ROOT, 'data', 'eval-runner.log'), timeoutMs: 15000 });
  await new Promise((r) => runner.listen(0, '127.0.0.1', r));
  const RUN = `http://127.0.0.1:${runner.address().port}/run`;
  const post = async (body) => (await fetch(RUN, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
  const hidden = async (task, code) => {
    const r = await post({ targetModule: 'eval-' + task.id, files: { 'main.mjs': code, 'test.mjs': task.test }, entry: 'test.mjs' });
    const t = r.tests || { pass: 0, fail: 0, total: 0 };
    return { ok: Boolean(r.executed && r.exitCode === 0 && t.fail === 0 && t.pass > 0), tests: t, stderr: String(r.stderr || '').slice(0, 300) };
  };

  if (argv.includes('--validate')) {
    let bad = 0;
    for (const t of tasks) {
      const h = await hidden(t, t.reference);
      console.log(`${h.ok ? 'PASS' : 'FAIL'} ${t.id} (숨긴 테스트 ${h.tests.pass}/${h.tests.total})${h.ok ? '' : ' · ' + h.stderr}`);
      if (!h.ok) bad++;
    }
    runner.close();
    console.log(`\n정답 코드 검증 ${tasks.length - bad}/${tasks.length}`);
    process.exit(bad ? 1 : 0);
  }

  const spec = val('--model', 'mock');
  const callModelFn = adapter(spec, tasks);
  const rows = [];
  for (const t of tasks) {
    const e = new AstraUnifiedEngine({ runnerUrl: RUN, storage: memStore(), lockManager: null, maxRetries: Number(val('--retries', 3)), candidates: Number(val('--candidates', 1)), testsFirst: !argv.includes('--no-tests') });
    const t0 = Date.now();
    let r;
    try { r = await e.runTask({ targetModule: t.id, userPrompt: t.prompt, callModelFn }); } catch (err) { r = { status: 'ERROR', stopReason: String((err && err.message) || err), code: '' }; }
    const h = r.code ? await hidden(t, r.code) : { ok: false, tests: { pass: 0, total: 0 } };
    const row = { id: t.id, engine: r.status, stop: r.stopReason || '-', verification: r.verification || '-', attempts: r.attempts || 0, hidden: h.ok, hiddenTests: `${h.tests.pass}/${h.tests.total}`, falseVerified: r.status === 'VERIFIED' && !h.ok, sec: (Date.now() - t0) / 1000 };
    rows.push(row);
    console.log(`${h.ok ? 'PASS' : 'FAIL'} ${t.id} · 엔진 ${row.engine}/${row.stop} (${row.verification}) · 숨긴 테스트 ${row.hiddenTests} · 시도 ${row.attempts} · ${row.sec.toFixed(1)}s${row.falseVerified ? ' · 거짓 확정' : ''}`);
  }
  runner.close();
  const pass = rows.filter((x) => x.hidden).length;
  const falseV = rows.filter((x) => x.falseVerified).length;
  const avg = (k) => (rows.reduce((a, x) => a + x[k], 0) / rows.length).toFixed(1);
  const md = [
    `# DARK CODE 코드 생성 평가 · ${new Date().toISOString()}`,
    '',
    `- 모델: \`${spec}\` · 후보 ${val('--candidates', 1)}개 · 재시도 ${val('--retries', 3)}회 · 테스트 우선 ${argv.includes('--no-tests') ? '끔' : '켬'}`,
    `- **통과율 (숨긴 테스트): ${pass}/${rows.length} (${Math.round((pass / rows.length) * 100)}%)**`,
    `- 거짓 확정 (엔진 VERIFIED 인데 숨긴 테스트 실패): ${falseV}건`,
    `- 평균 시도 ${avg('attempts')}회 · 평균 ${avg('sec')}초`,
    '',
    '| 과제 | 결과 | 엔진 판정 | 검증 방식 | 숨긴 테스트 | 시도 | 초 |',
    '|-|-|-|-|-|-|-|',
    ...rows.map((x) => `| ${x.id} | ${x.hidden ? 'PASS' : 'FAIL'} | ${x.engine} / ${x.stop}${x.falseVerified ? ' (거짓 확정)' : ''} | ${x.verification} | ${x.hiddenTests} | ${x.attempts} | ${x.sec.toFixed(1)} |`),
    '',
  ].join('\n');
  fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'data', 'eval-report.md'), md, 'utf8');
  console.log(`\n통과율 ${pass}/${rows.length} (${Math.round((pass / rows.length) * 100)}%) · 거짓 확정 ${falseV}건 → data/eval-report.md`);
  const min = Number(val('--min', 0));
  process.exit(pass / rows.length >= min ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((e) => { console.error(e); process.exit(2); });
