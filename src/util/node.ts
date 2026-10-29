// Typed access to the Node built-ins the CLI providers need.
//
// Obsidian's community review lints plugin sources with the typed
// @typescript-eslint rules but WITHOUT @types/node, so there every value
// that comes out of `child_process`, `fs`, `os`, `path`, or the global
// `process` is `any`, and each use site trips a no-unsafe-* rule. The
// explicit views below narrow each helper to the signature Yunseul
// relies on, so every caller is fully typed in both environments: here
// tsc checks the view against the real Node typings, there the view is
// simply the type. Keep every Node import in this file.
import { spawn as nodeSpawn } from 'child_process';
import { promises as nodeFs } from 'fs';
import { tmpdir as nodeTmpdir } from 'os';
import { join as nodeJoin } from 'path';
import type { EnvMap, SpawnedProc } from '../claude-code/io';

/** `child_process.spawn` as the lifecycle module consumes it (argv array, no shell). */
export type SpawnFn = (cmd: string, args: string[], opts: { cwd: string; env: EnvMap }) => SpawnedProc;
export const spawn: SpawnFn = nodeSpawn as SpawnFn;

interface FsView {
	writeFile(path: string, data: string, opts: { encoding: 'utf8'; flag: 'wx' }): Promise<void>;
	unlink(path: string): Promise<void>;
	mkdir(path: string, opts: { recursive: boolean }): Promise<unknown>;
	readFile(path: string, opts: { encoding: 'utf8' }): Promise<string>;
}
const fs = nodeFs as FsView;

/**
 * Create a file, refusing to overwrite: the `wx` flag is the defence
 * against symlink-replace attacks where a vault sync (Obsidian Sync, git,
 * Syncthing) drops a stale symlink at the target path.
 */
export const writeFileExclusive = (path: string, data: string): Promise<void> =>
	fs.writeFile(path, data, { encoding: 'utf8', flag: 'wx' });
export const unlink = (path: string): Promise<void> => fs.unlink(path);
export const mkdirp = async (path: string, opts: { recursive: boolean }): Promise<void> => {
	await fs.mkdir(path, opts);
};
export const readTextFile = (path: string): Promise<string> => fs.readFile(path, { encoding: 'utf8' });

export const joinPath: (...parts: string[]) => string = nodeJoin as (...parts: string[]) => string;
export const osTmpdir: () => string = nodeTmpdir as () => string;

/**
 * Narrow view of the global `process`: the members Yunseul reads (env for
 * the subprocess allowlist and the Codex home, platform for path
 * separators, cwd for the version probe). Nothing here leaves the
 * machine; see env.ts for the allowlist rationale.
 */
export interface ProcessView {
	env: EnvMap;
	platform: string;
	cwd(): string;
}
export const nodeProcess: ProcessView = process as ProcessView;
