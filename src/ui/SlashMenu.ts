import { type Component } from 'obsidian';
import { filterSlashCommands } from '../claude-code/slash';

// Slash-command popover for the composer.
//
// Opens while the textarea holds nothing but `/` plus a partial command
// name, lists the commands the owner supplies (Yunseul's own /clear,
// /model, /effort for every provider, plus the Claude Code CLI's
// advertised list when that provider is active), and fills the textarea
// with `/name ` on pick. It is a listbox driven from the textarea (ARIA
// "textbox with aria-activedescendant" pattern): the textarea keeps
// focus, options are not focusable, and the active option is mirrored
// into aria-activedescendant. Mouse selection goes through
// mousedown-preventDefault so the textarea never blurs mid-pick.
//
// The owner (ChatComposer) routes keystrokes through handleKeydown
// BEFORE its own Enter-to-send binding, so Enter/Tab accept an option
// instead of sending while the popover is open.

export interface SlashMenuOptions {
	/** Positioned container the popover anchors to (the composer frame). */
	anchorEl: HTMLElement;
	inputEl: HTMLTextAreaElement;
	component: Component;
	/** Unique per view; used for aria-controls / option ids. */
	menuId: string;
	getCommands: () => readonly string[];
	/** False for providers without slash commands (LM Studio). */
	isEnabled: () => boolean;
	onPick: (name: string) => void;
}

export interface SlashMenuHandle {
	listEl: HTMLElement;
	/** Re-evaluate the textarea value: open, filter, or close. */
	sync(): void;
	/** Returns true when the popover consumed the key (caller preventDefaults). */
	handleKeydown(ev: KeyboardEvent): boolean;
	close(): void;
	isOpen(): boolean;
}

// The whole value must be `/` + partial name: a space or newline means
// the user is past the command and typing arguments.
const QUERY_RE = /^\/([A-Za-z0-9_:.-]*)$/;

// Height budget when opening upward. The CSS max-height is the ceiling;
// render() lowers it to the room actually available above the frame so a
// short pane cannot push the first rows out of view (negative overflow is
// not scrollable). The floor keeps at least a couple of rows usable.
const MENU_MAX_HEIGHT_PX = 240;
const MENU_MIN_HEIGHT_PX = 80;
const MENU_MARGIN_PX = 12;

