// 엔진 매니저: 어댑터 보관 · 헬스 캐시 · 리소스 풀(GPU 동시 실행 제한) · 온디맨드 기동/유휴 종료
// 원칙: 같은 exclusive 풀(예: 로컬 GPU 하나)에는 한 번에 한 엔진/모델만 올린다.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { createAdapter } from '../adapters/index.js';
import { ROOT } from '../config.js';

class Semaphore {
  constructor(n) { this.n = n; this.q = []; }
  async acquire(signal) {
    if (this.n > 0) { this.n--; return; }
    await new Promise((resolve, reject) => {
      const item = { resolve, reject };
      this.q.push(item);
      signal?.addEventListener('abort', () => { const i = this.q.indexOf(item); if (i >= 0) { this.q.splice(i, 1); reject(signal.reason || new Error('aborted')); } }, { once: true });
    });
  }
  release() { const nx = this.q.shift(); if (nx) nx.resolve(); else this.n++; }
  get waiting() { return this.q.length; }
}

export class EngineManager {
  constructor(cfg, log = () => {}) {
    this.cfg = cfg; this.log = log;
    this.engines = new Map();
    this.pools = new Map();
    const timeoutMs = (cfg.limits.requestTimeoutSec || 900) * 1000;
    for (const [id, e] of Object.entries(cfg.engines)) {
      this.engines.set(id, { id, cfg: e, adapter: e.baseUrl ? createAdapter(id, e, { timeoutMs }) : null, health: null, healthAt: 0, proc: null, lastUsed: 0, idleTimer: null, lastModel: null, inflight: 0 });
    }
    for (const [id, p] of Object.entries(cfg.pools || {})) this.pools.set(id, { id, cfg: p, sem: new Semaphore(p.concurrency || 1), active: null });
  }

  get(id) { return this.engines.get(id); }

  async health(id, { fresh = false, signal } = {}) {
    const e = this.engines.get(id);
    if (!e || !e.cfg.enabled || !e.adapter) return { ok: false, detail: e?.cfg.disabledReason || 'disabled' };
    if (!fresh && e.health && Date.now() - e.healthAt < 10000) return e.health;
    e.health = await e.adapter.health(signal); e.healthAt = Date.now();
    return e.health;
  }

  // 후보로 쓸 수 있는지 (켜져 있거나, 꺼져 있어도 launch 설정이 있으면 OK)
  async usable(id) {
    const e = this.engines.get(id);
    if (!e?.cfg.enabled || !e.adapter) return false;
    if ((await this.health(id)).ok) return true;
    return !!e.cfg.launch;
  }

  async start(id, signal) {
    const e = this.engines.get(id);
    if (!e.cfg.launch) throw new Error(`${id}: launch 설정이 없어 자동 기동 불가 (직접 실행하세요)`);
    if (e.proc && e.proc.exitCode === null) return;
    const { cmd, args = [], cwd, env, readyTimeoutSec = 120 } = e.cfg.launch;
    this.log('info', `engine ${id} 기동: ${cmd} ${args.join(' ')}`);
    e.proc = spawn(cmd, args, { cwd: cwd ? path.resolve(ROOT, cwd) : ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: process.platform === 'win32' && !/\.(exe|com)$/i.test(cmd) });
    e.proc.stderr.on('data', (d) => this.log('debug', `[${id}] ${String(d).trim().slice(0, 300)}`));
    e.proc.on('exit', (code) => { this.log('info', `engine ${id} 종료 (code ${code})`); e.proc = null; e.health = null; });
    const until = Date.now() + readyTimeoutSec * 1000;
    while (Date.now() < until) {
      if (signal?.aborted) throw signal.reason;
      if (!e.proc) throw new Error(`${id}: 프로세스가 바로 종료됨 (cmd/args 확인)`);
      if ((await this.health(id, { fresh: true })).ok) { this.log('ok', `engine ${id} 준비 완료`); return; }
      await new Promise((r) => setTimeout(r, 1000));
    }
    this.stop(id);
    throw new Error(`${id}: ${readyTimeoutSec}초 안에 준비되지 않음`);
  }

  stop(id) {
    const e = this.engines.get(id);
    clearTimeout(e?.idleTimer);
    if (e?.proc) { this.log('info', `engine ${id} 정지`); e.proc.kill(); e.proc = null; e.health = null; }
  }

  // 요청 1건 동안 엔진 사용권을 얻는다 → { adapter, release }
  async acquire(id, model, signal) {
    const e = this.engines.get(id);
    if (!e?.cfg.enabled || !e.adapter) throw new Error(`엔진 ${id} 비활성`);
    const pool = e.cfg.pool ? this.pools.get(e.cfg.pool) : null;
    if (pool) {
      if (pool.sem.waiting || pool.sem.n === 0) this.log('debug', `pool ${pool.id} 대기 (${id}:${model})`);
      await pool.sem.acquire(signal);
    }
    try {
      if (pool?.cfg.exclusive && pool.active && (pool.active.engine !== id || pool.active.model !== model)) await this.evict(pool.active);
      if (!(await this.health(id)).ok) {
        if (e.cfg.launch) await this.start(id, signal);
        else throw new Error(`엔진 ${id} 응답 없음: ${(await this.health(id, { fresh: true })).detail}`);
      }
    } catch (err) { pool?.sem.release(); throw err; }
    if (pool) pool.active = { engine: id, model };
    e.inflight++; e.lastUsed = Date.now(); e.lastModel = model; clearTimeout(e.idleTimer);
    let released = false;
    return {
      adapter: e.adapter,
      release: () => {
        if (released) return; released = true;
        e.inflight--; e.lastUsed = Date.now();
        // keep_alive 0 인 Ollama 는 응답과 동시에 VRAM 에서 내려감 → 풀 점유 해제
        if (pool && e.cfg.type === 'ollama' && String(e.cfg.keepAlive) === '0') pool.active = null;
        const idle = e.cfg.launch?.idleStopSec;
        if (idle && e.proc) e.idleTimer = setTimeout(() => { if (!e.inflight) { if (pool?.active?.engine === id) pool.active = null; this.stop(id); } }, idle * 1000);
        pool?.sem.release();
      },
    };
  }

  async evict(active) {
    const e = this.engines.get(active.engine);
    if (!e) return;
    if (e.cfg.type === 'ollama') { this.log('debug', `pool 교체: ollama ${active.model} 언로드`); await e.adapter.unload(active.model); }
    else if (e.proc) this.stop(active.engine);
  }

  async status() {
    const out = [];
    for (const [id, e] of this.engines) {
      const h = await this.health(id);
      out.push({ id, type: e.cfg.type, enabled: !!e.cfg.enabled, baseUrl: e.cfg.baseUrl || null, pool: e.cfg.pool || null, health: h, managed: !!e.cfg.launch, running: !!e.proc, inflight: e.inflight, lastUsed: e.lastUsed || null, lastModel: e.lastModel, disabledReason: e.cfg.disabledReason || null });
    }
    return out;
  }

  shutdown() { for (const id of this.engines.keys()) this.stop(id); }
}
