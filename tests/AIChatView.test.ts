/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AIChatView } from '../src/ui/AIChatView';
import { ChatSession } from '../src/chat/session';
import type YunseulPlugin from '../src/main';
import type { StreamChatOpts, ProbeResult, StreamCompletionMeta } from '../src/llm/types';
import type { YunseulSettings } from '../src/settings';
import { TFile } from './_stubs/obsidian';

// JSDOM smoke test for the AIChatView orchestrator extracted in V1.3.
// We build a comprehensive stub plugin so production code stays untouched;
// the View takes the plugin via constructor and exercises a handful of
// well-defined hooks. The LLMClient is a driver the test owns so we can
// synthesize tokens / aborts / completes from outside.

interface StreamHandles {
	emitToken: (t: string) => void;
	emitMeta: (m: StreamCompletionMeta) => void;
	emitComplete: (m?: StreamCompletionMeta) => void;
	emitError: (e: Error) => void;
	signal: AbortSignal;
}

const DEFAULT_SETTINGS: YunseulSettings = {
	schemaVersion: 1,
	provider: 'lm-studio',
	lmStudio: {
		baseUrl: 'http://x', apiKey: '', chatModel: 'm', temperature: 0.7,
		maxContextChars: 12000, maxConversationRounds: 10,
	},
	claudeCode: { binary: '', modelOverride: '', effort: '', enableWrites: false, knownSlashCommands: [] },
	codex: { binary: '', model: '', effort: '', enableWrites: false },
	chat: {
		suggestions: ['Summarize this note', 'Find related notes'],
		downloadFolder: 'AI Chats',
	},
	index: { enabled: false, topK: 8, excludeTags: [], promptState: 'unanswered' },
	privacy: { allowExternalImages: false, treatClippingsAsUntrusted: true, clippingsFolder: 'Clippings' },
	debug: false,
};

function makeStub(opts?: { handles?: StreamHandles; retriever?: any }): {
	plugin: YunseulPlugin;
	openLinkText: ReturnType<typeof vi.fn>;
	connectionListeners: Set<(s: string) => void>;
	settingsListeners: Set<() => void>;
} {
	const sessions = new Map<string, ChatSession>();
	const connectionListeners = new Set<(s: string) => void>();
	const settingsListeners = new Set<() => void>();
	const openLinkText = vi.fn();
	let activeId: string | null = null;

	const lmClient = {
		probe: async (): Promise<ProbeResult> => ({ ok: true, kind: 'ok', message: 'ok' }),
		listModels: async (): Promise<string[]> => [],
		// Pending Promise so isStreaming() stays true until the test calls
		// emitComplete/emitError. session.send's abortCtrl is bound to this
		// Promise's lifetime.
		streamChat: (sc: StreamChatOpts): Promise<void> => new Promise<void>((resolve) => {
			if (opts?.handles === undefined) return;
			const h = opts.handles;
			h.emitToken = sc.onToken;
			h.emitMeta = (m): void => sc.onMeta?.(m);
			h.emitComplete = (m): void => { sc.onComplete(m); resolve(); };
			h.emitError = (e): void => { sc.onError(e); resolve(); };
			Object.defineProperty(h, 'signal', { value: sc.signal, configurable: true });
		}),
	};

	const plugin: any = {
		settings: { ...DEFAULT_SETTINGS },
		logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
		manifest: { id: 'yunseul', version: '0.1.0' },
		sessions,
		retriever: opts?.retriever ?? null,
		lmClient,
		app: {
			workspace: {
				getActiveFile: () => null,
				openLinkText,
				getLeaf: () => ({ openFile: async () => {} }),
			},
			vault: {
				cachedRead: vi.fn(async () => ''),
				getAbstractFileByPath: vi.fn(() => null),
				adapter: { exists: async () => false, write: async () => {} },
			},
		},
		getOrCreateActiveSessionId(): string {
			if (activeId !== null && sessions.has(activeId)) return activeId;
			return plugin.createSession();
		},
		createSession(): string {
			const s = new ChatSession(plugin as YunseulPlugin);
			sessions.set(s.id, s);
			activeId = s.id;
			return s.id;
		},
		setActiveSessionId: (id: string) => { activeId = id; },
		persistSession: vi.fn(),
		getConnectionState: () => ({ state: 'ready' }),
		updateConnectionState: vi.fn(),
		onConnectionStateChange: (l: (s: string) => void) => {
			connectionListeners.add(l);
			return () => { connectionListeners.delete(l); };
		},
		onSettingsChange: (l: () => void) => {
			settingsListeners.add(l);
			return () => { settingsListeners.delete(l); };
		},
	};

	return { plugin: plugin as YunseulPlugin, openLinkText, connectionListeners, settingsListeners };
}

