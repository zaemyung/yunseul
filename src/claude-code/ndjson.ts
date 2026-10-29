// NDJSON line-buffer + stream-event parser for the Claude Code CLI's
// `--output-format stream-json` mode.
//
// The CLI emits exactly one JSON value per \n-terminated line on stdout.
// JSON strings inside the value JSON-escape their newlines as `\n`
// (literal backslash-n), so a raw `\n` byte unambiguously marks a line
// boundary. We accumulate partial lines across chunks and parse on
// every newline.
//
// Pure module — no logger/Notice imports. Every user-visible surface
// (warnings, debug traces, api_retry Notice, the streaming token/meta
// surface) is injected as a callback by the orchestrator (client.ts) so
// this file can be unit-tested in isolation and the orchestrator can
// wire each callback to its preferred surface.

import { isObject } from '../util/guards';
import { LineBuffer } from '../util/lineBuffer';
import { STDOUT_BUFFER_MAX, STDOUT_LINE_MAX } from './constants';
import { sanitizeSlashCommandNames } from './slash';

/**
 * Callbacks fired by the NDJSON parser as it encounters known event
 * types. The orchestrator wires each one to the appropriate downstream:
 *   - onText → opts.onToken
 *   - onSystemInit → meta.sessionId = sid + opts.onMeta?.({sessionId: sid})
 *   - onResult → meta merge + opts.onMeta?.({...meta})
 *   - onApiRetry → optional Notice + plugin.logger.warn
 *   - warn / debug → plugin.logger.warn / .debug
 *
 * `warn` and `debug` are callbacks (not direct imports of the logger)
 * because the existing tests stub plugin.logger.warn AFTER construction
 * (claude-code.test.ts:1011, 1040, 1070, 1109). A naive `const warn =
 * plugin.logger.warn` captured at construction time would miss those
 * later stubs and silently fail the assertion. The orchestrator passes
 * `(m) => this.plugin.logger.warn(m)` so the lookup is fresh per call.
 */
export interface NdjsonHandlers {
	onText: (text: string) => void;
	onSystemInit: (sessionId: string) => void;
	onResult: (event: ResultEvent) => void;
	onApiRetry: (attempt: number | undefined) => void;
	warn: (msg: string) => void;
	debug: (msg: string) => void;
	/**
	 * Fired once per `system/init` that carries a well-formed
	 * `slash_commands` array — the commands the CLI accepts in headless
	 * mode (built-ins, skills, `.claude/commands/`). Already validated
	 * and sorted by sanitizeSlashCommandNames. Optional so callers that
	 * don't care (probes, tests) can omit it.
	 */
	onSlashCommands?: (names: string[]) => void;
	/**
	 * Fired on `system/compact_boundary` — the CLI finished a manual
	 * (`/compact`) or automatic compaction. A compaction run emits NO
	 * text deltas and an empty result, so this is the only signal the
	 * user would otherwise see as a blank reply.
	 */
	onCompactBoundary?: (info: CompactBoundaryInfo) => void;
}

/**
 * Normalized `compact_metadata` of a `system/compact_boundary` event.
 * Every field is optional for forward compat with CLI changes.
 */
export interface CompactBoundaryInfo {
	trigger: string | undefined;
	preTokens: number | undefined;
	postTokens: number | undefined;
}

/**
 * Per-run bookkeeping for the "no streamed text" fallback.
 *
 * Local slash commands (`/context`, `/usage`, the "/help isn't available"
 * notice, an unknown-command note, …) are answered by the CLI itself
 * without an API round-trip. Their text arrives ONLY inside the
 * `assistant` message and the `result` event — never as
 * `content_block_delta`s, which is all the chat surface renders. We
 * remember whether any text delta was seen and, if none was by the time
 * `result` lands, emit the result text once through onText so the bubble
 * is not left blank. Normal model turns stream every byte as deltas
 * (`--include-partial-messages`), so the fallback never double-emits.
 */
export interface StreamTextState {
	sawTextDelta: boolean;
	assistantTexts: string[];
}

