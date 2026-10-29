import { describe, expect, it } from 'vitest';
import {
	codexHomeDir,
	parseCodexConfigDefaultModel,
	parseCodexModelsCache,
	readCodexCatalog,
} from '../src/codex/catalog';

// Shape mirrors ~/.codex/models_cache.json as written by codex-cli
// 0.165.0 (fields trimmed to the ones we read, plus noise we ignore).
const CACHE = JSON.stringify({
	fetched_at: '2026-10-29T20:43:41Z',
	etag: 'W/"x"',
	client_version: '0.165.0',
	models: [
		{
			slug: 'gpt-6-astra', display_name: 'GPT-6-Astra', description: 'Frontier model.',
			visibility: 'list', priority: 2, default_reasoning_level: 'medium',
			supported_reasoning_levels: [
				{ effort: 'low', description: 'Fast' },
				{ effort: 'medium', description: 'Balanced' },
				{ effort: 'ultra', description: 'Max with delegation' },
			],
			model_messages: { persistent_instructions: 'never shown' },
		},
		{
			slug: 'gpt-6.1-sol', display_name: 'GPT-6.1-Sol', description: '  Latest   workhorse\nmodel.  ',
			visibility: 'list', priority: 1, default_reasoning_level: 'low',
			supported_reasoning_levels: [{ effort: 'low' }, { effort: 'max', description: 'Deepest' }],
		},
		{ slug: 'hidden-one', display_name: 'Hidden', visibility: 'hide', priority: 0 },
		{ slug: 'no-priority', visibility: 'list' },
		{ slug: 'bad slug with spaces', visibility: 'list', priority: 0 },
		{ slug: 'gpt-6.1-sol', visibility: 'list', priority: 0 },
		{ display_name: 'no slug at all', visibility: 'list' },
		'not an object',
	],
});

describe('parseCodexModelsCache', () => {
	it('keeps listed models, sorted by priority, with trimmed one-line copy and per-model efforts', () => {
		const models = parseCodexModelsCache(CACHE);
		expect(models).not.toBeNull();
		expect(models?.map((m) => m.id)).toEqual(['gpt-6.1-sol', 'gpt-6-astra', 'no-priority']);
		const sol = models?.[0];
		expect(sol?.label).toBe('GPT-6.1-Sol');
		expect(sol?.detail).toBe('Latest workhorse model.');
		expect(sol?.defaultEffort).toBe('low');
		expect(sol?.efforts).toEqual([{ level: 'low' }, { level: 'max', detail: 'Deepest' }]);
		const astra = models?.[1];
		expect(astra?.efforts?.map((e) => e.level)).toEqual(['low', 'medium', 'ultra']);
		expect(models?.[2]).toEqual({ id: 'no-priority' });
	});

	it('drops hidden, duplicate, malformed and non-object entries', () => {
		const ids = parseCodexModelsCache(CACHE)?.map((m) => m.id) ?? [];
		expect(ids).not.toContain('hidden-one');
		expect(ids).not.toContain('bad slug with spaces');
		expect(ids.filter((id) => id === 'gpt-6.1-sol')).toHaveLength(1);
	});

	it('returns null for non-JSON or a document without a models array', () => {
		expect(parseCodexModelsCache('{not json')).toBeNull();
		expect(parseCodexModelsCache('[]')).toBeNull();
		expect(parseCodexModelsCache('{"models": {}}')).toBeNull();
		expect(parseCodexModelsCache('null')).toBeNull();
	});

	it('returns an empty array for a well-formed cache with nothing pickable', () => {
		expect(parseCodexModelsCache('{"models": []}')).toEqual([]);
		expect(parseCodexModelsCache('{"models": [{"slug":"x","visibility":"hide"}]}')).toEqual([]);
	});

	it('accepts plain-string reasoning levels and ignores invalid ones', () => {
		const text = JSON.stringify({ models: [{ slug: 'm', supported_reasoning_levels: ['low', 'Bad Level', 'high', 'low'] }] });
		expect(parseCodexModelsCache(text)?.[0]?.efforts).toEqual([{ level: 'low' }, { level: 'high' }]);
	});

	it('truncates very long descriptions to one line', () => {
		const text = JSON.stringify({ models: [{ slug: 'm', description: 'x'.repeat(400) }] });
		const detail = parseCodexModelsCache(text)?.[0]?.detail ?? '';
		expect(detail.length).toBeLessThanOrEqual(160);
		expect(detail.endsWith('…')).toBe(true);
	});
});

