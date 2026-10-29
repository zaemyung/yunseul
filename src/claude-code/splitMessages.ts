// Pure helpers for assembling the system prompt + user prompt strings
// that feed the Claude Code CLI's --append-system-prompt-file flag and
// stdin payload respectively.
//
// Re-exported from client.ts so that
// tests/claude-code.test.ts:9 (`import { ..., splitMessages, ... } from
// '../src/claude-code/client'`) keeps working without import-path churn.

import { isSlashCommand } from './slash';

export interface SplitMessagesResult {
	systemPrompt: string;
	userPrompt: string;
}

/**
 * Split the assembled messages into a system prompt body (for the
 * --append-system-prompt-file flag) and a stdin user prompt. The
 * PromptAssembler returns up to four kinds of messages:
 *   1. The default system prompt + injection guard.
 *   2. Optional bound-file <vault_excerpt> wrapped in a system msg.
 *   3. Optional retrieval block wrapped in a system msg.
 *   4. Conversation history (user/assistant turns).
 *
 * We bundle 1–3 into the system prompt file. The user prompt body
 * depends on whether we have an active --resume session:
 *   - Slash command (latest user turn starts with `/name`): send that
 *     turn verbatim, with or without --resume. The CLI only recognizes
 *     a command at the very start of the prompt, so the "User: " label
 *     below would silently turn `/compact` into plain text. On a fresh
 *     session this drops the replayed history — acceptable because a
 *     command turn is self-contained and the fresh-with-history case
 *     only arises after a lost session id.
 *   - With --resume: send ONLY the most recent USER turn. The CLI
 *     keeps the prior history server-side. If the latest message is
 *     an assistant turn (regenerate flow), walk back to the last user
 *     message. If none exists, return an empty user prompt.
 *   - Fresh session: serialize the full history as "User: ...\n\n
 *     Assistant: ...\n\n..." so Claude has context.
 */
export function splitMessages(
	messages: Array<{ role: string; content: string }>,
	hasResume: boolean,
): SplitMessagesResult {
	const systemParts: string[] = [];
	const turns: Array<{ role: string; content: string }> = [];
	for (const m of messages) {
		if (m.role === 'system') {
			systemParts.push(m.content);
		} else {
			turns.push(m);
		}
	}
	const systemPrompt = systemParts.join('\n\n');

	if (turns.length === 0) {
		return { systemPrompt, userPrompt: '' };
	}

	// If the tail is an assistant message (regenerate flow), walk back
	// to find the last user turn — sending an assistant message as the
	// user prompt would confuse the resumed session.
	const lastUser = findLastUserTurn(turns);

	// Slash commands bypass both serialization modes: the CLI must see
	// `/name …` as the first bytes of stdin or it will not expand it.
	if (lastUser !== null && isSlashCommand(lastUser.content)) {
		return { systemPrompt, userPrompt: lastUser.content.trim() };
	}

	// With an active session, the CLI already has prior turns. Send
	// only the latest user message so we don't duplicate history.
	if (hasResume) {
		return { systemPrompt, userPrompt: lastUser?.content ?? '' };
	}

	// Fresh session: serialize every turn so Claude sees the context.
	// We label each turn so role boundaries are explicit. The final
	// "Assistant:" marker is omitted — the CLI's next reply IS the
	// assistant turn.
	const labeled: string[] = [];
	for (let i = 0; i < turns.length; i++) {
		const t = turns[i];
		if (t === undefined) continue;
		const label = t.role === 'user' ? 'User' : t.role === 'assistant' ? 'Assistant' : t.role;
		labeled.push(`${label}: ${t.content}`);
	}
	return { systemPrompt, userPrompt: labeled.join('\n\n') };
}

function findLastUserTurn(
	turns: ReadonlyArray<{ role: string; content: string }>,
): { role: string; content: string } | null {
	for (let i = turns.length - 1; i >= 0; i--) {
		const t = turns[i];
		if (t?.role === 'user') return t;
	}
	return null;
}

/**
 * Read the prior Claude Code session id from an extras bag. The
 * session stores claudeCodeSessionId on its snapshot; the caller passes
 * it here as extras.claudeCodeSessionId so we don't have to teach the
 * LLM interface about provider-specific fields.
 */
export function readSessionIdFromExtras(
	extras: Record<string, unknown> | undefined,
): string | null {
	if (extras === undefined) return null;
	const v = extras.claudeCodeSessionId;
	return typeof v === 'string' && v.length > 0 ? v : null;
}
