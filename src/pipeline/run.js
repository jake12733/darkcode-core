// 2층 파이프라인: CACHE → CONTEXT → ROUTE → (STRATEGIST) → IMPLEMENTER → CRITIC/VERIFY → GATE → RENDER
// 모든 단계는 emit(type, data) 로 실시간 이벤트를 내보내고, 로그·결과는 Store 에 기록된다.
import { classify } from '../router/classify.js';
import { Store } from '../store/db.js';
import { staticCheck, extractCode, toFiles, buildSnapshot } from './verify.js';

const estTok = (s) => { const t = String(s || ''); const cjk = (t.match(/[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af\u4e00-\u9fff]/g) || []).length; return Math.ceil(cjk + (t.length - cjk) / 4); };

const CRITIC_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['PASS', 'REVISE'] },
    score: { type: 'integer' },
    reason: { type: 'string' },
    fixes: { type: 'array', items: { type: 'string' }, maxItems: 3 },
  },
  required: ['verdict', 'score', 'reason', 'fixes'],
};

function parseJson(text) {
  const t = String(text || '');
  try { return JSON.parse(t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1)); } catch { return null; }
}

export async function runPipeline({ cfg, store, roles: roleRouter, input, sessionId, mode = 'auto', category: forced, noCache = false, signal, emit = () => {} }) {
  const t0 = Date.now();
  const sid = store.ensureSession(sessionId, input);
  const runId = store.startRun(sid, input);
  const route = [];
  const log = (level, msg) => { store.log(runId, level, msg); emit('log', { level, msg, t: Date.now() - t0 }); };
  const stage = (name, status = 'start', extra = {}) => emit('stage', { name, status, ...extra });
  const onRoute = (r) => { route.push({ ...r, t: Date.now() - t0 }); emit('route', r); };
  const roles = roleRouter.scoped(log);
  emit('run', { runId, sessionId: sid, input });

  let category = forced || null, pipeline = null;
  try {
    // ---------- CACHE ----------
    stage('cache');
    const session = store.session(sid);
    // 설정(역할·분류·파이프라인·프롬프트)이 바뀌면 캐시 키도 바뀌어 자동 무효화
    cfg._hash ??= Store.key({ p: cfg.profile, r: cfg.roles, c: cfg.categories, pl: cfg.pipelines, cv: 2 });
    const key = Store.key({ v: 1, cfg: cfg._hash, input: input.trim().toLowerCase(), snap: session?.snapshot?.text || '', mode, forced: forced || '' });
    const hit = noCache ? null : store.cacheGet(key);
    if (hit) {
      log('ok', `cache HIT (${key}) → 엔진 호출 0회`);
      stage('cache', 'done', { hit: true });
      store.addMessage(sid, 'user', input);
      store.addMessage(sid, 'assistant', hit.final, { runId, cached: true, category: hit.category });
      store.finishRun(runId, { category: hit.category, pipeline: 'cache', status: 'done', route: [], result: { cached: true }, ms: Date.now() - t0 });
      const out = { ...hit, runId, sessionId: sid, cached: true, ms: Date.now() - t0 };
      emit('done', out);
      return out;
    }
    log('info', `cache MISS (${key})`);
    stage('cache', 'done', { hit: false });

    // ---------- CONTEXT ----------
    stage('context');
    const history = store.messages(sid);
    const budget = cfg.limits.contextTokens || 6000;
    const keep = cfg.limits.keepRecentMessages || 4;
    const recent = [];
    let used = 0;
    for (let i = history.length - 1; i >= 0 && recent.length < keep; i--) {
      const m = history[i];
      const content = m.role === 'assistant' && m.content.length > 4000 ? m.content.slice(0, 4000) + '\n…(이하 생략: 이전 산출물)' : m.content;
      const tk = estTok(content);
      if (used + tk > budget) break;
      used += tk; recent.unshift({ role: m.role, content });
    }
    const ctx = [];
    if (session?.snapshot?.text && history.length > recent.length) ctx.push({ role: 'user', content: `[이전 작업 상태 (압축)]\n${session.snapshot.text}` }, { role: 'assistant', content: '이전 상태를 확인했습니다.' });
    ctx.push(...recent);
    log('info', `ctx 이력 ${history.length}개 중 최근 ${recent.length}개 (~${used} tok)${ctx.length > recent.length ? ' + 상태 압축본' : ''}`);
    stage('context', 'done', { messages: ctx.length, tokens: used });

    // ---------- ROUTE ----------
    stage('route');
    let cls;
    if (forced) cls = { category: forced, by: 'forced', reason: '사용자 지정' };
    else cls = await classify(input, { cfg, roles, signal, log });
    category = cls.category;
    pipeline = mode === 'fast' || mode === 'full' ? mode : cfg.categories[category].pipeline;
    const steps = cfg.pipelines[pipeline];
    log('route', `분류 → ${category} (${cfg.categories[category].label}) · ${cls.by} · ${cls.reason} · 파이프라인 ${pipeline}`);
    stage('route', 'done', { category, label: cfg.categories[category].label, by: cls.by, reason: cls.reason, pipeline, steps });

    // ---------- STRATEGIST ----------
    let plan = '';
    if (steps.includes('strategist')) {
      stage('strategist');
      try {
        const r = await roles.call('strategist', { messages: [...ctx, { role: 'user', content: input }], signal, onRoute, onDelta: (d) => d.content && emit('plan', { text: d.content }) });
        plan = r.content.trim();
      } catch (e) { if (signal?.aborted) throw e; log('warn', `strategist 생략: ${e.message}`); }
      stage('strategist', 'done', { chars: plan.length });
    }

    // ---------- IMPLEMENTER ----------
    const implRole = `implementer.${category}`;
    const implMsgs = (extraUser) => [...ctx, { role: 'user', content: (plan ? `요청:\n${input}\n\n[전략]\n${plan}` : input) + (extraUser ? `\n\n${extraUser}` : '') }];
    const generate = async (messages, kind) => {
      emit('draft', { kind, reset: true });
      let r = await roles.call(implRole, { messages, signal, onRoute, onDelta: (d) => { if (d.content) emit('token', { text: d.content, kind }); if (d.thinking) emit('thinking', { text: d.thinking, kind }); } });
      let text = r.content;
      // 길이 제한으로 끊기면 끊긴 지점부터 최대 2회 이어쓰기
      for (let k = 0; k < 2 && r.finishReason === 'length'; k++) {
        log('warn', `출력 길이 한도 도달 → 이어쓰기 ${k + 1}회차`);
        r = await roles.call(implRole, { messages: [...messages, { role: 'assistant', content: text }, { role: 'user', content: '출력이 길이 제한으로 끊겼습니다. 끊긴 마지막 글자 바로 다음부터 이어서 끝까지 작성하십시오. 이미 쓴 내용 반복·설명 금지.' }], signal, onRoute, onDelta: (d) => d.content && emit('token', { text: d.content, kind }) });
        text += r.content;
      }
      return text;
    };
    stage('implementer');
    let final = await generate(implMsgs(), 'draft');
    stage('implementer', 'done', { chars: final.length });

    // ---------- CRITIC / VERIFY 루프 ----------
    const rounds = [];
    let revisions = 0;
    const maxRev = cfg.limits.maxRevisions ?? 2;
    const useCritic = steps.includes('critic');
    if (useCritic || steps.includes('verify')) {
      let prevFixes = [];
      for (let round = 1; ; round++) {
        stage(useCritic ? 'critic' : 'verify', 'start', { round });
        const issues = staticCheck(final, category);
        if (issues.length) log('warn', `verify static ${issues.length}건: ${issues.slice(0, 3).join(' | ')}`); else log('ok', 'verify static PASS (0 tok)');
        let verdict = { verdict: issues.length ? 'REVISE' : 'PASS', score: issues.length ? 5 : 9, reason: issues.length ? '정적 검사 결함' : '정적 검사 통과', fixes: issues.slice(0, 3), source: 'static' };
        if (useCritic) {
          try {
            const r = await roles.callOnce('critic', {
              messages: [{ role: 'user', content: `[원래 요청]\n${input}\n\n[담당 AI]\n${cfg.categories[category].label}\n\n[검수 회차]\n${round}\n\n${prevFixes.length ? `[이전 수정 지시]\n${prevFixes.map((f, i) => `${i + 1}. ${f}`).join('\n')}\n\n` : ''}[산출물]\n${final.slice(0, 24000)}` }],
              json: CRITIC_SCHEMA, signal, onRoute,
            });
            const j = parseJson(r.content);
            if (j && (j.verdict === 'PASS' || j.verdict === 'REVISE')) {
              const fixes = [...issues, ...(j.verdict === 'REVISE' ? (j.fixes || []) : [])].map((f) => String(f).replace(/^\s*\d+[.)]\s*/, '')).slice(0, 3);
              verdict = { verdict: issues.length ? 'REVISE' : j.verdict, score: issues.length ? Math.min(j.score ?? 6, 6) : (j.score ?? 0), reason: issues.length ? `정적 검사 결함 + ${j.reason || ''}` : (j.reason || ''), fixes: issues.length || j.verdict === 'REVISE' ? fixes : [], source: issues.length ? 'critic+static' : 'critic' };
            } else log('warn', 'critic 출력 해석 실패 → 정적 검사 결과만 사용');
          } catch (e) { if (signal?.aborted) throw e; log('warn', `critic 실패 → 정적 검사 결과만 사용: ${e.message}`); }
        }
        rounds.push({ round, ...verdict });
        log(verdict.verdict === 'PASS' ? 'ok' : 'warn', `${useCritic ? 'critic' : 'verify'} ${round}차 → ${verdict.verdict} (${verdict.score}/10 · ${verdict.source})${verdict.fixes.length ? ' · ' + verdict.fixes.join(' / ') : ''}`);
        stage(useCritic ? 'critic' : 'verify', 'done', { round, ...verdict });
        const limit = useCritic ? maxRev : Math.min(1, maxRev);
        if (verdict.verdict === 'PASS' || revisions >= limit) break;
        revisions++;
        stage('revise', 'start', { round: revisions });
        final = await generate([...ctx, { role: 'user', content: `[원래 요청]\n${input}\n\n[직전 산출물]\n${final}\n\n[검수 피드백 - 아래 항목만 고치세요]\n${verdict.fixes.map((f, i) => `${i + 1}. ${f}`).join('\n')}\n\n지적된 항목만 고치고 나머지는 유지한 채, 결과물 전체를 생략 없이 다시 출력하십시오.` }], 'revise');
        stage('revise', 'done', { round: revisions });
        prevFixes = verdict.fixes;
      }
    }

    // ---------- GATE ----------
    let gate = { escalated: false };
    const last = rounds[rounds.length - 1];
    if (steps.includes('gate')) {
      stage('gate');
      if (last?.verdict === 'REVISE' && (await roles.plan('escalate')).length) {
        log('warn', `gate 미해결 → escalate 역할(상위 엔진)로 1회 승격`);
        try {
          final = await (async () => {
            emit('draft', { kind: 'escalate', reset: true });
            const r = await roles.call('escalate', { messages: [...ctx, { role: 'user', content: `[원래 요청]\n${input}\n\n[현재 산출물]\n${final.slice(0, 30000)}\n\n[미해결 문제]\n${last.fixes.join('\n')}\n\n문제를 해결한 최종본을 생략 없이 작성하십시오.` }], signal, onRoute, onDelta: (d) => d.content && emit('token', { text: d.content, kind: 'escalate' }) });
            return r.content;
          })();
          gate = { escalated: true };
        } catch (e) { if (signal?.aborted) throw e; log('warn', `escalate 실패 → 현재 결과 유지: ${e.message}`); }
      } else log('ok', last?.verdict === 'REVISE' ? 'gate 승격 엔진 없음 → 현재 결과로 확정 (남은 이슈 기록)' : 'gate 통과');
      stage('gate', 'done', gate);
    }

    // ---------- RENDER ----------
    stage('render');
    const files = toFiles(extractCode(final));
    const finalIssues = staticCheck(final, category);
    const snapshot = buildSnapshot({ input, category, rounds, revisions, final, issues: finalIssues, route });
    const result = { runId, sessionId: sid, category, label: cfg.categories[category].label, pipeline, final, thinking: undefined, files, rounds, revisions, gate, route, snapshot, issues: finalIssues, ms: Date.now() - t0 };
    store.addMessage(sid, 'user', input);
    store.addMessage(sid, 'assistant', final, { runId, category, files: files.map((f) => f.name) });
    store.setSnapshot(sid, snapshot);
    store.cachePut(key, { category, label: result.label, pipeline, final, files, rounds, revisions, snapshot, route }, cfg.limits.cacheTtlSec || 86400);
    store.finishRun(runId, { category, pipeline, status: 'done', route, result: { files: files.map((f) => f.name), rounds, revisions, issues: finalIssues }, ms: result.ms });
    log('ok', `render 완료 · 파일 ${files.length}개 · ${(result.ms / 1000).toFixed(1)}s`);
    stage('render', 'done', { files: files.map((f) => f.name) });
    emit('done', result);
    return result;
  } catch (e) {
    const aborted = signal?.aborted;
    log(aborted ? 'warn' : 'error', aborted ? '사용자 중단' : `실패: ${e.message}`);
    store.finishRun(runId, { category, pipeline, status: aborted ? 'aborted' : 'error', route, result: { error: e.message }, ms: Date.now() - t0 });
    emit('error', { runId, message: aborted ? '중단됨' : e.message });
    throw e;
  }
}
