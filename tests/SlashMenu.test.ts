/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, describe, expect, it } from 'vitest';
import { Component } from './_stubs/obsidian';
import { renderChatComposer, type ChatComposerHandle } from '../src/ui/ChatComposer';
import type { SlashMenuItem } from '../src/ui/SlashMenu';

// JSDOM tests for the slash-command popover, exercised THROUGH the
// composer so the keystroke routing (popover first, then Enter-to-send)
// is covered rather than the menu in isolation.

const COMMANDS = ['clear', 'code-review', 'compact', 'context', 'usage'];

interface Mounted {
	root: HTMLElement;
	handle: ChatComposerHandle;
	input: HTMLTextAreaElement;
	plugin: any;
	calls: { send: number; prevFocus: number };
	/** Argument-mode picks, as [command, value]. */
	picks: Array<[string, string]>;
	/** Commands whose picker opened, in order. */
	opened: string[];
}

interface MountExtras {
	/** Rows per command; a missing command has no picker (null). */
	argItems?: Record<string, SlashMenuItem[] | null>;
	status?: Record<string, string | null>;
}

function mount(provider: 'claude-code' | 'lm-studio', commands: string[] = COMMANDS, extras: MountExtras = {}): Mounted {
	const root = document.createElement('div');
	document.body.appendChild(root);
	const plugin: any = {
		settings: {
			provider,
			lmStudio: { maxContextChars: 12000 },
			claudeCode: { knownSlashCommands: commands },
		},
	};
	const calls = { send: 0, prevFocus: 0 };
	const picks: Array<[string, string]> = [];
	const opened: string[] = [];
	const handle = renderChatComposer({
		root,
		component: new Component(),
		plugin,
		slashHintId: 'hint-1',
		getActiveSession: () => undefined,
		onSendOrStop: () => { calls.send++; },
		onBindFile: () => {},
		onUnbindFile: () => {},
		onPreviousFocus: () => { calls.prevFocus++; },
		getArgumentItems: (command) => extras.argItems?.[command] ?? null,
		getArgumentStatus: (command) => extras.status?.[command] ?? null,
		onPickArgument: (command, value) => { picks.push([command, value]); },
		onArgumentMenuOpen: (command) => { opened.push(command); },
	});
	// A real user focuses the textarea before typing; the popover refuses
	// to open for an unfocused field (see SlashMenu.sync).
	handle.inputEl.focus();
	return { root, handle, input: handle.inputEl, plugin, calls, picks, opened };
}

const type = (input: HTMLTextAreaElement, value: string): void => {
	input.value = value;
	input.dispatchEvent(new Event('input', { bubbles: true }));
};

const key = (input: HTMLTextAreaElement, k: string, init: KeyboardEventInit = {}): KeyboardEvent => {
	const ev = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init });
	input.dispatchEvent(ev);
	return ev;
};

const menuEl = (root: HTMLElement): HTMLElement =>
	root.querySelector('.yunseul-slash-menu') as HTMLElement;
const isOpen = (root: HTMLElement): boolean => menuEl(root).classList.contains('is-open');
const optionTexts = (root: HTMLElement): string[] =>
	Array.from(root.querySelectorAll('.yunseul-slash-option')).map((e) => e.textContent ?? '');
const activeText = (root: HTMLElement): string | null =>
	root.querySelector('.yunseul-slash-option.is-active')?.textContent ?? null;

afterEach(() => {
	document.body.innerHTML = '';
});

