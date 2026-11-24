// DARK CODE Runner · AI가 만든 코드를 내 PC에서 "승인 후" 실행하고 관측 결과(stdout · exitCode)를 돌려주는 전용 실행기
// darkcode-core 게이트웨이(8787)와 분리된 별도 프로세스 · 기본 127.0.0.1:8797 · 외부 의존성 0
//
//   node runner/runner.js            승인 모드(기본): 실행 요청마다 이 콘솔에서 y/N 확인
//   node runner/runner.js --auto     자동 실행 (신뢰하는 작업에서만)
//   옵션: --port 8797  --timeout 15000  --python (python 실행 허용, 권한 격리 없음)
//
// 계약 (AstraUnifiedEngine.runOnLocal 이 사용)
//   GET  /health → { ok, name:"darkcode-runner", version, approval, languages, permissionModel, busy }
//   POST /run    { runId?, targetModule, language?, code | files{이름:내용}+entry, args?|command?, timeoutMs? }
//        → 200 { executed, exitCode, reason, output(stdout), stderr, timedOut, durationMs, truncated, codeHash, tests? }
//   POST /run    { ..., jobs:[{ files|code, entry?, args?, label? }] }  (최대 8개 · 승인 한 번 · 순서대로 실행)
//        → 200 { batch:true, results:[ 위와 같은 결과 + label, entry ] }
//   tests: entry 가 node:test 를 쓰면 TAP/spec 요약에서 { total, pass, fail, failed:[이름] } 를 뽑는다
//          reason: ok | nonzero_exit | timeout | unsupported_language | approval_denied | spawn_error
//        → 400 잘못된 요청 · 403 허용 안 된 Origin/Host · 409 실행 중 · 413 코드 너무 큼
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { spawn, spawnSync, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const VERSION = '0.2.0';
const HERE = path.dirname(fileURLToPath(import.meta.url));

export const DEFAULTS = {
  host: '127.0.0.1',
  port: 8797,
  origins: ['https://jake12733.github.io', 'http://localhost:*', 'http://127.0.0.1:*'],
  approval: 'ask',
  timeoutMs: 15000,
  maxTimeoutMs: 60000,
  maxCodeBytes: 200_000,
  maxOutputBytes: 64_000,
  workspace: path.join(HERE, 'workspace'),
  keepRuns: 20,
  python: false,
  pythonCmd: process.platform === 'win32' ? 'python' : 'python3',
  logFile: path.join(HERE, 'runner.log'),
};

const LANG = { js: 'javascript', javascript: 'javascript', mjs: 'javascript', node: 'javascript', nodejs: 'javascript', ecmascript: 'javascript', py: 'python', python: 'python', python3: 'python' };
export const normalizeLanguage = (l) => LANG[String(l || 'javascript').toLowerCase().trim()] || null;
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);

// Node 권한 모델: 작업 폴더 밖 파일 읽기/쓰기 · 자식 프로세스 · worker 차단 (Node 22.13+ / 23.5+ 는 --permission, 이전은 --experimental-permission)
export function detectPermissionFlag() {
  for (const flag of ['--permission', '--experimental-permission']) {
    try {
      const r = spawnSync(process.execPath, [flag, '-e', '0'], { stdio: 'ignore', timeout: 8000, windowsHide: true });
      if (r.status === 0) return flag;
    } catch { /* 다음 후보 */ }
  }
  return null;
}

// 여러 파일 실행: 파일 이름은 작업 폴더 안의 단순 이름만 (경로·상위 폴더 금지)
const FILE_RE = /^[a-z0-9_.-]{1,40}\.(mjs|js|cjs|json|txt|py)$/i;
export function parseTap(text) {
  const t = String(text || '');
  const num = (k) => { const m = t.match(new RegExp(`^\\s*[#ℹ]\\s*${k}\\s+(\\d+)`, 'm')); return m ? Number(m[1]) : null; };
  const pass = num('pass'), fail = num('fail'), total = num('tests');
  if (pass === null && fail === null) return null;
  const failed = [...t.matchAll(/^\s*not ok \d+ - (.+?)\s*$/gm)].map((m) => m[1].replace(/\s+#\s.*$/, '').trim());
  if (!failed.length) for (const m of t.matchAll(/^\s*✖\s+(.+?)\s+\(\d/gm)) failed.push(m[1].trim());
  return { total: total ?? (pass || 0) + (fail || 0), pass: pass || 0, fail: fail || 0, failed: [...new Set(failed)].slice(0, 50) };
}

function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
  else { try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* 이미 종료 */ } } }
}

