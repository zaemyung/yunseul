import { type Component } from 'obsidian';
import { filterSlashCommands } from '../claude-code/slash';

// Slash-command popover for the composer. Two modes, one listbox:
//
//  - Command mode: the textarea holds nothing but `/` plus a partial
//    command name. Lists the commands the owner supplies (Yunseul's own
//    /clear, /model, /effort for every provider, plus the Claude Code
//    CLI's advertised list when that provider is active) and fills the
//    textarea with `/name ` on pick.
//  - Argument mode: the textarea holds `/name ` plus a partial argument
//    and the owner has options for that command (`/model`, `/effort`).
//    Lists those options — with descriptions and a "current" marker —
//    filtered by the partial; picking one runs the command at once, the
//    way the CLIs' own pickers do. An optional status row carries
//    "Loading models…" or a failure reason while the owner fetches.
//
// It is a listbox driven from the textarea (ARIA "textbox with
// aria-activedescendant" pattern): the textarea keeps focus, options are
// not focusable, and the active option is mirrored into
// aria-activedescendant. Mouse selection goes through
// mousedown-preventDefault so the textarea never blurs mid-pick.
//
// The owner (ChatComposer) routes keystrokes through handleKeydown
// BEFORE its own Enter-to-send binding, so Enter/Tab accept an option
// instead of sending while the popover is open.

export interface SlashMenuItem {
	/** Command name (command mode) or argument value (argument mode). */
	value: string;
	/** One-line description shown muted after the value. */
	detail?: string;
	/** Argument mode: the value in effect for this chat right now. */
	current?: boolean;
}

