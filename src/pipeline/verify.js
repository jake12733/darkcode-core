// 0토큰 정적 검증 + 산출물(코드 블록 → 파일) 추출
import vm from 'node:vm';

// 코드 블록 바로 위 2줄 안의 파일명 표기 (### server.js / **models/user.js** / `utils/a.js`)
const FILE_HINT = /(?:^|[\s#*`'"(:：])((?:[\w.-]+\/)*[\w.-]+\.(?:html?|css|m?js|cjs|jsx|tsx?|py|sql|json|ya?ml|sh|ps1|go|rs|java|kt|swift|dart|php|rb|vue|svelte|md|toml|ini|conf|env|dockerfile))\b/i;
function nameHint(md, fenceIndex) {
  const before = md.slice(Math.max(0, fenceIndex - 240), fenceIndex).split('\n').filter((l) => l.trim()).slice(-2).reverse();
  for (const l of before) { const m = l.match(FILE_HINT); if (m && l.trim().length < 120) return m[1]; }
  return null;
}

export function extractCode(md) {
  const out = []; const re = /```([\w+.-]*)[^\n]*\n([\s\S]*?)```/g; let m;
  while ((m = re.exec(md))) out.push({ lang: (m[1] || 'text').toLowerCase(), code: m[2].replace(/\n$/, ''), name: nameHint(md, m.index) });
  // 닫히지 않은 마지막 펜스 (출력이 잘린 경우)
  const opens = (md.match(/```/g) || []).length;
  if (opens % 2 === 1) { const i = md.lastIndexOf('```'); const nl = md.indexOf('\n', i); if (nl > 0) out.push({ lang: (md.slice(i + 3, nl).trim().split(/\s/)[0] || 'text').toLowerCase(), code: md.slice(nl + 1), truncated: true }); }
  return out;
}

const NAME = { html: 'index.html', css: 'style.css', javascript: 'app.js', js: 'app.js', jsx: 'App.jsx', tsx: 'App.tsx', typescript: 'index.ts', ts: 'index.ts', python: 'main.py', py: 'main.py', sql: 'schema.sql', json: 'config.json', bash: 'run.sh', sh: 'run.sh', shell: 'run.sh', powershell: 'run.ps1', ps1: 'run.ps1', yaml: 'config.yaml', yml: 'config.yml', dockerfile: 'Dockerfile', go: 'main.go', rust: 'main.rs', java: 'Main.java', md: 'README.md' };
export function toFiles(blocks) {
  const used = new Set();
  return blocks.filter((b) => b.code.trim() && !['log', 'text', 'yaml-snapshot'].includes(b.lang)).map((b, i) => {
    let n = b.name || NAME[b.lang] || `snippet-${i + 1}.${b.lang && b.lang !== 'text' ? b.lang : 'txt'}`;
    if (used.has(n)) { const d = n.lastIndexOf('.'); n = d > 0 ? `${n.slice(0, d)}-${i + 1}${n.slice(d)}` : `${n}-${i + 1}`; }
    used.add(n);
    return { name: n, lang: b.lang, code: b.code, truncated: !!b.truncated };
  });
}

export function htmlIssues(code) {
  const lc = code.toLowerCase(); const n = (re) => (lc.match(re) || []).length; const out = [];
  if (n(/<style[\s>]/g) > n(/<\/style>/g)) out.push('<style> 닫힘 없음');
  if (n(/<script[\s>]/g) > n(/<\/script>/g)) out.push('<script> 닫힘 없음');
  if (/<html[\s>]|<!doctype/i.test(code) && !/<\/html>\s*$/i.test(code.trim())) out.push('</html> 없음 (문서 잘림)');
  const body = (code.match(/<body[^>]*>([\s\S]*)/i) || [])[1];
  if (/<head[\s>]/i.test(code) && body === undefined) out.push('<body> 없음');
  return out;
}

const OMISSION = /(\/\/\s*(중략|생략|나머지|\.\.\.\s*$))|(#\s*(중략|생략|\.\.\.\s*$))|(<!--\s*(중략|생략|나머지)[^>]*-->)|\bTODO\b|(나머지\s*(코드는?\s*)?(동일|생략))|(이하\s*생략)/im;

// 반환: 문제 목록 (빈 배열이면 통과)
export function staticCheck(md, category) {
  const issues = [];
  const blocks = extractCode(md);
  blocks.forEach((b, i) => {
    const where = `코드#${i + 1}(${b.lang})`;
    if (b.truncated) issues.push(`${where}: 코드 블록이 닫히지 않음 (출력 잘림)`);
    if (OMISSION.test(b.code)) issues.push(`${where}: 생략 표현(중략/TODO/나머지 동일) 포함`);
    if (['javascript', 'js'].includes(b.lang) && !/^\s*(import|export)\s/m.test(b.code)) {
      try { new vm.Script(b.code); } catch (e) { issues.push(`${where}: JS 문법 오류 ${e.message}`); }
    }
    if (b.lang === 'json') { try { JSON.parse(b.code); } catch (e) { issues.push(`${where}: JSON 오류 ${e.message}`); } }
    if (b.lang === 'html') {
      htmlIssues(b.code).forEach((x) => issues.push(`${where}: ${x}`));
      const re = /<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/gi; let m;
      while ((m = re.exec(b.code))) { if (/type=["']?(module|application\/ld\+json|text\/)/i.test(m[1])) continue; try { new vm.Script(m[2]); } catch (e) { issues.push(`${where}: 내장 <script> 문법 오류 ${e.message}`); } }
    }
  });
  if (category === 'web' && !blocks.some((b) => b.lang === 'html')) issues.push('웹 요청인데 html 코드 블록이 없음');
  const prose = md.replace(/```[\s\S]*?```/g, '');
  const han = prose.match(/[\u4E00-\u9FFF]{1,}/g);
  if (han) issues.push(`본문에 중국어 한자 섞임: ${han.slice(0, 3).join(', ')}`);
  return issues;
}

// 다음 턴에 넘길 4줄 상태 압축
export function buildSnapshot({ input, category, rounds, revisions, final, issues, route }) {
  const lastVerdict = rounds.length ? rounds[rounds.length - 1].verdict : 'PASS';
  const applied = rounds.slice(0, -1).flatMap((r) => r.fixes || []);
  const firstLine = final.replace(/```[\s\S]*?```/g, '').split('\n').map((l) => l.replace(/^#+\s*|\*\*/g, '').trim()).filter(Boolean).slice(0, 2).join(' / ').slice(0, 180);
  const impl = route.find((r) => r.role.startsWith('implementer') || r.role === 'escalate');
  return {
    goal: input.slice(0, 120),
    category,
    model: impl ? `${impl.engine}:${impl.model}` : '-',
    rounds: rounds.length, revisions, verdict: lastVerdict,
    summary: firstLine,
    improved: applied.slice(0, 4),
    open: lastVerdict === 'REVISE' ? (rounds[rounds.length - 1].fixes || []) : issues,
    text:
      `[최종 모델 & 라운드] ${impl ? `${impl.engine}:${impl.model}` : '-'} · 검수 ${rounds.length}회 · 수정 ${revisions}회 · ${lastVerdict}\n` +
      `[핵심 결과 요약] ${firstLine || '-'}\n` +
      `[보완된 사항] ${applied.length ? applied.slice(0, 4).join(' / ') : '없음'}\n` +
      `[남은 이슈] ${(lastVerdict === 'REVISE' ? rounds[rounds.length - 1].fixes : issues).slice(0, 3).join(' / ') || '없음'}`,
  };
}