// 콘솔 승인 게이트: 요청마다 코드 미리보기 + y/N (60초 무응답이면 거부)
export function consoleApprover({ timeoutSec = 60 } = {}) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  let pending = null;
  rl.on('line', (l) => { if (pending) { const p = pending; pending = null; p(l); } });
  let chain = Promise.resolve();
  return (job) => (chain = chain.then(() => new Promise((resolve) => {
    const lines = job.code.split('\n');
    process.stdout.write(`\n\x1b[33m──── 실행 승인 요청 ────\x1b[0m\n타겟: ${job.targetModule} · 언어: ${job.language} · ${job.batch ? `묶음 실행 ${job.batch}개 (후보 코드 + 테스트) · ` : ''}${lines.length}줄 · origin: ${job.origin || '-'} · hash ${job.codeHash}\n`);
    lines.slice(0, 30).forEach((l, i) => process.stdout.write(`\x1b[2m${String(i + 1).padStart(3)}│\x1b[0m ${l}\n`));
    if (lines.length > 30) process.stdout.write(`\x1b[2m   │ … ${lines.length - 30}줄 더\x1b[0m\n`);
    if (job.args.length) process.stdout.write(`인자: ${JSON.stringify(job.args)}\n`);
    process.stdout.write(`실행할까요? [y/N] (${timeoutSec}초 안에 답 없으면 거부) `);
    const timer = setTimeout(() => { pending = null; process.stdout.write('\n(응답 없음 → 거부)\n'); resolve({ ok: false, by: 'timeout' }); }, timeoutSec * 1000);
    pending = (ans) => { clearTimeout(timer); resolve({ ok: /^y(es)?$/i.test(String(ans).trim()), by: 'console' }); };
  })));
}

