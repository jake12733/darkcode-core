// 작업 분류: 1) 0토큰 규칙(키워드 점수) → 2) 애매하면 LLM 라우터(JSON 스키마 고정) → 3) 실패 시 general
const CODE_FENCE = /```|\b(function|const|let|def|class|import|SELECT|#include)\b/;

export function ruleScores(input, categories) {
  const text = ` ${String(input).toLowerCase()} `;
  const scores = {};
  for (const [cat, c] of Object.entries(categories)) {
    let s = 0;
    // 한글 2글자 단어(보안·포트)는 영문 4글자급 정보량 → 같은 가중치
    for (const kw of c.keywords || []) if (text.includes(kw.toLowerCase())) s += kw.length >= 4 || /[가-힣]{2,}/.test(kw) ? 2 : 1;
    scores[cat] = s;
  }
  const securityIntent = /(보안|취약|security|vuln|침해|해킹|인젝션|injection|xss|csrf).{0,20}(점검|분석|리뷰|진단|검토|감사|audit|review|찾아|막|대응|패치)/i.test(input)
    || /(점검|분석|리뷰|진단|검토).{0,10}(보안|취약)/.test(input);
  if (securityIntent) scores.security = (scores.security || 0) + 5;
  // 코드가 붙어 있어도 "보안 점검" 의도면 code 가산을 하지 않는다
  if (CODE_FENCE.test(input) && !securityIntent) scores.code = (scores.code || 0) + 2;
  // 웹 생성 의도 ("~ 페이지/사이트 만들어줘") 는 code 보다 web 우선
  if (/(페이지|사이트|화면|ui).{0,12}(만들|제작|생성|디자인)/i.test(input)) scores.web = (scores.web || 0) + 3;
  // 개념 질문은 general 가산 ("~가 뭐야", "차이", "설명")
  if (/(뭐야|무엇|뭔가요|차이|설명해|알려줘|이란|란\?)/.test(input) && !/(만들|작성|짜줘|고쳐|구현)/.test(input)) scores.general = (scores.general || 0) + 3;
  return scores;
}

const SCHEMA = (cats) => ({
  type: 'object',
  properties: { category: { type: 'string', enum: cats }, reason: { type: 'string' } },
  required: ['category', 'reason'],
});

export async function classify(input, { cfg, roles, signal, log = () => {} }) {
  const cats = Object.keys(cfg.categories);
  const scores = ruleScores(input, cfg.categories);
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [top, second] = ranked;
  const min = cfg.limits.routerMinScore ?? 2;
  if (top && top[1] >= min && top[1] - (second?.[1] || 0) >= 2) {
    return { category: top[0], by: 'rules', reason: `키워드 점수 ${top[1]} (차순위 ${second?.[0] || '-'} ${second?.[1] || 0})`, scores };
  }
  try {
    const r = await roles.callOnce('router', {
      messages: [{ role: 'user', content: `분류할 요청:\n${input}\n\n카테고리: ${cats.map((c) => `${c}(${cfg.categories[c].label})`).join(', ')}` }],
      json: SCHEMA(cats), signal,
    });
    const j = JSON.parse(r.content.slice(r.content.indexOf('{'), r.content.lastIndexOf('}') + 1));
    if (cats.includes(j.category)) return { category: j.category, by: 'llm', reason: String(j.reason || '').slice(0, 120), scores, engine: `${r.engine}:${r.model}` };
    log('warn', `router 출력 범위 밖: ${r.content.slice(0, 80)}`);
  } catch (e) {
    if (signal?.aborted) throw e;
    log('warn', `router LLM 실패 → 규칙/기본값 사용: ${e.message}`);
  }
  const fallback = top && top[1] > 0 ? top[0] : 'general';
  return { category: fallback, by: 'fallback', reason: top?.[1] ? `규칙 최고점 ${top[0]}` : '판단 근거 부족 → general', scores };
}
