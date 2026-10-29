// streamChat orchestration for the Codex provider. Mirrors the Claude
// Code orchestrator but is much shorter: Codex takes the system prompt
// as a `-c developer_instructions=` override (no temp file) and emits a
// handful of JSONL events (events.ts). Subprocess timing, env hardening,
// message splitting and outcome dispatch are the shared modules under
// src/claude-code/.

import type YunseulPlugin from '../main';
import type { StreamChatOpts, StreamCompletionMeta } from '../llm/types';
import { vaultBasePath } from '../util/paths';
import { redactSecrets } from '../util/redact';
import { EFFORT_PATTERN, MODEL_OVERRIDE_PATTERN, SESSION_ID_PATTERN } from '../claude-code/constants';
import { dispatchTerminate } from '../claude-code/dispatch';
import { buildSafeEnv } from '../claude-code/env';
import { runSubprocess, type LiveProc, type SubprocessIO } from '../claude-code/lifecycle';
import { assembleCodexArgs, describeCodexArgs } from './argv';
import { CodexEventBuffer } from './events';
import { CODEX_INSTRUCTIONS_MAX_BYTES, splitForCodex, utf8ByteLength } from './prompt';

export interface CodexStreamDeps {
	plugin: YunseulPlugin;
	io: SubprocessIO;
	registerLive: (entry: LiveProc) => void;
	unregisterLive: (entry: LiveProc) => void;
}

/** Env prefixes Codex needs on top of the shared allowlist (auth + config home). */
export const CODEX_ENV_PREFIXES: readonly string[] = ['OPENAI_', 'CODEX_'];

export function codexBinary(plugin: YunseulPlugin): string {
	const b = plugin.settings.codex.binary.trim();
	return b.length > 0 ? b : 'codex';
}

export async function streamCodexChat(deps: CodexStreamDeps, opts: StreamChatOpts): Promise<void> {
	const plugin = deps.plugin;
	const settings = plugin.settings.codex;
	const binary = codexBinary(plugin);

	let cwd: string;
	try {
		cwd = vaultBasePath(plugin);
	} catch (e) {
		opts.onError(e instanceof Error ? e : new Error(String(e)));
		return;
	}

	const priorThreadId = validate(readThreadId(opts.extras), SESSION_ID_PATTERN, 'thread id', plugin);
	const model = validate(firstNonEmpty(opts.model, settings.model), MODEL_OVERRIDE_PATTERN, 'model', plugin);
	const effort = validate(firstNonEmpty(opts.effort, settings.effort), EFFORT_PATTERN, 'effort', plugin);

	// Only the static head (prompt + guard + addendum) rides on argv;
	// vault excerpts and the retrieval block are prepended to stdin, where
	// size is not limited (see prompt.ts). Resume sends only the latest
	// user turn plus this turn's context blocks.
	const { developerInstructions, stdinPayload } = splitForCodex(opts.messages, priorThreadId !== null);
	const instructionBytes = utf8ByteLength(developerInstructions);
	if (instructionBytes > CODEX_INSTRUCTIONS_MAX_BYTES) {
		opts.onError(new Error(
			`The system prompt is too long for Codex (${instructionBytes} bytes; limit ${CODEX_INSTRUCTIONS_MAX_BYTES}). Shorten it and try again.`,
		));
		return;
	}
	const args = assembleCodexArgs({
		developerInstructions,
		priorThreadId,
		model,
		effort,
		enableWrites: settings.enableWrites,
	});
	plugin.logger.debug('codex spawn', { binary, args: describeCodexArgs(args), cwd });

	const meta: StreamCompletionMeta = {};
	// `error` events are not always fatal (the CLI also reports transient
	// stream retries that way), so an error only decides the outcome when
	// the turn actually failed or the process exited non-zero. A completed
	// turn clears it.
	let lastError: string | null = null;
	let turnFailed = false;
	const stderrDecoder = new TextDecoder();
	const events = new CodexEventBuffer({
		onThreadStarted: (id) => {
			meta.codexThreadId = id;
			opts.onMeta?.({ codexThreadId: id });
		},
		onText: (text) => opts.onToken(text),
		onTurnCompleted: (usage) => {
			if (usage.inputTokens !== undefined) meta.inputTokens = usage.inputTokens;
			if (usage.outputTokens !== undefined) meta.outputTokens = usage.outputTokens;
			lastError = null;
			turnFailed = false;
			opts.onMeta?.({ ...meta });
		},
		onError: (message, fatal) => {
			lastError = message;
			if (fatal) turnFailed = true;
		},
		warn: (m) => plugin.logger.warn(m),
		debug: (m) => plugin.logger.debug(m),
	});

	await runSubprocess(
		deps.io,
		{
			binary,
			args,
			cwd,
			env: buildSafeEnv(CODEX_ENV_PREFIXES),
			signal: opts.signal,
			stdinPayload,
		},
		{
			onStdout: (chunk) => events.push(chunk),
			// Codex writes progress notes to stderr on normal runs; keep
			// them at debug. A real failure still surfaces: the lifecycle
			// layer carries the stderr tail into the exit-error message.
			onStderr: (chunk) => {
				const text = typeof chunk === 'string' ? chunk : stderrDecoder.decode(chunk, { stream: true });
				for (const line of text.split('\n')) {
					const t = line.trim();
					if (t.length > 0) plugin.logger.debug(`codex stderr: ${redactSecrets(t)}`);
				}
			},
			onTerminate: (outcome) => {
				events.flush();
				// API/config failures (bad model, bad effort, quota) arrive
				// as JSON `error` + `turn.failed` with an empty stderr; the
				// generic exit-code message would hide the actual cause.
				const fatal = outcome.kind === 'exit-error' || (outcome.kind === 'complete' && turnFailed);
				if (fatal && lastError !== null) {
					opts.onError(new Error(`codex: ${redactSecrets(lastError).slice(0, 500)}`));
					return;
				}
				dispatchTerminate(outcome, binary, meta, opts);
			},
			onStdinError: (msg) => plugin.logger.warn(`codex stdin error: ${msg}`),
		},
		deps.registerLive,
		deps.unregisterLive,
	);
}

function readThreadId(extras: Record<string, unknown> | undefined): string {
	const v = extras?.codexThreadId;
	return typeof v === 'string' ? v : '';
}

function validate(raw: string, pattern: RegExp, what: string, plugin: YunseulPlugin): string | null {
	if (raw.length === 0) return null;
	if (pattern.test(raw)) return raw;
	plugin.logger.warn(`codex: ignoring invalid ${what} "${raw}"`);
	return null;
}

function firstNonEmpty(preferred: string | undefined, fallback: string | undefined): string {
	const a = (preferred ?? '').trim();
	if (a.length > 0) return a;
	return (fallback ?? '').trim();
}
