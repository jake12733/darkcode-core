// 실제 엔진으로 /dc/run 1건 실행하고 이벤트를 요약 출력
// 사용: node test/live-run.js "요청 문장"   또는  node test/live-run.js @request.json
import fs from 'node:fs';
import { createServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';

let arg = process.argv[2] || 'TCP와 UDP 차이 알려줘';
const payload = arg.startsWith('@') ? JSON.parse(fs.readFileSync(arg.slice(1), 'utf8')) : { input: arg };
const cfg = loadConfig();
cfg.server.port = 18790;
const server = createServer(cfg);
await new Promise((r) => server.listen(18790, '127.0.0.1', r));

const t0 = Date.now();
const res = await fetch('http://127.0.0.1:18790/dc/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
let buf = '', tokens = 0, thinking = 0, done = null;
const dec = new TextDecoder();
for await (const chunk of res.body) {
  buf += dec.decode(chunk, { stream: true });
  let i;
  while ((i = buf.indexOf('\n\n')) !== -1) {
    const block = buf.slice(0, i); buf = buf.slice(i + 2);
    if (!block.startsWith('event:')) continue;
    const [e, d] = block.split('\n'); const type = e.slice(7); const data = JSON.parse(d.slice(6));
    const s = ((Date.now() - t0) / 1000).toFixed(1).padStart(6);
    if (type === 'token') tokens++;
    else if (type === 'thinking') thinking++;
    else if (type === 'log') console.log(`${s}s  ${data.level.padEnd(5)} ${data.msg}`);
    else if (type === 'done') done = data;
    else if (type === 'error') console.log(`${s}s  ERROR ${data.message}`);
  }
}
console.log(`\n토큰 이벤트 ${tokens} · 생각 이벤트 ${thinking} · 총 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
if (done) {
  console.log(`분류: ${done.category} (${done.label}) · 파이프라인 ${done.pipeline} · 검수 ${done.rounds.length}회 · 수정 ${done.revisions}회 · 파일 ${done.files.map((f) => f.name).join(', ') || '-'}`);
  console.log('\n[상태 압축]\n' + done.snapshot.text);
  fs.writeFileSync(new URL('../data/last-run.md', import.meta.url), done.final);
  console.log('\n[산출물 앞부분]\n' + done.final.slice(0, 1500));
}
server.close(); server.dc.engines.shutdown();
