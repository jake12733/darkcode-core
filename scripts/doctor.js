// darkcode-core 연결 점검 (외부 의존성 0)
//   node scripts/doctor.js            이미 떠 있는 게이트웨이 점검
//   node scripts/doctor.js --start    안 떠 있으면 새 창으로 start-darkcode-core.bat 실행 후 점검 (Windows)
//   node scripts/doctor.js --inproc   이 프로세스 안에서 게이트웨이를 띄워 점검 (개발/CI 용)
//   옵션: --origin https://...  (기본 https://jake12733.github.io)   --no-run (CORE 실제 요청 생략)
// 결과: 콘솔 + data/doctor-report.txt  ·  종료 코드 0=통과, 1=실패
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { loadConfig, ROOT } from '../src/config.js';

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const ORIGIN = opt('--origin', 'https://jake12733.github.io');
const TEST_INPUT = 'TCP와 UDP 차이를 한 줄로 알려줘';

const report = [];
let failed = 0;
const C = { PASS: '\x1b[32m', FAIL: '\x1b[31m', WARN: '\x1b[33m', INFO: '\x1b[36m', SKIP: '\x1b[2m' };
function line(kind, step, msg, fix) {
  if (kind === 'FAIL') failed++;
  const s = `[${kind}] ${step} · ${msg}${fix ? `\n       → ${fix}` : ''}`;
  report.push(s);
  console.log(`${C[kind] || ''}[${kind}]\x1b[0m ${step} · ${msg}${fix ? `\n       → ${fix}` : ''}`);
}

function request(method, url, { headers = {}, body, timeoutMs = 5000, onData } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    // 전체 시간 제한: request.setTimeout 은 연결 성립 후에만 동작 → 연결 단계에서 멈추면(방화벽·보안 프로그램) 영원히 대기하므로 직접 타이머
    const timer = setTimeout(() => r.destroy(new Error(`${timeoutMs / 1000}초 동안 응답 없음`)), timeoutMs);
    const r = http.request({ method, hostname: u.hostname, port: u.port, path: u.pathname + u.search, headers }, (res) => {
      let buf = ''; res.setEncoding('utf8');
      res.on('data', (c) => { buf += c; onData?.(c); });
      res.on('end', () => { clearTimeout(timer); resolve({ status: res.statusCode, headers: res.headers, body: buf }); });
      res.on('error', (e) => { clearTimeout(timer); reject(e); });
    });
    r.on('error', (e) => { clearTimeout(timer); reject(e); });
    if (body) r.write(body);
    r.end();
  });
}

function portFree(host, port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', (e) => resolve(e.code === 'EADDRINUSE' ? false : null));
    s.once('listening', () => s.close(() => resolve(true)));
    s.listen(port, host);
  });
}

// 외부 명령은 비동기 + 자체 타이머: netstat 이 권한/보안 정책으로 멈춰도 점검은 계속 진행
function run(cmd, argv, ms = 5000) {
  return new Promise((resolve) => {
    let done = false;
    const fin = (v) => { if (!done) { done = true; resolve(v); } };
    const child = execFile(cmd, argv, { encoding: 'utf8', windowsHide: true }, (err, out) => fin(err ? null : out));
    setTimeout(() => { try { child.kill(); } catch { /* ignore */ } fin(null); }, ms);
  });
}
async function portOwner(port) {
  if (process.platform !== 'win32') return null;
  const out = await run('netstat', ['-ano', '-p', 'TCP']);
  if (!out) return null;
  const row = out.split(/\r?\n/).find((l) => new RegExp(`:${port}\\s+\\S+\\s+LISTENING\\s+\\d+`).test(l));
  if (!row) return null;
  const pid = row.trim().split(/\s+/).pop();
  const tl = await run('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']);
  const name = tl ? tl.split(',')[0].replace(/"/g, '').trim() || '?' : '?';
  return { pid, name };
}

async function health(base) {
  try {
    const r = await request('GET', `${base}/health`, { headers: { Origin: ORIGIN }, timeoutMs: 4000 });
    let j = null; try { j = JSON.parse(r.body); } catch { /* not json */ }
    return { status: r.status, json: j, headers: r.headers };
  } catch (e) { return { error: e.message }; }
}

