// Justification (community review): the Codex provider spawns the
// user-installed `codex` CLI with a fixed argv (no shell), an allowlisted
// env (env.ts + OPENAI_/CODEX_), cwd = vault root, and a read-only sandbox
// unless the user enables writes. Auth stays inside the user's Codex
// install (`codex login`); Yunseul never sees a key.
import type YunseulPlugin from '../main';
import { nodeProcess, readTextFile, spawn } from '../util/node';
import type { LLMClient, ProbeResult, StreamChatOpts } from '../llm/types';
import type { ModelCatalog } from '../llm/catalog';
import { redactSecrets } from '../util/redact';
import { vaultBasePath } from '../util/paths';
import { buildSafeEnv } from '../claude-code/env';
import type { LiveProc, SubprocessIO } from '../claude-code/lifecycle';
import { probeBinary } from '../claude-code/probe';
import { CODEX_ENV_PREFIXES, codexBinary, streamCodexChat } from './streamChat';
import { readCodexCatalog, type CatalogFiles } from './catalog';

// Subprocess invocation (see argv.ts for the verified flag set):
//   codex exec [resume <thread>] --json --skip-git-repo-check
//        -c sandbox_mode="read-only|workspace-write" -c approval_policy="never"
//        -c developer_instructions="<system prompt>" [-m <model>]
//        [-c model_reasoning_effort="<level>"] -
// The user prompt goes on stdin; stdout is JSONL (events.ts).

const DEFAULT_IO: SubprocessIO = { spawn };
const DEFAULT_FILES: CatalogFiles = { readFile: readTextFile };

export class CodexClient implements LLMClient {
	private readonly plugin: YunseulPlugin;
	private readonly io: SubprocessIO;
	private readonly files: CatalogFiles;
	private readonly liveProcs = new Set<LiveProc>();

	constructor(plugin: YunseulPlugin, io: SubprocessIO = DEFAULT_IO, files: CatalogFiles = DEFAULT_FILES) {
		this.plugin = plugin;
		this.io = io;
		this.files = files;
	}

	async listModels(): Promise<string[]> {
		// `codex exec` has no model listing; the settings dropdown stays
		// a free-text field. Empty = "backend decides". The pickers use
		// listModelCatalog() instead.
		return [];
	}

	async listModelCatalog(): Promise<ModelCatalog> {
		// Read from the Codex CLI's own local files (see catalog.ts):
		// $CODEX_HOME/models_cache.json for the account's models and
		// per-model effort levels, config.toml for the default model.
		const env = nodeProcess.env;
		return readCodexCatalog(
			this.files,
			{ CODEX_HOME: env.CODEX_HOME, HOME: env.HOME, USERPROFILE: env.USERPROFILE, platform: nodeProcess.platform },
			(msg) => this.plugin.logger.warn(msg),
		);
	}

	killAll(): void {
		for (const entry of this.liveProcs) {
			try {
				entry.markAborted();
				entry.proc.kill('SIGTERM');
			} catch {
				// process may already be dead
			}
		}
		this.liveProcs.clear();
	}

	async streamChat(opts: StreamChatOpts): Promise<void> {
		await streamCodexChat(
			{
				plugin: this.plugin,
				io: this.io,
				registerLive: (entry) => this.liveProcs.add(entry),
				unregisterLive: (entry) => {
					this.liveProcs.delete(entry);
				},
			},
			opts,
		);
	}

	async probe(): Promise<ProbeResult> {
		try {
			vaultBasePath(this.plugin);
		} catch {
			return {
				ok: false,
				kind: 'not-found',
				message: 'Codex requires desktop Obsidian (FileSystemAdapter).',
			};
		}
		return probeBinary(
			{
				io: this.io,
				env: buildSafeEnv(CODEX_ENV_PREFIXES),
				cwd: nodeProcess.cwd(),
				registerLive: (entry) => this.liveProcs.add(entry),
				unregisterLive: (entry) => {
					this.liveProcs.delete(entry);
				},
				redactStderr: redactSecrets,
				labels: { product: 'Codex', loginCommand: 'codex login' },
			},
			codexBinary(this.plugin),
		);
	}
}