function makeView(plugin: YunseulPlugin): AIChatView {
	// Cast leaf to any — only the stubbed ItemView constructor reads .app off it.
	const view = new AIChatView({ app: (plugin as any).app } as any, plugin);
	document.body.appendChild(view.containerEl);
	return view;
}

const microtasks = async (n = 2): Promise<void> => {
	for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};

const triggerEnter = (input: HTMLTextAreaElement): void => {
	input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
};

const getInput = (view: AIChatView): HTMLTextAreaElement =>
	view.containerEl.querySelector('textarea.yunseul-textarea') as HTMLTextAreaElement;

afterEach(() => {
	document.body.innerHTML = '';
	vi.useRealTimers();
});

describe('AIChatView — mount + empty state', () => {
	it('renders the empty-state tagline on first mount', async () => {
		const { plugin } = makeStub();
		const view = makeView(plugin);
		await view.onOpen();
		const empty = view.containerEl.querySelector('.yunseul-empty');
		expect(empty).not.toBeNull();
		expect(view.containerEl.querySelector('.yunseul-empty-tagline')?.textContent)
			.toContain('Where your notes catch the light.');
		await view.onClose();
	});
});

describe('AIChatView — send → user bubble rendered', () => {
	it('appends a role=user bubble when the composer triggers send via Enter', async () => {
		const handles = {} as StreamHandles;
		const { plugin } = makeStub({ handles });
		const view = makeView(plugin);
		await view.onOpen();

		const input = getInput(view);
		expect(input).not.toBeNull();
		input.value = 'hello';
		// Real Enter keydown — the composer's registerDomEvent('keydown', …)
		// handler funnels through handleSendOrStop.
		triggerEnter(input);
		await microtasks();

		const userBubble = view.containerEl.querySelector('.yunseul-msg.yunseul-msg-user');
		expect(userBubble).not.toBeNull();
		expect(userBubble?.textContent).toContain('hello');

		handles.emitComplete?.();
		await microtasks();
		await view.onClose();
	});
});

describe('AIChatView — streaming token text + final markdown render', () => {
	it('shows token text during stream and re-renders as markdown on completion', async () => {
		const handles = {} as StreamHandles;
		const { plugin } = makeStub({ handles });
		const view = makeView(plugin);
		await view.onOpen();

		const input = getInput(view);
		input.value = 'streaming check';
		triggerEnter(input);
		await microtasks();

		handles.emitToken('Hel');
		handles.emitToken('lo');
		// SendController's 33ms throttle — flush.
		await new Promise((r) => setTimeout(r, 60));

		const assistant = view.containerEl.querySelector('.yunseul-msg.yunseul-msg-assistant');
		expect(assistant).not.toBeNull();
		const body = assistant?.querySelector('.yunseul-msg-body');
		// Two-phase render: text node holds 'Hello' BEFORE the final phase
		// runs MarkdownRenderer.
		expect(body?.textContent).toContain('Hello');
		expect(body?.querySelector('.markdown-rendered')).toBeNull();

		handles.emitComplete?.();
		await microtasks();

		const rendered = assistant?.querySelector('.markdown-rendered');
		expect(rendered).not.toBeNull();
		expect(rendered?.textContent).toContain('Hello');
		await view.onClose();
	});
});