async function main() {
  const started = new Date();
  report.push(`DARK CODE Core 연결 점검 · ${started.toLocaleString('ko-KR')} · ${process.platform} · node ${process.versions.node}`);
  console.log(`\n\x1b[32mDARK CODE Core 연결 점검\x1b[0m  (브라우저 origin 가정: ${ORIGIN})\n`);

  // 1. Node
  const [ma, mi] = process.versions.node.split('.').map(Number);
  if (ma > 22 || (ma === 22 && mi >= 13)) line('PASS', '1 Node', `v${process.versions.node}`);
  else { line('FAIL', '1 Node', `v${process.versions.node} (내장 SQLite 필요)`, 'Node.js 22.13 이상 LTS 설치: https://nodejs.org'); return finish(); }

  // 2. 설정
  let cfg;
  try { cfg = loadConfig(); line('PASS', '2 설정', `profile=${cfg.profile} · ${cfg.server.host}:${cfg.server.port}`); }
  catch (e) { line('FAIL', '2 설정', e.message.split('\n')[0], 'darkcode.config.json / .env 를 확인하세요 (전체 메시지는 start-darkcode-core.bat 창에 표시)'); return finish(); }
  if (cfg.server.token) line('WARN', '2 설정', 'DC_TOKEN 설정됨 → 브라우저 CORE 모드는 토큰을 보내지 않아 401', 'PC 단독 사용이면 .env 의 DC_TOKEN= 을 비우세요');
  const originOk = cfg.server.cors.some((p) => p === '*' || p === ORIGIN || (p.endsWith(':*') && ORIGIN.startsWith(p.slice(0, -2) + ':')));
  if (!originOk) line('FAIL', '2 설정', `server.cors 에 ${ORIGIN} 없음 → 브라우저 요청이 CORS 로 거부됨`, `darkcode.config.json server.cors 배열에 "${ORIGIN}" 추가`);

  // 3. Ollama + 모델
  const oll = Object.entries(cfg.engines).find(([, e]) => e.type === 'ollama' && e.enabled);
  let ollamaOk = false;
  if (!oll) line('WARN', '3 Ollama', '설정에서 꺼져 있음 → 로컬 역할이 동작하지 않을 수 있음');
  else {
    try {
      const r = await request('GET', `${oll[1].baseUrl.replace(/\/+$/, '')}/api/tags`, { timeoutMs: 4000 });
      const have = JSON.parse(r.body).models.map((m) => m.name.replace(/:latest$/, ''));
      ollamaOk = true;
      const need = new Set();
      for (const list of Object.values(cfg.roles)) { const c = list.find((x) => (!x.profiles || x.profiles.includes(cfg.profile)) && x.engine === oll[0]); if (c) need.add(c.model); }
      const missing = [...need].filter((m) => !have.includes(m));
      const firstNeed = (cfg.roles['implementer.general'] || []).find((x) => (!x.profiles || x.profiles.includes(cfg.profile)) && x.engine === oll[0])?.model;
      line('PASS', '3 Ollama', `${oll[1].baseUrl} 응답 · 모델 ${have.length}개`);
      if (firstNeed && !have.includes(firstNeed)) { line('FAIL', '3 모델', `첫 테스트에 필요한 ${firstNeed} 없음`, 'DARK CODE 상단 LOCAL6 → 원클릭 연결 실행(없는 모델 자동 생성)'); ollamaOk = false; }
      if (missing.length) line('WARN', '3 모델', `설정 역할에 쓰는 모델 중 없음: ${missing.join(', ')}`, '해당 역할(작곡·전략 등)만 실패합니다. 원클릭 연결 또는 ollama pull <모델>');
    } catch (e) { line('FAIL', '3 Ollama', `${oll[1].baseUrl} 연결 실패 (${e.message})`, 'Ollama 실행(트레이 아이콘). 게이트웨이는 켜 둔 채로 두면 10초 안에 다시 확인합니다'); }
  }

  // 4. 게이트웨이 기동
  let host = cfg.server.host === '0.0.0.0' ? '127.0.0.1' : cfg.server.host;
  let port = cfg.server.port;
  let inproc = null;
  if (flag('--inproc')) {
    const { createServer } = await import('../src/server.js');
    inproc = createServer(cfg);
    await new Promise((r) => inproc.listen(0, '127.0.0.1', r));
    host = '127.0.0.1'; port = inproc.address().port;
    line('INFO', '4 기동', `--inproc: 이 프로세스 안에서 게이트웨이 시작 (포트 ${port})`);
  }
  const base = `http://${host}:${port}`;
  let h = await health(base);
  if (h.error && !inproc) {
    const free = await portFree(host, port);
    if (free === false) {
      line('FAIL', '4 기동', `포트 ${port} 을 다른 프로그램이 점유 중인데 /health 에 darkcode-core 가 응답하지 않음 (${h.error})`, `그 프로그램을 끄거나, .env 에 DC_PORT=${port + 1} 을 넣고 DARK CODE CORE 창 주소를 http://127.0.0.1:${port + 1} 로`);
      // 점유 프로그램 이름 (netstat/tasklist). 제한된 환경에서는 프로세스 생성이 멈출 수 있어 DC_DOCTOR_NO_OWNER=1 로 끌 수 있음
      if (!process.env.DC_DOCTOR_NO_OWNER) { const own = await portOwner(port); if (own) line('INFO', '4 기동', `점유 프로그램: PID ${own.pid} · ${own.name}`); }
      return finish(inproc);
    }
    if (flag('--start') && process.platform === 'win32') {
      line('INFO', '4 기동', `게이트웨이가 꺼져 있어 새 창으로 start-darkcode-core.bat 실행`);
      spawn('cmd.exe', ['/d', '/s', '/c', 'start "DARK CODE Core" cmd /k start-darkcode-core.bat'], { cwd: ROOT, detached: true, stdio: 'ignore', windowsVerbatimArguments: true }).unref();
      for (let i = 0; i < 30 && h.error; i++) { await new Promise((r) => setTimeout(r, 1500)); h = await health(base); }
    }
    if (h.error) { line('FAIL', '4 기동', `${base}/health 연결 실패 (${h.error})`, flag('--start') ? '새로 뜬 "DARK CODE Core" 창의 에러 메시지를 확인하세요' : 'start-darkcode-core.bat 실행 후 다시 점검 (또는 verify-core.bat 사용)'); return finish(inproc); }
  }

  // 5. /health 응답 계약
  if (h.status === 200 && h.json?.name === 'darkcode-core' && h.json.ok === true) {
    const eng = (h.json.engines || []).filter((e) => e.enabled).map((e) => `${e.id}:${e.ok ? 'UP' : 'DOWN'}`).join(' ');
    line('PASS', '5 /health', `darkcode-core v${h.json.version} · profile=${h.json.profile} · ${eng || '엔진 없음'}`);
  } else if (h.status === 403) { line('FAIL', '5 /health', `403 · origin ${ORIGIN} 거부`, `server.cors 에 "${ORIGIN}" 추가`); return finish(inproc); }
  else { line('FAIL', '5 /health', `예상과 다른 응답 (HTTP ${h.status}) ${String(h.json ? JSON.stringify(h.json) : '').slice(0, 120)}`, `${port} 포트에 다른 서버가 떠 있을 수 있습니다`); return finish(inproc); }
  if (h.headers['access-control-allow-origin'] === ORIGIN) line('PASS', '5 CORS(GET)', `Access-Control-Allow-Origin: ${ORIGIN}`);
  else line('FAIL', '5 CORS(GET)', `ACAO 헤더 없음/불일치 (${h.headers['access-control-allow-origin'] || '없음'})`, `server.cors 확인`);

  // 6. 브라우저 프리플라이트 재현 (POST + JSON + 사설망 접근)
  try {
    const r = await request('OPTIONS', `${base}/dc/run`, { headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type', 'Access-Control-Request-Private-Network': 'true' } });
    const ok = r.status === 204 && r.headers['access-control-allow-origin'] === ORIGIN && /content-type/i.test(r.headers['access-control-allow-headers'] || '') && r.headers['access-control-allow-private-network'] === 'true';
    if (ok) line('PASS', '6 프리플라이트', '204 · Allow-Origin · Allow-Headers(Content-Type) · Allow-Private-Network: true');
    else line('FAIL', '6 프리플라이트', `HTTP ${r.status} · ACAO=${r.headers['access-control-allow-origin'] || '-'} · PNA=${r.headers['access-control-allow-private-network'] || '-'}`, 'server.cors / 게이트웨이 버전 확인');
  } catch (e) { line('FAIL', '6 프리플라이트', e.message); }

  // 7. CORE 첫 실제 요청 (/dc/run SSE)
  if (flag('--no-run')) line('SKIP', '7 CORE 요청', '--no-run');
  else if (!ollamaOk) line('SKIP', '7 CORE 요청', 'Ollama/모델 문제로 생략 (3번 해결 후 다시)');
  else {
    const t0 = Date.now();
    const ev = []; let buf = '';
    const headers = { Origin: ORIGIN, 'Content-Type': 'application/json' };
    if (cfg.server.token) headers.Authorization = `Bearer ${cfg.server.token}`;
    console.log(`\x1b[2m       "${TEST_INPUT}" 실행 중… (첫 실행은 모델 로딩으로 10~40초)\x1b[0m`);
    try {
      const r = await request('POST', `${base}/dc/run`, {
        headers, timeoutMs: 240000,
        body: JSON.stringify({ input: TEST_INPUT, mode: 'fast', noCache: true, sessionId: 'doctor-check' }),
        onData: (c) => { buf += c; let i; while ((i = buf.indexOf('\n\n')) !== -1) { const b = buf.slice(0, i); buf = buf.slice(i + 2); if (!b.startsWith('event:')) continue; const nl = b.indexOf('\n'); try { ev.push({ type: b.slice(7, nl).trim(), data: JSON.parse(b.slice(nl + 1).replace(/^data:\s*/, '')) }); } catch { /* skip */ } } },
      });
      if (r.status !== 200) { line('FAIL', '7 CORE 요청', `HTTP ${r.status} ${r.body.slice(0, 160)}`, r.status === 401 ? '.env 의 DC_TOKEN 을 비우세요' : ''); return finish(inproc); }
      const route = ev.find((e) => e.type === 'stage' && e.data.name === 'route' && e.data.status === 'done')?.data;
      const eng = ev.find((e) => e.type === 'route')?.data;
      const done = ev.find((e) => e.type === 'done')?.data;
      const err = ev.find((e) => e.type === 'error')?.data;
      if (done) {
        line('PASS', '7 CORE 요청', `${((Date.now() - t0) / 1000).toFixed(1)}s · 분류 ${route?.category || '-'}(${route?.by || '-'}) · ${eng ? `${eng.engine}:${eng.model}` : '-'} · 이벤트 ${ev.length}개`);
        report.push(`       답변: ${String(done.final).replace(/\s+/g, ' ').slice(0, 140)}`);
        console.log(`\x1b[2m       답변: ${String(done.final).replace(/\s+/g, ' ').slice(0, 140)}\x1b[0m`);
      } else line('FAIL', '7 CORE 요청', err ? err.message : `done 이벤트 없음 (받은 이벤트: ${ev.map((e) => e.type).join(',')})`, '게이트웨이 창 로그의 마지막 warn/error 확인');
    } catch (e) { line('FAIL', '7 CORE 요청', e.message, '게이트웨이 창 로그 확인'); }
  }

  report.push('');
  report.push('[브라우저 확인] https://jake12733.github.io/darkcode-ai/ → 상단 CORE 버튼 → [연결 진단]');
  report.push('  - 게이트웨이 창에 "접속 GET /health ← https://jake12733.github.io" 가 찍히면 브라우저 → 게이트웨이 경로 OK');
  report.push('  - 브라우저가 "로컬 네트워크 기기 접근" 을 물으면 허용 (Chrome/Brave 버전에 따라 문구 다름)');
  console.log(`\n\x1b[36m[브라우저 확인]\x1b[0m DARK CODE → 상단 CORE 버튼 → [연결 진단]. 게이트웨이 창에 "접속 GET /health ← ${ORIGIN}" 가 찍히면 브라우저 경로 OK`);
  return finish(inproc);
}

function finish(inproc) {
  if (inproc) inproc.close();
  const verdict = failed ? `실패 ${failed}건 — 위 → 안내대로 고친 뒤 다시 실행하세요` : '통과 — PC 쪽 게이트웨이·CORS·CORE 응답 정상';
  report.push(`\n결과: ${verdict}`);
  console.log(`\n${failed ? '\x1b[31m' : '\x1b[32m'}결과: ${verdict}\x1b[0m`);
  try {
    const dir = path.join(ROOT, 'data'); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'doctor-report.txt'), report.join('\n') + '\n', 'utf8');
    console.log(`보고서: ${path.join(dir, 'doctor-report.txt')}`);
  } catch (e) { console.log(`보고서 저장 실패: ${e.message}`); }
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { line('FAIL', '점검 스크립트', e.stack || e.message); finish(); });