export interface SlashMenuOptions {
	/** Positioned container the popover anchors to (the composer frame). */
	anchorEl: HTMLElement;
	inputEl: HTMLTextAreaElement;
	component: Component;
	/** Unique per view; used for aria-controls / option ids. */
	menuId: string;
	getCommands: () => readonly string[];
	/** False for providers without slash commands (none today; kept for the owner). */
	isEnabled: () => boolean;
	/** Command mode pick: the owner fills `/name ` into the textarea. */
	onPick: (name: string) => void;
	/**
	 * Options for `/command <arg>`, or null when the command takes no
	 * picked argument (everything but /model and /effort).
	 */
	getArgumentItems: (command: string) => readonly SlashMenuItem[] | null;
	/** Status row for argument mode (loading, failure, nothing listed); null = none. */
	getArgumentStatus: (command: string) => string | null;
	/** Argument mode pick: the owner runs the command with the value. */
	onPickArgument: (command: string, value: string) => void;
	/** Fires each time the popover enters argument mode for a command (owner may start a fetch). */
	onArgumentMenuOpen: (command: string) => void;
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

type Mode = 'commands' | 'argument';

// Command mode: the whole value is `/` + partial name.
const COMMAND_RE = /^\/([A-Za-z0-9_:.-]*)$/;
// Argument mode: `/name` + spaces/tabs + partial argument, all on one
// line. A newline or a second argument means the user is past the
// picker (the command validator will reject spaces in an id anyway).
const ARGUMENT_RE = /^\/([A-Za-z0-9_][A-Za-z0-9_:.-]{0,63})[ \t]+(\S*)$/;

// Height budget when opening upward. The CSS max-height is the ceiling;
// render() lowers it to the room actually available above the frame so a
// short pane cannot push the first rows out of view (negative overflow is
// not scrollable). The floor keeps at least a couple of rows usable.
const MENU_MAX_HEIGHT_PX = 240;
const MENU_MIN_HEIGHT_PX = 80;
const MENU_MARGIN_PX = 12;

/** Prefix matches first, then substring matches, on the value only. */
export function filterSlashItems(items: readonly SlashMenuItem[], query: string): SlashMenuItem[] {
	const q = query.toLowerCase();
	if (q.length === 0) return items.slice();
	const prefix: SlashMenuItem[] = [];
	const contains: SlashMenuItem[] = [];
	for (const item of items) {
		const lower = item.value.toLowerCase();
		if (lower.startsWith(q)) prefix.push(item);
		else if (lower.includes(q)) contains.push(item);
	}
	return prefix.concat(contains);
}

export function renderSlashMenu(opts: SlashMenuOptions): SlashMenuHandle {
	const listEl = opts.anchorEl.createDiv({
		cls: 'yunseul-slash-menu',
		attr: { id: opts.menuId, role: 'listbox', 'aria-label': 'Commands' },
	});

	let open = false;
	let mode: Mode = 'commands';
	let command = '';
	let items: SlashMenuItem[] = [];
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

	const render = (status: string | null): void => {
		listEl.empty();
		fitHeight();
		listEl.setAttr('aria-label', mode === 'commands' ? 'Commands' : `Options for /${command}`);
		for (let i = 0; i < items.length; i++) {
			const item = items[i];
			if (item === undefined) continue;
			const el = listEl.createDiv({
				cls: 'yunseul-slash-option',
				attr: {
					role: 'option',
					id: optionId(i),
					'aria-selected': i === active ? 'true' : 'false',
					'data-index': String(i),
				},
			});
			el.createSpan({
				cls: 'yunseul-slash-option-name',
				text: mode === 'commands' ? `/${item.value}` : item.value,
			});
			if (item.detail !== undefined) {
				el.createSpan({ cls: 'yunseul-slash-option-detail', text: item.detail });
			}
			if (item.current === true) {
				el.addClass('is-current');
				el.setAttr('aria-current', 'true');
				// aria-current already announces it; the badge is visual.
				el.createSpan({ cls: 'yunseul-slash-option-badge', text: 'current', attr: { 'aria-hidden': 'true' } });
			}
			if (i === active) {
				el.addClass('is-active');
				// jsdom has no scrollIntoView; real DOM keeps the active
				// row visible inside the scrollable list.
				if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' });
			}
		}
		if (status !== null) {
			// Announced but never active: not an index in `items`, so the
			// arrow keys skip it and Enter cannot pick it.
			listEl.createDiv({
				cls: 'yunseul-slash-status',
				text: status,
				attr: { role: 'option', 'aria-disabled': 'true', 'aria-selected': 'false' },
			});
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
		mode = 'commands';
		command = '';
		items = [];
		active = -1;
		listEl.empty();
		listEl.removeClass('is-open');
		opts.inputEl.removeAttribute('aria-haspopup');
		opts.inputEl.removeAttribute('aria-autocomplete');
		opts.inputEl.removeAttribute('aria-controls');
		opts.inputEl.removeAttribute('aria-activedescendant');
	};

	const sameItems = (a: readonly SlashMenuItem[], b: readonly SlashMenuItem[]): boolean =>
		a.length === b.length && a.every((x, i) => x.value === b[i]?.value);

	const syncCommands = (partial: string): void => {
		const next = filterSlashCommands(opts.getCommands(), partial).map((value) => ({ value }));
		// Nothing matches: get out of the way so Enter sends the text as
		// typed (Claude Code forwards unknown commands to the model with a
		// note; other backends treat it as plain text).
		if (next.length === 0) {
			close();
			return;
		}
		const changed = mode !== 'commands' || !sameItems(next, items);
		mode = 'commands';
		command = '';
		query = partial;
		items = next;
		if (changed || !open) active = 0;
		open = true;
		render(null);
	};

	const syncArgument = (name: string, partial: string): void => {
		if (opts.getArgumentItems(name) === null) {
			close();
			return;
		}
		// Tell the owner first: it may flip its state to "loading" (and
		// start a fetch) so the rows and status read below already
		// reflect that on the very first paint.
		const entering = !(open && mode === 'argument' && command === name);
		if (entering) opts.onArgumentMenuOpen(name);
		const next = filterSlashItems(opts.getArgumentItems(name) ?? [], partial);
		const status = opts.getArgumentStatus(name);
		if (next.length === 0 && status === null) {
			close();
			return;
		}
		const changed = entering || !sameItems(next, items);
		mode = 'argument';
		command = name;
		query = partial;
		items = next;
		if (changed) {
			// Land on the row in effect when the list is unfiltered (the
			// CLIs' pickers do the same); a typed partial puts the best
			// match first.
			const currentIdx = partial.length === 0 ? next.findIndex((it) => it.current === true) : -1;
			active = next.length === 0 ? -1 : (currentIdx >= 0 ? currentIdx : 0);
		}
		open = true;
		render(status);
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
		const value = opts.inputEl.value;
		const cm = COMMAND_RE.exec(value);
		if (cm !== null) {
			syncCommands(cm[1] ?? '');
			return;
		}
		const am = ARGUMENT_RE.exec(value);
		if (am !== null) {
			syncArgument((am[1] ?? '').toLowerCase(), am[2] ?? '');
			return;
		}
		close();
	};

	const pick = (index: number): void => {
		const item = items[index];
		if (item === undefined) return;
		const pickedMode = mode;
		const pickedCommand = command;
		close();
		if (pickedMode === 'commands') opts.onPick(item.value);
		else opts.onPickArgument(pickedCommand, item.value);
	};

	const handleKeydown = (ev: KeyboardEvent): boolean => {
		if (!open || ev.isComposing) return false;
		switch (ev.key) {
			case 'ArrowDown':
				if (items.length === 0) return false;
				active = (active + 1) % items.length;
				render(mode === 'argument' ? opts.getArgumentStatus(command) : null);
				return true;
			case 'ArrowUp':
				if (items.length === 0) return false;
				active = (active - 1 + items.length) % items.length;
				render(mode === 'argument' ? opts.getArgumentStatus(command) : null);
				return true;
			case 'Enter':
			case 'Tab': {
				// Shift+Enter keeps its newline meaning.
				if (ev.shiftKey || active < 0) return false;
				const activeItem = items[active];
				if (activeItem === undefined) return false;
				if (mode === 'commands' && ev.key === 'Enter' && activeItem.value.toLowerCase() === query.toLowerCase()) {
					// The command is already typed in full. If it takes a
					// picked argument, Enter opens that picker (the owner's
					// onPick fills `/name ` and re-syncs); otherwise Enter
					// should send it, not rewrite it and demand a second
					// Enter. Tab still completes (adds the trailing space).
					if (opts.getArgumentItems(activeItem.value.toLowerCase()) !== null) {
						pick(active);
						return true;
					}
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
