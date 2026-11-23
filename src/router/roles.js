// 역할(role) → 엔진/모델 후보 해석 + 실패 시 다음 후보로 폴백 호출
// 앞단은 "critic 해줘", "implementer.code 해줘"만 말하고 어떤 엔진이 도는지는 몰라도 된다.
import { collect } from '../adapters/index.js';

export class RoleRouter {
  constructor(cfg, engines, log = () => {}) { this.cfg = cfg; this.engines = engines; this.log = log; }

  candidates(role) {
    const list = this.cfg.roles[role] || [];
    return list.filter((c) => !c.profiles || c.profiles.includes(this.cfg.profile));
  }

  async plan(role) {
    const out = [];
    for (const c of this.candidates(role)) if (await this.engines.usable(c.engine)) out.push(c);
    return out;
  }

  // 스트리밍 호출: onDelta({content,thinking}) / 반환 { content, thinking, finishReason, usage, engine, model }
  // 실행(run)별 로그를 섞지 않도록 로그 함수를 묶은 핸들
  scoped(log) {
    return { call: (r, o) => this.call(r, { ...o, log }), callOnce: (r, o) => this.call(r, { ...o, onDelta: undefined, log }), plan: (r) => this.plan(r) };
  }

  async call(role, { messages, json, params: extra = {}, onDelta, signal, onRoute, log = this.log }) {
    const cands = await this.plan(role);
    if (!cands.length) throw new Error(`역할 "${role}" 에 사용할 수 있는 엔진이 없습니다 (profile=${this.cfg.profile}). 설정의 roles/engines 를 확인하세요.`);
    let lastErr;
    for (const c of cands) {
      const msgs = c.systemText ? [{ role: 'system', content: c.systemText }, ...messages.filter((m) => m.role !== 'system')] : messages;
      const params = { ...(c.params || {}), ...extra };
      let lease;
      try {
        lease = await this.engines.acquire(c.engine, c.model, signal);
        onRoute?.({ role, engine: c.engine, model: c.model });
        log('route', `${role} → ${c.engine}:${c.model}`);
        const t0 = Date.now();
        let content = '', thinking = '', finishReason = null, usage = null;
        for await (const ev of lease.adapter.chat({ model: c.model, messages: msgs, params, json: json ?? (c.json ? true : undefined), signal })) {
          if (ev.type === 'delta') {
            if (ev.content) content += ev.content;
            if (ev.thinking) thinking += ev.thinking;
            onDelta?.(ev);
          } else if (ev.type === 'done') { finishReason = ev.finishReason; usage = ev.usage; }
        }
        lease.release();
        log('done', `${role} ${c.engine}:${c.model} ${content.length}자 ${((Date.now() - t0) / 1000).toFixed(1)}s finish=${finishReason}`);
        return { content, thinking, finishReason, usage, engine: c.engine, model: c.model, ms: Date.now() - t0 };
      } catch (e) {
        lease?.release();
        if (signal?.aborted) throw signal.reason || e;
        lastErr = e;
        log('warn', `fail ${role} ${c.engine}:${c.model} → ${e.message}${cands.length > 1 ? ' · 다음 후보로' : ''}`);
      }
    }
    throw lastErr;
  }

  async callOnce(role, opts) { return this.call(role, { ...opts, onDelta: undefined }); }
}

export { collect };
