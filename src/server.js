// DARK CODE Core Gateway — 외부 의존성 0 (Node >= 22.13)
//   OpenAI 호환:  GET /v1/models · POST /v1/chat/completions   (model: dc-auto | dc-pipeline | role:<역할> | <엔진>/<모델>)
//   파이프라인:   POST /dc/run  (SSE 이벤트 스트림)
//   관리:         GET /health · GET /dc/engines · POST /dc/engines/:id/start|stop · GET /dc/config
//   세션/기록:    GET /dc/sessions · GET|DELETE /dc/sessions/:id · GET /dc/runs/:id
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { loadConfig } from './config.js';
import { EngineManager } from './engines/manager.js';
import { RoleRouter } from './router/roles.js';
import { Store } from './store/db.js';
import { runPipeline } from './pipeline/run.js';

const VERSION = '0.1.0';
const C = { reset: '\x1b[0m', dim: '\x1b[2m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m' };
const LEVEL_COLOR = { error: C.red, warn: C.yellow, ok: C.green, route: C.cyan, done: C.green, info: '', debug: C.dim };
function log(level, msg) {
  if (level === 'debug' && !process.env.DC_DEBUG) return;
  const ts = new Date().toTimeString().slice(0, 8);
  console.log(`${C.dim}${ts}${C.reset} ${LEVEL_COLOR[level] || ''}${level.padEnd(5)}${C.reset} ${msg}`);
}

