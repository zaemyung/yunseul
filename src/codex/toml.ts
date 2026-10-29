// TOML encoding for `codex -c key=value` overrides. Codex parses the value
// half of `-c` as TOML, so the developer instructions (system prompt +
// injection guard + vault excerpts) travel as one TOML basic string.
//
// Basic strings permit `\" \\ \b \t \n \f \r \uXXXX`; every other control
// character must be escaped and the payload must consist of Unicode
// scalar values — a lone surrogate (possible in JS strings) is replaced
// with U+FFFD rather than producing invalid TOML.

export function tomlBasicString(s: string): string {
	let out = '"';
	for (const ch of s) {
		const cp = ch.codePointAt(0) ?? 0;
		switch (ch) {
			case '"': out += '\\"'; continue;
			case '\\': out += '\\\\'; continue;
			case '\n': out += '\\n'; continue;
			case '\r': out += '\\r'; continue;
			case '\t': out += '\\t'; continue;
			case '\b': out += '\\b'; continue;
			case '\f': out += '\\f'; continue;
			default:
				break;
		}
		if (cp >= 0xd800 && cp <= 0xdfff) {
			out += '\\uFFFD';
		} else if (cp < 0x20 || cp === 0x7f) {
			out += `\\u${cp.toString(16).toUpperCase().padStart(4, '0')}`;
		} else {
			out += ch;
		}
	}
	return `${out}"`;
}
