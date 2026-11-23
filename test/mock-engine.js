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
    if (schema?.properties?.category) { const req = (last.match(/분류할 요청:\n([\s\S]*?)\n\n/) || [, last])[1]; text = JSON.stringify({ category: /보안|취약/.test(req) ? 'security' : 'general', reason: 'mock 분류' }); }
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

if (process.argv[1]?.endsWith('mock-engine.js')) startMock(Number(process.env.PORT) || 18081).then(() => console.log('mock engine on :18081'));
