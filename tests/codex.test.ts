/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, describe, expect, it } from 'vitest';
import { MockChildProcess } from './_stubs/subprocess';
import { FileSystemAdapter } from './_stubs/obsidian';
import { CodexClient } from '../src/codex/client';
import { assembleCodexArgs, describeCodexArgs } from '../src/codex/argv';
import { tomlBasicString } from '../src/codex/toml';
import { createCodexTextState, parseCodexLine, type CodexEventHandlers } from '../src/codex/events';
import { buildSafeEnv } from '../src/claude-code/env';
import type { StreamChatOpts, StreamCompletionMeta } from '../src/llm/types';

// ---- harness --------------------------------------------------------

interface Harness {
	plugin: { settings: Record<string, any>; logger: Record<string, (...a: unknown[]) => void>; app: unknown; manifest: { id: string } };
	spawnCalls: Array<{ cmd: string; args: string[]; opts: { cwd: string; env: NodeJS.ProcessEnv } }>;
	nextProc: MockChildProcess;
	client: CodexClient;
}

function makeHarness(over?: Partial<{ binary: string; model: string; effort: string; enableWrites: boolean }>): Harness {
	const plugin = {
		settings: {
			provider: 'codex',
			codex: {
				binary: over?.binary ?? '',
				model: over?.model ?? '',
				effort: over?.effort ?? '',
				enableWrites: over?.enableWrites ?? false,
			},
			debug: false,
		},
		logger: { debug: (): void => {}, info: (): void => {}, warn: (): void => {}, error: (): void => {} },
		app: { vault: { adapter: new FileSystemAdapter('/test/vault'), configDir: '.obsidian' } },
		manifest: { id: 'yunseul' },
	};
	const spawnCalls: Harness['spawnCalls'] = [];
	const nextProc = new MockChildProcess();
	const client = new CodexClient(plugin as any, {
		spawn: (cmd, args, opts) => {
			spawnCalls.push({ cmd, args, opts: opts as { cwd: string; env: NodeJS.ProcessEnv } });
			return nextProc.asChildProcess() as any;
		},
	});
	return { plugin, spawnCalls, nextProc, client };
}

interface Captured { tokens: string[]; metaEvents: StreamCompletionMeta[]; completed: boolean; completedMeta: StreamCompletionMeta | undefined; errored: Error | null }

function makeOpts(overrides: Partial<StreamChatOpts> = {}): StreamChatOpts & Captured {
	const cap: Captured = { tokens: [], metaEvents: [], completed: false, completedMeta: undefined, errored: null };
	return {
		messages: [{ role: 'user', content: 'hello' }],
		signal: new AbortController().signal,
		onToken: (t) => { cap.tokens.push(t); },
		onMeta: (m) => { cap.metaEvents.push(m); },
		onComplete: (m) => { cap.completed = true; cap.completedMeta = m; },
		onError: (e) => { cap.errored = e; },
		...overrides,
		get tokens() { return cap.tokens; },
		get metaEvents() { return cap.metaEvents; },
		get completed() { return cap.completed; },
		get completedMeta() { return cap.completedMeta; },
		get errored() { return cap.errored; },
	} as StreamChatOpts & Captured;
}

const flush = async (): Promise<void> => {
	for (let i = 0; i < 20; i++) await Promise.resolve();
};

// Raw lines captured from codex-cli 0.165.0 (`codex exec --json`).
const FIX = {
	threadStarted: '{"type":"thread.started","thread_id":"01a18438-25c3-7550-8671-c1b790de3970"}\n',
	turnStarted: '{"type":"turn.started"}\n',
	agent: (text: string, id = 'item_0'): string =>
		`${JSON.stringify({ type: 'item.completed', item: { id, type: 'agent_message', text } })}\n`,
	agentPartial: (text: string, id = 'item_0'): string =>
		`${JSON.stringify({ type: 'item.updated', item: { id, type: 'agent_message', text } })}\n`,
	turnCompleted: '{"type":"turn.completed","usage":{"input_tokens":16746,"cached_input_tokens":13184,"cache_write_input_tokens":0,"output_tokens":5,"reasoning_output_tokens":0}}\n',
	error: '{"type":"error","message":"The \'no-such-model-xyz\' model is not supported when using Codex with a ChatGPT account."}\n',
	turnFailed: '{"type":"turn.failed","error":{"message":"The \'no-such-model-xyz\' model is not supported when using Codex with a ChatGPT account."}}\n',
};