describe('SlashMenu — opening and filtering', () => {
	it('opens on "/" with every cached command and the first one active', () => {
		const m = mount('claude-code');
		type(m.input, '/');
		expect(isOpen(m.root)).toBe(true);
		// CLI list merged with the local commands (/clear, /effort, /model).
		expect(optionTexts(m.root)).toEqual(['/clear', '/code-review', '/compact', '/context', '/effort', '/model', '/usage']);
		expect(activeText(m.root)).toBe('/clear');
		expect(m.input.getAttribute('aria-activedescendant')).toBe('hint-1-menu-opt-0');
		expect(m.input.getAttribute('aria-controls')).toBe('hint-1-menu');
		expect(menuEl(m.root).getAttribute('role')).toBe('listbox');
	});

	it('filters as the user types, prefix matches before substring matches', () => {
		const m = mount('claude-code');
		type(m.input, '/co');
		expect(optionTexts(m.root)).toEqual(['/code-review', '/compact', '/context']);
		type(m.input, '/ea');
		expect(optionTexts(m.root)).toEqual(['/clear']);
	});

	it('closes once the text stops looking like a command, and when nothing matches', () => {
		const m = mount('claude-code');
		type(m.input, '/comp');
		expect(isOpen(m.root)).toBe(true);
		type(m.input, '/compact now');
		expect(isOpen(m.root)).toBe(false);
		expect(m.input.hasAttribute('aria-activedescendant')).toBe(false);
		type(m.input, '/zzz');
		expect(isOpen(m.root)).toBe(false);
		type(m.input, 'hello /compact');
		expect(isOpen(m.root)).toBe(false);
	});

	it('offers only the local commands for the LM Studio provider (no CLI list)', () => {
		const m = mount('lm-studio');
		type(m.input, '/');
		expect(optionTexts(m.root)).toEqual(['/clear', '/effort', '/model']);
		key(m.input, 'Tab');
		expect(m.input.value).toBe('/clear ');
		expect(m.calls.send).toBe(0);
	});

	it('offers the local commands before the CLI list has been learned', () => {
		const m = mount('claude-code', []);
		type(m.input, '/');
		expect(isOpen(m.root)).toBe(true);
		expect(m.root.querySelector('.yunseul-slash-empty')).toBeNull();
		expect(optionTexts(m.root)).toEqual(['/clear', '/effort', '/model']);
	});

	it('never opens for an unfocused textarea (settings-change re-sync, sibling leaf learning the list)', () => {
		const m = mount('claude-code');
		type(m.input, '/co');
		expect(isOpen(m.root)).toBe(true);
		m.input.blur();
		expect(isOpen(m.root)).toBe(false);
		// Another leaf's reply persisted a new list → settings listener →
		// updateSlashHint() → sync(): must stay closed while unfocused.
		m.handle.updateSlashHint();
		expect(isOpen(m.root)).toBe(false);
		expect(m.input.hasAttribute('aria-activedescendant')).toBe(false);
		// Programmatic input without focus (paste via command, etc.) too.
		type(m.input, '/');
		expect(isOpen(m.root)).toBe(false);
		// Focus back + a keystroke reopens as usual.
		m.input.focus();
		type(m.input, '/co');
		expect(isOpen(m.root)).toBe(true);
	});

	it('merges the CLI list with the local commands without duplicates', () => {
		const m = mount('claude-code', ['effort', 'model', 'usage']);
		type(m.input, '/');
		expect(optionTexts(m.root)).toEqual(['/clear', '/effort', '/model', '/usage']);
	});

	it('picks up a list learned after mount (live read of settings)', () => {
		const m = mount('claude-code', []);
		m.plugin.settings.claudeCode.knownSlashCommands = ['usage'];
		type(m.input, '/u');
		expect(optionTexts(m.root)).toEqual(['/usage']);
	});
});

