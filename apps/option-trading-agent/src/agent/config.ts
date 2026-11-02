import { resolve } from 'node:path';

export const OPTION_AGENT_TOOL_NAMES = Object.freeze({
  read: 'read', hello: 'hello', dailyBars: 'get_daily_bars', optionChain: 'get_option_chain', contract: 'get_contract',
} as const);
export const OPTION_AGENT_TOOLS: readonly string[] = Object.freeze(Object.values(OPTION_AGENT_TOOL_NAMES));

export interface Config {
  piBin: string;
  model: string;
  cwd: string;
  extension: string;
  skills: string;
  timeoutMs: number;
  requestTimeoutMs: number;
  shutdownGraceMs: number;
  maxLineBytes: number;
  env: NodeJS.ProcessEnv;
}

export function assertModel(model: string): void {
  if (typeof model !== 'string' || /(?:^|\/)anthropic(?:\/|$)/i.test(model)) {
    throw new Error('OPTION_AGENT_MODEL must use a non-anthropic provider-qualified model.');
  }
  if (!/^[a-z0-9_-]+\/[^\s/\x00-\x1f\x7f]+(?:\/[^\s/\x00-\x1f\x7f]+)*$/i.test(model)) {
    throw new Error('OPTION_AGENT_MODEL must be provider-qualified.');
  }
}

export function loadConfig(appDirectory: string, env: NodeJS.ProcessEnv = process.env): Config {
  const model = (env.OPTION_AGENT_MODEL ?? 'openai-codex/gpt-6.1-sol').trim();
  assertModel(model);
  const integer = (name: string, fallback: number, max: number): number => {
    const value = env[name] === undefined ? fallback : Number(env[name]);
    if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`Invalid ${name}.`);
    return value;
  };
  const snapshot = { ...env };
  delete snapshot.POLYGON_API_KEY;
  delete snapshot.MARKET_DATA_ENV_FILE;
  return {
    piBin: env.OPTION_AGENT_PI_BIN || 'pi',
    model,
    cwd: resolve(appDirectory),
    extension: resolve(appDirectory, 'extensions/option-agent'),
    skills: resolve(appDirectory, 'skills'),
    timeoutMs: integer('OPTION_AGENT_TIMEOUT_MS', 180000, 600000),
    requestTimeoutMs: integer('OPTION_AGENT_REQUEST_TIMEOUT_MS', 10000, 60000),
    shutdownGraceMs: integer('OPTION_AGENT_SHUTDOWN_GRACE_MS', 200, 2000),
    maxLineBytes: integer('OPTION_AGENT_MAX_LINE_BYTES', 1048576, 4194304),
    env: snapshot,
  };
}

export function childEnv(config: Config, extraEnv: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...config.env, ...extraEnv, PI_OFFLINE: '1', PI_TELEMETRY: '0' };
  delete env.POLYGON_API_KEY;
  delete env.MARKET_DATA_ENV_FILE;
  return env;
}

export function piArgs(config: Config): string[] {
  assertModel(config.model);
  for (const [value, max] of [[config.timeoutMs, 600000], [config.requestTimeoutMs, 60000], [config.shutdownGraceMs, 2000], [config.maxLineBytes, 4194304]]) {
    if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error('Invalid Pi process limits.');
  }
  return [
    '--mode', 'rpc', '--no-extensions', '--model', config.model, '-e', config.extension,
    '--no-skills', '--skill', config.skills, '--no-session', '--no-context-files',
    '--no-prompt-templates', '--no-mcp', '--offline', '--no-approve', '--no-themes',
    '--tools', OPTION_AGENT_TOOLS.join(','),
    '--system-prompt', 'You are an options trading advice assistant. Follow the explicitly selected option-agent skills. Give advice only. Never place orders, access brokerage accounts, or claim to execute trades. Use only the explicitly configured tools. Never use shell, edit, or write tools. Never invent market data. Distinguish facts, missing data, and assumptions.',
    '--append-system-prompt', '',
  ];
}
