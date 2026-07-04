// IO contract for the Claude Code subprocess client. Kept in its own
// leaf module (no node or obsidian imports at all) so every other
// claude-code submodule (streamChat, sysprompt, lifecycle, probe) can
// reference the shared shape without importing through the orchestrator
// (client.ts). This breaks the source-level type-only cycle between
// client.ts and streamChat.ts that the audit flagged: streamChat.ts now
// imports `ClaudeCodeIO` from this leaf, not from client.ts.
//
// We keep DEFAULT_IO inside client.ts because it pulls in node's
// `child_process` and `fs/promises` and we want the IO definition to
// remain importable from test contexts that stub the bindings.
//
// The subprocess types below are STRUCTURAL on purpose — we declare the
// exact surface we consume instead of importing `ChildProcess` from
// 'child_process'. Node's real ChildProcess satisfies them, test mocks
// satisfy them trivially, and every submodule except the client.ts
// composition root typechecks without @types/node (which is also what
// the community plugin review lints against).

/** Environment map handed to the subprocess (allowlisted — see env.ts). */
export type EnvMap = Record<string, string | undefined>;

/**
 * Error surfaced by the spawn layer. Node decorates these with a string
 * `code` ('ENOENT' for a missing binary, 'EPIPE' for a closed stdin).
 */
export type SpawnError = Error & { code?: string };

/** Readable side (stdout/stderr) surface the lifecycle consumes. */
export interface ProcReadable {
	on(event: 'data', listener: (chunk: Uint8Array | string) => void): void;
	removeAllListeners(event: 'data'): void;
}

/** Writable side (stdin) surface the lifecycle consumes. */
export interface ProcWritable {
	on(event: 'error', listener: (err: SpawnError) => void): void;
	write(data: string): void;
	end(): void;
}

/**
 * Structural subset of node's ChildProcess that lifecycle/probe drive.
 * `kill` takes only the two signals we actually send; `exitCode` and
 * `signalCode` back the SIGTERM→SIGKILL escalation check.
 */
export interface SpawnedProc {
	stdout: ProcReadable | null;
	stderr: ProcReadable | null;
	stdin: ProcWritable | null;
	exitCode: number | null;
	signalCode: string | null;
	kill(signal?: 'SIGTERM' | 'SIGKILL'): boolean;
	on(event: 'error', listener: (err: SpawnError) => void): void;
	on(event: 'close', listener: (code: number | null) => void): void;
}

/**
 * IO surface the Claude Code provider uses to drive a subprocess. The
 * client owns the real implementation (DEFAULT_IO in client.ts) that
 * shells out to node's `child_process` + `fs/promises`. Tests inject a
 * mock variant via the ClaudeCodeClient constructor so they can drive
 * the lifecycle deterministically.
 *
 * Each method intentionally matches its node equivalent's signature so
 * the default implementation is a thin pass-through:
 *   spawn:     child_process.spawn(cmd, args, { cwd, env })
 *   writeFile: fs.promises.writeFile(path, data, { encoding, flag })
 *   unlink:    fs.promises.unlink(path)
 *   mkdir:     fs.promises.mkdir(path, { recursive })
 */
export interface ClaudeCodeIO {
	spawn: (cmd: string, args: string[], opts: { cwd: string; env: EnvMap }) => SpawnedProc;
	writeFile: (path: string, data: string) => Promise<void>;
	unlink: (path: string) => Promise<void>;
	mkdir: (path: string, opts: { recursive: boolean }) => Promise<void>;
}
