import type { ModelChoice } from '../shared/types';

export const DEFAULT_MODEL_ID = 'gpt-6.1-sol';

// An explicit user override wins. Without one, never silently pick Claude (or
// another model) just because the requested default is missing from the catalog.
export function selectStartupModel(models: readonly ModelChoice[], override?: string): { model: ModelChoice | null; error: string | null } {
  if (override) {
    const model = models.find(m => `${m.provider}/${m.id}` === override) ?? null;
    return { model, error: model ? null : `指定模型 ${override} 不可用，请从模型列表手动选择。` };
  }
  const matches = models.filter(m => m.id === DEFAULT_MODEL_ID);
  const model = matches.find(m => m.provider === 'openai-codex') ?? matches.find(m => m.provider === 'openai') ?? matches[0] ?? null;
  return { model, error: model ? null : `默认模型 ${DEFAULT_MODEL_ID} 不可用，请配置该模型或从列表手动选择；不会自动切换到其他模型。` };
}