const argAfter = (args: string[], flag: string): string | undefined => {
	const i = args.indexOf(flag);
	return i === -1 ? undefined : args[i + 1];
};
const configValues = (args: string[]): string[] =>
	args.flatMap((a, i) => (a === '-c' ? [args[i + 1] ?? ''] : []));

// ---- toml -----------------------------------------------------------

describe('tomlBasicString', () => {
	it('quotes and escapes the TOML basic-string specials', () => {
		expect(tomlBasicString('plain')).toBe('"plain"');
		expect(tomlBasicString('say "hi"\\now\nnext\ttab\r')).toBe('"say \\"hi\\"\\\\now\\nnext\\ttab\\r"');
		expect(tomlBasicString('\b\f')).toBe('"\\b\\f"');
	});

	it('escapes other control characters as \\uXXXX and replaces lone surrogates', () => {
		expect(tomlBasicString('a\u0001b\u007fc')).toBe('"a\\u0001b\\u007Fc"');
		expect(tomlBasicString('x\ud800y')).toBe('"x\\uFFFDy"');
		// A valid astral pair is kept as-is.
		expect(tomlBasicString('ok 😀')).toBe('"ok 😀"');
	});
});

// ---- argv -----------------------------------------------------------

describe('assembleCodexArgs', () => {
	it('fresh thread: exec --json, read-only sandbox, never-approve, instructions override, stdin prompt', () => {
		const args = assembleCodexArgs({ developerInstructions: 'be brief', priorThreadId: null, model: null, effort: null, enableWrites: false });
		expect(args.slice(0, 3)).toEqual(['exec', '--json', '--skip-git-repo-check']);
		expect(configValues(args)).toEqual(['sandbox_mode="read-only"', 'approval_policy="never"', 'developer_instructions="be brief"']);
		expect(args).not.toContain('resume');
		expect(args).not.toContain('-m');
		expect(args[args.length - 1]).toBe('-');
	});

	it('resume: exec resume … <thread id> - with the same config overrides (no -s/-C, which resume rejects)', () => {
		const args = assembleCodexArgs({ developerInstructions: 'x', priorThreadId: 'thread-1', model: null, effort: null, enableWrites: false });
		expect(args.slice(0, 4)).toEqual(['exec', 'resume', '--json', '--skip-git-repo-check']);
		expect(args.slice(-2)).toEqual(['thread-1', '-']);
		expect(args).not.toContain('-s');
		expect(args).not.toContain('-C');
	});

	it('writes → workspace-write sandbox; model → -m; effort → model_reasoning_effort override', () => {
		const args = assembleCodexArgs({ developerInstructions: 'x', priorThreadId: null, model: 'gpt-x', effort: 'xhigh', enableWrites: true });
		expect(configValues(args)).toContain('sandbox_mode="workspace-write"');
		expect(argAfter(args, '-m')).toBe('gpt-x');
		expect(configValues(args)).toContain('model_reasoning_effort="xhigh"');
	});

	it('TOML-encodes the instructions and the debug view hides their content', () => {
		const args = assembleCodexArgs({ developerInstructions: 'line "one"\nline two', priorThreadId: null, model: null, effort: null, enableWrites: false });
		expect(configValues(args)).toContain('developer_instructions="line \\"one\\"\\nline two"');
		const shown = describeCodexArgs(args).join(' ');
		expect(shown).not.toContain('line two');
		expect(shown).toMatch(/developer_instructions=<\d+ chars>/);
	});
});

// ---- events ---------------------------------------------------------

function collect(): { h: CodexEventHandlers; threads: string[]; texts: string[]; usage: unknown[]; errors: string[] } {
	const threads: string[] = []; const texts: string[] = []; const usage: unknown[] = []; const errors: string[] = [];
	const h: CodexEventHandlers = {
		onThreadStarted: (id) => { threads.push(id); },
		onText: (t) => { texts.push(t); },
		onTurnCompleted: (u) => { usage.push(u); },
		onError: (m) => { errors.push(m); },
		warn: () => {},
		debug: () => {},
	};
	return { h, threads, texts, usage, errors };
}

