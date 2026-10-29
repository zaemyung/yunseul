import { describe, expect, it } from 'vitest';
import { PromptAssembler } from '../src/chat/prompt';

const base = { boundFile: null, history: [{ role: 'user' as const, content: 'hi', ts: 1 }], maxChars: 12000 };

describe('PromptAssembler — Codex addendum', () => {
	it('adds the read-only sandbox addendum by default', () => {
		const [system] = PromptAssembler.build({ ...base, provider: 'codex' });
		expect(system?.content).toContain('read-only shell commands');
		expect(system?.content).toContain('[[Note Name]]');
		expect(system?.content).not.toContain('Edit/Write');
	});

	it('switches to the write-enabled addendum when writesEnabled is true', () => {
		const [system] = PromptAssembler.build({ ...base, provider: 'codex', writesEnabled: true });
		expect(system?.content).toContain('edit files in this vault');
	});

	it('the Claude Code addendum still keys off the same writesEnabled flag', () => {
		const [ro] = PromptAssembler.build({ ...base, provider: 'claude-code' });
		const [rw] = PromptAssembler.build({ ...base, provider: 'claude-code', writesEnabled: true });
		expect(ro?.content).toContain('cannot modify them');
		expect(rw?.content).toContain('Edit, and Write tools');
	});

	it('LM Studio gets no addendum', () => {
		const [system] = PromptAssembler.build({ ...base, provider: 'lm-studio' });
		expect(system?.content).not.toContain('Obsidian vault. The current working directory');
	});
});
