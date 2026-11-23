// ACE-Step 1.5 음악 생성 어댑터 (REST: /release_task → /query_result 폴링 → /v1/audio 다운로드)
// 문서: https://github.com/ace-step/ACE-Step-1.5/blob/main/docs/en/API.md
import { EngineError, withTimeout } from './base.js';

const unwrap = (j) => (j && typeof j === 'object' && 'data' in j ? j.data : j);

export class AceStepAdapter {
  constructor(id, cfg, { timeoutMs = 900000 } = {}) {
    this.id = id; this.cfg = cfg; this.base = cfg.baseUrl.replace(/\/+$/, ''); this.timeoutMs = timeoutMs;
  }
  headers() { const h = { 'Content-Type': 'application/json' }; if (this.cfg.apiKey) h.Authorization = `Bearer ${this.cfg.apiKey}`; return h; }

  async health(signal) {
    try {
      const r = await fetch(`${this.base}/health`, { headers: this.headers(), signal: withTimeout(signal, 3000) });
      if (!r.ok) return { ok: false, detail: `HTTP ${r.status}` };
      const d = unwrap(await r.json());
      return { ok: d?.status === 'ok' || r.ok, detail: d?.service || 'ace-step' };
    } catch (e) { return { ok: false, detail: e.message }; }
  }

  async models(signal) {
    const r = await fetch(`${this.base}/v1/models`, { headers: this.headers(), signal: withTimeout(signal, 5000) });
    if (!r.ok) return [];
    return (unwrap(await r.json())?.models || []).map((m) => m.name);
  }

  async unload() { /* 프로세스 단위 관리 (engines/manager.js idleStopSec) */ }

  // song = { caption, lyrics, duration, bpm, key, language, instrumental, thinking, steps }
  async generate(song, { signal, onProgress } = {}) {
    const body = {
      prompt: song.caption,
      lyrics: song.instrumental ? '[Instrumental]' : (song.lyrics || ''),
      audio_duration: song.duration,
      vocal_language: song.language || 'ko',
      thinking: song.thinking !== false,
      batch_size: 1,
      audio_format: 'mp3',
      inference_steps: song.steps || 8,
      use_cot_caption: false, // 캡션은 작곡 역할이 이미 다듬었음
    };
    if (song.bpm) body.bpm = Math.max(30, Math.min(300, Math.round(song.bpm)));
    if (song.key) body.key_scale = song.key;
    if (song.model) body.model = song.model;
    const sig = withTimeout(signal, this.timeoutMs);
    const rel = await fetch(`${this.base}/release_task`, { method: 'POST', headers: this.headers(), body: JSON.stringify(body), signal: sig });
    if (!rel.ok) throw new EngineError(this.id, `release_task HTTP ${rel.status} ${(await rel.text()).slice(0, 200)}`, { status: rel.status, retryable: rel.status === 429 || rel.status >= 500 });
    const task = unwrap(await rel.json());
    const taskId = task?.task_id;
    if (!taskId) throw new EngineError(this.id, '작업 ID 없음');
    onProgress?.({ phase: 'queued', taskId, queue: task.queue_position ?? null });

    const t0 = Date.now();
    for (;;) {
      await new Promise((r) => setTimeout(r, 2000));
      if (sig.aborted) throw sig.reason || new Error('aborted');
      const q = await fetch(`${this.base}/query_result`, { method: 'POST', headers: this.headers(), body: JSON.stringify({ task_id_list: [taskId] }), signal: sig });
      if (!q.ok) throw new EngineError(this.id, `query_result HTTP ${q.status}`, { status: q.status });
      const item = (unwrap(await q.json()) || [])[0] || {};
      const status = Number(item.status);
      onProgress?.({ phase: status === 1 ? 'done' : status === 2 ? 'failed' : 'running', taskId, elapsed: Date.now() - t0 });
      if (status === 2) throw new EngineError(this.id, `생성 실패: ${String(item.result || item.error || '').slice(0, 200)}`);
      if (status !== 1) continue;
      let results = item.result;
      if (typeof results === 'string') { try { results = JSON.parse(results); } catch { results = []; } }
      const first = (Array.isArray(results) ? results : [results]).find((x) => x && x.file);
      if (!first) throw new EngineError(this.id, '결과 파일 없음');
      const url = first.file.startsWith('http') ? first.file : `${this.base}${first.file.startsWith('/') ? '' : '/'}${first.file}`;
      const a = await fetch(url, { headers: this.headers(), signal: sig });
      if (!a.ok) throw new EngineError(this.id, `오디오 다운로드 HTTP ${a.status}`);
      return { audio: Buffer.from(await a.arrayBuffer()), mime: a.headers.get('content-type') || 'audio/mpeg', metas: first.metas || {}, lyrics: first.lyrics, caption: first.prompt, seed: first.seed_value, model: first.dit_model, lm: first.lm_model, ms: Date.now() - t0 };
    }
  }
}