export function renderSlashMenu(opts: SlashMenuOptions): SlashMenuHandle {
	const listEl = opts.anchorEl.createDiv({
		cls: 'yunseul-slash-menu',
		attr: { id: opts.menuId, role: 'listbox', 'aria-label': 'Commands' },
	});

	let open = false;
	let items: string[] = [];
	let active = -1;
	let query = '';

	const optionId = (i: number): string => `${opts.menuId}-opt-${i}`;

	const fitHeight = (): void => {
		const root = opts.anchorEl.closest('.yunseul-chat-root');
		if (root === null) return;
		const room = opts.anchorEl.getBoundingClientRect().top
			- root.getBoundingClientRect().top
			- MENU_MARGIN_PX;
		const px = Math.max(MENU_MIN_HEIGHT_PX, Math.min(MENU_MAX_HEIGHT_PX, Math.floor(room)));
		listEl.setCssStyles({ maxHeight: `${px}px` });
	};

	const render = (): void => {
		listEl.empty();
		fitHeight();
		for (let i = 0; i < items.length; i++) {
			const name = items[i];
			if (name === undefined) continue;
			const el = listEl.createDiv({
				cls: 'yunseul-slash-option',
				attr: {
					role: 'option',
					id: optionId(i),
					'aria-selected': i === active ? 'true' : 'false',
					'data-index': String(i),
				},
			});
			el.createSpan({ cls: 'yunseul-slash-option-name', text: `/${name}` });
			if (i === active) {
				el.addClass('is-active');
				// jsdom has no scrollIntoView; real DOM keeps the active
				// row visible inside the scrollable list.
				if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' });
			}
		}
		listEl.addClass('is-open');
		opts.inputEl.setAttr('aria-haspopup', 'listbox');
		opts.inputEl.setAttr('aria-autocomplete', 'list');
		opts.inputEl.setAttr('aria-controls', opts.menuId);
		if (active >= 0) {
			opts.inputEl.setAttr('aria-activedescendant', optionId(active));
		} else {
			opts.inputEl.removeAttribute('aria-activedescendant');
		}
	};

	const close = (): void => {
		if (!open && items.length === 0) return;
		open = false;
		items = [];
		active = -1;
		listEl.empty();
		listEl.removeClass('is-open');
		opts.inputEl.removeAttribute('aria-haspopup');
		opts.inputEl.removeAttribute('aria-autocomplete');
		opts.inputEl.removeAttribute('aria-controls');
		opts.inputEl.removeAttribute('aria-activedescendant');
	};

	const sync = (): void => {
		if (!opts.isEnabled()) {
			close();
			return;
		}
		// Never open for an unfocused textarea. sync() also runs from the
		// settings-change hook (a sibling leaf learning the command list
		// mid-stream, a toggle in the settings tab), and a popover with
		// aria-activedescendant on a field that is not focused is wrong
		// for assistive tech and cannot be dismissed by typing.
		if (opts.inputEl.ownerDocument.activeElement !== opts.inputEl) {
			close();
			return;
		}
		const m = QUERY_RE.exec(opts.inputEl.value);
		if (m === null) {
			close();
			return;
		}
		query = m[1] ?? '';
		const next = filterSlashCommands(opts.getCommands(), query);
		// Nothing matches: get out of the way so Enter sends the text as
		// typed (Claude Code forwards unknown commands to the model with a
		// note; other backends treat it as plain text).
		if (next.length === 0) {
			close();
			return;
		}
		const changed = next.length !== items.length || next.some((n, i) => n !== items[i]);
		items = next;
		if (changed || !open) active = items.length > 0 ? 0 : -1;
		open = true;
		render();
	};

	const pick = (index: number): void => {
		const name = items[index];
		if (name === undefined) return;
		close();
		opts.onPick(name);
	};

	const handleKeydown = (ev: KeyboardEvent): boolean => {
		if (!open || ev.isComposing) return false;
		switch (ev.key) {
			case 'ArrowDown':
				if (items.length === 0) return false;
				active = (active + 1) % items.length;
				render();
				return true;
			case 'ArrowUp':
				if (items.length === 0) return false;
				active = (active - 1 + items.length) % items.length;
				render();
				return true;
			case 'Enter':
			case 'Tab': {
				// Shift+Enter keeps its newline meaning.
				if (ev.shiftKey || active < 0) return false;
				// The command is already typed in full: Enter should send
				// it, not rewrite it and demand a second Enter. Tab still
				// completes (adds the trailing space).
				const activeName = items[active];
				if (ev.key === 'Enter' && activeName !== undefined && activeName.toLowerCase() === query.toLowerCase()) {
					close();
					return false;
				}
				pick(active);
				return true;
			}
			case 'Escape':
				close();
				return true;
			default:
				return false;
		}
	};

	// Keep focus in the textarea across a mouse pick (mousedown would
	// otherwise blur it, and the blur handler below closes the list
	// before click can land).
	opts.component.registerDomEvent(listEl, 'mousedown', (ev: MouseEvent) => {
		ev.preventDefault();
	});
	opts.component.registerDomEvent(listEl, 'click', (ev: MouseEvent) => {
		const target = ev.target instanceof HTMLElement ? ev.target : null;
		const optionEl = target?.closest('.yunseul-slash-option');
		if (!(optionEl instanceof HTMLElement)) return;
		const idx = Number(optionEl.getAttribute('data-index'));
		if (Number.isInteger(idx)) pick(idx);
	});
	opts.component.registerDomEvent(opts.inputEl, 'blur', () => {
		close();
	});

	return {
		listEl,
		sync,
		handleKeydown,
		close,
		isOpen: () => open,
	};
}