export function createStreamTextState(): StreamTextState {
	return { sawTextDelta: false, assistantTexts: [] };
}

/**
 * Normalized payload of a `type=result` event after the parser has
 * pulled out the fields we care about. Any field may be undefined if the
 * CLI didn't emit it (forward compat with older / newer versions).
 */
export interface ResultEvent {
	sessionId: string | undefined;
	totalCostUsd: number | undefined;
	inputTokens: number | undefined;
	outputTokens: number | undefined;
}

/**
 * Buffer NDJSON chunks across stdout boundaries and dispatch one parse
 * call per complete line. The buffer tolerates Windows `\r\n` boundaries
 * via downstream trim(); drops oversize lines (> STDOUT_LINE_MAX) with a
 * debug log; abandons the buffer entirely (with a warn) if the running
 * partial line crosses STDOUT_BUFFER_MAX without a newline.
 *
 * The buffer is single-threaded per process (one instance per
 * runSubprocess call). Callers must invoke push() on every stdout data
 * event and flush() exactly once when the stream closes — flush() walks
 * any final un-newlined trailing line.
 */
export class NdjsonBuffer {
	private readonly lines: LineBuffer;
	private readonly textState = createStreamTextState();

	constructor(handlers: NdjsonHandlers) {
		// Line splitting/caps live in util/lineBuffer.ts (shared with the
		// Codex provider). Lines are dispatched in-loop so onText /
		// onResult interleave in the order the CLI emitted them — the
		// multi-chunk regression test depends on that.
		this.lines = new LineBuffer(
			{
				onLine: (line) => parseStreamLine(line, handlers, this.textState),
				onOversizeLine: (n) => handlers.debug(`claude-code: dropping oversize stdout line (${n} chars)`),
				// Runaway upstream — abandon the buffer rather than stall
				// the renderer; the close handler surfaces a non-zero exit.
				onOverflow: () => handlers.warn('claude-code: stdout buffer exceeded cap; discarding'),
			},
			{ lineMax: STDOUT_LINE_MAX, bufferMax: STDOUT_BUFFER_MAX },
		);
	}

	/** Push one stdout chunk; dispatches one parse per complete line. */
	push(chunk: Uint8Array | string): void {
		this.lines.push(chunk);
	}

	/** Dispatch a trailing un-newlined line once on close. Idempotent. */
	flush(): void {
		this.lines.flush();
	}
}

/**
 * Parse one NDJSON line from the CLI's stdout and dispatch the event.
 * Unknown event types are ignored — we want forward-compat with new CLI
 * events without crashing.
 *
 * Event types we intentionally ignore: `tool_use`, `tool_result`,
 * `message_start`, `message_delta`, `content_block_start`,
 * `content_block_stop`. The current chat surface only renders the text
 * deltas; tool calls are handled by the CLI itself and we don't surface
 * them in the bubble.
 *
 * `state` is the per-run StreamTextState shared across every line of one
 * subprocess (NdjsonBuffer owns it). A caller parsing a single line in
 * isolation may omit it and gets a fresh state.
 */