describe('AIChatView — sources click → openLinkText invoked', () => {
	it('routes a click on a .internal-link inside the sources block through workspace.openLinkText', async () => {
		const handles = {} as StreamHandles;
		// Retriever stub: returns one hit; session.maybeRetrieve forwards it
		// to session.lastRetrieval, which SendController consumes inside
		// onComplete to render the sources block.
		const hitFile = Object.assign(new TFile(), { path: 'Notes/Widget.md', basename: 'Widget' });
		const retriever = {
			search: vi.fn(() => [{ file: hitFile, score: 0.8, matchedTerms: ['widgets'] }]),
		};
		const { plugin, openLinkText } = makeStub({ handles, retriever });
		(plugin as any).settings.index.enabled = true;
		const view = makeView(plugin);
		await view.onOpen();

		const input = getInput(view);
		input.value = 'find related notes about widgets';
		triggerEnter(input);
		await microtasks();

		handles.emitToken('answer body');
		await new Promise((r) => setTimeout(r, 60));
		handles.emitComplete?.();
		await microtasks();

		const link = view.containerEl.querySelector('a.internal-link') as HTMLAnchorElement | null;
		expect(link).not.toBeNull();
		link?.click();
		expect(openLinkText).toHaveBeenCalledTimes(1);
		expect(openLinkText.mock.calls[0]?.[0]).toBe('Notes/Widget');
		await view.onClose();
	});
});

describe('AIChatView — New chat stops in-flight stream', () => {
	it('calls session.stop() on the streaming session BEFORE creating the next one (V1.3 fix)', async () => {
		const handles = {} as StreamHandles;
		const { plugin } = makeStub({ handles });
		const view = makeView(plugin);
		await view.onOpen();

		const input = getInput(view);
		input.value = 'streaming-then-new';
		triggerEnter(input);
		await microtasks();
		handles.emitToken('partial');
		await microtasks(1);

		const streaming = Array.from(plugin.sessions.values()).find((s) => s.isStreaming());
		expect(streaming).toBeDefined();
		const stopSpy = vi.spyOn(streaming!, 'stop');
		const createSpy = vi.spyOn(plugin as any, 'createSession');

		const newBtn = Array.from(view.containerEl.querySelectorAll('button.yunseul-header-btn'))
			.find((b) => b.textContent === 'New') as HTMLButtonElement | undefined;
		newBtn?.click();
		await microtasks();

		expect(stopSpy).toHaveBeenCalledTimes(1);
		expect(createSpy).toHaveBeenCalledTimes(1);
		// Strict ordering: stop's invocationCallOrder < createSession's.
		const stopOrder = stopSpy.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER;
		const createOrder = createSpy.mock.invocationCallOrder[0] ?? 0;
		expect(stopOrder).toBeLessThan(createOrder);

		handles.emitComplete?.();
		await microtasks();
		await view.onClose();
	});
});

describe('AIChatView — onClose cleanup', () => {
	beforeEach(() => { vi.useFakeTimers(); });

	it('invokes connectionUnsub and leaves no dangling view-owned intervals', async () => {
		const { plugin, connectionListeners } = makeStub();
		const view = makeView(plugin);
		await view.onOpen();

		expect(connectionListeners.size).toBe(1);

		// Drain the one-shot jsdom-internal timer scheduled by
		// textarea.focus() inside onOpen (Selection._associateRange).
		// It is NOT view-owned and must not muddy the strict assertion.
		vi.advanceTimersByTime(0);
		await view.onClose();

		expect(connectionListeners.size).toBe(0);
		// The composer's send-button interval and MessageBubble's prefill
		// interval are bound to the view's Component lifecycle; both must
		// be cleared by now.
		expect(vi.getTimerCount()).toBe(0);
	});
});

