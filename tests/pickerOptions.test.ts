import { describe, expect, it } from 'vitest';
import {
	effortModelId,
	effortPickerItems,
	IDLE_CATALOG,
	modelPickerItems,
	pickerStatus,
	type CatalogState,
	type PickerContext,
} from '../src/chat/pickerOptions';
import { CLAUDE_MODEL_ALIASES } from '../src/claude-code/models';
import type { ModelCatalog } from '../src/llm/catalog';
import type { Provider, YunseulSettings } from '../src/settings';

function settings(provider: Provider, patch: { claudeModel?: string; claudeEffort?: string; codexModel?: string; codexEffort?: string; lmModel?: string } = {}): YunseulSettings {
	return {
		schemaVersion: 1,
		provider,
		lmStudio: { baseUrl: 'http://x', apiKey: '', chatModel: patch.lmModel ?? '', temperature: 0.7, maxContextChars: 12000, maxConversationRounds: 10 },
		claudeCode: { binary: '', modelOverride: patch.claudeModel ?? '', effort: patch.claudeEffort ?? '', enableWrites: false, knownSlashCommands: [] },
		codex: { binary: '', model: patch.codexModel ?? '', effort: patch.codexEffort ?? '', enableWrites: false },
		chat: { suggestions: [], downloadFolder: 'AI Chats' },
		index: { enabled: false, topK: 8, excludeTags: [], promptState: 'unanswered' },
		privacy: { allowExternalImages: false, treatClippingsAsUntrusted: true, clippingsFolder: 'Clippings' },
		debug: false,
	};
}

const ready = (catalog: ModelCatalog): CatalogState => ({ status: 'ready', catalog, error: null });

const CODEX_CATALOG: ModelCatalog = {
	defaultModel: 'gpt-6.1-sol',
	models: [
		{
			id: 'gpt-6.1-sol', detail: 'Workhorse', defaultEffort: 'low',
			efforts: [{ level: 'low', detail: 'Fast' }, { level: 'medium' }, { level: 'max', detail: 'Deepest' }, { level: 'ultra', detail: 'Delegates' }],
		},
		{ id: 'gpt-6-astra', detail: 'Frontier', efforts: [{ level: 'xhigh' }, { level: 'ultra' }] },
	],
};

const ctx = (provider: Provider, state: CatalogState, overrides: { model?: string | null; effort?: string | null } = {}, s?: YunseulSettings): PickerContext => ({
	settings: s ?? settings(provider),
	state,
	modelOverride: overrides.model ?? null,
	effortOverride: overrides.effort ?? null,
});

describe('modelPickerItems', () => {
	it('starts with a current "default" row and lists the Claude aliases with descriptions', () => {
		const items = modelPickerItems(ctx('claude-code', ready({ models: CLAUDE_MODEL_ALIASES, defaultModel: null })));
		expect(items[0]).toEqual({ value: 'default', detail: 'Claude Code picks', current: true });
		expect(items.slice(1).map((i) => i.value)).toEqual(CLAUDE_MODEL_ALIASES.map((m) => m.id));
		expect(items.find((i) => i.value === 'opusplan')?.detail).toBe('Opus while planning, Sonnet for execution');
		expect(items.filter((i) => i.current === true)).toHaveLength(1);
	});

	it('marks the override as current and names the Settings default on the default row', () => {
		const s = settings('claude-code', { claudeModel: 'sonnet' });
		const items = modelPickerItems(ctx('claude-code', ready({ models: CLAUDE_MODEL_ALIASES, defaultModel: null }), { model: 'opus' }, s));
		expect(items[0]).toEqual({ value: 'default', detail: 'Settings default · sonnet' });
		expect(items.find((i) => i.value === 'opus')?.current).toBe(true);
		expect(items.filter((i) => i.current === true)).toHaveLength(1);
	});

	it('inserts an unlisted override right after default and names the Codex config default', () => {
		const items = modelPickerItems(ctx('codex', ready(CODEX_CATALOG), { model: 'gpt-custom' }));
		expect(items[0]?.detail).toBe('Codex default · gpt-6.1-sol');
		expect(items[1]).toEqual({ value: 'gpt-custom', detail: 'Custom id set for this chat', current: true });
		expect(items.slice(2).map((i) => i.value)).toEqual(['gpt-6.1-sol', 'gpt-6-astra']);
	});

	it('offers just the default row before any catalog arrived (LM Studio, no model configured)', () => {
		expect(modelPickerItems(ctx('lm-studio', IDLE_CATALOG))).toEqual([
			{ value: 'default', detail: 'No model configured in Settings', current: true },
		]);
	});
});

