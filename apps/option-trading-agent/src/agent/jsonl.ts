export type RpcRecord = Record<string, unknown>;

export class JsonlDecoder {
  private buffer = Buffer.alloc(0);
  private readonly utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

  constructor(private readonly receive: (record: RpcRecord) => void, private readonly maxLineBytes = 1048576) {
    if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes < 1) {
      throw new Error('RPC JSONL byte limit must be a positive safe integer.');
    }
  }

  push(chunk: Uint8Array): void {
    let from = 0;
    for (let index = 0; index < chunk.length; index++) {
      if (chunk[index] !== 10) continue;
      this.append(chunk.subarray(from, index));
      from = index + 1;
      let line = this.buffer;
      this.buffer = Buffer.alloc(0);
      if (line.at(-1) === 13) line = line.subarray(0, -1);
      if (line.length) {
        let record: unknown;
        try {
          const text = this.utf8.decode(line);
          if (/^[\t\r ]*$/.test(text)) continue;
          record = JSON.parse(text);
        } catch {
          throw new Error('RPC record must be valid UTF-8 JSON.');
        }
        if (!record || typeof record !== 'object' || Array.isArray(record)) {
          throw new Error('RPC record must be an object.');
        }
        this.receive(record as RpcRecord);
      }
    }
    this.append(chunk.subarray(from));
  }

  private append(bytes: Uint8Array): void {
    if (this.buffer.length + bytes.length > this.maxLineBytes) throw new Error('RPC JSONL line exceeds byte limit.');
    if (bytes.length) this.buffer = Buffer.concat([this.buffer, bytes]);
  }

  end(): void {
    if (this.buffer.length) throw new Error('RPC stdout ended with an unterminated JSONL record.');
  }
}