describe('SlashMenu — keyboard', () => {
	it('ArrowDown / ArrowUp move the active option with wrap-around', () => {
		const m = mount('claude-code');
		type(m.input, '/');
		key(m.input, 'ArrowDown');
		expect(activeText(m.root)).toBe('/code-review');
		expect(m.input.getAttribute('aria-activedescendant')).toBe('hint-1-menu-opt-1');
		key(m.input, 'ArrowUp');
		key(m.input, 'ArrowUp');
		expect(activeText(m.root)).toBe('/usage');
		key(m.input, 'ArrowDown');
		expect(activeText(m.root)).toBe('/clear');
	});

	it('Enter accepts the active option, fills "/name ", keeps focus, and does NOT send', () => {
		const m = mount('claude-code');
		m.input.focus();
		type(m.input, '/co');
		key(m.input, 'ArrowDown');
		const ev = key(m.input, 'Enter');
		expect(ev.defaultPrevented).toBe(true);
		expect(m.input.value).toBe('/compact ');
		expect(m.input.selectionStart).toBe('/compact '.length);
		expect(isOpen(m.root)).toBe(false);
		expect(m.calls.send).toBe(0);
		expect(document.activeElement).toBe(m.input);
		// The next Enter sends the completed command.
		key(m.input, 'Enter');
		expect(m.calls.send).toBe(1);
	});

	it('Enter on a fully typed command sends it instead of re-completing', () => {
		const m = mount('claude-code');
		type(m.input, '/compact');
		expect(activeText(m.root)).toBe('/compact');
		const ev = key(m.input, 'Enter');
		expect(ev.defaultPrevented).toBe(true); // the composer's own send binding
		expect(m.calls.send).toBe(1);
		expect(m.input.value).toBe('/compact');
		expect(isOpen(m.root)).toBe(false);
		// Case-insensitive: /COMPACT typed in full also sends.
		type(m.input, '/COMPACT');
		key(m.input, 'Enter');
		expect(m.calls.send).toBe(2);
		// A partial still completes first.
		type(m.input, '/comp');
		key(m.input, 'Enter');
		expect(m.input.value).toBe('/compact ');
		expect(m.calls.send).toBe(2);
	});

	it('Tab accepts as well; Shift+Enter is left alone (newline)', () => {
		const m = mount('claude-code');
		type(m.input, '/us');
		key(m.input, 'Tab');
		expect(m.input.value).toBe('/usage ');
		type(m.input, '/us');
		const ev = key(m.input, 'Enter', { shiftKey: true });
		expect(ev.defaultPrevented).toBe(false);
		expect(m.input.value).toBe('/us');
		expect(m.calls.send).toBe(0);
	});

	it('Escape closes the popover without sending or moving focus; a second Escape restores focus', () => {
		const m = mount('claude-code');
		type(m.input, '/');
		key(m.input, 'Escape');
		expect(isOpen(m.root)).toBe(false);
		expect(m.calls.prevFocus).toBe(0);
		key(m.input, 'Escape');
		expect(m.calls.prevFocus).toBe(1);
		expect(m.calls.send).toBe(0);
	});

	it('Enter with the popover closed sends as usual', () => {
		const m = mount('claude-code');
		type(m.input, 'plain message');
		key(m.input, 'Enter');
		expect(m.calls.send).toBe(1);
	});
});

describe('SlashMenu — mouse, lifecycle, hint', () => {
	it('clicking an option picks it and mousedown does not steal focus', () => {
		const m = mount('claude-code');
		m.input.focus();
		type(m.input, '/');
		const option = m.root.querySelectorAll('.yunseul-slash-option')[2] as HTMLElement;
		const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
		option.dispatchEvent(down);
		expect(down.defaultPrevented).toBe(true);
		option.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		expect(m.input.value).toBe('/compact ');
		expect(document.activeElement).toBe(m.input);
	});

	it('setValue("") (post-send clear) and blur both close the popover', () => {
		const m = mount('claude-code');
		type(m.input, '/');
		m.handle.setValue('');
		expect(isOpen(m.root)).toBe(false);
		type(m.input, '/');
		expect(isOpen(m.root)).toBe(true);
		m.input.dispatchEvent(new FocusEvent('blur'));
		expect(isOpen(m.root)).toBe(false);
	});

	it('hint wording follows the provider and updateSlashHint() re-syncs the list', () => {
		const m = mount('claude-code');
		const hint = m.root.querySelector('.yunseul-composer-slash-hint') as HTMLElement;
		expect(hint.textContent).toBe('/ Claude Code commands');
		type(m.input, '/');
		m.plugin.settings.provider = 'lm-studio';
		m.handle.updateSlashHint();
		expect(hint.textContent).toBe('/ commands');
		expect(optionTexts(m.root)).toEqual(['/clear', '/effort', '/model']);
	});
});

