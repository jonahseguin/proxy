import { afterEach, expect, it, vi } from 'vitest';

import { runtimeFailure } from '../src/logging.ts';

afterEach(() => vi.restoreAllMocks());

it('records a fixed runtime stage and recognized platform failure', () => {
	const output = vi.spyOn(console, 'error').mockImplementation(() => {});
	const error = new Error('Durable Object reset because its code was updated.');
	error.stack = 'Error: reset\n at ProxyContainer.startRuntime (index.js:123:45)';
	runtimeFailure('startup-timestamp', error);
	expect(JSON.parse(output.mock.calls[0]![0])).toEqual({
		type: 'proxy-runtime-error',
		stage: 'startup-timestamp',
		name: 'Error',
		message: error.message,
		location: 'index.js:123:45',
	});
});

it('omits arbitrary error content, identity, tokens, filenames and request details', () => {
	const output = vi.spyOn(console, 'error').mockImplementation(() => {});
	const privateText =
		'Bearer synthetic-secret user@example.test auths/private.json https://private.test/path?token=synthetic-secret prompt-content';
	const error = new Error(privateText);
	error.name = privateText;
	error.stack = `${privateText}\n at ${privateText} (index.js:123:45)`;
	runtimeFailure(privateText, error);
	const result = output.mock.calls[0]![0] as string;
	expect(result).not.toContain('synthetic-secret');
	expect(result).not.toContain('private');
	expect(result).not.toContain('prompt-content');
	expect(JSON.parse(result)).toEqual({
		type: 'proxy-runtime-error',
		stage: 'unknown',
		name: 'Error',
		message: 'Unclassified runtime error',
		location: 'index.js:123:45',
	});
});
