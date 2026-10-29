import type { CatalogEffort, CatalogModel } from '../llm/catalog';

// What the Claude Code CLI accepts for `--model` / `/model`. The CLI does
// not enumerate models in headless mode; its own `/model` reply lists
// these aliases ("Available: sonnet, opus, haiku, fable, best,
// sonnet[1m], opus[1m], fable[1m], opusplan, default, or a full model
// ID"). Descriptions paraphrase the Claude Code model-configuration
// docs and deliberately carry no version numbers, which drift.
//
// `default` is not listed here: the picker adds its own reset row.
export const CLAUDE_MODEL_ALIASES: readonly CatalogModel[] = Object.freeze([
	{ id: 'sonnet', label: 'Sonnet', detail: 'Latest Sonnet, for daily work' },
	{ id: 'opus', label: 'Opus', detail: 'Latest Opus, for complex reasoning' },
	{ id: 'haiku', label: 'Haiku', detail: 'Fast and efficient, for simple tasks' },
	{ id: 'fable', label: 'Fable', detail: 'For the hardest, longest-running tasks' },
	{ id: 'best', label: 'Best', detail: 'Fable where available to you, otherwise Opus' },
	{ id: 'sonnet[1m]', label: 'Sonnet 1M', detail: 'Sonnet with a 1M-token context window' },
	{ id: 'opus[1m]', label: 'Opus 1M', detail: 'Opus with a 1M-token context window' },
	{ id: 'fable[1m]', label: 'Fable 1M', detail: 'Fable with a 1M-token context window' },
	{ id: 'opusplan', label: 'Opus plan', detail: 'Opus while planning, Sonnet for execution' },
]);

// `claude --effort` levels (CLI 2.1.x: "low, medium, high, xhigh, max").
// The docs define the levels but no per-level copy; these lines are
// Yunseul's own, kept short and relative.
export const CLAUDE_EFFORTS: readonly CatalogEffort[] = Object.freeze([
	{ level: 'low', detail: 'Quickest replies, least reasoning' },
	{ level: 'medium', detail: 'Balanced speed and depth' },
	{ level: 'high', detail: 'Deeper reasoning for harder problems' },
	{ level: 'xhigh', detail: 'Extra depth for complex problems' },
	{ level: 'max', detail: 'Deepest reasoning the model offers' },
]);
