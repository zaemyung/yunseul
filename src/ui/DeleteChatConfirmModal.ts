import { type App, Component, Modal } from 'obsidian';

// Confirmation modal for the destructive "Delete chat" action. Removing a
// session drops its transcript from memory and deletes the on-disk snapshot
// permanently, so a single mis-click in the header shouldn't wipe a
// conversation. Mirrors ResetIndexConfirmModal so the two destructive
// confirmations read as a matched pair. The view only opens this when the
// chat has content worth losing; an empty chat is deleted without a prompt.

export interface DeleteChatConfirmOpts {
	/** Message count shown so the user knows how much they're discarding. */
	messageCount: number;
	onConfirm: () => void;
}

export class DeleteChatConfirmModal extends Modal {
	private readonly opts: DeleteChatConfirmOpts;
	private readonly lifecycle = new Component();

	constructor(app: App, opts: DeleteChatConfirmOpts) {
		super(app);
		this.opts = opts;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		// Reuse the shared index-modal layout rules (note/actions) so the
		// confirmation matches the plugin's other destructive prompt.
		contentEl.addClass('yunseul-delete-modal');
		contentEl.addClass('yunseul-index-modal');
		this.lifecycle.load();

		this.setTitle('Delete this chat?');

		const intro = contentEl.createEl('p');
		const n = this.opts.messageCount;
		intro.setText(
			`This permanently deletes the current conversation (${n} message${n === 1 ? '' : 's'}) and returns you to the start page.`,
		);

		const impact = contentEl.createEl('p', { cls: 'yunseul-index-modal-note' });
		impact.setText('This cannot be undone.');

		const actions = contentEl.createDiv({ cls: 'yunseul-index-modal-actions' });

		const cancelBtn = actions.createEl('button', { text: 'Cancel' });
		this.lifecycle.registerDomEvent(cancelBtn, 'click', () => this.close());

		const confirmBtn = actions.createEl('button', {
			text: 'Delete chat',
			cls: 'mod-warning',
		});
		this.lifecycle.registerDomEvent(confirmBtn, 'click', () => {
			this.opts.onConfirm();
			this.close();
		});

		// Initial focus on the SAFE action (Cancel) — WCAG 2.4.3. A user who
		// hits Enter immediately after the modal opens gets a no-op rather
		// than data loss, matching ResetIndexConfirmModal.
		cancelBtn.focus();
	}

	onClose(): void {
		this.lifecycle.unload();
		this.contentEl.empty();
	}
}
