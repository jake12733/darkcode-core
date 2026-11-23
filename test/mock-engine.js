// 테스트용 가짜 OpenAI 호환 엔진 (vLLM/SGLang/llama.cpp 자리 대체) — GPU 없이 라우팅·파이프라인 검증
import http from 'node:http';

export function startMock(port = 18081) {
  let criticCalls = 0, lengthOnce = true;
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    if (req.url.endsWith('/models')) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ data: [{ id: 'mock-small' }, { id: 'mock-big' }] })); }
    if (!req.url.endsWith('/chat/completions')) { res.writeHead(404); return res.end(); }
    const last = body.messages.filter((m) => m.role === 'user').pop()?.content || '';
    const sys = body.messages.find((m) => m.role === 'system')?.content || '';
    const schema = body.response_format?.json_schema?.schema;
    let text, reasoning = '', finish = 'stop';
    if (schema?.properties?.caption && schema?.properties?.lyrics) text = JSON.stringify({ title: '빗속의 네온', caption: 'synthwave, retro, rainy night, analog synth, drum machine, female vocal, dreamy', lyrics: '[Verse 1]\n젤은 거리를 걸어\n[Chorus]\n네온 아래서 춤을 춰', bpm: 98, key: 'A Minor', duration: 60, language: 'ko', instrumental: false, mood: '비 오는 밤 레트로' });
    else if (schema?.properties?.scenes) text = JSON.stringify({ title: '빗속의 네온', palette: ['#00FF66', '#7C3AED', '#0EA5E9'], scenes: [{ dur: 5, template: 'kinetic', text: '빗속의 네온', sub: 'DARK CODE', palette: ['#00FF66', '#7C3AED', '#0EA5E9'] }, { dur: 5, template: 'bars', text: '젤은 거리', sub: '', palette: ['#F472B6', '#7C3AED', '#0EA5E9'] }, { dur: 5, template: 'nope', text: '네온 아래', sub: '', palette: ['bad', '#7C3AED', '#0EA5E9'] }] });
    else if (schema?.properties?.category) { const req = (last.match(/분류할 요청:\n([\s\S]*?)\n\n/) || [, last])[1]; text = JSON.stringify({ category: /보안|취약/.test(req) ? 'security' : 'general', reason: 'mock 분류' }); }
    else if (schema?.properties?.verdict) { criticCalls++; text = JSON.stringify(criticCalls % 2 === 1 ? { verdict: 'REVISE', score: 6, reason: 'mock: 접근성 보완 필요', fixes: ['버튼에 aria-label 추가'] } : { verdict: 'PASS', score: 9, reason: 'mock: 통과', fixes: [] }); }
    else if (/전략가/.test(sys)) text = '- 목표: 요청 해석\n- 구조: 단일 파일\n- 가정: 기본 다크 테마';
    else if (/\[\[LENGTH\]\]/.test(last) && lengthOnce) { lengthOnce = false; text = '```python\nprint("part1")'; finish = 'length'; }
    else if (/이어서/.test(last)) text = '\nprint("part2")\n```';
    else if (/페이지|랜딩/.test(last) || /웹 구현자/.test(sys)) { reasoning = '레이아웃 구상 중'; text = '요약: 랜딩 페이지\n\n```html\n<!doctype html><html><head><style>body{background:#000;color:#0f6}</style></head><body><h1>DARK CODE</h1><button>시작</button><script>document.querySelector("button").onclick=()=>alert(1)</script></body></html>\n```'; }
    else text = `mock 답변: ${last.slice(0, 60)}`;

    if (!body.stream) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: text }, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 20 } })); }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const w = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    if (reasoning) w({ choices: [{ delta: { reasoning_content: reasoning } }] });
    for (let i = 0; i < text.length; i += 17) w({ choices: [{ delta: { content: text.slice(i, i + 17) } }] });
    w({ choices: [{ delta: {}, finish_reason: finish }] });
    w({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 20 } });
    res.end('data: [DONE]\n\n');
  });
  return new Promise((r) => server.listen(port, '127.0.0.1', () => r(server)));
}

// 가짜 ACE-Step API (release_task → query_result 2회차에 완료 → v1/audio)
export function startMockAceStep(port = 18082) {
  const tasks = new Map();
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString() || '{}') : {};
    const ok = (data) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ data, code: 200, error: null, timestamp: Date.now() })); };
    if (req.url === '/health') return ok({ status: 'ok', service: 'ACE-Step API', version: '1.0' });
    if (req.url === '/release_task') { const id = 'task-' + tasks.size; tasks.set(id, { polls: 0, body }); return ok({ task_id: id, status: 'queued', queue_position: 1 }); }
    if (req.url === '/query_result') {
      return ok(body.task_id_list.map((id) => { const t = tasks.get(id); t.polls++; return t.polls < 2 ? { task_id: id, status: 0 } : { task_id: id, status: 1, result: JSON.stringify([{ file: '/v1/audio?path=%2Ftmp%2Fx.mp3', status: 1, prompt: t.body.prompt, lyrics: t.body.lyrics, metas: { bpm: t.body.bpm, duration: t.body.audio_duration, keyscale: t.body.key_scale }, dit_model: 'acestep-v15-turbo', lm_model: 'acestep-5Hz-lm-0.6B' }]) }; }));
    }
    if (req.url.startsWith('/v1/audio')) { res.writeHead(200, { 'Content-Type': 'audio/mpeg' }); return res.end(Buffer.from('ID3MOCKAUDIO'.repeat(100))); }
    res.writeHead(404); res.end();
  });
  return new Promise((r) => server.listen(port, '127.0.0.1', () => r(server)));
}

if (process.argv[1]?.endsWith('mock-engine.js')) startMock(Number(process.env.PORT) || 18081).then(() => console.log('mock engine on :18081'));