export function createServer(cfg = loadConfig()) {
  const store = new Store(cfg.storage.path);
  const engines = new EngineManager(cfg, log);
  const roles = new RoleRouter(cfg, engines, log);
  setInterval(() => store.purge(), 3600_000).unref();

  const originOk = (origin) => !origin || cfg.server.cors.some((p) => {
    if (p === '*') return true;
    if (p.endsWith(':*')) return origin.startsWith(p.slice(0, -2) + ':') || origin === p.slice(0, -2);
    return origin === p;
  });

  function cors(req, res) {
    const origin = req.headers.origin;
    if (origin && originOk(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-DC-Session');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Private-Network', 'true');
      res.setHeader('Access-Control-Max-Age', '600');
    }
    return !origin || originOk(origin);
  }

  const send = (res, status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };

  async function body(req) {
    let size = 0; const chunks = [];
    for await (const c of req) { size += c.length; if (size > (cfg.limits.maxBodyBytes || 2e6)) throw Object.assign(new Error('요청 본문이 너무 큽니다'), { status: 413 }); chunks.push(c); }
    if (!chunks.length) return {};
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw Object.assign(new Error('JSON 형식 오류'), { status: 400 }); }
  }

  function sse(res) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    const ping = setInterval(() => res.write(': ping\n\n'), 15000);
    res.on('close', () => clearInterval(ping));
    return (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  function abortOnClose(req, res) {
    const ctl = new AbortController();
    res.on('close', () => { if (!res.writableFinished) ctl.abort(new Error('클라이언트 연결 종료')); });
    return ctl.signal;
  }

  const lastUser = (messages = []) => [...messages].reverse().find((m) => m.role === 'user')?.content || '';
  const textOf = (c) => (Array.isArray(c) ? c.map((p) => p.text || '').join('') : String(c ?? ''));

  // ---------- OpenAI 호환 /v1/chat/completions ----------
  async function chatCompletions(req, res) {
    const b = await body(req);
    const model = String(b.model || 'dc-auto');
    const stream = !!b.stream;
    const signal = abortOnClose(req, res);
    const id = 'chatcmpl-' + randomUUID().slice(0, 12);
    const created = Math.floor(Date.now() / 1000);
    const messages = (b.messages || []).map((m) => ({ role: m.role, content: textOf(m.content) }));
    const params = { temperature: b.temperature, top_p: b.top_p, max_tokens: b.max_tokens ?? b.max_completion_tokens, stop: b.stop, seed: b.seed };
    Object.keys(params).forEach((k) => params[k] === undefined && delete params[k]);

    let write = null;
    if (stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      write = (delta, finish = null) => res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
      write({ role: 'assistant' });
    }
    const onDelta = (d) => { if (!write) return; if (d.thinking) write({ reasoning_content: d.thinking }); if (d.content) write({ content: d.content }); };

    let content = '', usage = null, meta = {};
    try {
      if (model === 'dc-auto' || model === 'dc-pipeline') {
        // 파이프라인: 마지막 user 메시지를 입력으로, 세션은 X-DC-Session 헤더 또는 user 필드
        let streamedKind = null;
        const r = await runPipeline({
          cfg, store, roles, input: lastUser(messages), sessionId: req.headers['x-dc-session'] || b.user, mode: model === 'dc-pipeline' ? 'full' : 'fast', signal,
          emit: (type, data) => {
            if (!write) return;
            if (type === 'draft') { if (streamedKind && data.reset) write({ content: `\n\n---\n[${data.kind === 'revise' ? '검수 반영 수정본' : data.kind}]\n\n` }); streamedKind = data.kind; }
            if (type === 'token') write({ content: data.text });
          },
        });
        content = r.final; meta = { dc: { runId: r.runId, sessionId: r.sessionId, category: r.category, rounds: r.rounds, files: r.files.map((f) => f.name) } };
      } else if (model.startsWith('role:')) {
        const r = await roles.call(model.slice(5), { messages, params, onDelta, signal });
        content = r.content; usage = r.usage; meta = { dc: { engine: r.engine, model: r.model } };
      } else {
        const slash = model.indexOf('/');
        const engineId = slash > 0 ? model.slice(0, slash) : null;
        if (!engineId || !engines.get(engineId)) throw Object.assign(new Error(`model 은 dc-auto | dc-pipeline | role:<역할> | <엔진>/<모델> 형식 (엔진: ${[...engines.engines.keys()].join(', ')})`), { status: 400 });
        const lease = await engines.acquire(engineId, model.slice(slash + 1), signal);
        try {
          for await (const ev of lease.adapter.chat({ model: model.slice(slash + 1), messages, params, signal })) {
            if (ev.type === 'delta') { if (ev.content) content += ev.content; onDelta(ev); }
            else if (ev.type === 'done') usage = ev.usage;
          }
        } finally { lease.release(); }
      }
      if (write) { write({}, 'stop'); res.end('data: [DONE]\n\n'); }
      else send(res, 200, { id, object: 'chat.completion', created, model, choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage, ...meta });
    } catch (e) {
      if (signal.aborted) return;
      if (write) { res.write(`data: ${JSON.stringify({ error: { message: e.message } })}\n\n`); res.end('data: [DONE]\n\n'); }
      else send(res, e.status || 502, { error: { message: e.message } });
    }
  }

  // ---------- 라우팅 ----------
  const server = http.createServer(async (req, res) => {
    const allowed = cors(req, res);
    if (req.method === 'OPTIONS') { res.writeHead(allowed ? 204 : 403); return res.end(); }
    if (!allowed) return send(res, 403, { error: { message: 'origin 허용 안 됨 (server.cors)' } });
    const url = new URL(req.url, 'http://x');
    const p = url.pathname.replace(/\/+$/, '') || '/';
    if (cfg.server.token && p !== '/health' && req.headers.authorization !== `Bearer ${cfg.server.token}`) return send(res, 401, { error: { message: 'Bearer 토큰 필요' } });
    try {
      if (req.method === 'GET' && p === '/health') return send(res, 200, { ok: true, name: 'darkcode-core', version: VERSION, profile: cfg.profile, engines: (await engines.status()).map((e) => ({ id: e.id, enabled: e.enabled, ok: e.health.ok })) });
      if (req.method === 'GET' && p === '/dc/engines') return send(res, 200, await engines.status());
      const em = p.match(/^\/dc\/engines\/([\w-]+)\/(start|stop)$/);
      if (req.method === 'POST' && em) { if (em[2] === 'start') await engines.start(em[1]); else engines.stop(em[1]); return send(res, 200, { ok: true }); }
      if (req.method === 'GET' && p === '/dc/config') return send(res, 200, { profile: cfg.profile, categories: Object.fromEntries(Object.entries(cfg.categories).map(([k, v]) => [k, { label: v.label, pipeline: v.pipeline }])), pipelines: cfg.pipelines, roles: Object.fromEntries(Object.keys(cfg.roles).map((r) => [r, roles.candidates(r).map((c) => `${c.engine}:${c.model}`)])), limits: cfg.limits });

      if (req.method === 'GET' && p === '/v1/models') {
        const data = [{ id: 'dc-auto', object: 'model', owned_by: 'darkcode' }, { id: 'dc-pipeline', object: 'model', owned_by: 'darkcode' }, ...Object.keys(cfg.roles).map((r) => ({ id: `role:${r}`, object: 'model', owned_by: 'darkcode' }))];
        for (const [id, e] of engines.engines) {
          if (!e.cfg.enabled || !(await engines.health(id)).ok) continue;
          try { for (const m of await e.adapter.models()) data.push({ id: `${id}/${m}`, object: 'model', owned_by: id }); } catch { /* skip */ }
        }
        return send(res, 200, { object: 'list', data });
      }
      if (req.method === 'POST' && p === '/v1/chat/completions') return await chatCompletions(req, res);

      if (req.method === 'POST' && p === '/dc/run') {
        const b = await body(req);
        if (!b.input || !String(b.input).trim()) return send(res, 400, { error: { message: 'input 필요' } });
        const signal = abortOnClose(req, res);
        const emit = sse(res);
        try { await runPipeline({ cfg, store, roles, input: String(b.input), sessionId: b.sessionId, mode: b.mode || 'auto', category: b.category, noCache: !!b.noCache, signal, emit }); }
        catch { /* error 이벤트는 runPipeline 이 이미 보냄 */ }
        return res.end();
      }

      if (req.method === 'GET' && p === '/dc/sessions') return send(res, 200, store.sessions(Number(url.searchParams.get('limit')) || 50));
      const sm = p.match(/^\/dc\/sessions\/([\w-]+)$/);
      if (sm && req.method === 'GET') { const s = store.session(sm[1]); return s ? send(res, 200, s) : send(res, 404, { error: { message: '세션 없음' } }); }
      if (sm && req.method === 'DELETE') { store.deleteSession(sm[1]); return send(res, 200, { ok: true }); }
      const rm = p.match(/^\/dc\/runs\/([\w-]+)$/);
      if (rm && req.method === 'GET') { const r = store.run(rm[1]); return r ? send(res, 200, r) : send(res, 404, { error: { message: '실행 기록 없음' } }); }

      return send(res, 404, { error: { message: `없는 경로: ${req.method} ${p}` } });
    } catch (e) {
      log('error', `${req.method} ${p} → ${e.message}`);
      if (!res.headersSent) send(res, e.status || 500, { error: { message: e.message } }); else res.end();
    }
  });
  server.dc = { cfg, store, engines, roles };
  return server;
}

// 직접 실행 시
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  let cfg;
  try { cfg = loadConfig(); } catch (e) { console.error(e.message); process.exit(1); }
  const server = createServer(cfg);
  server.listen(cfg.server.port, cfg.server.host, async () => {
    log('ok', `DARK CODE Core ${VERSION} · http://${cfg.server.host}:${cfg.server.port} · profile=${cfg.profile}`);
    for (const e of await server.dc.engines.status()) log(e.health.ok ? 'ok' : (e.enabled ? 'warn' : 'debug'), `engine ${e.id.padEnd(9)} ${e.enabled ? (e.health.ok ? 'UP   ' : 'DOWN ') : 'off  '} ${e.baseUrl || ''} ${e.enabled && !e.health.ok ? '· ' + e.health.detail : ''}`);
    if (cfg.server.host !== '127.0.0.1' && !cfg.server.token) log('warn', '외부에 열려 있는데 DC_TOKEN 이 없습니다. 서버 배포 시 반드시 토큰을 설정하세요.');
  });
  const bye = () => { server.dc.engines.shutdown(); process.exit(0); };
  process.on('SIGINT', bye); process.on('SIGTERM', bye);
}
