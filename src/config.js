// 설정 로드: darkcode.config.json (+ DC_CONFIG 경로) + ${ENV} 치환 + DC_PROFILE 덮어쓰기 + 검증
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadDotEnv() {
  const p = path.join(ROOT, '.env');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

function substEnv(v) {
  if (typeof v === 'string') return v.replace(/\$\{([A-Z0-9_]+)\}/gi, (_, k) => process.env[k] ?? '');
  if (Array.isArray(v)) return v.map(substEnv);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, substEnv(x)]));
  return v;
}

export function loadConfig(file = process.env.DC_CONFIG || path.join(ROOT, 'darkcode.config.json')) {
  loadDotEnv();
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const cfg = substEnv(raw);
  if (process.env.DC_PROFILE) cfg.profile = process.env.DC_PROFILE;
  if (process.env.DC_PORT) cfg.server.port = Number(process.env.DC_PORT);
  if (process.env.DC_HOST) cfg.server.host = process.env.DC_HOST;

  const errors = [];
  for (const [id, e] of Object.entries(cfg.engines || {})) {
    if (!['ollama', 'openai', 'acestep'].includes(e.type)) errors.push(`engines.${id}.type 은 ollama | openai | acestep`);
    if (e.enabled && !e.baseUrl) { e.enabled = false; e.disabledReason = 'baseUrl 비어 있음 (환경변수 미설정)'; }
    // launch.cwd 가 환경변수로 비어 있으면 자동 기동만 끄고 엔진은 유지 (사용자가 직접 띄운 서버는 그대로 사용)
    if (e.launch && 'cwd' in e.launch && !e.launch.cwd) delete e.launch;
    if (e.pool && !cfg.pools?.[e.pool]) errors.push(`engines.${id}.pool "${e.pool}" 이 pools 에 없음`);
  }
  for (const [role, list] of Object.entries(cfg.roles || {})) {
    for (const c of list) {
      if (!cfg.engines[c.engine]) errors.push(`roles.${role}: 없는 엔진 "${c.engine}"`);
      if (c.system) {
        const p = path.join(ROOT, c.system);
        if (!fs.existsSync(p)) errors.push(`roles.${role}: 시스템 프롬프트 파일 없음 ${c.system}`);
        else c.systemText = fs.readFileSync(p, 'utf8').trim();
      }
    }
  }
  for (const [cat, c] of Object.entries(cfg.categories || {})) {
    if (!cfg.pipelines[c.pipeline]) errors.push(`categories.${cat}.pipeline "${c.pipeline}" 없음`);
    if (!cfg.roles[`implementer.${cat}`]) errors.push(`categories.${cat}: roles["implementer.${cat}"] 필요`);
  }
  if (errors.length) throw new Error('설정 오류:\n- ' + errors.join('\n- '));
  cfg.storage.path = path.resolve(ROOT, cfg.storage.path);
  return cfg;
}
