/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, describe, expect, it } from 'vitest';
import { Component } from './_stubs/obsidian';
import { renderChatComposer, type ChatComposerHandle } from '../src/ui/ChatComposer';

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
}

function mount(provider: 'claude-code' | 'lm-studio', commands: string[] = COMMANDS): Mounted {
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
	});
	// A real user focuses the textarea before typing; the popover refuses
	// to open for an unfocused field (see SlashMenu.sync).
	handle.inputEl.focus();
	return { root, handle, input: handle.inputEl, plugin, calls };
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
