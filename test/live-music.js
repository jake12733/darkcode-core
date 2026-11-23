// 실제 엔진으로 /dc/music 1건 (ACE-Step 이 없으면 작곡안 + Suno 핸드오프)
// 사용: node test/live-music.js "운동할 때 신나는거"
import { createServer } from '../src/server.js';
import { loadConfig } from '../src/config.js';

const input = process.argv[2] || '비 오는 날 듣기 좋은 노래';
const cfg = loadConfig(); cfg.server.port = 18791;
const server = createServer(cfg);
await new Promise((r) => server.listen(18791, '127.0.0.1', r));
const t0 = Date.now();
const r = await fetch('http://127.0.0.1:18791/dc/music', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input }) });
const txt = await r.text();
for (const b of txt.split('\n\n').filter((x) => x.startsWith('event:'))) {
  const [e, d] = b.split('\n'); const type = e.slice(7); const data = JSON.parse(d.slice(6));
  if (type === 'log') console.log(`${(data.t / 1000).toFixed(1).padStart(6)}s ${data.level.padEnd(5)} ${data.msg}`);
  if (type === 'compose') console.log('\n[작곡 설계]\n' + JSON.stringify(data, null, 2));
  if (type === 'done') console.log(`\n[결과] track=${data.track ? data.track.url : '없음'} · ${data.reason || ''} · ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  if (type === 'error') console.log('ERROR', data.message);
}
server.close(); server.dc.engines.shutdown();
