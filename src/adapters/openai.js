// OpenAI 호환 어댑터 — llama.cpp(llama-server) / LM Studio / LocalAI / vLLM / SGLang 공통
// reasoning 모델: vLLM·SGLang --reasoning-parser 사용 시 delta.reasoning_content(또는 reasoning) 로 오고, 아니면 본문 <think> 를 분리
import { EngineError, withTimeout, lines, thinkSplitter } from './base.js';

export class OpenAIAdapter {
  constructor(id, cfg, { timeoutMs = 900000 } = {}) {
    this.id = id; this.cfg = cfg; this.base = cfg.baseUrl.replace(/\/+$/, ''); this.timeoutMs = timeoutMs;
  }

  headers() {
    const h = { 'Content-Type': 'application/json' };
    if (this.cfg.apiKey) h.Authorization = `Bearer ${this.cfg.apiKey}`;
    return h;
  }

  async health(signal) {
    try {
      const r = await fetch(`${this.base}/models`, { headers: this.headers(), signal: withTimeout(signal, 3000) });
      return r.ok ? { ok: true, detail: 'openai-compatible' } : { ok: false, detail: `HTTP ${r.status}` };
    } catch (e) { return { ok: false, detail: e.message }; }
  }

  async models(signal) {
    const r = await fetch(`${this.base}/models`, { headers: this.headers(), signal: withTimeout(signal, 5000) });
    if (!r.ok) throw new EngineError(this.id, `models HTTP ${r.status}`, { status: r.status });
    return ((await r.json()).data || []).map((m) => m.id);
  }

  async unload() { /* 서버형 엔진은 프로세스 단위로 관리 (engines/manager.js) */ }

  async *chat({ model, messages, params = {}, json, signal }) {
    const body = { model, messages, stream: true, stream_options: { include_usage: true } };
    for (const k of ['temperature', 'top_p', 'max_tokens', 'stop', 'seed']) if (params[k] !== undefined) body[k] = params[k];
    if (json === true) body.response_format = { type: 'json_object' };
    else if (json) body.response_format = { type: 'json_schema', json_schema: { name: 'dc_output', schema: json, strict: true } };
    // qwen3 계열 생각 모드 끄기 (vLLM/SGLang/llama.cpp chat template 공통 인자)
    if (params.think === false) body.chat_template_kwargs = { enable_thinking: false };

    let res;
    try {
      res = await fetch(`${this.base}/chat/completions`, { method: 'POST', headers: this.headers(), body: JSON.stringify(body), signal: withTimeout(signal, this.timeoutMs) });
    } catch (e) {
      if (signal?.aborted) throw e;
      throw new EngineError(this.id, `연결 실패: ${e.message}`, { retryable: true });
    }
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new EngineError(this.id, `HTTP ${res.status} ${t.slice(0, 200)}`, { status: res.status, retryable: res.status === 429 || res.status >= 500 || res.status === 404 });
    }
    const split = thinkSplitter();
    let finishReason = null, usage = null;
    for await (const line of lines(res.body)) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') break;
      let j; try { j = JSON.parse(data); } catch { continue; }
      if (j.error) throw new EngineError(this.id, j.error.message || JSON.stringify(j.error));
      if (j.usage) usage = j.usage;
      const ch = j.choices?.[0];
      if (!ch) continue;
      const d = ch.delta || {};
      const reasoning = d.reasoning_content ?? d.reasoning;
      if (reasoning) yield { type: 'delta', thinking: reasoning };
      if (d.content) for (const ev of split(d.content)) yield ev;
      if (ch.finish_reason) finishReason = ch.finish_reason;
    }
    for (const ev of split('', true)) yield ev;
    yield { type: 'done', finishReason: finishReason || 'stop', usage };
  }
}
