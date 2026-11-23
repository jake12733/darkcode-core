// 음악·영상 파이프라인
//   runMusic:      대충 친 명령 → [COMPOSE] 작곡 역할이 제목·스타일·가사·BPM·키 설계 → [RENDER] ACE-Step 으로 실제 노래 생성 → 저장
//   makeStoryboard: 곡 정보/명령 → 영상 장면 구성 JSON (STUDIO 영상 탭이 그대로 렌더)
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const COMPOSE_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    caption: { type: 'string' },
    lyrics: { type: 'string' },
    bpm: { type: 'integer' },
    key: { type: 'string' },
    duration: { type: 'integer' },
    language: { type: 'string' },
    instrumental: { type: 'boolean' },
    mood: { type: 'string' },
  },
  required: ['title', 'caption', 'lyrics', 'bpm', 'key', 'duration', 'language', 'instrumental', 'mood'],
};

const TEMPLATES = ['kinetic', 'bars', 'particles', 'waves', 'grid', 'glitch', 'photo'];
const STORY_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    palette: { type: 'array', items: { type: 'string' }, minItems: 3, maxItems: 3 },
    scenes: {
      type: 'array', minItems: 3, maxItems: 16,
      items: {
        type: 'object',
        properties: {
          dur: { type: 'number' },
          template: { type: 'string', enum: TEMPLATES },
          text: { type: 'string' },
          sub: { type: 'string' },
          palette: { type: 'array', items: { type: 'string' }, minItems: 3, maxItems: 3 },
        },
        required: ['dur', 'template', 'text', 'sub', 'palette'],
      },
    },
  },
  required: ['title', 'palette', 'scenes'],
};

const parseJson = (t) => { const s = String(t || ''); try { return JSON.parse(s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1)); } catch { return null; } };
const HEX = /^#[0-9a-f]{6}$/i;
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));

function normalizeSong(j, opts) {
  const s = { ...j };
  s.title = String(s.title || '무제').slice(0, 60);
  s.caption = String(s.caption || 'k-pop, upbeat, synth, drums').slice(0, 600);
  s.instrumental = opts.instrumental ?? !!s.instrumental;
  s.lyrics = opts.lyrics ? String(opts.lyrics) : String(s.lyrics || '');
  if (!s.instrumental && !/\[(verse|chorus|intro|bridge|outro|hook)/i.test(s.lyrics)) s.lyrics = `[Verse]\n${s.lyrics}`;
  s.bpm = clamp(Number(s.bpm) || 110, 50, 200);
  s.duration = clamp(Number(opts.duration || s.duration) || 120, 20, 300);
  s.language = String(opts.language || s.language || 'ko').slice(0, 5);
  s.key = String(s.key || 'C Major').slice(0, 20);
  s.mood = String(s.mood || '').slice(0, 60);
  return s;
}

export async function runMusic({ cfg, store, roles: roleRouter, engines, input, options = {}, signal, emit = () => {} }) {
  const t0 = Date.now();
  const log = (level, msg) => emit('log', { level, msg, t: Date.now() - t0 });
  const roles = roleRouter.scoped(log);
  emit('stage', { name: 'compose', status: 'start' });
  let song;
  try {
    const ask = [{ role: 'user', content: `사용자 요청(대충 써도 됨): ${input}\n\n옵션: ${JSON.stringify({ instrumental: options.instrumental ?? null, duration: options.duration ?? null, language: options.language ?? null, lyrics: options.lyrics ? '사용자 가사 있음(그대로 사용)' : null })}` }];
    let r = await roles.callOnce('composer', { messages: ask, json: COMPOSE_SCHEMA, signal });
    let j = parseJson(r.content);
    if (!j) throw new Error('작곡 결과 JSON 해석 실패');
    // 한국어 곡인데 가사에 한자/중국어가 섞이면(qwen 계열 버릇) 한 번 더 한글로 쓰게 한다
    const lang = String(options.language || j.language || 'ko');
    const hanRatio = (s) => { const t = String(s || '').replace(/\[[^\]]*\]|\s/g, ''); return t.length ? (t.match(/[\u4E00-\u9FFF]/g) || []).length / t.length : 0; };
    if (lang.startsWith('ko') && !options.lyrics && hanRatio(j.lyrics) > 0.02) {
      log('warn', `가사에 한자 ${(hanRatio(j.lyrics) * 100).toFixed(0)}% → 한글 가사로 다시 작성`);
      r = await roles.callOnce('composer', { messages: [...ask, { role: 'assistant', content: r.content }, { role: 'user', content: '가사가 한국어가 아닙니다. 같은 곡 설계를 유지하되 lyrics 를 자연스러운 한국어 한글로만 다시 쓰세요. 한자·중국어 금지(훅 한두 단어의 영어는 허용). title 도 자연스러운 한국어로.' }], json: COMPOSE_SCHEMA, signal });
      const j2 = parseJson(r.content);
      if (j2 && hanRatio(j2.lyrics) < hanRatio(j.lyrics)) j = j2;
      if (hanRatio(j.lyrics) > 0.02) { log('warn', '재작성 후에도 한자 남음 → 한자 줄 제거'); j.lyrics = String(j.lyrics).split('\n').filter((l) => !/[\u4E00-\u9FFF]/.test(l)).join('\n'); }
    }
    song = normalizeSong(j, options);
    log('ok', `compose "${song.title}" · ${song.bpm}BPM · ${song.key} · ${song.duration}s · ${song.instrumental ? '인스트' : '보컬'}`);
  } catch (e) {
    if (signal?.aborted) throw e;
    log('warn', `작곡 역할 실패 → 기본 설계 사용: ${e.message}`);
    song = normalizeSong({ title: input.slice(0, 30), caption: `${input}, modern production, catchy melody`, lyrics: '', instrumental: true }, { ...options, instrumental: options.instrumental ?? true });
  }
  emit('compose', song);
  emit('stage', { name: 'compose', status: 'done' });

  emit('stage', { name: 'render', status: 'start' });
  const engineId = Object.entries(cfg.engines).find(([, e]) => e.type === 'acestep' && e.enabled)?.[0];
  const sunoStyle = `${song.caption}, ${song.bpm} BPM, ${song.key}`.slice(0, 1000);
  if (!engineId || !(await engines.usable(engineId))) {
    log('warn', '음악 엔진(ACE-Step) 없음 → 작곡안 + Suno 핸드오프만 반환');
    emit('stage', { name: 'render', status: 'done', skipped: true });
    const out = { track: null, song, handoff: { style: sunoStyle, lyrics: song.instrumental ? '[Instrumental]' : song.lyrics }, ms: Date.now() - t0, reason: 'ACE-Step 엔진이 꺼져 있거나 설치되지 않았습니다' };
    emit('done', out);
    return out;
  }
  const lease = await engines.acquire(engineId, 'acestep', signal);
  let gen;
  try {
    log('route', `render → ${engineId} (ACE-Step)`);
    gen = await lease.adapter.generate(song, { signal, onProgress: (p) => emit('progress', p) });
  } finally { lease.release(); }
  const id = randomUUID().slice(0, 12);
  const dir = path.join(path.dirname(cfg.storage.path), 'media');
  fs.mkdirSync(dir, { recursive: true });
  const file = `${id}.mp3`;
  fs.writeFileSync(path.join(dir, file), gen.audio);
  const track = { id, kind: 'audio', title: song.title, file, url: `/dc/media/${file}`, bytes: gen.audio.length, song: { ...song, lyrics: gen.lyrics || song.lyrics }, metas: gen.metas, engine: engineId, model: gen.model, genMs: gen.ms, created: Date.now() };
  store.addMedia(track);
  log('ok', `render 완료 · ${(gen.audio.length / 1024).toFixed(0)}KB · ${(gen.ms / 1000).toFixed(1)}s`);
  emit('stage', { name: 'render', status: 'done' });
  const out = { track, song, handoff: { style: sunoStyle, lyrics: track.song.lyrics }, ms: Date.now() - t0 };
  emit('done', out);
  return out;
}