describe('SlashMenu — argument pickers (/model, /effort)', () => {
	const MODEL_ITEMS: SlashMenuItem[] = [
		{ value: 'default', detail: 'Claude Code picks', current: true },
		{ value: 'sonnet', detail: 'Latest Sonnet' },
		{ value: 'opus', detail: 'Latest Opus' },
		{ value: 'sonnet[1m]', detail: '1M context' },
	];
	const names = (root: HTMLElement): string[] =>
		Array.from(root.querySelectorAll('.yunseul-slash-option-name')).map((e) => e.textContent ?? '');
	const activeName = (root: HTMLElement): string | null =>
		root.querySelector('.yunseul-slash-option.is-active .yunseul-slash-option-name')?.textContent ?? null;

	it('typing "/model " opens the option list on the current row, with descriptions and a badge', () => {
		const m = mount('claude-code', COMMANDS, { argItems: { model: MODEL_ITEMS } });
		type(m.input, '/model ');
		expect(isOpen(m.root)).toBe(true);
		expect(names(m.root)).toEqual(['default', 'sonnet', 'opus', 'sonnet[1m]']);
		expect(activeName(m.root)).toBe('default');
		expect(m.root.querySelector('.yunseul-slash-option.is-current .yunseul-slash-option-badge')?.textContent).toBe('current');
		expect(m.root.querySelector('.yunseul-slash-option.is-current')?.getAttribute('aria-current')).toBe('true');
		expect(m.root.querySelector('.yunseul-slash-option-detail')?.textContent).toBe('Claude Code picks');
		expect(menuEl(m.root).getAttribute('aria-label')).toBe('Options for /model');
		expect(m.input.getAttribute('aria-activedescendant')).toBe('hint-1-menu-opt-0');
		expect(m.opened).toEqual(['model']);
	});

	it('lands on the current row even when it is not first', () => {
		const items = MODEL_ITEMS.map((i) => ({ ...i, current: i.value === 'opus' }));
		const m = mount('claude-code', COMMANDS, { argItems: { model: items } });
		type(m.input, '/model ');
		expect(activeName(m.root)).toBe('opus');
	});

	it('filters by the typed partial; Enter runs the command with the active value and does not send', () => {
		const m = mount('claude-code', COMMANDS, { argItems: { model: MODEL_ITEMS } });
		type(m.input, '/model so');
		expect(names(m.root)).toEqual(['sonnet', 'sonnet[1m]']);
		expect(activeName(m.root)).toBe('sonnet');
		const ev = key(m.input, 'Enter');
		expect(ev.defaultPrevented).toBe(true);
		expect(m.picks).toEqual([['model', 'sonnet']]);
		expect(m.calls.send).toBe(0);
		expect(isOpen(m.root)).toBe(false);
	});

	it('ArrowDown then Tab picks too; Shift+Enter is left alone', () => {
		const m = mount('claude-code', COMMANDS, { argItems: { model: MODEL_ITEMS } });
		type(m.input, '/model ');
		key(m.input, 'ArrowDown');
		key(m.input, 'ArrowDown');
		expect(activeName(m.root)).toBe('opus');
		expect(key(m.input, 'Enter', { shiftKey: true }).defaultPrevented).toBe(false);
		key(m.input, 'Tab');
		expect(m.picks).toEqual([['model', 'opus']]);
	});

	it('Enter on a fully typed /model opens its picker instead of sending; /clear still sends', () => {
		const m = mount('claude-code', COMMANDS, { argItems: { model: MODEL_ITEMS } });
		type(m.input, '/model');
		expect(optionTexts(m.root)).toEqual(['/model']);
		key(m.input, 'Enter');
		expect(m.input.value).toBe('/model ');
		expect(isOpen(m.root)).toBe(true);
		expect(names(m.root)).toEqual(['default', 'sonnet', 'opus', 'sonnet[1m]']);
		expect(m.calls.send).toBe(0);
		expect(m.opened).toEqual(['model']);

		type(m.input, '/clear');
		key(m.input, 'Enter');
		expect(m.calls.send).toBe(1);
		expect(m.input.value).toBe('/clear');
	});

	it('picking /model from the command list opens its picker in the same motion', () => {
		const m = mount('claude-code', COMMANDS, { argItems: { model: MODEL_ITEMS } });
		type(m.input, '/mod');
		key(m.input, 'Enter');
		expect(m.input.value).toBe('/model ');
		expect(isOpen(m.root)).toBe(true);
		expect(activeName(m.root)).toBe('default');
	});

	it('openArgumentPicker() does the same from outside (bare /model sent via the Send button)', () => {
		const m = mount('claude-code', COMMANDS, { argItems: { effort: [{ value: 'default', current: true }, { value: 'high' }] } });
		m.handle.openArgumentPicker('effort');
		expect(m.input.value).toBe('/effort ');
		expect(names(m.root)).toEqual(['default', 'high']);
		expect(document.activeElement).toBe(m.input);
	});

	it('shows the status row with no rows while loading, and refreshSlashMenu() fills the rows in place', () => {
		const items: SlashMenuItem[] = [];
		const status: Record<string, string | null> = { model: 'Loading models…' };
		const m = mount('lm-studio', COMMANDS, { argItems: { model: items }, status });
		type(m.input, '/model ');
		expect(isOpen(m.root)).toBe(true);
		expect(names(m.root)).toEqual([]);
		const statusEl = m.root.querySelector('.yunseul-slash-status');
		expect(statusEl?.textContent).toBe('Loading models…');
		expect(statusEl?.getAttribute('aria-disabled')).toBe('true');
		expect(m.input.hasAttribute('aria-activedescendant')).toBe(false);
		// Arrow keys and Enter have nothing to act on.
		expect(key(m.input, 'ArrowDown').defaultPrevented).toBe(false);

		items.push({ value: 'default', current: true }, { value: 'qwen-7b' }, { value: 'llama-8b' });
		status.model = null;
		m.handle.refreshSlashMenu();
		expect(names(m.root)).toEqual(['default', 'qwen-7b', 'llama-8b']);
		expect(m.root.querySelector('.yunseul-slash-status')).toBeNull();
		expect(activeName(m.root)).toBe('default');
		// Still the same picker session: the open hook fired once.
		expect(m.opened).toEqual(['model']);
	});

	it('closes when nothing matches so Enter sends a custom id as typed', () => {
		const m = mount('claude-code', COMMANDS, { argItems: { model: MODEL_ITEMS } });
		type(m.input, '/model claude-sonnet-5-5');
		expect(isOpen(m.root)).toBe(false);
		key(m.input, 'Enter');
		expect(m.calls.send).toBe(1);
		expect(m.picks).toEqual([]);
	});

	it('never opens for a command without a picker, a second argument, or a newline', () => {
		const m = mount('claude-code', COMMANDS, { argItems: { model: MODEL_ITEMS } });
		type(m.input, '/compact now');
		expect(isOpen(m.root)).toBe(false);
		expect(m.opened).toEqual([]);
		type(m.input, '/model a b');
		expect(isOpen(m.root)).toBe(false);
		type(m.input, '/model \nx');
		expect(isOpen(m.root)).toBe(false);
	});

	it('clicking a row picks it; Escape closes and keeps the text', () => {
		const m = mount('claude-code', COMMANDS, { argItems: { model: MODEL_ITEMS } });
		type(m.input, '/model ');
		const rows = m.root.querySelectorAll('.yunseul-slash-option');
		(rows[2] as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));
		expect(m.picks).toEqual([['model', 'opus']]);
		expect(isOpen(m.root)).toBe(false);

		type(m.input, '/effort ');
		// /effort has no rows in this mount → no picker.
		expect(isOpen(m.root)).toBe(false);
		type(m.input, '/model ');
		expect(isOpen(m.root)).toBe(true);
		key(m.input, 'Escape');
		expect(isOpen(m.root)).toBe(false);
		expect(m.input.value).toBe('/model ');
		expect(m.calls.prevFocus).toBe(0);
	});

	it('re-opening the picker after it closed fires the open hook again (lets a failed fetch retry)', () => {
		const m = mount('claude-code', COMMANDS, { argItems: { model: MODEL_ITEMS } });
		type(m.input, '/model ');
		key(m.input, 'Escape');
		type(m.input, '/model ');
		expect(m.opened).toEqual(['model', 'model']);
	});
});

