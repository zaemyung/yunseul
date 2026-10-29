import { EMPTY_CATALOG, type CatalogEffort, type ModelCatalog } from '../llm/catalog';
import type { Provider, YunseulSettings } from '../settings';
import { effortLevelsFor } from '../claude-code/slash';
import { CLAUDE_EFFORTS } from '../claude-code/models';
import { providerDefaultEffort, providerDefaultModel, providerDisplayName } from './localCommands';

// Rows for the `/model` and `/effort` pickers in the composer popover.
// Pure: the view hands in the settings, the chat's active overrides, and
// the provider's catalog state; this decides what to list, in what
// order, and which row is "current". Kept free of DOM so the ordering
// and labelling rules are unit-testable.
//
// Every picker starts with a `default` row (= `/model default`, which
// clears the chat override) so the reset path is one keystroke away,
// exactly like the CLIs' own pickers.

export interface PickerItem {
	/** What `/model <value>` or `/effort <value>` receives; `default` resets. */
	value: string;
	/** One-line description, muted in the UI. */
	detail?: string;
	/** In effect for this chat right now. */
	current?: boolean;
}

export type CatalogStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface CatalogState {
	status: CatalogStatus;
	catalog: ModelCatalog;
	/** Short reason when status is 'error'. */
	error: string | null;
}

export const IDLE_CATALOG: CatalogState = Object.freeze({ status: 'idle', catalog: EMPTY_CATALOG, error: null });

export interface PickerContext {
	settings: YunseulSettings;
	state: CatalogState;
	/** The chat's `/model` override when it belongs to the active provider, else null. */
	modelOverride: string | null;
	/** The chat's `/effort` override when it belongs to the active provider, else null. */
	effortOverride: string | null;
}

export const DEFAULT_VALUE = 'default';

function defaultModelDetail(ctx: PickerContext): string {
	const provider = ctx.settings.provider;
	const fromSettings = providerDefaultModel(ctx.settings);
	if (fromSettings.length > 0) return `Settings default · ${fromSettings}`;
	const fromBackend = ctx.state.catalog.defaultModel;
	if (fromBackend !== null) return `${providerDisplayName(provider)} default · ${fromBackend}`;
	if (provider === 'lm-studio') return 'No model configured in Settings';
	return `${providerDisplayName(provider)} picks`;
}

/** Rows for `/model`: default, then the catalog (plus the override if it is a custom id). */
export function modelPickerItems(ctx: PickerContext): PickerItem[] {
	const override = ctx.modelOverride;
	const defaultRow: PickerItem = { value: DEFAULT_VALUE, detail: defaultModelDetail(ctx) };
	if (override === null) defaultRow.current = true;
	const items: PickerItem[] = [defaultRow];
	let overrideListed = false;
	for (const m of ctx.state.catalog.models) {
		if (m.id === DEFAULT_VALUE) continue;
		const current = override === m.id;
		if (current) overrideListed = true;
		const item: PickerItem = { value: m.id };
		if (m.detail !== undefined) item.detail = m.detail;
		if (current) item.current = true;
		items.push(item);
	}
	if (override !== null && !overrideListed) {
		items.splice(1, 0, { value: override, detail: 'Custom id set for this chat', current: true });
	}
	return items;
}

/**
 * The model whose effort levels apply right now: the chat's effective
 * model, else the backend's own default when the catalog knows it.
 */
export function effortModelId(ctx: PickerContext): string {
	const fromChat = ctx.modelOverride ?? providerDefaultModel(ctx.settings);
	if (fromChat.length > 0) return fromChat;
	return ctx.state.catalog.defaultModel ?? '';
}

function knownEfforts(ctx: PickerContext): { efforts: readonly CatalogEffort[]; defaultEffort: string | null } {
	const provider: Provider = ctx.settings.provider;
	if (provider === 'claude-code') return { efforts: CLAUDE_EFFORTS, defaultEffort: null };
	const models = ctx.state.catalog.models;
	const modelId = effortModelId(ctx);
	const exact = models.find((m) => m.id === modelId);
	if (exact?.efforts !== undefined) {
		return { efforts: exact.efforts, defaultEffort: exact.defaultEffort ?? null };
	}
	// Unknown or unlisted model: offer the union of what the catalog's
	// models accept, keeping the first description seen per level.
	const union = new Map<string, CatalogEffort>();
	for (const m of models) {
		for (const e of m.efforts ?? []) if (!union.has(e.level)) union.set(e.level, e);
	}
	return { efforts: Array.from(union.values()), defaultEffort: null };
}

/**
 * Rows for `/effort`: default, then the levels. Only levels in the
 * provider's static list (effortLevelsFor) are offered, in that order,
 * so a picked row can never be rejected by the command validator;
 * backend descriptions are attached when known. Empty when the
 * provider has no effort setting (LM Studio).
 */
export function effortPickerItems(ctx: PickerContext): PickerItem[] {
	const provider = ctx.settings.provider;
	const allowed = effortLevelsFor(provider);
	if (allowed.length === 0) return [];
	const override = ctx.effortOverride;
	const { efforts, defaultEffort } = knownEfforts(ctx);

	const fromSettings = providerDefaultEffort(ctx.settings);
	let detail: string;
	if (fromSettings.length > 0) detail = `Settings default · ${fromSettings}`;
	else if (defaultEffort !== null) detail = `Model default · ${defaultEffort}`;
	else detail = `${providerDisplayName(provider)} default`;
	const defaultRow: PickerItem = { value: DEFAULT_VALUE, detail };
	if (override === null) defaultRow.current = true;
	const items: PickerItem[] = [defaultRow];

	// With per-model knowledge, list that model's levels; without any,
	// list the whole static set. While the first fetch is still out and
	// nothing is known yet, list only the reset row under the "Loading
	// effort levels…" status rather than a set that shrinks a moment
	// later under the cursor.
	const pending = provider !== 'claude-code'
		&& ctx.state.status === 'loading'
		&& ctx.state.catalog.models.length === 0;
	const levels = pending
		? []
		: efforts.length > 0
			? allowed.filter((level) => efforts.some((e) => e.level === level))
			: allowed;
	let overrideListed = false;
	for (const level of levels) {
		const known = efforts.find((e) => e.level === level);
		const current = override === level;
		if (current) overrideListed = true;
		const item: PickerItem = { value: level };
		if (known?.detail !== undefined) item.detail = known.detail;
		if (current) item.current = true;
		items.push(item);
	}
	if (override !== null && !overrideListed) {
		items.splice(1, 0, { value: override, detail: 'Set for this chat', current: true });
	}
	return items;
}

/**
 * Status row text for a picker (loading / failed / nothing listed), or
 * null when the rows speak for themselves. Claude Code's model aliases
 * and every provider's static effort list need no fetch, so they never
 * show one.
 */
export function pickerStatus(kind: 'model' | 'effort', provider: Provider, state: CatalogState): string | null {
	if (kind === 'effort' && provider !== 'codex') return null;
	if (kind === 'model' && provider === 'claude-code') return null;
	switch (state.status) {
		case 'loading':
			return kind === 'model' ? 'Loading models…' : 'Loading effort levels…';
		case 'error':
			return kind === 'model' ? `Couldn't list models: ${state.error ?? 'unknown error'}` : null;
		case 'ready':
			if (kind === 'model' && state.catalog.models.length === 0) {
				return provider === 'codex'
					? 'No Codex model catalog found yet. Run codex once, or type a model id.'
					: 'No models loaded. Type a model id.';
			}
			return null;
		default:
			return null;
	}
}
