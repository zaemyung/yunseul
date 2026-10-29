import type { CatalogEffort, CatalogModel, ModelCatalog } from '../llm/catalog';
import { MODEL_OVERRIDE_PATTERN, EFFORT_PATTERN } from '../claude-code/constants';

// Codex's model catalog, read from the CLI's own local files so the
// `/model` and `/effort` pickers can list what the account really offers
// (`codex exec` has no "list models" command).
//
//   $CODEX_HOME/models_cache.json  — the catalog the Codex CLI fetches from
//        the server and refreshes on its own runs. Verified shape (codex-cli
//        0.165.0): { fetched_at, etag, client_version, identity, models: [
//        { slug, display_name, description, visibility: "list"|"hide",
//          priority, default_reasoning_level,
//          supported_reasoning_levels: [{ effort, description }], … } ] }.
//   $CODEX_HOME/config.toml        — top-level `model = "…"` is the default
//        the CLI uses when `-m` is absent.
//
// Both are optional: a missing or unreadable file yields an empty catalog
// and the picker falls back to "type an id". Nothing is written, and
// nothing read here leaves the machine. $CODEX_HOME defaults to ~/.codex.

const CATALOG_MAX_MODELS = 64;

interface RawLevel {
	effort?: unknown;
	description?: unknown;
}

interface RawModel {
	slug?: unknown;
	display_name?: unknown;
	description?: unknown;
	visibility?: unknown;
	priority?: unknown;
	default_reasoning_level?: unknown;
	supported_reasoning_levels?: unknown;
}

function str(v: unknown): string | undefined {
	return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function oneLine(v: unknown, max = 160): string | undefined {
	const s = str(v);
	if (s === undefined) return undefined;
	const flat = s.replace(/\s+/g, ' ').trim();
	if (flat.length === 0) return undefined;
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function parseEfforts(v: unknown): CatalogEffort[] | undefined {
	if (!Array.isArray(v)) return undefined;
	const out: CatalogEffort[] = [];
	const seen = new Set<string>();
	for (const entry of v) {
		const level = typeof entry === 'string' ? entry : str((entry as RawLevel | null)?.effort);
		if (level === undefined || !EFFORT_PATTERN.test(level) || seen.has(level)) continue;
		seen.add(level);
		const detail = typeof entry === 'string' ? undefined : oneLine((entry as RawLevel).description);
		out.push(detail === undefined ? { level } : { level, detail });
	}
	return out.length > 0 ? out : undefined;
}

/**
 * Parse the contents of models_cache.json. Returns null when the text is
 * not the expected document (so callers can log once); an empty array
 * when it is but lists nothing pickable.
 */
export function parseCodexModelsCache(text: string): CatalogModel[] | null {
	let doc: unknown;
	try {
		doc = JSON.parse(text);
	} catch {
		return null;
	}
	if (doc === null || typeof doc !== 'object') return null;
	const raw = (doc as { models?: unknown }).models;
	if (!Array.isArray(raw)) return null;

	const rows: Array<{ model: CatalogModel; priority: number }> = [];
	const seen = new Set<string>();
	for (const entry of raw) {
		if (entry === null || typeof entry !== 'object') continue;
		const m = entry as RawModel;
		const slug = str(m.slug);
		if (slug === undefined || !MODEL_OVERRIDE_PATTERN.test(slug) || seen.has(slug)) continue;
		// "hide" marks models the CLI's own picker does not list.
		if (m.visibility !== undefined && m.visibility !== 'list') continue;
		seen.add(slug);
		const model: CatalogModel = { id: slug };
		const label = oneLine(m.display_name, 80);
		if (label !== undefined) model.label = label;
		const detail = oneLine(m.description);
		if (detail !== undefined) model.detail = detail;
		const efforts = parseEfforts(m.supported_reasoning_levels);
		if (efforts !== undefined) model.efforts = efforts;
		const def = str(m.default_reasoning_level);
		if (def !== undefined && EFFORT_PATTERN.test(def)) model.defaultEffort = def;
		const priority = typeof m.priority === 'number' && Number.isFinite(m.priority) ? m.priority : Number.POSITIVE_INFINITY;
		rows.push({ model, priority });
	}
	rows.sort((a, b) => (a.priority - b.priority) || a.model.id.localeCompare(b.model.id));
	return rows.slice(0, CATALOG_MAX_MODELS).map((r) => r.model);
}

/**
 * The top-level `model = "…"` of config.toml, or null. Only the root
 * table counts: a `model` under `[profiles.x]` or any other section is
 * not what a bare `codex exec` uses. Deliberately not a TOML parser —
 * one line, basic or literal string, optional trailing comment.
 */
export function parseCodexConfigDefaultModel(text: string): string | null {
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (line.startsWith('[')) break;
		const m = /^model\s*=\s*(?:"([^"\\]*)"|'([^']*)')\s*(?:#.*)?$/.exec(line);
		if (m === null) continue;
		const value = m[1] ?? m[2] ?? '';
		return MODEL_OVERRIDE_PATTERN.test(value) ? value : null;
	}
	return null;
}

export interface CatalogFiles {
	readFile(path: string): Promise<string>;
}

export interface CodexHomeEnv {
	CODEX_HOME?: string;
	HOME?: string;
	USERPROFILE?: string;
	/** `process.platform`; on win32 the home is USERPROFILE first, as the Codex CLI resolves it. */
	platform?: string;
}

/** `$CODEX_HOME`, else `~/.codex`; null when neither is known. */
export function codexHomeDir(env: CodexHomeEnv): string | null {
	const explicit = env.CODEX_HOME?.trim();
	if (explicit !== undefined && explicit.length > 0) return explicit;
	// Codex (Rust `dirs::home_dir`) uses USERPROFILE on Windows even when a
	// Git Bash / MSYS shell exports HOME; follow it so both read the same
	// directory.
	const home = (env.platform === 'win32' ? (env.USERPROFILE ?? env.HOME) : (env.HOME ?? env.USERPROFILE)) ?? '';
	if (home.length === 0) return null;
	const sep = home.includes('\\') && !home.includes('/') ? '\\' : '/';
	return `${home.replace(/[\\/]+$/, '')}${sep}.codex`;
}

export async function readCodexCatalog(
	files: CatalogFiles,
	env: CodexHomeEnv,
	warn: (msg: string) => void = () => {},
): Promise<ModelCatalog> {
	const home = codexHomeDir(env);
	if (home === null) return { models: [], defaultModel: null };
	const sep = home.includes('\\') && !home.includes('/') ? '\\' : '/';

	let models: CatalogModel[] = [];
	try {
		const text = await files.readFile(`${home}${sep}models_cache.json`);
		const parsed = parseCodexModelsCache(text);
		if (parsed === null) warn('codex: models_cache.json is not in the expected shape; the model picker will be empty.');
		else models = parsed;
	} catch {
		// Not there yet (Codex has never run) or unreadable: fine.
	}

	let defaultModel: string | null = null;
	try {
		defaultModel = parseCodexConfigDefaultModel(await files.readFile(`${home}${sep}config.toml`));
	} catch {
		// No config.toml is normal.
	}
	return { models, defaultModel };
}