describe('parseCodexLine', () => {
	it('parses the captured happy-path turn', () => {
		const c = collect(); const st = createCodexTextState();
		for (const l of [FIX.threadStarted, FIX.turnStarted, FIX.agent('ok'), FIX.turnCompleted]) parseCodexLine(l.trim(), c.h, st);
		expect(c.threads).toEqual(['01a18438-25c3-7550-8671-c1b790de3970']);
		expect(c.texts).toEqual(['ok']);
		expect(c.usage).toEqual([{ inputTokens: 16746, outputTokens: 5 }]);
		expect(c.errors).toEqual([]);
	});

	it('emits only the unseen suffix across item.updated → item.completed, and separates distinct messages', () => {
		const c = collect(); const st = createCodexTextState();
		parseCodexLine(FIX.agentPartial('Hel').trim(), c.h, st);
		parseCodexLine(FIX.agentPartial('Hello').trim(), c.h, st);
		parseCodexLine(FIX.agent('Hello').trim(), c.h, st);
		parseCodexLine(FIX.agent('Second.', 'item_1').trim(), c.h, st);
		expect(c.texts).toEqual(['Hel', 'lo', '\n\nSecond.']);
	});

	it('surfaces error and turn.failed messages, ignores non-JSON and unknown events', () => {
		const c = collect(); const st = createCodexTextState();
		parseCodexLine('not json', c.h, st);
		parseCodexLine('{"type":"item.completed","item":{"id":"i","type":"command_execution","command":"ls"}}', c.h, st);
		parseCodexLine(FIX.error.trim(), c.h, st);
		parseCodexLine(FIX.turnFailed.trim(), c.h, st);
		expect(c.texts).toEqual([]);
		expect(c.errors).toHaveLength(2);
		expect(c.errors[0]).toContain('no-such-model-xyz');
	});
});

// ---- client ---------------------------------------------------------

