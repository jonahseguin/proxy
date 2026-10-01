import { expect, it } from '@effect/vitest';
import { Effect } from 'effect';

import { syncWorkerKey, type WorkerSecret, type WorkerTarget } from './cloudflare.ts';
import { type CliDependencies, runCli } from './commands.ts';

const unexpected = () => {
	throw new Error('Admin sync must not use the terminal');
};

/** Guided-flow dependencies that admin sync must never use. */
const inert: Pick<CliDependencies, 'terminal' | 'host'> = {
	terminal: {
		intro: unexpected,
		outro: unexpected,
		step: unexpected,
		info: unexpected,
		note: unexpected,
		select: unexpected,
		password: unexpected,
		confirm: unexpected,
		spinner: unexpected,
		clipboard: unexpected,
	},
	host: { platform: 'darwin', arch: 'arm64' },
};

const origin = 'https://proxy.example.test';

const accountId = '0123456789abcdef0123456789abcdef';

const digest = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';

const secret: WorkerSecret = { digest, name: 'ADMIN_TOKEN_SHA256' };

const input: WorkerTarget & WorkerSecret = { worker: 'proxy', accountId, ...secret };

it.live('writes only the digest through cf to the configured Worker', () =>
	Effect.tryPromise(async () => {
		const calls: unknown[] = [];
		await syncWorkerKey(input, {
			run: async (args, account) => {
				calls.push({ args, account });
			},
		});
		expect(calls).toEqual([
			{
				args: [
					'workers',
					'secrets',
					'update',
					'ADMIN_TOKEN_SHA256',
					'--worker',
					'proxy',
					'--type',
					'secret_text',
					'--text',
					digest,
				],
				account: accountId,
			},
		]);
	}),
);

it.live('rejects malformed targets without invoking cf and reports failed writes', () =>
	Effect.tryPromise(async () => {
		let writes = 0;
		const dependencies = {
			run: async () => {
				writes++;
				throw new Error('private cf error');
			},
		};
		for (const target of [
			{ worker: 'Proxy/../other' },
			{ worker: '' },
			{ accountId: 'bad' },
			{ digest: 'short' },
		]) {
			await expect(syncWorkerKey({ ...input, ...target }, dependencies)).rejects.toThrow(
				'Worker name',
			);
		}
		expect(writes).toBe(0);
		await expect(syncWorkerKey(input, dependencies)).rejects.toThrow('rejected');
		expect(writes).toBe(1);
	}),
);

it.effect('syncs the administrator digest and verifies acceptance without rotating the key', () =>
	Effect.gen(function* () {
		const published: WorkerSecret[] = [];
		const verified: Request[] = [];

		const result = yield* runCli(['admin', 'sync', origin], {
			secrets: {
				get: async ({ service, name }) => {
					expect(name).toBe(origin);
					expect(service).toBe('jonah.proxy.admin');

					return 'hello';
				},
				set: async () => {
					throw new Error('Must not rotate during sync');
				},
			},
			...inert,
			loginEnvironment: {},
			syncDigest: async (key) => {
				published.push(key);
			},
			fetch: async (url, init) => {
				verified.push(new Request(url, init));

				return Response.json({ users: [] });
			},
		});

		expect(published).toEqual([secret]);
		expect(
			verified.map((request) => [
				request.url,
				request.headers.get('authorization'),
				request.redirect,
			]),
		).toEqual([[`${origin}/admin/users`, 'Bearer hello', 'error']]);
		expect(result).toContain(`key synced and accepted by ${origin}`);
		expect(result).not.toContain('hello');
	}),
);

it.effect(
	'reports unconfirmed sync or failed verification without replacing the recoverable key',
	() =>
		Effect.gen(function* () {
			for (const failure of ['write', 'unauthorized', 'invalid-response']) {
				let checks = 0;

				const result = yield* runCli(['admin', 'sync', origin], {
					secrets: {
						get: async () => 'hello',
						set: async () => {
							throw new Error('Must preserve key');
						},
					},
					...inert,
					loginEnvironment: {},
					syncDigest: async () => {
						if (failure === 'write') throw new Error('Private provider details');
					},
					fetch: async () => {
						checks++;

						return failure === 'unauthorized'
							? new Response(null, { status: 401 })
							: Response.json({ wrong: true });
					},
				}).pipe(Effect.flip);

				expect(result.message).toContain(
					failure === 'write' ? 'remote state is unconfirmed' : 'Digest updated',
				);
				expect(result.message).not.toContain('Private provider details');
				expect(checks).toBe(failure === 'write' ? 0 : 1);
			}
		}),
);
