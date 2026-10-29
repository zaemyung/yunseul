// JSONL event parser for `codex exec --json`. Pure module; the orchestrator
// (streamChat.ts) wires the callbacks.
//
// Event shapes observed on codex-cli 0.165.0:
//   {"type":"thread.started","thread_id":"…"}
//   {"type":"turn.started"}
//   {"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"…"}}
//   {"type":"turn.completed","usage":{"input_tokens":N,"output_tokens":N,…}}
//   {"type":"error","message":"…"}            (API/config failures)
//   {"type":"turn.failed","error":{"message":"…"}}
// Agent text arrived only as a completed item in every probe; the parser
// also accepts `item.updated` with a growing `text` and emits just the
// unseen suffix, so a future streaming build is handled without change.

import { isObject } from '../util/guards';
import { LineBuffer } from '../util/lineBuffer';
import { STDOUT_BUFFER_MAX, STDOUT_LINE_MAX } from '../claude-code/constants';

export interface CodexUsage {
	inputTokens: number | undefined;
	outputTokens: number | undefined;
}

export interface CodexEventHandlers {
	onThreadStarted: (threadId: string) => void;
	onText: (text: string) => void;
	onTurnCompleted: (usage: CodexUsage) => void;
	/**
	 * `error` (fatal=false: may be a transient retry notice) and
	 * `turn.failed` (fatal=true) payloads. The orchestrator decides how to
	 * surface them together with the exit code.
	 */
	onError: (message: string, fatal: boolean) => void;
	warn: (msg: string) => void;
	debug: (msg: string) => void;
}

/** Per-run bookkeeping so partial + completed items never double-emit. */
export interface CodexTextState {
	emittedByItem: Map<string, number>;
	lastItemId: string | null;
}

export function createCodexTextState(): CodexTextState {
	return { emittedByItem: new Map(), lastItemId: null };
}

export class CodexEventBuffer {
	private readonly lines: LineBuffer;
	private readonly state = createCodexTextState();

	constructor(handlers: CodexEventHandlers) {
		this.lines = new LineBuffer(
			{
				onLine: (line) => parseCodexLine(line, handlers, this.state),
				onOversizeLine: (n) => handlers.debug(`codex: dropping oversize stdout line (${n} chars)`),
				onOverflow: () => handlers.warn('codex: stdout buffer exceeded cap; discarding'),
			},
			{ lineMax: STDOUT_LINE_MAX, bufferMax: STDOUT_BUFFER_MAX },
		);
	}

	push(chunk: Uint8Array | string): void {
		this.lines.push(chunk);
	}

	flush(): void {
		this.lines.flush();
	}
}

export function parseCodexLine(
	line: string,
	handlers: CodexEventHandlers,
	state: CodexTextState = createCodexTextState(),
): void {
	let event: unknown;
	try {
		event = JSON.parse(line);
	} catch {
		handlers.debug(`codex: dropping non-JSON line: ${line.slice(0, 100)}`);
		return;
	}
	if (!isObject(event)) return;
	const type = typeof event.type === 'string' ? event.type : '';

	if (type === 'thread.started') {
		if (typeof event.thread_id === 'string' && event.thread_id.length > 0) {
			handlers.onThreadStarted(event.thread_id);
		}
		return;
	}

	if (type === 'item.started' || type === 'item.updated' || type === 'item.completed') {
		const item = isObject(event.item) ? event.item : undefined;
		if (item === undefined || item.type !== 'agent_message') return;
		const text = typeof item.text === 'string' ? item.text : '';
		if (text.length === 0) return;
		const id = typeof item.id === 'string' ? item.id : 'item';
		const already = state.emittedByItem.get(id) ?? 0;
		if (text.length <= already) return;
		// A second agent message in the same turn starts a new paragraph.
		const prefix = state.lastItemId !== null && state.lastItemId !== id && already === 0 ? '\n\n' : '';
		state.emittedByItem.set(id, text.length);
		state.lastItemId = id;
		handlers.onText(prefix + text.slice(already));
		return;
	}

	if (type === 'turn.completed') {
		const usage = isObject(event.usage) ? event.usage : undefined;
		handlers.onTurnCompleted({
			inputTokens: usage !== undefined && typeof usage.input_tokens === 'number' ? usage.input_tokens : undefined,
			outputTokens: usage !== undefined && typeof usage.output_tokens === 'number' ? usage.output_tokens : undefined,
		});
		return;
	}

	if (type === 'error') {
		handlers.onError(typeof event.message === 'string' ? event.message : 'unknown error', false);
		return;
	}

	if (type === 'turn.failed') {
		const err = isObject(event.error) ? event.error : undefined;
		handlers.onError(
			err !== undefined && typeof err.message === 'string' ? err.message : 'turn failed',
			true,
		);
		return;
	}
	// turn.started, command executions, reasoning items, …: not rendered.
}