describe('AIChatView — Claude Code slash commands handled locally', () => {
	it('/clear starts a new session instead of sending', async () => {
		const handles = {} as StreamHandles;
		const { plugin } = makeStub({ handles });
		plugin.settings.provider = 'claude-code';
		const view = makeView(plugin);
		await view.onOpen();
		const streamSpy = vi.spyOn(plugin.lmClient, 'streamChat');
		const createSpy = vi.spyOn(plugin as any, 'createSession');

		const input = getInput(view);
		input.value = '/clear';
		triggerEnter(input);
		await microtasks();

		expect(streamSpy).not.toHaveBeenCalled();
		expect(createSpy).toHaveBeenCalledTimes(1);
		expect(input.value).toBe('');
		await view.onClose();
	});

	it('/model <id> and /effort <level> set per-chat overrides, persist, refresh the strip, and do not send', async () => {
		const handles = {} as StreamHandles;
		const { plugin } = makeStub({ handles });
		plugin.settings.provider = 'claude-code';
		const view = makeView(plugin);
		await view.onOpen();
		const streamSpy = vi.spyOn(plugin.lmClient, 'streamChat');
		const persistSpy = plugin.persistSession as unknown as ReturnType<typeof vi.fn>;
		persistSpy.mockClear();

		const input = getInput(view);
		input.value = '/model opus';
		triggerEnter(input);
		await microtasks();

		const session = Array.from(plugin.sessions.values())[0]!;
		expect(streamSpy).not.toHaveBeenCalled();
		expect(input.value).toBe('');
		expect(session.modelOverride).toBe('opus');
		expect(session.history).toHaveLength(0);
		expect(persistSpy).toHaveBeenCalled();
		expect(view.containerEl.textContent).toContain('opus');

		input.value = '/effort high';
		triggerEnter(input);
		await microtasks();
		expect(session.effortOverride).toBe('high');
		expect(view.containerEl.textContent).toContain('opus · high');

		input.value = '/effort bogus';
		triggerEnter(input);
		await microtasks();
		expect(session.effortOverride).toBe('high');

		input.value = '/model default';
		triggerEnter(input);
		await microtasks();
		expect(session.modelOverride).toBeNull();
		expect(streamSpy).not.toHaveBeenCalled();
		await view.onClose();
	});

	it('any other slash command (/compact) is forwarded verbatim as the latest user turn', async () => {
		const handles = {} as StreamHandles;
		const { plugin } = makeStub({ handles });
		plugin.settings.provider = 'claude-code';
		const view = makeView(plugin);
		await view.onOpen();
		const streamSpy = vi.spyOn(plugin.lmClient, 'streamChat');

		const input = getInput(view);
		input.value = '/compact';
		triggerEnter(input);
		await microtasks();

		expect(streamSpy).toHaveBeenCalledTimes(1);
		const sent = streamSpy.mock.calls[0]?.[0] as StreamChatOpts;
		const lastUser = [...sent.messages].reverse().find((m) => m.role === 'user');
		expect(lastUser?.content).toBe('/compact');
		handles.emitComplete?.();
		await microtasks();
		await view.onClose();
	});

	it('with the LM Studio provider, /clear also starts a new chat (local commands are provider-neutral)', async () => {
		const handles = {} as StreamHandles;
		const { plugin } = makeStub({ handles });
		plugin.settings.provider = 'lm-studio';
		const view = makeView(plugin);
		await view.onOpen();
		const streamSpy = vi.spyOn(plugin.lmClient, 'streamChat');
		const createSpy = vi.spyOn(plugin as any, 'createSession');

		const input = getInput(view);
		input.value = '/clear';
		triggerEnter(input);
		await microtasks();

		expect(streamSpy).not.toHaveBeenCalled();
		expect(createSpy).toHaveBeenCalledTimes(1);
		await view.onClose();
	});
});

describe('AIChatView — rejected local command keeps the text', () => {
	it('/model with an invalid id leaves the composer untouched and sets no override', async () => {
		const handles = {} as StreamHandles;
		const { plugin } = makeStub({ handles });
		plugin.settings.provider = 'claude-code';
		const view = makeView(plugin);
		await view.onOpen();
		const streamSpy = vi.spyOn(plugin.lmClient, 'streamChat');
		const input = getInput(view);
		input.value = '/model bad id';
		triggerEnter(input);
		await microtasks();
		const session = Array.from(plugin.sessions.values())[0]!;
		expect(input.value).toBe('/model bad id');
		expect(session.modelOverride).toBeNull();
		expect(streamSpy).not.toHaveBeenCalled();
		input.value = '/effort bogus';
		triggerEnter(input);
		await microtasks();
		expect(input.value).toBe('/effort bogus');
		await view.onClose();
	});
});

