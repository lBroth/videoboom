// Local LLM adapter: wraps the on-device mlx-lm module into the LlmBackend interface. `role` is ignored
// (one local model serves both the story bible and the shot list).
import { llmJsonLocal } from '../../localLlm';
import type { LlmBackend } from '../types';

export const localLlm: LlmBackend = {
  llmJson(system, user, schema, _role, maxTokens, temperature) {
    return llmJsonLocal(system, user, schema, maxTokens, temperature);
  },
};
