// Prompt split for Codex. Pure.
//
// Claude Code gets the whole system side (prompt + guard + bound-note
// excerpt + retrieval block) through a temp file, so size is not a
// concern. Codex has no file flag: its instructions ride on ONE argv
// element (`-c developer_instructions=…`), and argv has hard limits
// (Windows ≈32k chars for the whole command line, Linux 128 KiB per
// argument, macOS 1 MiB total). A bound note plus retrieved excerpts can
// exceed all three. So for Codex only the static head — system prompt +
// injection guard + addendum, the first system message — becomes the
// override; every further system message (vault excerpts, retrieval
// block) is prepended to the stdin payload, where there is no limit. The
// guard's `<vault_excerpt>` semantics are unchanged: the excerpts are still
// tagged data, just delivered in the user turn.

import { splitMessages } from '../claude-code/splitMessages';

export interface CodexPromptSplit {
	/** First system message: prompt + guard + addendum. Goes to `-c developer_instructions`. */
	developerInstructions: string;
	/** Context blocks (if any) followed by the user prompt. Goes to stdin. */
	stdinPayload: string;
}

// Generous ceiling for the instructions override — the static head is
// ~1–2 KB; crossing this means a runaway custom system prompt, and the
// failure should be a clear message rather than `spawn E2BIG`.
export const CODEX_INSTRUCTIONS_MAX_BYTES = 24 * 1024;

export function splitForCodex(
	messages: ReadonlyArray<{ role: string; content: string }>,
	hasResume: boolean,
): CodexPromptSplit {
	const systems = messages.filter((m) => m.role === 'system');
	const turns = messages.filter((m) => m.role !== 'system');
	const developerInstructions = systems[0]?.content ?? '';
	const context = systems.slice(1).map((m) => m.content).filter((c) => c.trim().length > 0);
	const { userPrompt } = splitMessages(turns, hasResume);
	const stdinPayload = context.length > 0
		? `${context.join('\n\n')}\n\n${userPrompt}`
		: userPrompt;
	return { developerInstructions, stdinPayload };
}

export function utf8ByteLength(s: string): number {
	return new TextEncoder().encode(s).length;
}
