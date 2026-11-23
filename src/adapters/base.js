// 1층 공통 어댑터 계약
//   health()            -> { ok, detail }
//   models()            -> string[]
//   chat(req)           -> AsyncGenerator<{type:'delta', content?, thinking?} | {type:'done', finishReason, usage}>
//   unload(model)       -> void (선택)
// req = { model, messages:[{role,content}], params:{temperature,top_p,max_tokens,stop,seed,think}, json: true|schema|undefined, signal }

export class EngineError extends Error {
  constructor(engine, message, { status = 0, retryable = false } = {}) {
    super(`[${engine}] ${message}`);
    this.engine = engine; this.status = status; this.retryable = retryable;
  }
}

export function withTimeout(signal, ms) {
  const t = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, t]) : t;
}

// 본문에 섞여 나오는 <think>...</think> 를 thinking 채널로 분리 (스트림 조각 경계 안전)
export function thinkSplitter() {
  let mode = 'start'; let buf = '';
  return function feed(chunk, flush = false) {
    const out = [];
    buf += chunk;
    for (;;) {
      if (mode === 'start') {
        const t = buf.trimStart();
        if (!t.length && !flush) return out;
        if ('<think>'.startsWith(t) && t.length < 7 && !flush) return out; // 아직 판단 불가
        if (t.startsWith('<think>')) { buf = t.slice(7); mode = 'think'; continue; }
        mode = 'body'; continue;
      }
      if (mode === 'think') {
        const i = buf.indexOf('</think>');
        if (i === -1) {
          const keep = flush ? 0 : 8; // 닫는 태그가 잘려 들어올 수 있음
          if (buf.length > keep) { out.push({ type: 'delta', thinking: buf.slice(0, buf.length - keep) }); buf = buf.slice(buf.length - keep); }
          return out;
        }
        if (i > 0) out.push({ type: 'delta', thinking: buf.slice(0, i) });
        buf = buf.slice(i + 8).replace(/^\s+/, ''); mode = 'body'; continue;
      }
      if (buf) out.push({ type: 'delta', content: buf });
      buf = '';
      return out;
    }
  };
}

export async function collect(gen) {
  let content = '', thinking = '', finishReason = null, usage = null;
  for await (const ev of gen) {
    if (ev.type === 'delta') { if (ev.content) content += ev.content; if (ev.thinking) thinking += ev.thinking; }
    else if (ev.type === 'done') { finishReason = ev.finishReason; usage = ev.usage; }
  }
  return { content, thinking, finishReason, usage };
}

// fetch 스트림을 줄 단위로
export async function* lines(body) {
  const dec = new TextDecoder(); let buf = '';
  for await (const chunk of body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) !== -1) { yield buf.slice(0, i).replace(/\r$/, ''); buf = buf.slice(i + 1); }
  }
  if (buf) yield buf;
}
