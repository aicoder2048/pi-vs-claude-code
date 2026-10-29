import { describe, expect, test } from 'bun:test';
import { DEFAULT_MODEL_ID, selectStartupModel } from '../src/agent/model-selection';
const claude = { provider: 'anthropic', id: 'claude-sonnet-4-5', name: 'Claude Sonnet' };
const sol = { provider: 'openai-codex', id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol' };
describe('requested default model', () => {
  test('gpt-6.1-sol wins regardless of catalog ordering', () => {
    expect(DEFAULT_MODEL_ID).toBe('gpt-6.1-sol');
    expect(selectStartupModel([claude, sol])).toEqual({ model: sol, error: null });
  });
  test('prefers the configured Codex provider when the ID exists more than once', () => {
    expect(selectStartupModel([{ ...sol, provider: 'openai' }, sol]).model?.provider).toBe('openai-codex');
    expect(selectStartupModel([{ ...sol, provider: 'custom' }]).model?.provider).toBe('custom');
  });
  test('matches the exact model ID, not a similar name or prefix', () => {
    const result = selectStartupModel([claude, { ...sol, id: 'gpt-6.1-sol-preview' }]);
    expect(result.model).toBeNull(); expect(result.error).toContain('gpt-6.1-sol');
  });
  test('missing default never silently switches to Claude or any other model', () => {
    expect(selectStartupModel([claude]).model).toBeNull();
    expect(selectStartupModel([]).model).toBeNull();
    expect(selectStartupModel([claude]).error).toContain('不会自动切换');
  });
  test('an explicit valid override is respected, including IDs containing slashes', () => {
    const custom = { provider: 'router', id: 'org/model', name: 'Custom' };
    expect(selectStartupModel([claude, sol, custom], 'router/org/model')).toEqual({ model: custom, error: null });
    expect(selectStartupModel([claude, sol], 'anthropic/claude-sonnet-4-5').model).toEqual(claude);
  });
  test('an invalid explicit override is reported without automatic substitution', () => {
    const result = selectStartupModel([claude, sol], 'missing/model');
    expect(result.model).toBeNull(); expect(result.error).toContain('missing/model');
  });
});
