import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MarketData } from '../src/business/market-data/client.ts';
import { decodeDataResult, parseDate, parseSymbol } from '../src/business/market-data/normalize.ts';
import type { ContractQuery, DailyBar, DailyBarsQuery, DataResult, OptionChainQuery, OptionSnapshot } from '../src/business/types.ts';

const artifactsDir = fileURLToPath(new URL('../artifacts/', import.meta.url));
const defaultArtifactPath = join(artifactsDir, 'massive-probe.json');
const nyDate = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
});
const safeIssues = new Set([
  'Market data credentials are unavailable.', 'Market data HTTP request budget exhausted.',
  'Provider data is unavailable.', 'Provider HTTP request failed.', 'Provider request or response failed.',
  'Provider request timed out.', 'Provider redirect rejected.', 'Provider response size limit exceeded.',
  'Missing provider response body.', 'Malformed provider payload.', 'Invalid market data result.',
  'Provider response is incomplete.', 'Additional provider pages remain.', 'Provider page limit reached.',
  'Unsafe or repeated provider pagination stopped.', 'Provider row limit reached.',
  'Invalid provider row omitted.', 'No valid provider rows.', 'Insufficient daily history.',
  'Duplicate daily session omitted.', 'Bar volume is missing or invalid.',
  'Crossed option quote omitted.', 'Desired option quote fields are missing or invalid.',
  'Option volume is missing or invalid.', 'Option quote time is missing or invalid.',
  'Market data cache write failed.', 'Provider reported an error.', 'Unrecognized provider status.',
  'Invalid provider contract identity.', 'Provider symbol does not match query.',
  'Provider daily sessions do not match requested date range.',
]);

type ProbeClient = Pick<MarketData, 'dailyBars' | 'optionChain' | 'contract' | 'httpRequests'>;
type Checkpoint = {
  status: 'not-run' | 'usable' | 'unusable';
  httpRequests: number;
  reason: 'dependency-unusable' | 'usable-rows' | 'no-usable-rows' | 'credentials-unavailable'
    | 'invalid-result' | 'request-failed' | 'budget-exhausted';
};
type MissingOptionFields = Record<'bid' | 'ask' | 'iv' | 'delta' | 'gamma' | 'theta' | 'vega'
  | 'openInterest' | 'volume' | 'quotedAt', number>;

export interface ProbeArtifact {
  status: 'ok' | 'partial' | 'failed';
  timestamp: string;
  httpRequests: number;
  maxHttpRequests: 3;
  maxPages: 1;
  query: { daily: DailyBarsQuery; chain: OptionChainQuery | null; contract: ContractQuery | null };
  results: { daily: DataResult<DailyBar> | null; chain: DataResult<OptionSnapshot> | null; contract: DataResult<OptionSnapshot> | null };
  checkpoints: Record<'daily' | 'chain' | 'contract', Checkpoint>;
  missingFields: { daily: { volume: number }; chain: MissingOptionFields; contract: MissingOptionFields };
  quoteFields: 'not-observed' | 'complete' | 'missing-possibly-entitlement-limited';
  limitations: string[];
}

