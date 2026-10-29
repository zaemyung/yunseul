import obsidianmd from 'eslint-plugin-obsidianmd';
import globals from 'globals';
import { defineConfig, globalIgnores } from 'eslint/config';

export default defineConfig(
	globalIgnores([
		'node_modules',
		'dist',
		'coverage',
		'esbuild.config.mjs',
		'version-bump.mjs',
		'versions.json',
		'main.js',
		'package.json',
		'package-lock.json',
		'tsconfig.json',
		'tests/**',
		'vitest.config.ts',
	]),
	{
		languageOptions: {
			globals: {
				...globals.browser,
			},
			parserOptions: {
				projectService: {
					allowDefaultProject: ['eslint.config.mts', 'manifest.json'],
				},
				tsconfigRootDir: import.meta.dirname,
				extraFileExtensions: ['.json'],
			},
		},
	},
	...obsidianmd.configs.recommended,
	{
		// Project-specific overrides applied AFTER the recommended preset so they win.
		rules: {
			'@typescript-eslint/no-unused-vars': ['warn', {
				argsIgnorePattern: '^_',
				varsIgnorePattern: '^_',
				caughtErrorsIgnorePattern: '^_',
			}],
			// Disabled: the rule's case-folder mangles legitimate URLs (http://, /v1/models),
			// API names (requestUrl), acronyms (CORS), and version labels (MVP, V1).
			// Our settings strings are already in sentence case for normal prose.
			'obsidianmd/ui/sentence-case': 'off',
		},
	},
	{
		// LMStudio client needs raw `fetch` for two narrow purposes:
		//   1. streaming SSE — requestUrl returns the whole body at once,
		//      which would defeat token-by-token streaming.
		//   2. probeDetailed — compares fetch (CORS-aware) vs requestUrl
		//      (CORS-bypassing) to distinguish CORS-blocked from offline.
		// Switching to requestUrl in either path would silently break
		// streaming or hide a misconfiguration error users need to fix.
		// Scoped override: the obsidianmd preset's `no-restricted-globals`
		// rule (which forbids `fetch`) is reset here without affecting the
		// other restricted globals (`app`, `localStorage`). An inline
		// eslint-disable is not an option — the preset forbids disabling
		// that rule inline — so the community review, which lints with the
		// preset alone, keeps reporting these two calls as warnings.
		files: ['src/lmstudio/client.ts'],
		rules: {
			'no-restricted-globals': ['error',
				{
					name: 'app',
					message: 'Avoid using the global app object. Instead use the reference provided by your plugin instance.',
				},
				{
					name: 'localStorage',
					message: 'Prefer `App#saveLocalStorage` / `App#loadLocalStorage` functions to write / read localStorage data that\'s unique to a vault.',
				},
			],
		},
	},
	{
		// util/node.ts narrows the Node built-ins with `as` views so the
		// community review's lint (typed rules, no @types/node) sees typed
		// values. With @types/node present the assertions are redundant by
		// construction; tsc still checks each one for comparability.
		files: ['src/util/node.ts'],
		rules: {
			'@typescript-eslint/no-unnecessary-type-assertion': 'off',
		},
	},
	{
		// settings.ts still calls the deprecated PluginSettingTab#display()
		// as a re-render seam. The replacement getSettingDefinitions API
		// (added in 1.13.0) would require a wholesale rewrite from the
		// imperative DOM-building pattern to a declarative description.
		// Tracked as a future refactor; the override exists so the warning
		// doesn't drown out other lint output.
		files: ['src/settings.ts'],
		rules: {
			'@typescript-eslint/no-deprecated': 'off',
			'obsidianmd/settings-tab/prefer-setting-definitions': 'off',
		},
	},
);