describe('SlashMenu — refresh and settings-change semantics', () => {
	it('a fetch landing after Escape does not re-open the picker, so Enter sends the typed id', () => {
		const items: SlashMenuItem[] = [];
		const status: Record<string, string | null> = { model: 'Loading models…' };
		const m = mount('lm-studio', COMMANDS, { argItems: { model: items }, status });
		type(m.input, '/model qwen');
		expect(isOpen(m.root)).toBe(true);
		key(m.input, 'Escape');
		expect(isOpen(m.root)).toBe(false);

		items.push({ value: 'default', current: true }, { value: 'qwen-7b' });
		status.model = null;
		m.handle.refreshSlashMenu();
		expect(isOpen(m.root)).toBe(false);
		key(m.input, 'Enter');
		expect(m.calls.send).toBe(1);
		expect(m.picks).toEqual([]);
	});

	it('updateSlashHint() restarts an open picker so the owner can refetch its rows', () => {
		const m = mount('lm-studio', COMMANDS, { argItems: { model: [{ value: 'default', current: true }, { value: 'a' }] } });
		type(m.input, '/model ');
		expect(m.opened).toEqual(['model']);
		m.handle.updateSlashHint();
		expect(isOpen(m.root)).toBe(true);
		expect(m.opened).toEqual(['model', 'model']);
		// A closed popover stays closed.
		key(m.input, 'Escape');
		m.handle.updateSlashHint();
		expect(isOpen(m.root)).toBe(false);
	});
});
