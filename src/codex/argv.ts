// Argv assembly for `codex exec` / `codex exec resume`. Pure.
//
// Verified against codex-cli 0.165.0:
//   - `codex exec [OPTIONS] -`            reads the prompt from stdin
//   - `codex exec resume [OPTIONS] <id> -` continues a thread, prompt on stdin
//   - `-c key=value` config overrides are accepted by BOTH forms, whereas
//     the dedicated `-s/--sandbox` and `-C/--cd` flags exist only on the
//     fresh form. We therefore express sandbox + approval policy as `-c`
//     overrides and rely on the spawn cwd (the vault root) for both.
//   - `-c developer_instructions="…"` reaches the model (replies obey it),
//     which is how the system prompt is delivered — Codex has no
//     append-system-prompt flag.
//   - `--json` prints JSONL events; `--skip-git-repo-check` lets Codex run
//     in a vault that is not a git repository.

import { tomlBasicString } from './toml';

export interface CodexArgvInputs {
	/** System prompt (+ guard + excerpts). TOML-encoded here. */
	developerInstructions: string;
	/** Validated thread id for `exec resume`, or null for a fresh thread. */
	priorThreadId: string | null;
	/** Validated model id (`-m`), or null for the config default. */
	model: string | null;
	/** Validated effort level (`model_reasoning_effort`), or null for the config default. */
	effort: string | null;
	enableWrites: boolean;
}

export function assembleCodexArgs(inputs: CodexArgvInputs): string[] {
	const args: string[] = ['exec'];
	if (inputs.priorThreadId !== null) args.push('resume');
	args.push('--json', '--skip-git-repo-check');
	// Read-only sandbox unless the user opted into writes; never prompt
	// for approval — there is nobody to answer from a non-interactive
	// stdin, and `never` makes the sandbox the only guard.
	args.push('-c', `sandbox_mode=${inputs.enableWrites ? '"workspace-write"' : '"read-only"'}`);
	args.push('-c', 'approval_policy="never"');
	args.push('-c', `developer_instructions=${tomlBasicString(inputs.developerInstructions)}`);
	if (inputs.model !== null) args.push('-m', inputs.model);
	// Effort is pattern-validated to [a-z]+ upstream, so bare quotes are safe.
	if (inputs.effort !== null) args.push('-c', `model_reasoning_effort="${inputs.effort}"`);
	if (inputs.priorThreadId !== null) args.push(inputs.priorThreadId);
	args.push('-');
	return args;
}

/**
 * Debug-log view of the argv: the developer_instructions override carries
 * the whole system prompt (and vault excerpts), so only its length is
 * logged.
 */
export function describeCodexArgs(args: readonly string[]): string[] {
	return args.map((a) =>
		a.startsWith('developer_instructions=')
			? `developer_instructions=<${a.length - 'developer_instructions='.length} chars>`
			: a,
	);
}