export function parseStreamLine(
	line: string,
	handlers: NdjsonHandlers,
	state: StreamTextState = createStreamTextState(),
): void {
	let event: unknown;
	try {
		event = JSON.parse(line);
	} catch {
		// Skip malformed lines silently — defensive against the CLI
		// emitting a non-JSON warning that escaped stderr.
		handlers.debug(`claude-code: dropping non-JSON line: ${line.slice(0, 100)}`);
		return;
	}
	if (!isObject(event)) return;

	const type = stringOrUndef(event.type);
	const subtype = stringOrUndef(event.subtype);

	if (type === 'system' && subtype === 'init') {
		const sid = stringOrUndef(event.session_id);
		if (sid !== undefined) {
			handlers.onSystemInit(sid);
		}
		// `slash_commands` lists what the CLI will expand in THIS mode
		// (headless). Absent on older CLI builds → leave the cache alone.
		if (handlers.onSlashCommands !== undefined) {
			const names = sanitizeSlashCommandNames(event.slash_commands);
			if (names !== null) handlers.onSlashCommands(names);
		}
		return;
	}

	if (type === 'system' && subtype === 'api_retry') {
		const attempt = typeof event.attempt === 'number' ? event.attempt : undefined;
		handlers.onApiRetry(attempt);
		return;
	}

	if (type === 'system' && subtype === 'compact_boundary') {
		const md = isObject(event.compact_metadata) ? event.compact_metadata : undefined;
		handlers.onCompactBoundary?.({
			trigger: md !== undefined ? stringOrUndef(md.trigger) : undefined,
			preTokens: md !== undefined ? numberOrUndef(md.pre_tokens) : undefined,
			postTokens: md !== undefined ? numberOrUndef(md.post_tokens) : undefined,
		});
		return;
	}

	if (type === 'stream_event') {
		const inner = event.event;
		if (!isObject(inner)) return;
		if (inner.type !== 'content_block_delta') return;
		const delta = inner.delta;
		if (!isObject(delta)) return;
		if (delta.type !== 'text_delta') return;
		const text = stringOrUndef(delta.text);
		if (text !== undefined && text.length > 0) {
			state.sawTextDelta = true;
			handlers.onText(text);
		}
		return;
	}

	if (type === 'assistant') {
		// Only collected while no delta has streamed — the moment one
		// does, the assistant payload is a duplicate of what onText
		// already delivered and we stop accumulating.
		if (!state.sawTextDelta) collectAssistantText(event, state);
		return;
	}

	if (type === 'result') {
		const cost = typeof event.total_cost_usd === 'number' ? event.total_cost_usd : undefined;
		const sid = stringOrUndef(event.session_id);
		// Token counts are nested under `result.usage` on Claude Code's
		// NDJSON. Guard each field separately — older CLI versions may
		// omit one or both.
		const usage = isObject(event.usage) ? event.usage : undefined;
		const inputTokens = usage !== undefined && typeof usage.input_tokens === 'number'
			? usage.input_tokens
			: undefined;
		const outputTokens = usage !== undefined && typeof usage.output_tokens === 'number'
			? usage.output_tokens
			: undefined;
		// No-delta fallback (see StreamTextState). Only on a clean
		// success: error results are surfaced by the lifecycle layer via
		// the non-zero exit + stderr tail, and echoing `result` there would
		// double-report. The text is emitted BEFORE onResult so the
		// session sees "first token" before "completion meta".
		if (!state.sawTextDelta && subtype === 'success' && event.is_error !== true) {
			const fallback = pickFallbackText(stringOrUndef(event.result), state.assistantTexts);
			if (fallback !== null) {
				state.sawTextDelta = true;
				handlers.onText(fallback);
			}
		}
		handlers.onResult({
			sessionId: sid,
			totalCostUsd: cost,
			inputTokens,
			outputTokens,
		});
		return;
	}

	// Tool-use events and other types: ignore by design. The CLI
	// handles them; we'd only surface them when we add UI for it.
}

/**
 * Pull the text blocks out of an `assistant` event's
 * `message.content[]`. Non-text blocks (tool_use, thinking) are skipped.
 */
function collectAssistantText(event: Record<string, unknown>, state: StreamTextState): void {
	const message = isObject(event.message) ? event.message : undefined;
	const content = message !== undefined && Array.isArray(message.content) ? message.content : [];
	for (const block of content) {
		if (!isObject(block) || block.type !== 'text') continue;
		const text = stringOrUndef(block.text);
		if (text !== undefined && text.length > 0) state.assistantTexts.push(text);
	}
}

function pickFallbackText(resultText: string | undefined, assistantTexts: string[]): string | null {
	if (resultText !== undefined && resultText.trim().length > 0) return resultText;
	const joined = assistantTexts.join('\n\n');
	return joined.trim().length > 0 ? joined : null;
}

function stringOrUndef(x: unknown): string | undefined {
	return typeof x === 'string' ? x : undefined;
}

function numberOrUndef(x: unknown): number | undefined {
	return typeof x === 'number' && Number.isFinite(x) ? x : undefined;
}
