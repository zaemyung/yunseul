// Model catalog: what a backend can tell us about the models (and effort
// levels) a user may pick from. Feeds the `/model` and `/effort` pickers
// in the composer popover. Providers fill it from very different sources
// — Claude Code's documented CLI aliases, Codex's local model cache,
// LM Studio's /v1/models — so every field except `id` is optional and
// the UI degrades to "just the id".

export interface CatalogEffort {
	level: string;
	/** One-line description, when the backend supplies one. */
	detail?: string;
}

export interface CatalogModel {
	/** The id that is actually sent (alias, slug, or full model id). */
	id: string;
	/** Human-facing name; falls back to `id` in the UI. */
	label?: string;
	/** One-line description. */
	detail?: string;
	/** Effort levels this model accepts, when the backend knows per model. */
	efforts?: readonly CatalogEffort[];
	/** The level the backend uses for this model when none is set. */
	defaultEffort?: string;
}

export interface ModelCatalog {
	models: readonly CatalogModel[];
	/**
	 * The backend's own default model id when it is discoverable locally
	 * (Codex: the top-level `model` key of config.toml). Null when the
	 * backend keeps that to itself (Claude Code) or has no notion of it
	 * (LM Studio).
	 */
	defaultModel: string | null;
}

export const EMPTY_CATALOG: ModelCatalog = Object.freeze({ models: [], defaultModel: null });
