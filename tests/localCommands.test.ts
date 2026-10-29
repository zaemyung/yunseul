import { describe, expect, it } from 'vitest';
import type { ChatSession } from '../src/chat/session';
import {
	providerDefaultEffort,
	providerDefaultModel,
	providerDefaultModelLabel,
	providerDisplayName,
	runEffortCommand,
	runModelCommand,
} from '../src/chat/localCommands';
import { DEFAULT_SETTINGS, type YunseulSettings } from '../src/settings';

// The local /model and /effort commands are pure state transitions on
// the session's overrides. A structural fake stands in for ChatSession
// (only the override fields and the two resolvers are touched).
function fakeSession(settings: YunseulSettings): ChatSession {
	const s = {
		modelOverride: null as string | null,
		effortOverride: null as string | null,
		overrideProvider: null as string | null,
		setOverrides(provider: string, patch: { model?: string | null; effort?: string | null }): void {
			if (this.overrideProvider !== provider) {
				this.modelOverride = null;
				this.effortOverride = null;
				this.overrideProvider = provider;
			}
			if (patch.model !== undefined) this.modelOverride = patch.model;
			if (patch.effort !== undefined) this.effortOverride = patch.effort;
		},
		effectiveModel(): string {
			return this.modelOverride !== null && this.overrideProvider === settings.provider
				? this.modelOverride
				: providerDefaultModel(settings);
		},
		effectiveEffort(): string {
			return this.effortOverride !== null && this.overrideProvider === settings.provider
				? this.effortOverride
				: providerDefaultEffort(settings);
		},
	};
	return s as unknown as ChatSession;
}

const claude = (): YunseulSettings => ({
	...DEFAULT_SETTINGS,
	provider: 'claude-code',
	claudeCode: { ...DEFAULT_SETTINGS.claudeCode, modelOverride: 'sonnet', effort: 'low' },
});
const codex = (): YunseulSettings => ({ ...DEFAULT_SETTINGS, provider: 'codex' });
const lm = (): YunseulSettings => ({
	...DEFAULT_SETTINGS,
	provider: 'lm-studio',
	lmStudio: { ...DEFAULT_SETTINGS.lmStudio, chatModel: 'local-7b' },
});

describe('provider defaults', () => {
	it('reads the model/effort defaults from the active provider group', () => {
		expect(providerDefaultModel(claude())).toBe('sonnet');
		expect(providerDefaultEffort(claude())).toBe('low');
		expect(providerDefaultModel(codex())).toBe('');
		expect(providerDefaultEffort(lm())).toBe('');
		expect(providerDefaultModel(lm())).toBe('local-7b');
	});

	it('labels and names each provider', () => {
		expect(providerDefaultModelLabel('claude-code')).toBe('claude (default)');
		expect(providerDefaultModelLabel('codex')).toBe('codex (default)');
		expect(providerDefaultModelLabel('lm-studio')).toBe('(no model)');
		expect(providerDisplayName('codex')).toBe('Codex');
	});
});

describe('runModelCommand', () => {
	it('with no argument reports the effective model and usage without changing anything', () => {
		const s = fakeSession(claude());
		const out = runModelCommand(s, claude(), '');
		expect(out.changed).toBe(false);
		expect(out.notice).toContain('Model for this chat: sonnet');
		expect(out.notice).toContain('/model default');
		expect(s.modelOverride).toBeNull();
	});

	it('sets the override, reports no change on a repeat, and resets on a reset word', () => {
		const s = fakeSession(claude());
		expect(runModelCommand(s, claude(), ' opus ')).toEqual({ notice: 'Model set to opus for this chat.', changed: true, ok: true });
		expect(s.modelOverride).toBe('opus');
		expect(s.effectiveModel()).toBe('opus');
		expect(runModelCommand(s, claude(), 'opus').changed).toBe(false);
		const reset = runModelCommand(s, claude(), 'default');
		expect(reset.changed).toBe(true);
		expect(s.modelOverride).toBeNull();
		expect(reset.notice).toContain('reset to the Claude Code default');
		expect(runModelCommand(s, claude(), 'default').changed).toBe(false);
	});

	it('rejects ids that fail the argv-safety pattern', () => {
		const s = fakeSession(claude());
		for (const bad of ['bad id', '--flag', 'a;b', '']) {
			if (bad === '') continue;
			const out = runModelCommand(s, claude(), bad);
			expect(out.changed).toBe(false);
			expect(out.ok).toBe(false);
			expect(out.notice).toContain('letters, digits');
		}
		expect(s.modelOverride).toBeNull();
		expect(runModelCommand(s, claude(), 'sonnet[1m]').changed).toBe(true);
	});

	it('names the backend default when nothing is configured', () => {
		const s = fakeSession(codex());
		expect(runModelCommand(s, codex(), '').notice).toContain('Model for this chat: Codex default');
	});
});

