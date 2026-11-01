import { describe, expect, test } from 'bun:test';
import { parseDesktopCommand } from '../src/desktop.ts';

describe('desktop IPC command boundary', () => {
  test('parses only question, stop and restart commands', () => {
    expect(parseDesktopCommand({ kind: 'ask', text: '  中文\nhello  ' })).toEqual({ kind: 'ask', text: '中文\nhello' });
    expect(parseDesktopCommand({ kind: 'stop' })).toEqual({ kind: 'stop' });
    expect(parseDesktopCommand({ kind: 'restart' })).toEqual({ kind: 'restart' });
  });

  test.each([
    undefined, null, [], true, 3, 'stop', {},
    { kind: 'view' }, { kind: 'prompt', message: 'hello' }, { kind: 'echo', text: 'hello' },
    { kind: 'ask' }, { kind: 'ask', text: 3 }, { kind: 'ask', text: '' },
    { kind: 'ask', text: ' \n\t ' }, { kind: 'ask', text: 'unsafe\0text' },
    { kind: 'ask', text: 'a'.repeat(16001) },
    { kind: 'ask', text: 'hello', model: 'other/model' },
    { kind: 'ask', text: 'hello', requestId: 'forged' },
    { kind: 'restart', env: { OPTION_AGENT_PI_BIN: '/tmp/other' } },
    { kind: 'stop', text: 'extra' }, { type: 'get_state' },
  ].map(value => ({ value })))('rejects malformed or non-allowlisted input %#', ({ value }) => {
    expect(() => parseDesktopCommand(value)).toThrow();
  });

  test('accepts the exact text bound and does not mutate the input', () => {
    const value = Object.freeze({ kind: 'ask', text: 'a'.repeat(16000) });
    expect(parseDesktopCommand(value)).toEqual(value);
    expect(parseDesktopCommand({ kind: 'ask', text: '漢'.repeat(16000) })).toEqual({ kind: 'ask', text: '漢'.repeat(16000) });
  });
});
