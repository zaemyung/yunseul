// Slash commands Yunseul answers itself, for every provider: `/model` and
// `/effort` set per-chat overrides on the session; the view persists the
// session, refreshes the status strip, and shows the returned notice.
// Kept free of DOM and Obsidian imports so it can be unit-tested as a
// pure state transition.
//
// Resolution order used everywhere a model/effort is needed (session →
// client argv, status strip, notices):
//   1. the chat's own override (set by /model, /effort; persisted),
//   2. the provider's configured default in Settings,
//   3. the backend's own default (empty string — the CLI/server picks).

import type { ChatSession } from './session';
import type { Provider, YunseulSettings } from '../settings';
import { MODEL_OVERRIDE_PATTERN } from '../claude-code/constants';
import { effortLevelsFor, isResetWord } from '../claude-code/slash';

export interface LocalCommandOutcome {
	notice: string;
	/** True when a session override changed and must be persisted. */
	changed: boolean;
	/**
	 * False only when the input was rejected (unknown level, malformed
	 * id). The view keeps the typed text in the composer in that case so
	 * the user can correct it instead of retyping.
	 */
	ok: boolean;
}

export function providerDisplayName(provider: Provider): string {
	switch (provider) {
		case 'claude-code':
			return 'Claude Code';
		case 'codex':
			return 'Codex';
		case 'lm-studio':
			return 'LM Studio';
	}
}

/** Settings-level default model for the active provider ('' = backend default). */
export function providerDefaultModel(settings: YunseulSettings): string {
	switch (settings.provider) {
		case 'claude-code':
			return settings.claudeCode.modelOverride.trim();
		case 'codex':
			return settings.codex.model.trim();
		case 'lm-studio':
			return settings.lmStudio.chatModel.trim();
	}
}

/** Settings-level default effort for the active provider ('' = backend default). */
export function providerDefaultEffort(settings: YunseulSettings): string {
	switch (settings.provider) {
		case 'claude-code':
			return settings.claudeCode.effort.trim();
		case 'codex':
			return settings.codex.effort.trim();
		case 'lm-studio':
			return '';
	}
}

/** Label shown when no model id is configured anywhere. */
export function providerDefaultModelLabel(provider: Provider): string {
	switch (provider) {
		case 'claude-code':
			return 'claude (default)';
		case 'codex':
			return 'codex (default)';
		case 'lm-studio':
			return '(no model)';
	}
}

function modelHint(provider: Provider): string {
	switch (provider) {
		case 'claude-code':
			return ' Claude Code accepts sonnet, opus, haiku, fable, best, sonnet[1m], opus[1m], fable[1m], opusplan, or a full model ID.';
		case 'codex':
			return ' Use a model id your Codex account supports (the same names as Codex\'s own /model picker).';
		case 'lm-studio':
			return ' Use a model id that is loaded in your local server.';
	}
}

export function runModelCommand(
	session: ChatSession,
	settings: YunseulSettings,
	args: string,
): LocalCommandOutcome {
	const arg = args.trim();
	const providerName = providerDisplayName(settings.provider);
	if (arg.length === 0) {
		const current = session.effectiveModel();
		const shown = current.length > 0 ? current : `${providerName} default`;
		return {
			notice: `Model for this chat: ${shown}. Usage: /model <id> to change it for this chat, /model default to reset.${modelHint(settings.provider)}`,
			changed: false,
			ok: true,
		};
	}
	if (isResetWord(arg)) {
		const changed = session.effectiveModel() !== providerDefaultModel(settings) || session.modelOverride !== null;
		session.setOverrides(settings.provider, { model: null });
		return { notice: `Model reset to the ${providerName} default for this chat.`, changed, ok: true };
	}
	if (!MODEL_OVERRIDE_PATTERN.test(arg)) {
		return {
			notice: 'Model ids may only contain letters, digits, and . _ : / @ - [ ] with no spaces.',
			changed: false,
			ok: false,
		};
	}
	const changed = session.effectiveModel() !== arg;
	session.setOverrides(settings.provider, { model: arg });
	return { notice: `Model set to ${arg} for this chat.`, changed, ok: true };
}

export function runEffortCommand(
	session: ChatSession,
	settings: YunseulSettings,
	args: string,
): LocalCommandOutcome {
	const levels = effortLevelsFor(settings.provider);
	const providerName = providerDisplayName(settings.provider);
	if (levels.length === 0) {
		return { notice: `${providerName} has no effort setting.`, changed: false, ok: true };
	}
	const arg = args.trim().toLowerCase();
	const list = levels.join(', ');
	if (arg.length === 0) {
		const current = session.effectiveEffort();
		const shown = current.length > 0 ? current : `${providerName} default`;
		return {
			notice: `Effort for this chat: ${shown}. Usage: /effort <${levels.join('|')}> to change it for this chat, /effort default to reset.`,
			changed: false,
			ok: true,
		};
	}
	if (isResetWord(arg)) {
		const changed = session.effectiveEffort() !== providerDefaultEffort(settings) || session.effortOverride !== null;
		session.setOverrides(settings.provider, { effort: null });
		return { notice: `Effort reset to the ${providerName} default for this chat.`, changed, ok: true };
	}
	if (!levels.includes(arg)) {
		return { notice: `Effort must be one of: ${list}.`, changed: false, ok: false };
	}
	const changed = session.effectiveEffort() !== arg;
	session.setOverrides(settings.provider, { effort: arg });
	return { notice: `Effort set to ${arg} for this chat.`, changed, ok: true };
}