describe('runEffortCommand', () => {
	it('validates against the provider\'s level list and lower-cases the input', () => {
		const s = fakeSession(claude());
		expect(runEffortCommand(s, claude(), 'HIGH')).toEqual({ notice: 'Effort set to high for this chat.', changed: true, ok: true });
		const bad = runEffortCommand(s, claude(), 'bogus');
		expect(bad.changed).toBe(false);
		expect(bad.ok).toBe(false);
		expect(bad.notice).toBe('Effort must be one of: low, medium, high, xhigh, max.');
		expect(s.effortOverride).toBe('high');
	});

	it('reports the effective effort and usage with no argument, and resets', () => {
		const s = fakeSession(claude());
		const out = runEffortCommand(s, claude(), '');
		expect(out.changed).toBe(false);
		expect(out.notice).toContain('Effort for this chat: low');
		expect(out.notice).toContain('/effort <low|medium|high|xhigh|max>');
		s.effortOverride = 'max';
		expect(runEffortCommand(s, claude(), 'reset').changed).toBe(true);
		expect(s.effortOverride).toBeNull();
	});

	it('accepts the Codex-specific levels', () => {
		const s = fakeSession(codex());
		expect(runEffortCommand(s, codex(), 'xhigh').changed).toBe(true);
		expect(runEffortCommand(s, codex(), 'none').changed).toBe(true);
		expect(runEffortCommand(s, codex(), 'max').changed).toBe(false);
	});

	it('tells LM Studio users there is no effort setting', () => {
		const s = fakeSession(lm());
		expect(runEffortCommand(s, lm(), 'high')).toEqual({ notice: 'LM Studio has no effort setting.', changed: false, ok: true });
		expect(s.effortOverride).toBeNull();
	});
});

describe('provider scoping of the overrides', () => {
	it('an override set under Claude Code is inert under Codex and returns when switching back', () => {
		const settings: YunseulSettings = { ...DEFAULT_SETTINGS, provider: 'claude-code' };
		const s = fakeSession(settings);
		runModelCommand(s, settings, 'sonnet');
		runEffortCommand(s, settings, 'max');
		expect(s.effectiveModel()).toBe('sonnet');
		settings.provider = 'codex';
		expect(s.effectiveModel()).toBe('');
		expect(s.effectiveEffort()).toBe('');
		expect(runModelCommand(s, settings, '').notice).toContain('Model for this chat: Codex default');
		settings.provider = 'claude-code';
		expect(s.effectiveModel()).toBe('sonnet');
		expect(s.effectiveEffort()).toBe('max');
	});

	it('setting an override under another provider drops the previous pair', () => {
		const settings: YunseulSettings = { ...DEFAULT_SETTINGS, provider: 'claude-code' };
		const s = fakeSession(settings);
		runEffortCommand(s, settings, 'max');
		settings.provider = 'codex';
		runModelCommand(s, settings, 'gpt-x');
		expect(s.modelOverride).toBe('gpt-x');
		expect(s.effortOverride).toBeNull();
		expect(s.overrideProvider).toBe('codex');
	});
});
