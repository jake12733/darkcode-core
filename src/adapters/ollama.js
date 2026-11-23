// Ollama 네이티브 어댑터 (/api/chat NDJSON) — keep_alive·think·format(JSON 스키마)·언로드 제어 때문에 /v1 대신 네이티브 사용
import { EngineError, withTimeout, lines, thinkSplitter } from './base.js';

export class OllamaAdapter {
  constructor(id, cfg, { timeoutMs = 900000 } = {}) {
    this.id = id; this.cfg = cfg; this.base = cfg.baseUrl.replace(/\/+$/, ''); this.timeoutMs = timeoutMs;
  }

  async health(signal) {
    try {
      const r = await fetch(`${this.base}/api/version`, { signal: withTimeout(signal, 3000) });
      if (!r.ok) return { ok: false, detail: `HTTP ${r.status}` };
      return { ok: true, detail: `ollama ${(await r.json()).version}` };
    } catch (e) { return { ok: false, detail: e.message }; }
  }

  async models(signal) {
    const r = await fetch(`${this.base}/api/tags`, { signal: withTimeout(signal, 5000) });
    if (!r.ok) throw new EngineError(this.id, `tags HTTP ${r.status}`, { status: r.status });
    return (await r.json()).models.map((m) => m.name.replace(/:latest$/, ''));
  }

  async unload(model) {
    try { await fetch(`${this.base}/api/generate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, keep_alive: 0 }), signal: AbortSignal.timeout(10000) }); } catch { /* 이미 내려가 있음 */ }
  }

  async *chat({ model, messages, params = {}, json, signal }) {
    const options = {};
    if (params.temperature !== undefined) options.temperature = params.temperature;
    if (params.top_p !== undefined) options.top_p = params.top_p;
    if (params.max_tokens !== undefined) options.num_predict = params.max_tokens;
    if (params.num_ctx !== undefined) options.num_ctx = params.num_ctx;
    if (params.seed !== undefined) options.seed = params.seed;
    if (params.stop) options.stop = params.stop;
    const body = {
      model, messages, stream: true, options,
      keep_alive: params.keep_alive ?? this.cfg.keepAlive ?? '5m',
    };
    if (params.think !== undefined) body.think = !!params.think;
    if (json) body.format = json === true ? 'json' : json;

    let res;
    try {
      res = await fetch(`${this.base}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: withTimeout(signal, this.timeoutMs) });
    } catch (e) {
      if (signal?.aborted) throw e;
      throw new EngineError(this.id, `연결 실패: ${e.message}`, { retryable: true });
    }
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new EngineError(this.id, `HTTP ${res.status} ${t.slice(0, 200)}`, { status: res.status, retryable: res.status >= 500 || res.status === 404 });
    }
    const split = thinkSplitter();
    for await (const line of lines(res.body)) {
      if (!line.trim()) continue;
      let j; try { j = JSON.parse(line); } catch { continue; }
      if (j.error) throw new EngineError(this.id, j.error, { retryable: false });
      if (j.message?.thinking) yield { type: 'delta', thinking: j.message.thinking };
      if (j.message?.content) for (const ev of split(j.message.content)) yield ev;
      if (j.done) {
        for (const ev of split('', true)) yield ev;
        yield { type: 'done', finishReason: j.done_reason || 'stop', usage: { prompt_tokens: j.prompt_eval_count || 0, completion_tokens: j.eval_count || 0, total_ms: Math.round((j.total_duration || 0) / 1e6) } };
        return;
      }
    }
    yield { type: 'done', finishReason: 'eof', usage: null };
  }
}
