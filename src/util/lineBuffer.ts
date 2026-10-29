// Newline-delimited stream buffer shared by the subprocess providers
// (Claude Code's stream-json, Codex's JSONL). Accumulates stdout chunks,
// dispatches one callback per complete `\n`-terminated line, tolerates
// `\r\n`, drops oversize lines, and abandons the buffer entirely if a
// partial line grows past the cap without a newline (runaway upstream).
//
// Pure: no logger, no provider knowledge. The owner maps onOversizeLine
// / onOverflow onto its own debug/warn surface and parses each line.

export interface LineBufferHandlers {
	onLine: (line: string) => void;
	onOversizeLine: (length: number) => void;
	onOverflow: () => void;
}

export interface LineBufferCaps {
	/** Longest single line dispatched; longer lines are dropped. */
	lineMax: number;
	/** Longest un-newlined partial the buffer will hold before giving up. */
	bufferMax: number;
}

export class LineBuffer {
	private buf = '';
	private readonly decoder = new TextDecoder();
	private closed = false;

	constructor(
		private readonly handlers: LineBufferHandlers,
		private readonly caps: LineBufferCaps,
	) {}

	/**
	 * Push one stdout chunk. Lines are dispatched in-loop (not batched) so
	 * callbacks fire in the exact order the process emitted them.
	 */
	push(chunk: Uint8Array | string): void {
		if (this.closed) return;
		const text = typeof chunk === 'string' ? chunk : this.decoder.decode(chunk, { stream: true });
		this.buf += text;
		if (this.buf.length > this.caps.bufferMax) {
			this.handlers.onOverflow();
			this.buf = '';
			return;
		}
		let newlineIdx = this.buf.indexOf('\n');
		while (newlineIdx !== -1) {
			const rawLine = this.buf.slice(0, newlineIdx);
			this.buf = this.buf.slice(newlineIdx + 1);
			const line = rawLine.trim();
			if (line.length > 0 && line.length <= this.caps.lineMax) {
				this.handlers.onLine(line);
			} else if (line.length > this.caps.lineMax) {
				this.handlers.onOversizeLine(line.length);
			}
			newlineIdx = this.buf.indexOf('\n');
		}
	}

	/**
	 * Dispatch a trailing partial line that never got its newline (a
	 * process that exits mid-write). Idempotent.
	 */
	flush(): void {
		if (this.closed) return;
		this.closed = true;
		this.buf += this.decoder.decode();
		const tail = this.buf.trim();
		this.buf = '';
		if (tail.length > 0 && tail.length <= this.caps.lineMax) {
			this.handlers.onLine(tail);
		}
	}
}