describe('AIChatView — /model and /effort pickers', () => {
	const CLAUDE_CATALOG = {
		defaultModel: null,
		models: [
			{ id: 'sonnet', detail: 'Latest Sonnet' },
			{ id: 'opus', detail: 'Latest Opus' },
			{ id: 'haiku', detail: 'Fast' },
		],
	};
	const CODEX_CATALOG = {
		defaultModel: 'gpt-6.1-sol',
		models: [
			{ id: 'gpt-6.1-sol', detail: 'Workhorse', defaultEffort: 'low', efforts: [{ level: 'low' }, { level: 'medium' }, { level: 'max' }, { level: 'ultra', detail: 'Delegates' }] },
			{ id: 'gpt-6-astra', detail: 'Frontier', efforts: [{ level: 'xhigh' }] },
		],
	};
	const menuOf = (view: AIChatView): HTMLElement => view.containerEl.querySelector('.yunseul-slash-menu') as HTMLElement;
	const rowNames = (view: AIChatView): string[] =>
		Array.from(menuOf(view).querySelectorAll('.yunseul-slash-option-name')).map((e) => e.textContent ?? '');
	const pressKey = (input: HTMLTextAreaElement, k: string): void => {
		input.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
	};

	it('bare /model + Enter opens the picker with the provider catalog, and Enter on a row applies it', async () => {
		const handles = {} as StreamHandles;
		const { plugin } = makeStub({ handles });
		plugin.settings.provider = 'claude-code';
		(plugin.lmClient as any).listModelCatalog = async () => CLAUDE_CATALOG;
		const view = makeView(plugin);
		await view.onOpen();
		const streamSpy = vi.spyOn(plugin.lmClient, 'streamChat');
		const persistSpy = plugin.persistSession as unknown as ReturnType<typeof vi.fn>;
		persistSpy.mockClear();

		const input = getInput(view);
		input.value = '/model';
		triggerEnter(input);
		await microtasks();

		expect(streamSpy).not.toHaveBeenCalled();
		expect(input.value).toBe('/model ');
		expect(menuOf(view).classList.contains('is-open')).toBe(true);
		expect(rowNames(view)).toEqual(['default', 'sonnet', 'opus', 'haiku']);
		expect(menuOf(view).querySelector('.is-current .yunseul-slash-option-name')?.textContent).toBe('default');

		pressKey(input, 'ArrowDown');
		pressKey(input, 'ArrowDown');
		pressKey(input, 'Enter');
		await microtasks();

		const session = Array.from(plugin.sessions.values())[0]!;
		expect(session.modelOverride).toBe('opus');
		expect(input.value).toBe('');
		expect(menuOf(view).classList.contains('is-open')).toBe(false);
		expect(persistSpy).toHaveBeenCalled();
		expect(view.containerEl.textContent).toContain('opus');
		expect(streamSpy).not.toHaveBeenCalled();

		// Re-opening marks the new choice as current and lands on it.
		input.value = '/model';
		triggerEnter(input);
		await microtasks();
		expect(menuOf(view).querySelector('.is-current .yunseul-slash-option-name')?.textContent).toBe('opus');
		expect(menuOf(view).querySelector('.is-active .yunseul-slash-option-name')?.textContent).toBe('opus');
		await view.onClose();
	});

	it('/effort lists the current Codex model\'s levels from the catalog; a click applies one', async () => {
		const handles = {} as StreamHandles;
		const { plugin } = makeStub({ handles });
		plugin.settings.provider = 'codex';
		(plugin.lmClient as any).listModelCatalog = async () => CODEX_CATALOG;
		const view = makeView(plugin);
		await view.onOpen();

		const input = getInput(view);
		input.value = '/effort';
		triggerEnter(input);
		await microtasks();
		expect(rowNames(view)).toEqual(['default', 'low', 'medium', 'max', 'ultra']);
		expect(menuOf(view).querySelectorAll('.yunseul-slash-option-detail')[0]?.textContent).toBe('Model default · low');

		const rows = menuOf(view).querySelectorAll('.yunseul-slash-option');
		(rows[4] as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));
		await microtasks();
		const session = Array.from(plugin.sessions.values())[0]!;
		expect(session.effortOverride).toBe('ultra');
		// No Settings default and no override: the strip names the provider default.
		expect(view.containerEl.textContent).toContain('codex (default) · ultra');

		// Switching model narrows the effort list to that model's levels.
		input.value = '/model gpt-6-astra';
		triggerEnter(input);
		await microtasks();
		input.value = '/effort';
		triggerEnter(input);
		await microtasks();
		expect(rowNames(view)).toEqual(['default', 'ultra', 'xhigh']);
		await view.onClose();
	});

	it('with LM Studio, bare /effort gives the explanatory notice and opens no picker', async () => {
		const handles = {} as StreamHandles;
		const { plugin } = makeStub({ handles });
		plugin.settings.provider = 'lm-studio';
		const view = makeView(plugin);
		await view.onOpen();
		const input = getInput(view);
		input.value = '/effort';
		triggerEnter(input);
		await microtasks();
		expect(menuOf(view).classList.contains('is-open')).toBe(false);
		expect(input.value).toBe('');
		await view.onClose();
	});

	it('LM Studio /model fetches listModels(), shows a status row while loading, and a custom id still works', async () => {
		const handles = {} as StreamHandles;
		const { plugin } = makeStub({ handles });
		plugin.settings.provider = 'lm-studio';
		let resolveModels: (ids: string[]) => void = () => {};
		(plugin.lmClient as any).listModels = () => new Promise<string[]>((r) => { resolveModels = r; });
		const view = makeView(plugin);
		await view.onOpen();
		const input = getInput(view);
		input.value = '/model';
		triggerEnter(input);
		await microtasks();
		expect(menuOf(view).classList.contains('is-open')).toBe(true);
		expect(menuOf(view).querySelector('.yunseul-slash-status')?.textContent).toBe('Loading models…');
		expect(rowNames(view)).toEqual(['default']);

		// Embedding models and ids the validator would reject are left out;
		// LM Studio's `model@quant` ids are accepted.
		resolveModels(['qwen-7b', 'text-embedding-x', 'qwen2.5-7b@q4_k_m', 'bad id']);
		await microtasks();
		expect(menuOf(view).querySelector('.yunseul-slash-status')).toBeNull();
		expect(rowNames(view)).toEqual(['default', 'qwen-7b', 'qwen2.5-7b@q4_k_m']);

		const rows = menuOf(view).querySelectorAll('.yunseul-slash-option');
		(rows[2] as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));
		await microtasks();
		expect(Array.from(plugin.sessions.values())[0]!.modelOverride).toBe('qwen2.5-7b@q4_k_m');

		input.value = '/model';
		triggerEnter(input);
		await microtasks();

		input.value = '/model my-local-model';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		expect(menuOf(view).classList.contains('is-open')).toBe(false);
		triggerEnter(input);
		await microtasks();
		const session = Array.from(plugin.sessions.values())[0]!;
		expect(session.modelOverride).toBe('my-local-model');
		await view.onClose();
	});

	it('a failed catalog fetch shows the reason in the status row and the picker still offers default', async () => {
		const handles = {} as StreamHandles;
		const { plugin } = makeStub({ handles });
		plugin.settings.provider = 'lm-studio';
		(plugin.lmClient as any).listModels = async () => { throw new Error('ECONNREFUSED'); };
		const view = makeView(plugin);
		await view.onOpen();
		const input = getInput(view);
		input.value = '/model';
		triggerEnter(input);
		await microtasks();
		expect(menuOf(view).querySelector('.yunseul-slash-status')?.textContent).toBe("Couldn't list models: ECONNREFUSED");
		expect(rowNames(view)).toEqual(['default']);
		expect((plugin.logger.warn as any).mock.calls.length).toBeGreaterThan(0);
		await view.onClose();
	});
});