export function createRunner(opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const approve = cfg.approver || (cfg.approval === 'auto' ? async () => ({ ok: true, by: 'auto' }) : consoleApprover());
  const permFlag = cfg.permissionFlag !== undefined ? cfg.permissionFlag : detectPermissionFlag();
  const log = cfg.log || ((level, msg) => console.log(`${new Date().toTimeString().slice(0, 8)} ${level.padEnd(5)} ${msg}`));
  let busy = false;
  fs.mkdirSync(cfg.workspace, { recursive: true });
  const wsRoot = path.resolve(cfg.workspace);

  const originOk = (o) => cfg.origins.some((p) => p === o || (p.endsWith(':*') && (o === p.slice(0, -2) || o.startsWith(p.slice(0, -2) + ':'))));
  const hostOk = (h, port) => h === `127.0.0.1:${port}` || h === `localhost:${port}` || h === `[::1]:${port}`;
  const appendLog = (rec) => { try { fs.appendFileSync(cfg.logFile, JSON.stringify(rec) + '\n'); } catch { /* 로그 실패는 실행을 막지 않음 */ } };
  const languages = () => ['javascript', ...(cfg.python ? ['python'] : [])];

  function cleanup() {
    try {
      const dirs = fs.readdirSync(wsRoot, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => ({ p: path.join(wsRoot, d.name), t: fs.statSync(path.join(wsRoot, d.name)).mtimeMs })).sort((a, b) => b.t - a.t);
      for (const d of dirs.slice(cfg.keepRuns)) if (path.resolve(d.p).startsWith(wsRoot + path.sep)) fs.rmSync(d.p, { recursive: true, force: true });
    } catch { /* 정리 실패 무시 */ }
  }

  function execute(job) {
    return new Promise((resolve) => {
      const dir = path.join(wsRoot, job.runId);
      fs.mkdirSync(dir, { recursive: true });
      for (const [name, content] of Object.entries(job.files)) fs.writeFileSync(path.join(dir, name), content, 'utf8');
      const file = path.join(dir, job.entry);
      const usesNodeTest = job.language === 'javascript' && /node:test/.test(job.files[job.entry] || '');
      let cmd, argv;
      if (job.language === 'python') { cmd = cfg.pythonCmd; argv = [file, ...job.args]; }
      else { cmd = process.execPath; argv = [...(permFlag ? [permFlag, `--allow-fs-read=${dir}`, `--allow-fs-write=${dir}`] : []), file, ...job.args]; }
      const env = { PATH: process.env.PATH || '', SystemRoot: process.env.SystemRoot || '', TEMP: dir, TMP: dir, HOME: dir, USERPROFILE: dir, NODE_NO_WARNINGS: '1', PYTHONIOENCODING: 'utf-8' };
      const t0 = Date.now();
      let out = '', err = '', truncated = false, timedOut = false, settled = false;
      let child;
      const finish = (r) => { if (settled) return; settled = true; clearTimeout(timer); resolve({ ...r, durationMs: Date.now() - t0, truncated }); };
      try {
        child = spawn(cmd, argv, { cwd: dir, env, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (e) { return finish({ executed: false, exitCode: null, reason: 'spawn_error', output: '', stderr: `SPAWN_ERROR: ${e.message}`, timedOut: false }); }
      const cap = (buf, chunk) => { if (buf.length >= cfg.maxOutputBytes) { truncated = true; return buf; } const s = buf + chunk; if (s.length > cfg.maxOutputBytes) { truncated = true; return s.slice(0, cfg.maxOutputBytes); } return s; };
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
      child.stdout.on('data', (c) => { out = cap(out, c); });
      child.stderr.on('data', (c) => { err = cap(err, c); });
      const timer = setTimeout(() => { timedOut = true; killTree(child); }, job.timeoutMs);
      child.on('error', (e) => finish({ executed: false, exitCode: null, reason: 'spawn_error', output: out.trim(), stderr: `SPAWN_ERROR: ${e.message}`, timedOut: false }));
      child.on('close', (code, signal) => {
        if (timedOut) return finish({ executed: false, exitCode: code, reason: 'timeout', output: out.trim(), stderr: `${err.trim()}\nTIMEOUT: ${job.timeoutMs}ms 초과로 강제 종료`.trim(), timedOut: true, signal });
        const tests = usesNodeTest ? parseTap(`${out}\n${err}`) : null;
        finish({ executed: true, exitCode: code, reason: code === 0 ? 'ok' : 'nonzero_exit', output: out.trim(), stderr: err.trim(), timedOut: false, signal, ...(tests ? { tests } : {}) });
      });
    });
  }

  const send = (res, status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };

  const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    const port = server.address()?.port;
    // DNS 리바인딩 차단: Host 는 반드시 루프백 주소
    if (!hostOk(String(req.headers.host || ''), port)) { log('warn', `거부: Host=${req.headers.host}`); return send(res, 403, { error: 'host not allowed' }); }
    if (origin) {
      if (!originOk(origin)) { log('warn', `거부: Origin=${origin} (허용 목록에 없음)`); return send(res, 403, { error: `origin not allowed: ${origin}` }); }
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Private-Network', 'true');
      res.setHeader('Access-Control-Max-Age', '600');
    }
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    const p = req.url.split('?')[0];
    if (req.method === 'GET' && p === '/health') return send(res, 200, { ok: true, name: 'darkcode-runner', version: VERSION, approval: cfg.approver ? 'custom' : cfg.approval, languages: languages(), permissionModel: permFlag, busy, features: ['files', 'jobs', 'tap'] });
    if (!(req.method === 'POST' && p === '/run')) return send(res, 404, { error: `없는 경로: ${req.method} ${p}` });

    let raw = '';
    for await (const c of req) { raw += c; if (raw.length > cfg.maxCodeBytes * 2 + 10000) return send(res, 413, { error: 'request too large' }); }
    let b; try { b = JSON.parse(raw || '{}'); } catch { return send(res, 400, { error: 'JSON 형식 오류' }); }
    const isBatch = Array.isArray(b.jobs) && b.jobs.length > 0;
    if (!isBatch && (typeof b.code !== 'string' || !b.code.trim()) && !(b.files && typeof b.files === 'object')) return send(res, 400, { error: 'code 또는 files 필요' });
    if (!isBatch && typeof b.code === 'string' && !b.files && Buffer.byteLength(b.code) > cfg.maxCodeBytes) return send(res, 413, { error: `code 가 ${cfg.maxCodeBytes} bytes 초과` });
    if (isBatch && b.jobs.length > 8) return send(res, 400, { error: 'jobs 는 8개 이하' });
    const targetModule = String(b.targetModule || 'module').slice(0, 120);
    const runId = String(b.runId || `r_${Date.now().toString(36)}`).replace(/[^\w-]/g, '_').slice(0, 64) + '_' + crypto.randomBytes(3).toString('hex');
    // 셸 문자열은 실행하지 않는다: args 배열(우선) 또는 command 를 공백으로 나눈 인자만 스크립트에 전달
    let args = Array.isArray(b.args) ? b.args : (typeof b.command === 'string' && b.command.trim() ? b.command.trim().split(/\s+/) : []);
    if (args.length > 20 || args.some((a) => typeof a !== 'string' || a.length > 200)) return send(res, 400, { error: 'args 는 문자열 20개 이하, 각 200자 이하' });
    const timeoutMs = Math.max(1000, Math.min(Number(b.timeoutMs) || cfg.timeoutMs, cfg.maxTimeoutMs));
    const language = normalizeLanguage(b.language);
    const badArgs = (list) => list.length > 20 || list.some((a) => typeof a !== 'string' || a.length > 200);
    // 작업 목록 만들기 (단일 code · files+entry · jobs 묶음 모두 같은 형태로)
    const prep = (j, i) => {
      let files;
      if (j.files && typeof j.files === 'object' && !Array.isArray(j.files)) {
        const names = Object.keys(j.files);
        if (!names.length || names.length > 6) throw { status: 400, error: 'files 는 1~6개' };
        files = {}; let total = 0;
        for (const n of names) { if (!FILE_RE.test(n)) throw { status: 400, error: `파일 이름 불가: ${n}` }; if (typeof j.files[n] !== 'string') throw { status: 400, error: `파일 내용은 문자열: ${n}` }; total += Buffer.byteLength(j.files[n]); files[n] = j.files[n]; }
        if (total > cfg.maxCodeBytes) throw { status: 413, error: `files 합계가 ${cfg.maxCodeBytes} bytes 초과` };
      } else if (typeof j.code === 'string' && j.code.trim()) {
        if (Buffer.byteLength(j.code) > cfg.maxCodeBytes) throw { status: 413, error: `code 가 ${cfg.maxCodeBytes} bytes 초과` };
        files = { [language === 'python' ? 'main.py' : 'main.mjs']: j.code };
      } else throw { status: 400, error: 'code 또는 files 필요' };
      const entry = typeof j.entry === 'string' && j.entry ? j.entry : (language === 'python' ? 'main.py' : 'main.mjs');
      if (!files[entry]) throw { status: 400, error: `entry 파일 없음: ${entry}` };
      const jargs = Array.isArray(j.args) ? j.args : (i === 0 ? args : []);
      if (badArgs(jargs)) throw { status: 400, error: 'args 는 문자열 20개 이하, 각 200자 이하' };
      return { files, entry, args: jargs, label: String(j.label || `job${i + 1}`).slice(0, 40), language: entry.endsWith('.py') ? 'python' : 'javascript' };
    };
    let jobList;
    try { jobList = isBatch ? b.jobs.map((j, i) => prep(j || {}, i)) : [prep(b, 0)]; }
    catch (e) { return send(res, e.status || 400, { error: e.error || String(e) }); }
    const codeHash = sha(jobList.map((j) => j.files[j.entry]).join('\n'));
    const logRec = { ts: new Date().toISOString(), origin: origin || null, runId, targetModule, language: language || String(b.language), codeHash };

    if (!language || !languages().includes(language) || jobList.some((j) => !languages().includes(j.language))) {
      appendLog({ ...logRec, reason: 'unsupported_language' });
      return send(res, 200, { executed: false, exitCode: null, reason: 'unsupported_language', output: '', stderr: `UNSUPPORTED_LANGUAGE: ${b.language} (지원: ${languages().join(', ')})`, timedOut: false, durationMs: 0, codeHash });
    }
    if (busy) return send(res, 409, { error: '다른 실행이 진행 중', reason: 'busy' });
    busy = true;
    try {
      const display = isBatch ? jobList.map((j, i) => `### ${i + 1}. ${j.label} · ${j.entry} · ${j.files[j.entry].split('\n').length}줄\n${j.files[j.entry].split('\n').slice(0, 8).join('\n')}`).join('\n\n') : jobList[0].files[jobList[0].entry];
      const job = { runId, targetModule, language, code: display, args: jobList[0].args, timeoutMs, origin, codeHash, batch: isBatch ? jobList.length : 0 };
      const ap = await approve(job);
      if (!ap.ok) {
        log('warn', `실행 거부 (${ap.by}) · ${targetModule} · ${codeHash}`);
        appendLog({ ...logRec, approval: ap.by, reason: 'approval_denied' });
        return send(res, 200, { executed: false, exitCode: null, reason: 'approval_denied', output: '', stderr: `APPROVAL_DENIED (${ap.by})`, timedOut: false, durationMs: 0, codeHash });
      }
      log('info', `실행 ${targetModule} · ${language}${permFlag && language === 'javascript' ? ' · 권한 격리' : ''}${isBatch ? ` · 묶음 ${jobList.length}개` : ''} · ${codeHash}`);
      const results = [];
      for (let i = 0; i < jobList.length; i++) {
        const j = jobList[i];
        const r = await execute({ ...j, runId: isBatch ? `${runId}_j${i + 1}` : runId, timeoutMs });
        log(r.reason === 'ok' ? 'ok' : 'warn', `결과 ${isBatch ? j.label + ' ' : ''}${r.reason} · exit ${r.exitCode} · ${r.durationMs}ms · stdout ${r.output.length}자${r.tests ? ` · 테스트 ${r.tests.pass}/${r.tests.total}` : ''}`);
        appendLog({ ...logRec, label: j.label, approval: ap.by, reason: r.reason, exitCode: r.exitCode, durationMs: r.durationMs, tests: r.tests || undefined });
        results.push({ ...r, label: j.label, entry: j.entry, codeHash: sha(j.files[j.entry]) });
      }
      cleanup();
      if (isBatch) return send(res, 200, { batch: true, results });
      return send(res, 200, { ...results[0], codeHash, workspace: path.relative(HERE, path.join(wsRoot, runId)) });
    } finally { busy = false; }
  });
  server.runner = { cfg, permFlag };
  return server;
}

// 직접 실행
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const val = (n) => { const i = a.indexOf(n); return i >= 0 ? a[i + 1] : undefined; };
  const opts = { approval: a.includes('--auto') ? 'auto' : 'ask', python: a.includes('--python') };
  if (val('--port')) opts.port = Number(val('--port'));
  if (val('--timeout')) opts.timeoutMs = Number(val('--timeout'));
  const server = createRunner(opts);
  const { cfg, permFlag } = server.runner;
  server.on('error', (e) => { console.error(e.code === 'EADDRINUSE' ? `포트 ${cfg.port} 사용 중 → --port 8798 처럼 바꾸고 엔진의 runnerUrl 도 맞추세요` : e.message); process.exit(2); });
  server.listen(cfg.port, cfg.host, () => {
    console.log(`\x1b[32mDARK CODE Runner ${VERSION}\x1b[0m · http://${cfg.host}:${cfg.port}/run · 승인: ${cfg.approval === 'auto' ? '자동(--auto)' : '콘솔에서 y/N'}`);
    console.log(`JS 격리: ${permFlag ? `${permFlag} (작업 폴더 밖 파일·자식 프로세스 차단)` : '사용 불가 (Node 22.13+ 권장) → 승인 모드 유지 권장'} · 작업 폴더: ${cfg.workspace}`);
    if (cfg.python) console.log('\x1b[33mpython 실행 허용됨: python 은 권한 격리가 없습니다. 승인 화면에서 코드를 꼭 확인하세요.\x1b[0m');
    if (cfg.approval === 'ask' && !process.stdin.isTTY) console.log('\x1b[33m콘솔 입력이 없는 환경이라 승인 요청이 60초 뒤 모두 거부됩니다. 콘솔 창에서 실행하세요.\x1b[0m');
  });
  process.on('SIGINT', () => process.exit(0));
}
