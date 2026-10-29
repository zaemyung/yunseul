// Shared subprocess mock for the CLI-backed provider tests (Claude Code,
// Codex). Mimics just enough of node's ChildProcess to drive the
// stdout/stderr/exit lifecycle deterministically. Extracted verbatim from
// tests/claude-code.test.ts, which still carries its own copy.
import { EventEmitter } from 'events';
import { Writable } from 'stream';
import type { ChildProcess } from 'child_process';

export class MockChildProcess extends EventEmitter {
	stdin: Writable | null;
	stdout: EventEmitter;
	stderr: EventEmitter;
	exitCode: number | null = null;
	signalCode: NodeJS.Signals | null = null;
	killSignals: NodeJS.Signals[] = [];
	stdinWrites: string[] = [];
	stdinEnded = false;

	constructor(opts: { withStdin?: boolean } = {}) {
		super();
		this.stdout = new EventEmitter();
		this.stderr = new EventEmitter();
		if (opts.withStdin !== false) {
			const writes = this.stdinWrites;
			// We track the call to end() directly rather than the
			// 'finish' event because the Writable's finish event fires
			// on the next macrotask, which is awkward under fake timers.
			const self = this;
			const stdinAny = new Writable({
				write(chunk, _enc, cb) {
					writes.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
					cb();
				},
			}) as Writable & { end: Writable['end'] };
			const origEnd = stdinAny.end.bind(stdinAny);
			stdinAny.end = function (...args: unknown[]): Writable {
				self.stdinEnded = true;
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				return origEnd(...(args as [any, any?, any?]));
			} as Writable['end'];
			this.stdin = stdinAny;
		} else {
			this.stdin = null;
		}
	}

	kill(signal?: NodeJS.Signals | number): boolean {
		const sig = (typeof signal === 'string' ? signal : 'SIGTERM') as NodeJS.Signals;
		this.killSignals.push(sig);
		return true;
	}

	emitStdout(line: string): void {
		this.stdout.emit('data', Buffer.from(line, 'utf8'));
	}

	emitStderr(line: string): void {
		this.stderr.emit('data', Buffer.from(line, 'utf8'));
	}

	finish(code: number): void {
		this.exitCode = code;
		this.emit('close', code);
	}

	asChildProcess(): ChildProcess {
		// The shape is structural; cast through unknown so we don't
		// invoke the full ChildProcess constructor.
		return this as unknown as ChildProcess;
	}
}