export function nextFriday(now: number): string {
  const date = new Date(`${nyDate.format(now)}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + (5 - date.getUTCDay() + 7) % 7);
  return date.toISOString().slice(0, 10);
}

export function parseProbeArgs(args: readonly string[]):
  | { kind: 'disabled' }
  | { kind: 'invalid' }
  | { kind: 'run'; symbol: string; expiry?: string } {
  if (!args.includes('--run')) return { kind: 'disabled' };
  try {
    const seen = new Set<string>();
    let symbol = 'AAPL';
    let expiry: string | undefined;
    for (let index = 0; index < args.length; index++) {
      const flag = args[index];
      if (seen.has(flag)) return { kind: 'invalid' };
      seen.add(flag);
      if (flag === '--run') continue;
      if (flag === '--symbol') symbol = parseSymbol(args[++index]);
      else if (flag === '--expiry') expiry = parseDate(args[++index]);
      else return { kind: 'invalid' };
    }
    return { kind: 'run', symbol, ...(expiry === undefined ? {} : { expiry }) };
  } catch {
    return { kind: 'invalid' };
  }
}

function missingOptionFields(rows: readonly OptionSnapshot[]): MissingOptionFields {
  const counts: MissingOptionFields = { bid: 0, ask: 0, iv: 0, delta: 0, gamma: 0, theta: 0, vega: 0,
    openInterest: 0, volume: 0, quotedAt: 0 };
  for (const row of rows) {
    for (const field of ['bid', 'ask', 'iv', 'openInterest', 'volume', 'quotedAt'] as const) {
      if (row[field] === null) counts[field]++;
    }
    for (const field of ['delta', 'gamma', 'theta', 'vega'] as const) {
      if (row.greeks[field] === null) counts[field]++;
    }
  }
  return counts;
}

function sanitizeIssues<T>(result: DataResult<T>): DataResult<T> {
  return { ...result, issues: [...new Set(result.issues.map(issue =>
    safeIssues.has(issue) ? issue : 'Unclassified market data issue.'))] };
}

function usable<T>(result: DataResult<T>): boolean {
  return (result.status === 'ok' || result.status === 'partial') && result.rows.length > 0;
}

export async function runProbe({ client, symbol = 'AAPL', expiry, now = Date.now, artifactPath = defaultArtifactPath }: {
  client: ProbeClient;
  symbol?: string;
  expiry?: string;
  now?: () => number;
  artifactPath?: string;
}): Promise<{ artifact: ProbeArtifact; artifactPath: string; exitCode: 0 | 1 }> {
  const timestamp = now();
  const skipped = (): Checkpoint => ({ status: 'not-run', httpRequests: 0, reason: 'dependency-unusable' });
  const artifact: ProbeArtifact = {
    status: 'failed', timestamp: new Date(timestamp).toISOString(), httpRequests: 0, maxHttpRequests: 3, maxPages: 1,
    query: { daily: { symbol: parseSymbol(symbol), days: 20 }, chain: null, contract: null },
    results: { daily: null, chain: null, contract: null },
    checkpoints: { daily: skipped(), chain: skipped(), contract: skipped() },
    missingFields: { daily: { volume: 0 }, chain: missingOptionFields([]), contract: missingOptionFields([]) },
    quoteFields: 'not-observed',
    limitations: [
      'Manual observation only. No orders or model calls.',
      'At most three actual HTTP attempts, including failed attempts. No retries. One page per query.',
      'The default expiry is the same or next New York calendar Friday, not a holiday-adjusted trading date. Use --expiry for a known holiday exception.',
      'The chain is restricted to last daily close plus or minus one percent. Remaining pages are not fetched.',
      'Missing quote fields may reflect provider entitlements or absent market data. This probe cannot confirm the cause.',
      'A partial result passes only when normalized rows remain usable. Daily history may contain fewer than twenty sessions or a provisional session.',
      'Holidays and Treasury rates are not probed because they would exceed the request budget.',
    ],
  };
  let stage: 'daily' | 'chain' | 'contract' = 'daily';
  try {
    const selectedExpiry = expiry === undefined ? nextFriday(timestamp) : parseDate(expiry);
    if (selectedExpiry < nyDate.format(timestamp)) throw new Error('Past expiry.');
    if (client.httpRequests !== 0) throw new Error('Probe requires an unused client.');
    const observe = <T>(result: DataResult<T>): boolean => {
      const valid = usable(result);
      artifact.checkpoints[stage] = { status: valid ? 'usable' : 'unusable', httpRequests: client.httpRequests,
        reason: valid ? 'usable-rows' : result.issues.includes('Market data credentials are unavailable.')
          ? 'credentials-unavailable' : 'no-usable-rows' };
      return valid;
    };
    const budgetAvailable = (): boolean => {
      if (client.httpRequests < 3) return true;
      artifact.checkpoints[stage] = { status: 'not-run', httpRequests: client.httpRequests, reason: 'budget-exhausted' };
      return false;
    };
    const daily = sanitizeIssues(decodeDataResult('dailyBars', await client.dailyBars(artifact.query.daily)));
    artifact.results.daily = daily;
    if (!observe(daily)) return await finish();
    if (daily.rows.some(row => row.symbol !== artifact.query.daily.symbol)) throw new Error('Mismatched symbol.');
    const last = daily.rows.reduce<DailyBar | null>((latest, row) => latest === null || row.date > latest.date ? row : latest, null);
    if (last === null || last.close <= 0) throw new Error('No last close.');
    stage = 'chain';
    const chainQuery: OptionChainQuery = { symbol: artifact.query.daily.symbol, expiry: selectedExpiry,
      strikeRange: { min: last.close * 0.99, max: last.close * 1.01 } };
    artifact.query.chain = chainQuery;
    if (!budgetAvailable()) return await finish();
    const chain = sanitizeIssues(decodeDataResult('optionChain', await client.optionChain(chainQuery)));
    artifact.results.chain = chain;
    if (!observe(chain)) return await finish();
    const first = chain.rows.find(row => row.symbol === chainQuery.symbol && row.expiry === selectedExpiry
      && row.strike >= last.close * 0.99 && row.strike <= last.close * 1.01);
    if (!first) throw new Error('No matching option.');
    stage = 'contract';
    const contractQuery = { occ: first.occ };
    artifact.query.contract = contractQuery;
    if (!budgetAvailable()) return await finish();
    const contract = sanitizeIssues(decodeDataResult('contract', await client.contract(contractQuery)));
    artifact.results.contract = contract;
    if (!observe(contract)) return await finish();
    if (contract.rows[0]?.occ !== first.occ) throw new Error('Mismatched contract.');
    artifact.status = [daily, chain, contract].some(result => result.status === 'partial') ? 'partial' : 'ok';
  } catch {
    artifact.checkpoints[stage] = { status: 'unusable', httpRequests: client.httpRequests,
      reason: artifact.results[stage] === null ? 'request-failed' : 'invalid-result' };
  }
  return await finish();

  async function finish() {
    artifact.httpRequests = client.httpRequests;
    artifact.missingFields = {
      daily: { volume: artifact.results.daily?.rows.filter(row => row.volume === null).length ?? 0 },
      chain: missingOptionFields(artifact.results.chain?.rows ?? []),
      contract: missingOptionFields(artifact.results.contract?.rows ?? []),
    };
    if ((artifact.results.chain?.rows.length ?? 0) + (artifact.results.contract?.rows.length ?? 0) > 0) {
      artifact.quoteFields = Object.values(artifact.missingFields.chain).some(count => count > 0)
        || Object.values(artifact.missingFields.contract).some(count => count > 0)
        ? 'missing-possibly-entitlement-limited' : 'complete';
    }
    await mkdir(dirname(artifactPath), { recursive: true });
    const temporaryPath = `${artifactPath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify(artifact, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
      await rename(temporaryPath, artifactPath);
    } finally {
      await rm(temporaryPath, { force: true });
    }
    return { artifact, artifactPath, exitCode: artifact.status === 'failed' ? 1 : 0 } satisfies {
      artifact: ProbeArtifact; artifactPath: string; exitCode: 0 | 1;
    };
  }
}

export async function main(args: readonly string[], { artifactPath = defaultArtifactPath }: {
  artifactPath?: string;
} = {}): Promise<{ summary: string; exitCode: number }> {
  const parsed = parseProbeArgs(args);
  if (parsed.kind !== 'run') return { exitCode: parsed.kind === 'invalid' ? 2 : 0,
    summary: `status=${parsed.kind} httpRequests=0 rows=0 missingFields=0 artifact=none` };
  let client: ProbeClient | null = null;
  try {
    client = new MarketData({ maxHttpRequests: 3, maxPages: 1,
      cacheDir: join(dirname(artifactPath), `massive-probe-cache-${randomUUID()}`) });
    const { artifact, exitCode } = await runProbe({ client, symbol: parsed.symbol, expiry: parsed.expiry, artifactPath });
    const rows = { daily: artifact.results.daily?.rows.length ?? 0, chain: artifact.results.chain?.rows.length ?? 0,
      contract: artifact.results.contract?.rows.length ?? 0 };
    return { exitCode, summary: `status=${artifact.status} httpRequests=${artifact.httpRequests} rows=${JSON.stringify(rows)} missingFields=${JSON.stringify(artifact.missingFields)} artifact=${artifactPath}` };
  } catch {
    return { exitCode: 1, summary: `status=artifact-write-failed httpRequests=${client?.httpRequests ?? 0} rows=unknown missingFields=unknown artifact=${artifactPath}` };
  }
}

if (import.meta.main) {
  const result = await main(process.argv.slice(2));
  process.stdout.write(`${result.summary}\n`);
  process.exitCode = result.exitCode;
}
