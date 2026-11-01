import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { childEnv, piArgs, type Config } from './config.ts';
import { JsonlDecoder, type RpcRecord } from './jsonl.ts';

interface Pending {
  command: string;
  resolve(record: RpcRecord): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

type Connection =
  | { kind: 'new' }
  | { kind: 'running'; child: ChildProcessWithoutNullStreams; config: Readonly<Config> }
  | { kind: 'closing'; child: ChildProcessWithoutNullStreams; config: Readonly<Config>; error: Error }
  | { kind: 'closed'; error: Error };

export class PiProcess {
  private connection: Connection = { kind: 'new' };
  private sequence = 0;
  private readonly pending = new Map<string, Pending>();
  private writes: Promise<void> = Promise.resolve();
  private closed: Promise<void> = Promise.resolve();
  private shutdown: Promise<void> | undefined;
  private stderr = Buffer.alloc(0);

  constructor(private readonly config: Config, private readonly receive: (record: RpcRecord) => void) {}

  start(extraEnv: NodeJS.ProcessEnv = {}): void {
    if (this.connection.kind !== 'new') throw new Error('PiProcess can only start once.');
    const config = { ...this.config, env: { ...this.config.env } };
    const args = piArgs(config);
    const decoder = new JsonlDecoder(record => this.onRecord(record), config.maxLineBytes);
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(config.piBin, args, {
        cwd: config.cwd, shell: false, stdio: ['pipe', 'pipe', 'pipe'], env: childEnv(config, extraEnv),
      });
    } catch { throw new Error('Cannot start Pi executable.'); }
    this.connection = { kind: 'running', child, config };
    this.closed = new Promise(resolve => child.once('close', (code, signal) => {
      this.fail(new Error(`Pi exited (${signal ?? code}). ${this.stderr.toString('utf8')}`));
      resolve();
    }));
    child.stdout.on('data', (chunk: Buffer) => {
      if (this.connection.kind !== 'running') return;
      try { decoder.push(chunk); } catch { this.fail(new Error('Invalid Pi RPC record.')); }
    });
    child.stdout.on('end', () => {
      if (this.connection.kind !== 'running') return;
      try { decoder.end(); } catch { this.fail(new Error('Pi stdout ended with an unterminated JSONL record.')); return; }
      this.fail(new Error(`Pi stdout closed. ${this.stderr.toString('utf8')}`));
    });
    child.stderr.on('data', (chunk: Buffer) => {
      this.stderr = Buffer.concat([this.stderr, chunk.subarray(-8192)]).subarray(-8192);
    });
    child.stdin.on('error', () => this.fail(new Error('Pi stdin failed.')));
    child.on('error', () => this.fail(new Error('Cannot start Pi executable.')));
  }

  private onRecord(record: RpcRecord): void {
    if (this.connection.kind !== 'running') return;
    if (typeof record.type !== 'string' || !record.type) throw new Error('Pi record requires a type.');
    if (record.type === 'response') {
      if (typeof record.command !== 'string' || typeof record.success !== 'boolean') throw new Error('Invalid Pi response.');
      const pending = typeof record.id === 'string' ? this.pending.get(record.id) : undefined;
      if (!pending) {
        if (!record.success) throw new Error('Unmatched Pi error.');
        return;
      }
      if (record.command !== pending.command) throw new Error('Pi response does not match request.');
      clearTimeout(pending.timer);
      if (typeof record.id === 'string') this.pending.delete(record.id);
      if (record.success) pending.resolve(record);
      else pending.reject(new Error(typeof record.error === 'string' ? record.error : 'Pi command failed.'));
    }
    if (record.type === 'extension_ui_request' && ['select', 'confirm', 'input', 'editor'].includes(String(record.method))) {
      if (typeof record.id !== 'string' || !record.id) throw new Error('Pi UI request requires an ID.');
      void this.write({ type: 'extension_ui_response', id: record.id, cancelled: true })
        .catch(() => this.fail(new Error('Cannot cancel Pi UI request.')));
    }
    this.receive(record);
  }

  private fail(error: Error): void {
    if (this.connection.kind !== 'running') return;
    void this.beginShutdown(error);
    this.receive({ type: 'rpc_error', error: error.message });
  }

  private write(record: RpcRecord, closing = false): Promise<void> {
    const connection = this.connection;
    if (connection.kind !== 'running' && !(closing && connection.kind === 'closing')) return Promise.reject(new Error('Pi is not connected.'));
    let line: string;
    try {
      line = `${JSON.stringify(record)}\n`;
      if (Buffer.byteLength(line) - 1 > connection.config.maxLineBytes) throw new Error('RPC command exceeds byte limit.');
    } catch {
      return Promise.reject(new Error('RPC command must be bounded JSON.'));
    }
    const next = this.writes.then(() => new Promise<void>((resolve, reject) => {
      const connection = this.connection;
      if (connection.kind !== 'running' && !(closing && connection.kind === 'closing')) {
        reject(new Error('Pi is not connected.'));
        return;
      }
      if (!connection.child.stdin.writable) { reject(new Error('Pi stdin is closed.')); return; }
      connection.child.stdin.write(line, error => error ? reject(new Error('Pi stdin failed.')) : resolve());
    }));
    this.writes = next.catch(() => {});
    return next;
  }

  request(command: RpcRecord, timeoutMs?: number): Promise<RpcRecord> {
    const connection = this.connection;
    if (connection.kind !== 'running') {
      return Promise.reject(connection.kind === 'new' ? new Error('Pi is not connected.') : connection.error);
    }
    if (typeof command.type !== 'string' || !command.type) return Promise.reject(new Error('RPC command requires a type.'));
    const timeout = timeoutMs ?? connection.config.requestTimeoutMs;
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 60000) return Promise.reject(new Error('Invalid RPC timeout.'));
    const type = command.type;
    const id = `option-agent-${++this.sequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new Error('Pi request timed out.')), timeout);
      this.pending.set(id, { command: type, resolve, reject, timer });
      void this.write({ ...command, id }).catch(() => this.fail(new Error('Cannot write Pi RPC command.')));
    });
  }

  stop(): Promise<void> {
    return this.beginShutdown(new Error('Pi stopped.'));
  }

  private beginShutdown(error: Error): Promise<void> {
    if (this.shutdown) return this.shutdown;
    const connection = this.connection;
    if (connection.kind !== 'running') {
      this.connection = { kind: 'closed', error };
      return this.shutdown = Promise.resolve();
    }
    this.connection = { kind: 'closing', child: connection.child, config: connection.config, error };
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    return this.shutdown = this.stopChild(connection.child, connection.config.shutdownGraceMs).finally(() => { this.connection = { kind: 'closed', error }; });
  }

  private async stopChild(child: ChildProcessWithoutNullStreams, grace: number): Promise<void> {
    await this.within(this.write({ type: 'abort', id: 'option-agent-stop' }, true).catch(() => {}), grace);
    child.stdin.end();
    if (await this.within(this.closed, grace)) return;
    child.kill('SIGTERM');
    if (await this.within(this.closed, grace)) return;
    child.kill('SIGKILL');
    if (await this.within(this.closed, grace)) return;
    child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); child.unref();
  }

  private async within(promise: Promise<void>, ms: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([promise.then(() => true), new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), ms); })]);
    } finally { clearTimeout(timer); }
  }
}