describe('CodexClient.streamChat', () => {
	it('happy path: thread id via onMeta, text via onToken, usage in the completion meta, labeled fresh transcript on stdin', async () => {
		const h = makeHarness();
		const opts = makeOpts({ messages: [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'hi' }, { role: 'assistant', content: 'yo' }, { role: 'user', content: 'again' }] });
		void h.client.streamChat(opts);
		await flush();
		expect(h.spawnCalls[0]?.cmd).toBe('codex');
		expect(h.spawnCalls[0]?.opts.cwd).toBe('/test/vault');
		expect(configValues(h.spawnCalls[0]?.args ?? [])).toContain('developer_instructions="SYS"');
		expect(h.nextProc.stdinWrites.join('')).toBe('User: hi\n\nAssistant: yo\n\nUser: again');
		expect(h.nextProc.stdinEnded).toBe(true);
		h.nextProc.emitStdout(FIX.threadStarted + FIX.turnStarted);
		h.nextProc.emitStdout(FIX.agent('ok') + FIX.turnCompleted);
		h.nextProc.finish(0);
		await flush();
		expect(opts.metaEvents[0]).toEqual({ codexThreadId: '01a18438-25c3-7550-8671-c1b790de3970' });
		expect(opts.tokens).toEqual(['ok']);
		expect(opts.completed).toBe(true);
		expect(opts.completedMeta).toEqual({ codexThreadId: '01a18438-25c3-7550-8671-c1b790de3970', inputTokens: 16746, outputTokens: 5 });
		expect(opts.errored).toBeNull();
	});

	it('resumes a validated thread id with only the latest user turn on stdin; rejects a flag-shaped id', async () => {
		const h = makeHarness();
		const opts = makeOpts({
			messages: [{ role: 'user', content: 'one' }, { role: 'assistant', content: 'two' }, { role: 'user', content: 'three' }],
			extras: { codexThreadId: 'thread-abc' },
		});
		void h.client.streamChat(opts);
		await flush();
		const args = h.spawnCalls[0]?.args ?? [];
		expect(args.slice(0, 2)).toEqual(['exec', 'resume']);
		expect(args.slice(-2)).toEqual(['thread-abc', '-']);
		expect(h.nextProc.stdinWrites.join('')).toBe('three');
		h.nextProc.finish(0);
		await flush();

		const h2 = makeHarness();
		void h2.client.streamChat(makeOpts({ extras: { codexThreadId: '--dangerous' } }));
		await flush();
		expect(h2.spawnCalls[0]?.args).not.toContain('resume');
		h2.nextProc.finish(0);
	});

	it('session-resolved model/effort win over settings; invalid values are dropped', async () => {
		const h = makeHarness({ model: 'settings-model', effort: 'low' });
		void h.client.streamChat(makeOpts({ model: 'gpt-x', effort: 'xhigh' }));
		await flush();
		let args = h.spawnCalls[0]?.args ?? [];
		expect(argAfter(args, '-m')).toBe('gpt-x');
		expect(configValues(args)).toContain('model_reasoning_effort="xhigh"');
		h.nextProc.finish(0);
		await flush();

		const h2 = makeHarness({ model: 'settings-model', effort: 'low' });
		void h2.client.streamChat(makeOpts({ effort: 'Not Valid' }));
		await flush();
		args = h2.spawnCalls[0]?.args ?? [];
		expect(argAfter(args, '-m')).toBe('settings-model');
		expect(configValues(args).some((v) => v.startsWith('model_reasoning_effort='))).toBe(false);
		h2.nextProc.finish(0);
	});

	it('surfaces a JSON error event as the failure reason instead of the bare exit code', async () => {
		const h = makeHarness();
		const opts = makeOpts();
		void h.client.streamChat(opts);
		await flush();
		h.nextProc.emitStdout(FIX.threadStarted + FIX.error + FIX.turnFailed);
		h.nextProc.finish(1);
		await flush();
		expect(opts.completed).toBe(false);
		expect(opts.errored?.message).toContain('codex: The \'no-such-model-xyz\' model is not supported');
	});

	it('falls back to the generic exit message when there was no JSON error (e.g. dead thread id on stderr)', async () => {
		const h = makeHarness();
		const opts = makeOpts();
		void h.client.streamChat(opts);
		await flush();
		h.nextProc.emitStderr('Error: thread/resume: no rollout found for thread id x\n');
		h.nextProc.finish(1);
		await flush();
		expect(opts.errored?.message).toContain('codex exited with code 1');
		expect(opts.errored?.message).toContain('no rollout found');
	});

	it('admits OPENAI_/CODEX_ env vars for Codex only; the shared default allowlist still excludes them', async () => {
		const saved = { OPENAI_API_KEY: process.env.OPENAI_API_KEY, CODEX_HOME: process.env.CODEX_HOME, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY };
		process.env.OPENAI_API_KEY = 'sk-test-not-real';
		process.env.CODEX_HOME = '/tmp/codex-home';
		process.env.ANTHROPIC_API_KEY = 'sk-ant-not-real';
		try {
			const h = makeHarness();
			void h.client.streamChat(makeOpts());
			await flush();
			const env = h.spawnCalls[0]?.opts.env ?? {};
			expect(env.OPENAI_API_KEY).toBe('sk-test-not-real');
			expect(env.CODEX_HOME).toBe('/tmp/codex-home');
			// Claude's auth must never be visible to Codex-run shell commands.
			expect(env.ANTHROPIC_API_KEY).toBeUndefined();
			expect(buildSafeEnv().OPENAI_API_KEY).toBeUndefined();
			expect(buildSafeEnv().ANTHROPIC_API_KEY).toBeUndefined();
			h.nextProc.finish(0);
		} finally {
			if (saved.OPENAI_API_KEY === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = saved.OPENAI_API_KEY;
			if (saved.CODEX_HOME === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = saved.CODEX_HOME;
			if (saved.ANTHROPIC_API_KEY === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = saved.ANTHROPIC_API_KEY;
		}
	});

	it('honors the binary path setting and killAll() terminates live processes', async () => {
		const h = makeHarness({ binary: '/opt/bin/codex' });
		const opts = makeOpts();
		void h.client.streamChat(opts);
		await flush();
		expect(h.spawnCalls[0]?.cmd).toBe('/opt/bin/codex');
		h.client.killAll();
		expect(h.nextProc.killSignals).toEqual(['SIGTERM']);
		h.nextProc.finish(null);
		await flush();
		expect(opts.completed).toBe(true);
	});
});

describe('CodexClient.probe', () => {
	afterEach(() => {});

	it('reports the Codex product name on success', async () => {
		const h = makeHarness();
		const p = h.client.probe();
		await flush();
		h.nextProc.emitStdout('codex-cli 0.165.0\n');
		h.nextProc.finish(0);
		const r = await p;
		expect(r.ok).toBe(true);
		expect(r.message).toContain('Codex available: codex-cli 0.165.0');
	});

	it('maps ENOENT to not-found with a `which codex` hint', async () => {
		const h = makeHarness();
		const p = h.client.probe();
		await flush();
		h.nextProc.emit('error', Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' }));
		const r = await p;
		expect(r.ok).toBe(false);
		expect(r.kind).toBe('not-found');
		expect(r.message).toContain('which codex');
	});
});

describe('CodexClient.streamChat — argv size and error semantics (audit round 2)', () => {
	it('keeps vault excerpts off argv: only the first system message is the instructions override, the rest lead the stdin payload', async () => {
		const h = makeHarness();
		const big = `<vault_excerpt path="n.md">${'x'.repeat(50_000)}</vault_excerpt>`;
		const opts = makeOpts({ messages: [
			{ role: 'system', content: 'HEAD' },
			{ role: 'system', content: big },
			{ role: 'system', content: 'RETRIEVAL' },
			{ role: 'user', content: 'q' },
		] });
		void h.client.streamChat(opts);
		await flush();
		const args = h.spawnCalls[0]?.args ?? [];
		expect(configValues(args)).toContain('developer_instructions="HEAD"');
		expect(args.join(' ')).not.toContain('xxxxxxxx');
		expect(h.nextProc.stdinWrites.join('')).toBe(`${big}\n\nRETRIEVAL\n\nUser: q`);
		h.nextProc.finish(0);
	});

	it('refuses an oversized instructions override with a clear error instead of spawning', async () => {
		const h = makeHarness();
		const opts = makeOpts({ messages: [{ role: 'system', content: 'y'.repeat(30_000) }, { role: 'user', content: 'q' }] });
		await h.client.streamChat(opts);
		expect(h.spawnCalls).toHaveLength(0);
		expect(opts.errored?.message).toContain('too long for Codex');
	});

	it('a non-fatal error event followed by turn.completed and exit 0 still completes with the text', async () => {
		const h = makeHarness();
		const opts = makeOpts();
		void h.client.streamChat(opts);
		await flush();
		h.nextProc.emitStdout(FIX.threadStarted);
		h.nextProc.emitStdout('{"type":"error","message":"stream connection failed; waiting to retry"}\n');
		h.nextProc.emitStdout(FIX.agent('answer') + FIX.turnCompleted);
		h.nextProc.finish(0);
		await flush();
		expect(opts.errored).toBeNull();
		expect(opts.completed).toBe(true);
		expect(opts.tokens).toEqual(['answer']);
	});

	it('error + turn.failed is fatal even when the process exits 0', async () => {
		const h = makeHarness();
		const opts = makeOpts();
		void h.client.streamChat(opts);
		await flush();
		h.nextProc.emitStdout(FIX.threadStarted + FIX.error + FIX.turnFailed);
		h.nextProc.finish(0);
		await flush();
		expect(opts.completed).toBe(false);
		expect(opts.errored?.message).toContain('not supported');
	});
});

describe('CodexClient.listModelCatalog', () => {
	it('reads the Codex CLI\'s local cache and config through the injected file reader, under $CODEX_HOME', async () => {
		const h = makeHarness();
		const reads: string[] = [];
		const files = {
			readFile: async (p: string): Promise<string> => {
				reads.push(p);
				if (p.endsWith('models_cache.json')) {
					return JSON.stringify({ models: [
						{ slug: 'gpt-b', visibility: 'list', priority: 2 },
						{ slug: 'gpt-a', visibility: 'list', priority: 1, supported_reasoning_levels: [{ effort: 'low' }, { effort: 'ultra', description: 'Delegates' }] },
					] });
				}
				if (p.endsWith('config.toml')) return 'model = "gpt-a"\n';
				throw new Error('ENOENT');
			},
		};
		const client = new CodexClient(h.plugin as any, { spawn: () => { throw new Error('no spawn expected'); } }, files);
		const prev = process.env.CODEX_HOME;
		process.env.CODEX_HOME = '/cx';
		try {
			const catalog = await client.listModelCatalog();
			expect(reads).toEqual(['/cx/models_cache.json', '/cx/config.toml']);
			expect(catalog.models.map((m) => m.id)).toEqual(['gpt-a', 'gpt-b']);
			expect(catalog.models[0]?.efforts).toEqual([{ level: 'low' }, { level: 'ultra', detail: 'Delegates' }]);
			expect(catalog.defaultModel).toBe('gpt-a');
		} finally {
			if (prev === undefined) delete process.env.CODEX_HOME;
			else process.env.CODEX_HOME = prev;
		}
	});

	it('yields an empty catalog when Codex has never written its files', async () => {
		const h = makeHarness();
		const client = new CodexClient(h.plugin as any, { spawn: () => { throw new Error('no spawn expected'); } }, {
			readFile: async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
		});
		expect(await client.listModelCatalog()).toEqual({ models: [], defaultModel: null });
	});
});