// 오프라인/실패 대비: 가사 줄·곡 길이로 만드는 기본 스토리보드
export function fallbackStoryboard({ title = 'DARK CODE', lyrics = '', duration = 30, palette }) {
  const pal = palette && palette.length === 3 ? palette : ['#00FF66', '#7C3AED', '#0EA5E9'];
  const lines = String(lyrics).split('\n').map((l) => l.trim()).filter((l) => l && !/^\[.*\]$/.test(l));
  const n = clamp(Math.round(duration / 5), 3, 12);
  const scenes = Array.from({ length: n }, (_, i) => ({ dur: duration / n, template: TEMPLATES[i % 6], text: i === 0 ? title : lines[(i - 1) % Math.max(1, lines.length)] || title, sub: i === 0 ? 'DARK CODE STUDIO' : '', palette: pal }));
  return { title, palette: pal, scenes };
}

export async function makeStoryboard({ roles: roleRouter, input, song = {}, duration = 30, format = '9:16', signal, log = () => {} }) {
  const roles = roleRouter.scoped(log);
  try {
    const r = await roles.callOnce('storyboard', {
      messages: [{ role: 'user', content: `영상 요청(대충 써도 됨): ${input || '(없음)'}\n곡 제목: ${song.title || '-'}\n곡 분위기: ${song.mood || song.caption || '-'}\n가사:\n${(song.lyrics || '').slice(0, 1500)}\n총 길이: ${duration}초 · 화면 비율 ${format}\n사용 가능한 템플릿: ${TEMPLATES.join(', ')}` }],
      json: STORY_SCHEMA, signal,
    });
    const j = parseJson(r.content);
    if (!j?.scenes?.length) throw new Error('장면 없음');
    const pal = (j.palette || []).filter((c) => HEX.test(c));
    const scenes = j.scenes.slice(0, 16).map((s) => ({ dur: Math.max(1.5, Number(s.dur) || 4), template: TEMPLATES.includes(s.template) ? s.template : 'kinetic', text: String(s.text || '').slice(0, 60), sub: String(s.sub || '').slice(0, 80), palette: (s.palette || []).filter((c) => HEX.test(c)).length === 3 ? s.palette : (pal.length === 3 ? pal : ['#00FF66', '#7C3AED', '#0EA5E9']) }));
    const total = scenes.reduce((a, s) => a + s.dur, 0);
    scenes.forEach((s) => { s.dur = Math.round((s.dur * duration / total) * 100) / 100; });
    return { title: String(j.title || song.title || 'DARK CODE').slice(0, 60), palette: pal.length === 3 ? pal : scenes[0].palette, scenes, by: 'ai' };
  } catch (e) {
    if (signal?.aborted) throw e;
    log('warn', `storyboard 역할 실패 → 기본 구성: ${e.message}`);
    return { ...fallbackStoryboard({ title: song.title || input, lyrics: song.lyrics, duration }), by: 'fallback' };
  }
}

export { TEMPLATES };
