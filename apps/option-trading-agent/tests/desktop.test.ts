import { describe, expect, test } from 'bun:test';
import { parseDesktopCommand } from '../src/desktop.ts';

describe('desktop IPC command boundary', () => {
  test('parses question, stop and restart commands', () => {
    expect(parseDesktopCommand({ kind: 'ask', text: '  中文\nhello  ' })).toEqual({ kind: 'ask', text: '中文\nhello' });
    expect(parseDesktopCommand({ kind: 'stop' })).toEqual({ kind: 'stop' });
    expect(parseDesktopCommand({ kind: 'restart' })).toEqual({ kind: 'restart' });
  });

  test.each([
    undefined, null, [], true, 3, 'stop', {},
    { kind: 'view' }, { kind: 'prompt', message: 'hello' }, { kind: 'echo', text: 'hello' },
    { kind: 'market' },
    { kind: 'contract', occ: 'O:NIMB261106P00100000' },
    { kind: 'get_daily_bars', symbol: 'NIMB', days: 4 },
    { kind: 'command', action: 'market', query: { symbol: 'NIMB', days: 4 } },
    { kind: 'ask' }, { kind: 'ask', text: 3 }, { kind: 'ask', text: '' },
    { kind: 'ask', text: ' \n\t ' }, { kind: 'ask', text: 'unsafe\0text' },
    { kind: 'ask', text: 'a'.repeat(16001) },
    { kind: 'ask', text: 'hello', model: 'other/model' },
    { kind: 'ask', text: 'hello', requestId: 'forged' },
    { kind: 'ask', text: 'hello', selectedSymbol: 'FORGED' },
    { kind: 'ask', text: 'hello', currentDate: '2000-01-01' },
    { kind: 'ask', text: 'hello', query: { symbol: 'NIMB', days: 4 } },
    { kind: 'ask', text: 'hello', apiKey: 'forged' },
    { kind: 'restart', env: { OPTION_AGENT_PI_BIN: '/tmp/other' } },
    { kind: 'stop', text: 'extra' }, { type: 'get_state' },
  ].map(value => ({ value })))('rejects malformed or non-allowlisted input %#', ({ value }) => {
    expect(() => parseDesktopCommand(value)).toThrow();
  });

  test.each([
    { query: { symbol: 'nimb', days: 4 }, expected: { symbol: 'NIMB', days: 4 } },
    { query: { symbol: 'brk.b', days: 1 }, expected: { symbol: 'BRK.B', days: 1 } },
    { query: { symbol: 'ABC-1', days: 500 }, expected: { symbol: 'ABC-1', days: 500 } },
    { query: { symbol: 'nimb', days: 4, expiry: '2024-02-29' },
      expected: { symbol: 'NIMB', days: 4, expiry: '2024-02-29' } },
    { query: { symbol: 'nimb', days: 4, strikeRange: { min: 0, max: 100.5 } },
      expected: { symbol: 'NIMB', days: 4, strikeRange: { min: 0, max: 100.5 } } },
    { query: { symbol: 'nimb', days: 4, expiry: '2026-11-06', strikeRange: { min: 100, max: 100 } },
      expected: { symbol: 'NIMB', days: 4, expiry: '2026-11-06', strikeRange: { min: 100, max: 100 } } },
    { query: { symbol: 'nimb', days: 4, expiry: undefined, strikeRange: undefined },
      expected: { symbol: 'NIMB', days: 4 } },
  ])('normalizes a market query at the IPC boundary %#', ({ query, expected }) => {
    expect(parseDesktopCommand({ kind: 'market', query })).toEqual({ kind: 'market', query: expected });
  });

  test.each([
    undefined, null, [], true, 3, 'NIMB', {},
    { days: 4 }, { symbol: 'NIMB' },
    ...[null, 3, '', ' NIMB', 'NIMB ', 'A/B', '../NIMB', 'NIMB\0', 'NIMB\n', '股票',
      'ABCDEFGHIJKLMNOPQ'].map(symbol => ({ symbol, days: 4 })),
    ...[null, '4', true, 0, -1, 501, 1.5, NaN, Infinity, -Infinity]
      .map(days => ({ symbol: 'NIMB', days })),
    ...[null, 20261106, '', '2026-02-29', '2026-04-31', '2026-13-01', '2026-11-06T00:00:00Z']
      .map(expiry => ({ symbol: 'NIMB', days: 4, expiry })),
    ...[null, [], 100, '100-105', {}, { min: 100 }, { max: 105 },
      { min: 105, max: 100 }, { min: -1, max: 100 }, { min: 0, max: -1 },
      { min: '100', max: 105 }, { min: 100, max: '105' }, { min: null, max: 105 },
      { min: NaN, max: 105 }, { min: 100, max: Infinity }]
      .map(strikeRange => ({ symbol: 'NIMB', days: 4, strikeRange })),
  ].map(query => ({ query })))('rejects an invalid market query at the IPC boundary %#', ({ query }) => {
    expect(() => parseDesktopCommand({ kind: 'market', query })).toThrow();
  });

  test.each([
    { text: 'hello' }, { requestId: 'forged' }, { action: 'market' }, { selectedSymbol: 'FORGED' },
    { currentDate: '2000-01-01' }, { apiKey: 'forged' }, { model: 'other/model' },
    { env: { OPTION_AGENT_PI_BIN: '/tmp/other' } }, { extra: undefined },
  ])('rejects extra market command and query fields %#', extra => {
    const query = { symbol: 'NIMB', days: 4 };
    expect(() => parseDesktopCommand({ kind: 'market', query, ...extra })).toThrow();
    expect(() => parseDesktopCommand({ kind: 'market', query: { ...query, ...extra } })).toThrow();
    expect(() => parseDesktopCommand({ kind: 'market', query: {
      ...query, strikeRange: { min: 100, max: 105, ...extra },
    } })).toThrow();
  });

  test('normalizes a frozen market query without mutating or retaining input objects', () => {
    const strikeRange = Object.freeze({ min: 100, max: 105 });
    const query = Object.freeze({ symbol: 'nimb', days: 4, expiry: '2026-11-06', strikeRange });
    const value = Object.freeze({ kind: 'market', query });
    const command = parseDesktopCommand(value);
    expect(command).toEqual({ kind: 'market', query: { ...query, symbol: 'NIMB' } });
    expect(query.symbol).toBe('nimb');
    expect(command).not.toBe(value);
    if (command.kind !== 'market') throw new Error('Expected a market command.');
    expect(command.query).not.toBe(query);
    expect(command.query.strikeRange).not.toBe(strikeRange);
  });

  test('accepts the exact text bound and does not mutate the input', () => {
    const value = Object.freeze({ kind: 'ask', text: 'a'.repeat(16000) });
    expect(parseDesktopCommand(value)).toEqual(value);
    expect(parseDesktopCommand({ kind: 'ask', text: '漢'.repeat(16000) })).toEqual({ kind: 'ask', text: '漢'.repeat(16000) });
  });
});
