// Slash-command helpers for the Claude Code provider.
//
// The CLI's headless mode (`claude -p`) expands a slash command when the
// prompt STARTS with `/name` — custom commands from `.claude/commands/`,
// skills, and the subset of built-ins the CLI advertises in its
// `system/init` event (`slash_commands`). Everything in here is pure so
// the argv/stdin layer (splitMessages), the NDJSON parser, and the
// composer UI can share one definition of "what counts as a command".
//
// Verified against claude 2.1.308: a command is only recognized at the
// very start of the prompt, names may contain plugin namespaces
// (`anthropic-skills:docs`) and leading underscores, and an unknown
// `/name` is forwarded to the model as ordinary text with a note.

export interface ParsedSlashCommand {
	/** Command name without the leading slash, as typed (case preserved). */
	name: string;
	/** Everything after the name, whitespace-trimmed. Empty when absent. */
	args: string;
}

// Name alphabet mirrors what the CLI emits in `slash_commands`:
// alphanumerics, `_`, `-`, `.`, and `:` for plugin namespaces. The first
// char must not be `-` so a tampered cache entry can never look like an
// argv flag if it is ever echoed into a prompt. 64 chars is far above
// any real command name and keeps the UI rows bounded.
export const SLASH_COMMAND_NAME_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_:.-]{0,63}$/;

// A leading command must be followed by whitespace or end-of-text, so an
// absolute path pasted at the start of a message (`/Users/me/note.md …`)
// does NOT parse as a command — the `/` inside the path breaks the match.
const LEADING_COMMAND_RE = /^\/([A-Za-z0-9_][A-Za-z0-9_:.-]{0,63})(?:\s+([\s\S]*))?$/;

// Upper bound on the cached command list. The CLI ships well under a
// hundred entries; the cap exists so a corrupted data.json or a rogue
// CLI build cannot balloon the settings blob or the popover.
export const SLASH_COMMAND_LIST_MAX = 256;

/**
 * Parse a user message as a leading slash command. Returns null when
 * the (trimmed) text does not start with `/name` followed by whitespace
 * or end-of-text.
 */
export function parseSlashCommand(text: string): ParsedSlashCommand | null {
	const m = LEADING_COMMAND_RE.exec(text.trim());
	if (m === null) return null;
	const name = m[1];
	if (name === undefined) return null;
	return { name, args: (m[2] ?? '').trim() };
}

export function isSlashCommand(text: string): boolean {
	return parseSlashCommand(text) !== null;
}

/**
 * Validate the `slash_commands` payload of a `system/init` event into a
 * canonical, deduplicated, case-insensitively sorted list. Returns null
 * when the payload is not an array at all (older CLI builds), so the
 * caller can leave its cache untouched rather than wiping it.
 */
export function sanitizeSlashCommandNames(raw: unknown): string[] | null {
	if (!Array.isArray(raw)) return null;
	const seen = new Set<string>();
	for (const entry of raw) {
		if (typeof entry !== 'string') continue;
		if (!SLASH_COMMAND_NAME_PATTERN.test(entry)) continue;
		seen.add(entry);
		if (seen.size >= SLASH_COMMAND_LIST_MAX) break;
	}
	return Array.from(seen).sort(compareNames);
}

export function sameSlashCommandList(a: readonly string[], b: readonly string[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) return false;
	}
	return true;
}

/**
 * Rank cached command names against what the user has typed after the
 * slash. Prefix matches come first (in list order), then substring
 * matches. Case-insensitive. An empty query returns the whole list.
 */
export function filterSlashCommands(names: readonly string[], query: string): string[] {
	const q = query.toLowerCase();
	if (q.length === 0) return names.slice();
	const prefix: string[] = [];
	const contains: string[] = [];
	for (const name of names) {
		const lower = name.toLowerCase();
		if (lower.startsWith(q)) prefix.push(name);
		else if (lower.includes(q)) contains.push(name);
	}
	return prefix.concat(contains);
}

/**
 * Commands Yunseul handles itself instead of forwarding to a CLI. They
 * exist for every provider.
 *
 *   - `new-chat`: `/clear`. In headless mode the Claude CLI answers with
 *     a `conversation_reset` event and a NEW session id while Yunseul's
 *     transcript would keep showing the old turns; Codex has no such
 *     command at all. Mapping it onto the plugin's own "New chat" keeps
 *     transcript and backend session in step.
 *   - `model` / `effort`: `/model <id>`, `/effort <level>`. Both CLIs
 *     scope these "to this session", and Yunseul spawns a fresh process
 *     per message (verified: the next `--resume` turn reverts), so the
 *     plugin keeps the choice itself — per chat, persisted with the
 *     session — and re-sends it as argv on every turn. See
 *     chat/localCommands.ts for the state transition.
 */
export type LocalSlashCommand =
	| { kind: 'new-chat' }
	| { kind: 'model' }
	| { kind: 'effort' };

export const LOCAL_SLASH_COMMANDS: readonly string[] = ['clear', 'effort', 'model'];

export function classifyLocalSlashCommand(name: string): LocalSlashCommand | null {
	switch (name.toLowerCase()) {
		case 'clear':
			return { kind: 'new-chat' };
		case 'model':
			return { kind: 'model' };
		case 'effort':
			return { kind: 'effort' };
		default:
			return null;
	}
}

/**
 * Effort levels each backend accepts, as printed by the CLIs themselves
 * (`claude --effort bogus` lists low…max; Codex rejects an unknown
 * `model_reasoning_effort` with the list none…xhigh). Empty for backends
 * without the concept.
 */
const EFFORT_LEVELS: Readonly<Record<string, readonly string[]>> = {
	'claude-code': ['low', 'medium', 'high', 'xhigh', 'max'],
	codex: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
};

export function effortLevelsFor(provider: string): readonly string[] {
	return EFFORT_LEVELS[provider] ?? [];
}

/** `/model default`, `/effort reset`, … clear the per-chat override. */
export function isResetWord(arg: string): boolean {
	const a = arg.trim().toLowerCase();
	return a === 'default' || a === 'reset' || a === 'clear' || a === 'off';
}

/**
 * What the composer popover offers: Yunseul's own commands for every
 * provider, plus — for Claude Code — whatever its CLI advertised in the
 * last headless `system/init`. Deduplicated, sorted case-insensitively.
 */
export function availableSlashCommands(provider: string, cliCommands: readonly string[]): string[] {
	const names = new Set<string>(LOCAL_SLASH_COMMANDS);
	if (provider === 'claude-code') {
		for (const n of cliCommands) names.add(n);
	}
	return Array.from(names).sort(compareNames);
}

function compareNames(a: string, b: string): number {
	const la = a.toLowerCase();
	const lb = b.toLowerCase();
	if (la < lb) return -1;
	if (la > lb) return 1;
	return a < b ? -1 : a > b ? 1 : 0;
}
