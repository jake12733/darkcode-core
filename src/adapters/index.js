import { OllamaAdapter } from './ollama.js';
import { OpenAIAdapter } from './openai.js';

export function createAdapter(id, cfg, opts) {
  if (cfg.type === 'ollama') return new OllamaAdapter(id, cfg, opts);
  if (cfg.type === 'openai') return new OpenAIAdapter(id, cfg, opts);
  throw new Error(`알 수 없는 엔진 타입: ${cfg.type}`);
}
export { collect, EngineError } from './base.js';