describe('AIChatView — picker catalog lifecycle', () => {
	const menuOf = (view: AIChatView): HTMLElement => view.containerEl.querySelector('.yunseul-slash-menu') as HTMLElement;
	const statusText = (view: AIChatView): string | null => menuOf(view).querySelector('.yunseul-slash-status')?.textContent ?? null;
	const rowNames = (view: AIChatView): string[] =>
		Array.from(menuOf(view).querySelectorAll('.yunseul-slash-option-name')).map((e) => e.textContent ?? '');

	it('a fetch that never settles times out into the error row, and re-opening retries', async () => {
		const handles = {} as StreamHandles;
		const { plugin } = makeStub({ handles });
		plugin.settings.provider = 'lm-studio';
		let calls = 0;
		(plugin.lmClient as any).listModels = () => { calls++; return new Promise<string[]>(() => {}); };
		const view = makeView(plugin);
		await view.onOpen();
		vi.useFakeTimers();
		const input = getInput(view);
		input.value = '/model';
		triggerEnter(input);
		await vi.advanceTimersByTimeAsync(0);
		expect(statusText(view)).toBe('Loading models…');
		expect(calls).toBe(1);

		await vi.advanceTimersByTimeAsync(10_000);
		expect(statusText(view)).toBe("Couldn't list models: timed out after 10 s");
		expect(rowNames(view)).toEqual(['default']);

		// Escape, then open again: the error state is retried.
		input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
		input.value = '/model';
		triggerEnter(input);
		await vi.advanceTimersByTimeAsync(0);
		expect(calls).toBe(2);
		expect(statusText(view)).toBe('Loading models…');
		vi.useRealTimers();
		await view.onClose();
	});

	it('a fetch landing after the view closed is dropped without touching anything', async () => {
		const handles = {} as StreamHandles;
		const { plugin } = makeStub({ handles });
		plugin.settings.provider = 'lm-studio';
		let resolveModels: (ids: string[]) => void = () => {};
		(plugin.lmClient as any).listModels = () => new Promise<string[]>((r) => { resolveModels = r; });
		const view = makeView(plugin);
		await view.onOpen();
		const input = getInput(view);
		input.value = '/model';
		triggerEnter(input);
		await microtasks();
		await view.onClose();
		resolveModels(['late-model']);
		await microtasks();
		expect((plugin.logger.warn as any).mock.calls).toHaveLength(0);
		expect((plugin.logger.error as any).mock.calls).toHaveLength(0);
	});

	it('a settings change drops the cached catalog and an open picker refetches', async () => {
		const handles = {} as StreamHandles;
		const { plugin, settingsListeners } = makeStub({ handles });
		plugin.settings.provider = 'lm-studio';
		let ids = ['first-a'];
		let calls = 0;
		(plugin.lmClient as any).listModels = async () => { calls++; return ids; };
		const view = makeView(plugin);
		await view.onOpen();
		const input = getInput(view);
		input.value = '/model';
		triggerEnter(input);
		await microtasks();
		expect(rowNames(view)).toEqual(['default', 'first-a']);
		expect(calls).toBe(1);

		// Same provider, different server: the old list must not survive.
		ids = ['second-b'];
		plugin.settings.lmStudio.baseUrl = 'http://elsewhere';
		for (const l of settingsListeners) l();
		await microtasks();
		expect(calls).toBe(2);
		expect(menuOf(view).classList.contains('is-open')).toBe(true);
		expect(rowNames(view)).toEqual(['default', 'second-b']);
		await view.onClose();
	});

	it('a provider switch while a fetch is in flight masks the stale result', async () => {
		const handles = {} as StreamHandles;
		const { plugin, settingsListeners } = makeStub({ handles });
		plugin.settings.provider = 'lm-studio';
		let resolveModels: (ids: string[]) => void = () => {};
		(plugin.lmClient as any).listModels = () => new Promise<string[]>((r) => { resolveModels = r; });
		(plugin.lmClient as any).listModelCatalog = undefined;
		const view = makeView(plugin);
		await view.onOpen();
		const input = getInput(view);
		input.value = '/model';
		triggerEnter(input);
		await microtasks();
		expect(statusText(view)).toBe('Loading models…');

		plugin.settings.provider = 'claude-code';
		(plugin.lmClient as any).listModelCatalog = async () => ({ models: [{ id: 'sonnet' }], defaultModel: null });
		for (const l of settingsListeners) l();
		await microtasks();
		// The LM Studio fetch is still pending; the Claude catalog is what shows.
		expect(rowNames(view)).toEqual(['default', 'sonnet']);
		resolveModels(['lm-model']);
		await microtasks();
		expect(rowNames(view)).toEqual(['default', 'sonnet']);
		await view.onClose();
	});
});