describe('parseCodexConfigDefaultModel', () => {
	it('reads the root-table model key (basic or literal string, trailing comment ok)', () => {
		expect(parseCodexConfigDefaultModel('notify = ["x"]\nmodel = "gpt-6.1-sol"\nmodel_reasoning_effort = "medium"\n')).toBe('gpt-6.1-sol');
		expect(parseCodexConfigDefaultModel("model = 'o3' # comment\n")).toBe('o3');
		expect(parseCodexConfigDefaultModel('  model="gpt-x"\n')).toBe('gpt-x');
	});

	it('ignores model keys inside sections and other keys that merely start with "model"', () => {
		expect(parseCodexConfigDefaultModel('[profiles.fast]\nmodel = "gpt-mini"\n')).toBeNull();
		expect(parseCodexConfigDefaultModel('model_reasoning_effort = "high"\n[x]\nmodel = "y"\n')).toBeNull();
		expect(parseCodexConfigDefaultModel('model_provider = "openai"\n')).toBeNull();
	});

	it('rejects values that are not a valid model id', () => {
		expect(parseCodexConfigDefaultModel('model = "has space"\n')).toBeNull();
		expect(parseCodexConfigDefaultModel('model = ""\n')).toBeNull();
	});
});

describe('codexHomeDir', () => {
	it('prefers CODEX_HOME, then ~/.codex from HOME or USERPROFILE', () => {
		expect(codexHomeDir({ CODEX_HOME: '/custom', HOME: '/h' })).toBe('/custom');
		expect(codexHomeDir({ CODEX_HOME: '  ', HOME: '/h/' })).toBe('/h/.codex');
		expect(codexHomeDir({ USERPROFILE: 'C:\\Users\\me' })).toBe('C:\\Users\\me\\.codex');
		expect(codexHomeDir({})).toBeNull();
	});
});

describe('readCodexCatalog', () => {
	const files = (map: Record<string, string>) => ({
		readFile: async (p: string): Promise<string> => {
			const v = map[p];
			if (v === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
			return v;
		},
	});

	it('combines the cache and the config default', async () => {
		const cat = await readCodexCatalog(files({
			'/h/.codex/models_cache.json': CACHE,
			'/h/.codex/config.toml': 'model = "gpt-6.1-sol"\n',
		}), { HOME: '/h' });
		expect(cat.models.map((m) => m.id)).toEqual(['gpt-6.1-sol', 'gpt-6-astra', 'no-priority']);
		expect(cat.defaultModel).toBe('gpt-6.1-sol');
	});

	it('is empty (not an error) when neither file exists or the home is unknown', async () => {
		expect(await readCodexCatalog(files({}), { HOME: '/h' })).toEqual({ models: [], defaultModel: null });
		expect(await readCodexCatalog(files({}), {})).toEqual({ models: [], defaultModel: null });
	});

	it('warns once when the cache is not in the expected shape', async () => {
		const warnings: string[] = [];
		const cat = await readCodexCatalog(files({ '/h/.codex/models_cache.json': '{"nope":1}' }), { HOME: '/h' }, (m) => warnings.push(m));
		expect(cat.models).toEqual([]);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain('models_cache.json');
	});
});

describe('codexHomeDir on Windows', () => {
	it('prefers USERPROFILE over a Git Bash HOME, matching the Codex CLI', () => {
		expect(codexHomeDir({ HOME: '/c/Users/me', USERPROFILE: 'C:\\Users\\me', platform: 'win32' })).toBe('C:\\Users\\me\\.codex');
		expect(codexHomeDir({ HOME: '/c/Users/me', platform: 'win32' })).toBe('/c/Users/me/.codex');
		expect(codexHomeDir({ HOME: '/home/me', USERPROFILE: 'C:\\x', platform: 'linux' })).toBe('/home/me/.codex');
	});
});
