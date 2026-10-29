/** TillDone Desk L2: UTF-8 transport framing, splitting exclusively on LF (never readline). */
import { StringDecoder } from "node:string_decoder";
export class JsonlDecoder {
	private readonly decoder = new StringDecoder("utf8");
	private buffer = "";
	constructor(private readonly onRecord: (record: Record<string, any>) => void) {}
	push(chunk: Buffer): void {
		this.buffer += this.decoder.write(chunk);
		let index: number;
		while ((index = this.buffer.indexOf("\n")) !== -1) {
			const line = this.buffer.slice(0, index).replace(/\r$/, "");
			this.buffer = this.buffer.slice(index + 1);
			if (!line) continue;
			const record = JSON.parse(line);
			if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error("RPC record must be an object.");
			this.onRecord(record);
		}
	}
	end(): void {
		this.buffer += this.decoder.end();
		if (this.buffer.length) throw new Error("Pi stdout ended with an unterminated JSONL record.");
	}
}
