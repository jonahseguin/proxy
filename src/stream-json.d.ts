import type { none } from 'stream-chain/core';
import type { ParserOptions, TokenSource } from 'stream-json/core/parser.js';

declare module 'stream-json/core/parser.js' {
	export function jsonParser(
		options?: ParserOptions,
	): (input: string | typeof none) => ReturnType<TokenSource>;
}
