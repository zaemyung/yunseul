import { describe, expect, it } from 'vitest';
import {
	LOCAL_SLASH_COMMANDS,
	SLASH_COMMAND_LIST_MAX,
	availableSlashCommands,
	classifyLocalSlashCommand,
	effortLevelsFor,
	isResetWord,
	filterSlashCommands,
	isSlashCommand,
	parseSlashCommand,
	sameSlashCommandList,
	sanitizeSlashCommandNames,
} from '../src/claude-code/slash';

describe('parseSlashCommand', () => {
	it('parses a bare command', () => {
		expect(parseSlashCommand('/compact')).toEqual({ name: 'compact', args: '' });
	});

	it('parses a command with arguments and trims them', () => {
		expect(parseSlashCommand('/ping   42 extra  ')).toEqual({ name: 'ping', args: '42 extra' });
	});

	it('accepts plugin-namespaced, dotted, and underscore-led names', () => {
		expect(parseSlashCommand('/anthropic-skills:docs')?.name).toBe('anthropic-skills:docs');
		expect(parseSlashCommand('/v1.2-beta go')?.name).toBe('v1.2-beta');
		expect(parseSlashCommand('/__remote-workflow')?.name).toBe('__remote-workflow');
	});

	it('tolerates surrounding whitespace and a newline after the name', () => {
		expect(parseSlashCommand('  /context\n')).toEqual({ name: 'context', args: '' });
		expect(parseSlashCommand('/ping\n42')).toEqual({ name: 'ping', args: '42' });
	});

	it('rejects absolute paths and other non-command slashes', () => {
		expect(parseSlashCommand('/Users/me/note.md what is this?')).toBeNull();
		expect(parseSlashCommand('/')).toBeNull();
		expect(parseSlashCommand('//comment')).toBeNull();
		expect(parseSlashCommand('/-flag')).toBeNull();
		expect(parseSlashCommand('hello /compact')).toBeNull();
		expect(parseSlashCommand('')).toBeNull();
	});

	it('rejects names longer than 64 chars', () => {
		expect(parseSlashCommand(`/${'a'.repeat(64)}`)).not.toBeNull();
		expect(parseSlashCommand(`/${'a'.repeat(65)}`)).toBeNull();
	});

	it('isSlashCommand mirrors parseSlashCommand', () => {
		expect(isSlashCommand('/x')).toBe(true);
		expect(isSlashCommand('x')).toBe(false);
	});
});

describe('sanitizeSlashCommandNames', () => {
	it('returns null when the payload is not an array', () => {
		expect(sanitizeSlashCommandNames(undefined)).toBeNull();
		expect(sanitizeSlashCommandNames('compact')).toBeNull();
		expect(sanitizeSlashCommandNames({ 0: 'compact' })).toBeNull();
	});

	it('drops non-strings and malformed names, dedupes, and sorts case-insensitively', () => {
		const out = sanitizeSlashCommandNames([
			'usage', 42, 'Compact', '-bad', 'has space', 'compact', 'clear', null, 'anthropic-skills:pdf',
		]);
		expect(out).toEqual(['anthropic-skills:pdf', 'clear', 'Compact', 'compact', 'usage']);
	});

	it('caps the list length', () => {
		const many = Array.from({ length: SLASH_COMMAND_LIST_MAX + 50 }, (_, i) => `c${i}`);
		expect(sanitizeSlashCommandNames(many)?.length).toBe(SLASH_COMMAND_LIST_MAX);
	});
});

describe('sameSlashCommandList', () => {
	it('compares element-wise', () => {
		expect(sameSlashCommandList(['a', 'b'], ['a', 'b'])).toBe(true);
		expect(sameSlashCommandList(['a', 'b'], ['b', 'a'])).toBe(false);
		expect(sameSlashCommandList(['a'], ['a', 'b'])).toBe(false);
		expect(sameSlashCommandList([], [])).toBe(true);
	});
});

describe('filterSlashCommands', () => {
	const names = ['clear', 'code-review', 'compact', 'context', 'usage'];

	it('returns everything for an empty query', () => {
		expect(filterSlashCommands(names, '')).toEqual(names);
	});

	it('ranks prefix matches before substring matches, case-insensitively', () => {
		expect(filterSlashCommands(names, 'Co')).toEqual(['code-review', 'compact', 'context']);
		expect(filterSlashCommands(names, 'ea')).toEqual(['clear']);
		expect(filterSlashCommands(names, 'c')).toEqual(['clear', 'code-review', 'compact', 'context']);
	});

	it('returns an empty list when nothing matches', () => {
		expect(filterSlashCommands(names, 'zzz')).toEqual([]);
	});
});

describe('classifyLocalSlashCommand', () => {
	it('maps /clear to new-chat regardless of case', () => {
		expect(classifyLocalSlashCommand('clear')).toEqual({ kind: 'new-chat' });
		expect(classifyLocalSlashCommand('CLEAR')).toEqual({ kind: 'new-chat' });
	});

	it('maps /model and /effort to their local kinds', () => {
		expect(classifyLocalSlashCommand('model')).toEqual({ kind: 'model' });
		expect(classifyLocalSlashCommand('Effort')).toEqual({ kind: 'effort' });
	});

	it('leaves every other command to the CLI', () => {
		expect(classifyLocalSlashCommand('compact')).toBeNull();
		expect(classifyLocalSlashCommand('context')).toBeNull();
		expect(classifyLocalSlashCommand('ping')).toBeNull();
	});
});

describe('effortLevelsFor / isResetWord / availableSlashCommands', () => {
	it('lists each backend\'s accepted effort levels, empty for LM Studio', () => {
		expect(effortLevelsFor('claude-code')).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
		expect(effortLevelsFor('codex')).toEqual(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);
		expect(effortLevelsFor('lm-studio')).toEqual([]);
		expect(effortLevelsFor('nope')).toEqual([]);
	});

	it('recognizes the reset words case-insensitively', () => {
		for (const w of ['default', 'Reset', ' clear ', 'OFF']) expect(isResetWord(w)).toBe(true);
		expect(isResetWord('opus')).toBe(false);
		expect(isResetWord('')).toBe(false);
	});

	it('always offers the local commands, adds the CLI list only for Claude Code, deduped and sorted', () => {
		expect(LOCAL_SLASH_COMMANDS).toEqual(['clear', 'effort', 'model']);
		expect(availableSlashCommands('lm-studio', ['compact'])).toEqual(['clear', 'effort', 'model']);
		expect(availableSlashCommands('codex', ['compact'])).toEqual(['clear', 'effort', 'model']);
		expect(availableSlashCommands('claude-code', ['usage', 'model', 'Compact'])).toEqual(['clear', 'Compact', 'effort', 'model', 'usage']);
	});
});
