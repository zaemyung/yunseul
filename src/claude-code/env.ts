// Subprocess environment hardening for the Claude Code CLI.
//
// The renderer's process.env can contain credentials and Electron
// internals the CLI doesn't need and shouldn't see. We forward a tiny
// set of locale/path vars and any CLAUDE_*/ANTHROPIC_*/AWS_* the user
// might rely on (Bedrock / Vertex auth lives in those). Explicit
// ELECTRON_RUN_AS_NODE (and anything else ELECTRON_*) is stripped.
//
// Pure module — reads process.env directly. No IO injection needed; the
// tests cover this via spawn-call inspection (see
// tests/claude-code.test.ts 'env hardening (regression)' describe).

import type { EnvMap } from './io';
// Narrow, explicitly-typed view of the global `process` (env, platform),
// shared with the other Node touch points; see util/node.ts for why.
import { nodeProcess } from '../util/node';

// Minimal env allowlist for the subprocess.
export const SAFE_ENV_VARS: ReadonlySet<string> = new Set([
	'PATH',
	'HOME',
	'USER',
	'LOGNAME',
	'LANG',
	'LC_ALL',
	'LC_CTYPE',
	'TERM',
	'SHELL',
	'TMPDIR',
	'TMP',
	'TEMP',
	'XDG_CONFIG_HOME',
	'XDG_DATA_HOME',
	'XDG_CACHE_HOME',
	'XDG_RUNTIME_DIR',
	'NODE_EXTRA_CA_CERTS',
	'HTTP_PROXY',
	'HTTPS_PROXY',
	'NO_PROXY',
	'http_proxy',
	'https_proxy',
	'no_proxy',
	'APPDATA',
	'LOCALAPPDATA',
	'PROGRAMFILES',
	'PROGRAMFILES(X86)',
	'SYSTEMROOT',
	'SYSTEMDRIVE',
	'WINDIR',
	'COMSPEC',
	'PATHEXT',
]);

/**
 * Auth/config prefixes the Claude Code CLI needs (OAuth, Console key,
 * Bedrock, Vertex). Admitted ONLY into the Claude process — Codex runs
 * model-issued shell commands that inherit its env, so Anthropic/AWS
 * credentials must never be visible there (and vice versa, see
 * src/codex/streamChat.ts CODEX_ENV_PREFIXES).
 */
export const CLAUDE_ENV_PREFIXES: readonly string[] = [
	'CLAUDE_',
	'ANTHROPIC_',
	'AWS_',
	'GOOGLE_',
	'VERTEX_',
];

/**
 * Build the allowlisted env for a provider subprocess: the shared
 * SAFE_ENV_VARS plus whatever `prefixes` the calling provider admits
 * (Claude: CLAUDE_ENV_PREFIXES; Codex: OPENAI_/CODEX_). With no prefixes
 * only the neutral variables pass.
 */
export function buildSafeEnv(prefixes: readonly string[] = []): EnvMap {
	// Justification (community review): we read process.env to construct
	// the SAFE_ENV subset the CLI subprocess (Claude Code or Codex)
	// inherits. The renderer's full env contains Electron internals and
	// unrelated credentials the CLI does not need; the allowlist +
	// ELECTRON_* strip is a hardening measure, NOT identity collection. No
	// env data leaves the user machine; it is handed to a locally-spawned
	// subprocess only.
	const out: EnvMap = {};
	const src = nodeProcess.env;
	for (const key of Object.keys(src)) {
		const v = src[key];
		if (v === undefined) continue;
		// Always strip Electron internals — these tell the binary the
		// parent process is a renderer, which can change CLI behavior.
		if (key === 'ELECTRON_RUN_AS_NODE' || key.startsWith('ELECTRON_')) continue;
		if (SAFE_ENV_VARS.has(key)) {
			out[key] = v;
			continue;
		}
		for (const prefix of prefixes) {
			if (key.startsWith(prefix)) {
				out[key] = v;
				break;
			}
		}
	}
	// Augment PATH with common install locations. Electron apps launched
	// from Finder/Dock on macOS get a stripped PATH that omits e.g.
	// /opt/homebrew/bin (where Homebrew-installed `claude` lives on Apple
	// Silicon). Appending these (NOT prepending — user PATH still wins
	// for collisions) makes the CLI discoverable on standard installs
	// without forcing users to type the absolute path in settings.
	out.PATH = augmentPath(out.PATH);
	return out;
}

export function augmentPath(existing: string | undefined): string {
	// Justification (community review): HOME / USERPROFILE are read only
	// to compute additional PATH entries for common CLI install locations
	// (Homebrew, npm-global, $HOME/.local/bin, etc.). The values never
	// leave the user machine — they become PATH segments handed to a
	// locally-spawned subprocess so the `claude` binary is discoverable
	// when Electron launches from Finder/Dock with a stripped PATH.
	const sep = nodeProcess.platform === 'win32' ? ';' : ':';
	const home = nodeProcess.env.HOME ?? nodeProcess.env.USERPROFILE ?? '';
	const additions = [
		'/opt/homebrew/bin',          // Apple Silicon Homebrew
		'/opt/homebrew/sbin',
		'/usr/local/bin',             // Intel Homebrew, common Unix
		'/usr/local/sbin',
		home.length > 0 ? `${home}/.local/bin` : '',
		home.length > 0 ? `${home}/.npm-global/bin` : '',
		home.length > 0 ? `${home}/.claude/local` : '',
		home.length > 0 ? `${home}/bin` : '',
	].filter((p) => p.length > 0);
	const seen = new Set<string>();
	const parts: string[] = [];
	const push = (p: string): void => {
		if (p.length === 0 || seen.has(p)) return;
		seen.add(p);
		parts.push(p);
	};
	if (existing !== undefined && existing.length > 0) {
		for (const p of existing.split(sep)) push(p);
	}
	for (const p of additions) push(p);
	return parts.join(sep);
}