describe('effortPickerItems', () => {
	it('is empty for LM Studio', () => {
		expect(effortPickerItems(ctx('lm-studio', IDLE_CATALOG))).toEqual([]);
	});

	it('lists every Claude level with a description and a default row', () => {
		const items = effortPickerItems(ctx('claude-code', IDLE_CATALOG));
		expect(items.map((i) => i.value)).toEqual(['default', 'low', 'medium', 'high', 'xhigh', 'max']);
		expect(items[0]?.detail).toBe('Claude Code default');
		expect(items.every((i) => typeof i.detail === 'string' && i.detail.length > 0)).toBe(true);
	});

	it('uses the current Codex model\'s levels, in canonical order, with the model default named', () => {
		const items = effortPickerItems(ctx('codex', ready(CODEX_CATALOG)));
		expect(items.map((i) => i.value)).toEqual(['default', 'low', 'medium', 'max', 'ultra']);
		expect(items[0]?.detail).toBe('Model default · low');
		expect(items.find((i) => i.value === 'ultra')?.detail).toBe('Delegates');
		expect(items[0]?.current).toBe(true);
	});

	it('follows the chat\'s model override when choosing which levels to list', () => {
		const items = effortPickerItems(ctx('codex', ready(CODEX_CATALOG), { model: 'gpt-6-astra', effort: 'ultra' }));
		expect(items.map((i) => i.value)).toEqual(['default', 'xhigh', 'ultra']);
		expect(items.find((i) => i.value === 'ultra')?.current).toBe(true);
		expect(items[0]?.current).toBeUndefined();
	});

	it('falls back to the union of catalog levels for an unlisted model, and to the static list without a catalog', () => {
		const union = effortPickerItems(ctx('codex', ready(CODEX_CATALOG), { model: 'gpt-unknown' }));
		expect(union.map((i) => i.value)).toEqual(['default', 'low', 'medium', 'xhigh', 'max', 'ultra']);
		const stat = effortPickerItems(ctx('codex', IDLE_CATALOG));
		expect(stat.map((i) => i.value)).toEqual(['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
		expect(stat[0]?.detail).toBe('Codex default');
	});

	it('prefers the Settings default effort on the default row and surfaces an unlisted override', () => {
		const s = settings('codex', { codexEffort: 'medium' });
		const items = effortPickerItems(ctx('codex', ready(CODEX_CATALOG), { effort: 'minimal' }, s));
		expect(items[0]?.detail).toBe('Settings default · medium');
		expect(items[1]).toEqual({ value: 'minimal', detail: 'Set for this chat', current: true });
	});
});

describe('effortModelId', () => {
	it('resolves chat override, then Settings, then the backend default', () => {
		expect(effortModelId(ctx('codex', ready(CODEX_CATALOG), { model: 'a' }))).toBe('a');
		expect(effortModelId(ctx('codex', ready(CODEX_CATALOG), {}, settings('codex', { codexModel: 'b' })))).toBe('b');
		expect(effortModelId(ctx('codex', ready(CODEX_CATALOG)))).toBe('gpt-6.1-sol');
		expect(effortModelId(ctx('codex', IDLE_CATALOG))).toBe('');
	});
});

describe('pickerStatus', () => {
	it('never shows a status for static lists', () => {
		expect(pickerStatus('model', 'claude-code', { status: 'loading', catalog: { models: [], defaultModel: null }, error: null })).toBeNull();
		expect(pickerStatus('effort', 'claude-code', { status: 'loading', catalog: { models: [], defaultModel: null }, error: null })).toBeNull();
		expect(pickerStatus('effort', 'lm-studio', IDLE_CATALOG)).toBeNull();
	});

	it('reports loading, failure, and an empty result for fetched lists', () => {
		const loading: CatalogState = { status: 'loading', catalog: { models: [], defaultModel: null }, error: null };
		expect(pickerStatus('model', 'lm-studio', loading)).toBe('Loading models…');
		expect(pickerStatus('effort', 'codex', loading)).toBe('Loading effort levels…');
		expect(pickerStatus('model', 'codex', { status: 'error', catalog: { models: [], defaultModel: null }, error: 'EACCES' })).toBe("Couldn't list models: EACCES");
		expect(pickerStatus('effort', 'codex', { status: 'error', catalog: { models: [], defaultModel: null }, error: 'EACCES' })).toBeNull();
		expect(pickerStatus('model', 'codex', ready({ models: [], defaultModel: null }))).toContain('Run codex once');
		expect(pickerStatus('model', 'lm-studio', ready({ models: [], defaultModel: null }))).toBe('No models loaded. Type a model id.');
		expect(pickerStatus('model', 'lm-studio', ready({ models: [{ id: 'm' }], defaultModel: null }))).toBeNull();
	});
});

describe('effortPickerItems while the first Codex fetch is pending', () => {
	it('lists only the reset row (the status row explains) instead of a list that shrinks later', () => {
		const loading: CatalogState = { status: 'loading', catalog: { models: [], defaultModel: null }, error: null };
		expect(effortPickerItems(ctx('codex', loading))).toEqual([{ value: 'default', detail: 'Codex default', current: true }]);
		// Claude's list is static and never waits.
		expect(effortPickerItems(ctx('claude-code', loading)).map((i) => i.value)).toEqual(['default', 'low', 'medium', 'high', 'xhigh', 'max']);
		// A re-fetch with a previous catalog still in hand keeps listing it.
		const refetch: CatalogState = { status: 'loading', catalog: CODEX_CATALOG, error: null };
		expect(effortPickerItems(ctx('codex', refetch)).map((i) => i.value)).toEqual(['default', 'low', 'medium', 'max', 'ultra']);
	});
});
