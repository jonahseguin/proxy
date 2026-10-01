import { expect, it } from '@effect/vitest';
import { Effect } from 'effect';

import { adminDigest } from '../src/admin.ts';
import { handleRequest, inferenceBodyLimit, layer } from '../src/gateway.ts';
import { Users } from '../src/users.ts';

const policy = {
	adminDigest: adminDigest('admin-only'),
	models: { claude: ['claude-haiku-4-5-20251001', 'claude-sonnet-4-6'], codex: ['gpt-5.4'] },
};

const request = (
	path: string,
	init: {
		method?: string;
		key?: string;
		apiKey?: string;
		body?: string | null;
		headers?: HeadersInit;
		signal?: AbortSignal;
	},
) => {
	const headers = new Headers(init.headers);

	if (init.key !== undefined) headers.set('authorization', `Bearer ${init.key}`);

	if (init.apiKey !== undefined) headers.set('x-api-key', init.apiKey);

	const initRequest: RequestInit = { headers };

	if (init.method !== undefined) initRequest.method = init.method;

	if (init.body !== undefined && init.body !== null) initRequest.body = init.body;

	if (init.signal !== undefined) initRequest.signal = init.signal;

	return new Request(`http://proxy.test${path}`, initRequest);
};

const proxy = (
	users: ReturnType<typeof Users.testLayer>,
	forward: (value: Request) => Promise<Response> = async () => new Response('unexpected'),
) => layer(policy, users, forward);

it.effect('rejects wrong keys, models, methods, and routes without reaching the runtime', () => {
	let forwarded = 0;

	return Effect.gen(function* () {
		const users = yield* Users.Service;

		for (const test of [
			{ path: '/claude/v1/messages', method: 'POST', key: '', body: '{}', status: 401 },
			{ path: '/claude/v1/messages', method: 'POST', key: 'admin-only', body: '{}', status: 401 },
			{ path: '/claude/v1/messages', method: 'POST', key: 'old-editor', body: '{}', status: 401 },
			{ path: '/claude/accounts', method: 'GET', key: 'old-editor', body: null, status: 401 },
			{ path: '/claude/accounts', method: 'GET', key: 'admin-only', body: null, status: 401 },
			{ path: '/claude/accounts', method: 'POST', key: 'alice-key', body: '{}', status: 405 },
			{ path: '/admin/users', method: 'GET', key: 'alice-key', body: null, status: 401 },
			{ path: '/admin/users/alice', method: 'PUT', key: 'alice-key', body: '{}', status: 401 },
			{ path: '/admin/users/alice', method: 'DELETE', key: 'alice-key', body: null, status: 401 },
			{ path: '/admin/users', method: 'PUT', key: 'admin-only', body: '{}', status: 405 },
			{ path: '/admin/users/alice', method: 'GET', key: 'admin-only', body: null, status: 405 },
			{ path: '/admin/users/Alice', method: 'PUT', key: 'admin-only', body: '{}', status: 404 },
			{ path: '/admin/users/a/b', method: 'PUT', key: 'admin-only', body: '{}', status: 404 },
			{ path: '/admin/users/alice', method: 'PUT', key: 'admin-only', body: '{}', status: 400 },
			{
				path: '/admin/users/alice',
				method: 'PUT',
				key: 'admin-only',
				body: '{"digest":"abc"}',
				status: 400,
			},
			{
				path: '/admin/users/alice',
				method: 'PUT',
				key: 'admin-only',
				body: JSON.stringify({ digest: policy.adminDigest }),
				status: 400,
			},
			{ path: '/admin/users/carol', method: 'DELETE', key: 'admin-only', body: null, status: 404 },
			{ path: '/claude/v1/messages', method: 'PUT', key: 'alice-key', body: '{}', status: 405 },
			{ path: '/claude/v1/models', method: 'POST', key: 'alice-key', body: '{}', status: 405 },
			{ path: '/claude/v1/messages', method: 'POST', key: 'alice-key', body: '{', status: 400 },
			{ path: '/claude/v1/messages', method: 'POST', key: 'alice-key', body: '{}', status: 400 },
			{ path: '/claude/v1/messages', method: 'POST', key: 'alice-key', body: '[1]', status: 400 },
			{
				path: '/claude/v1/messages',
				method: 'POST',
				key: 'alice-key',
				body: '{"model":42}',
				status: 400,
			},
			{
				path: '/claude/v1/messages',
				method: 'POST',
				key: 'alice-key',
				body: '{"model":"claude-latest"}',
				status: 403,
			},
			{
				path: '/claude/v1/messages',
				method: 'POST',
				key: 'alice-key',
				body: '{"model":"bob/claude-sonnet-4-6"}',
				status: 403,
			},
			{
				path: '/claude/v1/messages/count_tokens',
				method: 'POST',
				key: 'alice-key',
				body: '{"model":"gpt-5"}',
				status: 403,
			},
			{ path: '/codex/v1/messages', method: 'POST', key: 'alice-key', body: '{}', status: 404 },
			{
				path: '/admin/providers/claude',
				method: 'GET',
				key: 'admin-only',
				body: null,
				status: 404,
			},
			{
				path: '/v0/management/auth-files',
				method: 'POST',
				key: 'alice-key',
				body: '{}',
				status: 404,
			},
			{
				path: '/claude/v0/management/auth-files',
				method: 'POST',
				key: 'alice-key',
				body: '{}',
				status: 404,
			},
			{
				path: '/claude/v1/messages?auth_token=alice-key',
				method: 'POST',
				key: 'alice-key',
				body: '{}',
				status: 404,
			},
			{
				path: '/claude/v1/messages?beta=true&auth_token=alice-key',
				method: 'POST',
				key: 'alice-key',
				body: '{}',
				status: 404,
			},
			{
				path: '/claude/v1/messages?beta=false',
				method: 'POST',
				key: 'alice-key',
				body: '{}',
				status: 404,
			},
			{
				path: '/claude/v1/models?beta=true',
				method: 'GET',
				key: 'alice-key',
				body: null,
				status: 404,
			},
			{
				path: '/claude/accounts?beta=true',
				method: 'GET',
				key: 'alice-key',
				body: null,
				status: 404,
			},
		]) {
			const result = yield* handleRequest(
				request(test.path, { method: test.method, key: test.key, body: test.body }),
			);

			expect(result.status, `${test.method} ${test.path}`).toBe(test.status);
		}

		expect(forwarded).toBe(0);
		expect(yield* users.list()).toEqual(['alice', 'bob']);
	}).pipe(
		Effect.provide(
			proxy(Users.testLayer({ alice: 'alice-key', bob: 'bob-key' }), async () => {
				forwarded++;

				return new Response('unexpected');
			}),
		),
	);
});

it.effect('lists only allowed models and fails closed on ambiguous or shared credentials', () => {
	let forwarded = 0;

	return Effect.gen(function* () {
		const unused = async () => {
			forwarded++;

			return new Response();
		};

		const list = yield* handleRequest(request('/claude/v1/models', { apiKey: 'alice-key' })).pipe(
			Effect.provide(proxy(Users.testLayer({ alice: 'alice-key', bob: 'bob-key' }), unused)),
		);

		expect(list.status).toBe(200);
		expect(list.headers.get('cache-control')).toBe('no-store');
		expect(yield* Effect.promise(() => list.json())).toEqual({
			data: [
				{
					id: 'claude-haiku-4-5-20251001',
					type: 'model',
					display_name: 'claude-haiku-4-5-20251001',
					created_at: '1970-01-01T00:00:00Z',
				},
				{
					id: 'claude-sonnet-4-6',
					type: 'model',
					display_name: 'claude-sonnet-4-6',
					created_at: '1970-01-01T00:00:00Z',
				},
			],
			first_id: 'claude-haiku-4-5-20251001',
			last_id: 'claude-sonnet-4-6',
			has_more: false,
		});

		const ambiguous = yield* handleRequest(
			request('/claude/v1/models', { apiKey: 'alice-key', key: 'bob-key' }),
		).pipe(Effect.provide(proxy(Users.testLayer({ alice: 'alice-key', bob: 'bob-key' }), unused)));

		expect(ambiguous.status).toBe(401);

		const shared = yield* handleRequest(
			request('/claude/v1/models', { apiKey: 'admin-only' }),
		).pipe(Effect.provide(proxy(Users.testLayer({ root: 'admin-only' }), unused)));

		expect(shared.status).toBe(401);

		yield* Effect.gen(function* () {
			const registry = yield* Users.TestService;
			yield* registry.failNextFind();

			const unavailable = yield* handleRequest(
				request('/claude/v1/models', { apiKey: 'alice-key' }),
			);

			expect(unavailable.status).toBe(401);
		}).pipe(Effect.provide(proxy(Users.testLayer({ alice: 'alice-key' }), unused)));

		expect(forwarded).toBe(0);
	});
});

it.effect('registers, rotates, and removes users through the administrator route', () =>
	Effect.gen(function* () {
		const forwarded: Request[] = [];
		let runtimeBusy = false;

		yield* Effect.gen(function* () {
			const users = yield* Users.Service;
			const carolKey = 'c'.repeat(64);

			const registered = yield* handleRequest(
				request('/admin/users/carol', {
					method: 'PUT',
					key: 'admin-only',
					body: JSON.stringify({ digest: adminDigest(carolKey) }),
				}),
			);

			expect(registered.status).toBe(200);
			expect(yield* Effect.promise(() => registered.json())).toEqual({ id: 'carol' });

			const listed = yield* handleRequest(request('/admin/users', { key: 'admin-only' }));

			expect(yield* Effect.promise(() => listed.json())).toEqual({ users: ['carol'] });

			const asCarol = yield* handleRequest(request('/claude/accounts', { apiKey: carolKey }));

			expect(asCarol.status).toBe(200);
			expect(asCarol.headers.get('cache-control')).toBe('no-store');
			expect(forwarded).toHaveLength(1);
			expect(forwarded[0]?.method).toBe('GET');
			expect(new URL(forwarded[0]?.url ?? '').pathname).toBe('/claude/accounts');
			expect(Object.fromEntries(forwarded[0]?.headers ?? [])).toEqual({
				'x-proxy-user': 'carol',
			});

			const rotatedKey = 'd'.repeat(64);
			yield* handleRequest(
				request('/admin/users/carol', {
					method: 'PUT',
					key: 'admin-only',
					body: JSON.stringify({ digest: adminDigest(rotatedKey) }),
				}),
			);

			const oldKey = yield* handleRequest(request('/claude/accounts', { apiKey: carolKey }));

			expect(oldKey.status).toBe(401);

			// The container is busy: the credential stays, so the user must stay registered and
			// the same DELETE must be able to finish the job later.
			runtimeBusy = true;

			const blocked = yield* handleRequest(
				request('/admin/users/carol', { method: 'DELETE', key: 'admin-only' }),
			);

			expect(blocked.status).toBe(409);
			expect(forwarded).toHaveLength(2);
			expect(forwarded[1]?.method).toBe('DELETE');
			expect(yield* users.list()).toEqual(['carol']);

			runtimeBusy = false;

			const removed = yield* handleRequest(
				request('/admin/users/carol', { method: 'DELETE', key: 'admin-only' }),
			);

			expect(removed.status).toBe(200);
			expect(yield* Effect.promise(() => removed.json())).toEqual({
				state: 'disconnected',
				accounts: [],
			});
			expect(forwarded).toHaveLength(3);
			expect(forwarded[2]?.method).toBe('DELETE');
			expect(forwarded[2]?.headers.get('x-proxy-user')).toBe('carol');
			expect(new URL(forwarded[2]?.url ?? '').pathname).toBe('/accounts');
			expect(yield* users.list()).toEqual([]);

			const revoked = yield* handleRequest(request('/claude/accounts', { apiKey: rotatedKey }));

			expect(revoked.status).toBe(401);

			const gone = yield* handleRequest(
				request('/admin/users/carol', { method: 'DELETE', key: 'admin-only' }),
			);

			expect(gone.status).toBe(404);
			expect(forwarded).toHaveLength(3);
		}).pipe(
			Effect.provide(
				proxy(Users.testLayer(), async (incoming) => {
					forwarded.push(incoming);

					return runtimeBusy
						? Response.json({ error: 'account_busy' }, { status: 409 })
						: Response.json({ state: 'disconnected', accounts: [] });
				}),
			),
		);
	}),
);

it.effect(
	'prefixes the model with the caller, preserves message and tool JSON, filters headers, and never retries',
	() =>
		Effect.gen(function* () {
			const payload =
				'{ "model":"claude-sonnet-4-6", "messages":[{"role":"user","content":[{"type":"tool_result","tool_use_id":"tool-7","content":"42"}]}], "tools":[{"name":"lookup","input_schema":{"type":"object"}}], "stream":true, "metadata":{"user_id":"u-1"} }';

			let forwarded = 0;
			const abort = new AbortController();

			const response = yield* handleRequest(
				request('/claude/v1/messages/count_tokens', {
					method: 'POST',
					apiKey: 'bob-key',
					body: payload,
					signal: abort.signal,
					headers: {
						cookie: 'private-cookie',
						'x-goog-api-key': 'wrong-key',
						'x-proxy-user': 'alice',
						'anthropic-version': '2023-06-01',
						'anthropic-beta': 'test-beta',
					},
				}),
			).pipe(
				Effect.provide(
					proxy(Users.testLayer({ alice: 'alice-key', bob: 'bob-key' }), async (incoming) => {
						forwarded++;
						expect(new URL(incoming.url).pathname).toBe('/claude/v1/messages/count_tokens');
						expect(await incoming.json()).toEqual({
							model: 'bob/claude-sonnet-4-6',
							messages: [
								{
									role: 'user',
									content: [{ type: 'tool_result', tool_use_id: 'tool-7', content: '42' }],
								},
							],
							tools: [{ name: 'lookup', input_schema: { type: 'object' } }],
							stream: true,
							metadata: { user_id: 'u-1' },
						});
						expect(Object.fromEntries(incoming.headers)).toEqual({
							'anthropic-beta': 'test-beta',
							'anthropic-version': '2023-06-01',
							'content-type': 'application/json',
							'x-proxy-user': 'bob',
						});
						abort.abort();
						expect(incoming.signal.aborted).toBe(true);

						return new Response(
							'{"type":"error","error":{"type":"rate_limit_error","message":"Try later"}}',
							{
								status: 429,
								headers: { 'retry-after': '17', 'content-type': 'application/json' },
							},
						);
					}),
				),
			);

			expect(response.status).toBe(429);
			expect(response.headers.get('retry-after')).toBe('17');
			expect(yield* Effect.promise(() => response.text())).toBe(
				'{"type":"error","error":{"type":"rate_limit_error","message":"Try later"}}',
			);
			expect(forwarded).toBe(1);
		}),
);

it.effect('accepts the SDK beta marker on inference routes and drops it before forwarding', () =>
	Effect.gen(function* () {
		const urls: string[] = [];

		const forward = async (incoming: Request) => {
			urls.push(incoming.url);

			return Response.json({ input_tokens: 1 });
		};

		const users = Users.testLayer({ alice: 'alice-key' });

		for (const path of ['/claude/v1/messages', '/claude/v1/messages/count_tokens']) {
			const response = yield* handleRequest(
				request(`${path}?beta=true`, {
					method: 'POST',
					key: 'alice-key',
					body: '{"model":"claude-sonnet-4-6"}',
					headers: { 'anthropic-beta': 'interleaved-thinking-2025-05-14' },
				}),
			).pipe(Effect.provide(proxy(users, forward)));

			expect(response.status, path).toBe(200);
		}

		expect(urls).toEqual([
			'http://proxy.test/claude/v1/messages',
			'http://proxy.test/claude/v1/messages/count_tokens',
		]);
	}),
);

it.effect('streams the first chunk before completion and propagates response cancellation', () =>
	Effect.gen(function* () {
		let cancelled = false;

		const upstream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode('event: message_start\n\n'));
			},
			cancel() {
				cancelled = true;
			},
		});

		const response = yield* handleRequest(
			request('/claude/v1/messages', {
				method: 'POST',
				key: 'alice-key',
				body: '{"model":"claude-sonnet-4-6","stream":true}',
			}),
		).pipe(
			Effect.provide(
				proxy(
					Users.testLayer({ alice: 'alice-key', bob: 'bob-key' }),
					async () => new Response(upstream, { headers: { 'content-type': 'text/event-stream' } }),
				),
			),
		);

		expect(response.headers.get('content-type')).toBe('text/event-stream');
		const reader = response.body?.getReader();
		expect(reader).toBeDefined();
		const chunk = yield* Effect.promise(() => reader?.read() ?? Promise.resolve(undefined));
		expect(new TextDecoder().decode(chunk?.value)).toBe('event: message_start\n\n');
		yield* Effect.promise(() => reader?.cancel() ?? Promise.resolve());
		expect(cancelled).toBe(true);
	}),
);

it.effect('accepts exactly the body limit and rejects one byte over it before forwarding', () =>
	Effect.gen(function* () {
		let forwarded = 0;
		const json = '{"model":"claude-sonnet-4-6"}';
		const atLimit = json + ' '.repeat(inferenceBodyLimit - json.length);

		yield* Effect.gen(function* () {
			const accepted = yield* handleRequest(
				request('/claude/v1/messages', { method: 'POST', apiKey: 'alice-key', body: atLimit }),
			);

			expect(accepted.status).toBe(200);
			expect(yield* Effect.promise(() => accepted.text())).toBe('accepted');

			const rejected = yield* handleRequest(
				request('/claude/v1/messages', {
					method: 'POST',
					apiKey: 'alice-key',
					body: atLimit + ' ',
					headers: { 'content-length': '1' },
				}),
			);

			expect(rejected.status).toBe(413);
		}).pipe(
			Effect.provide(
				proxy(Users.testLayer({ alice: 'alice-key', bob: 'bob-key' }), async () => {
					forwarded++;

					return new Response('accepted');
				}),
			),
		);

		expect(forwarded).toBe(1);
	}),
);

it.effect('routes Codex responses with the same user prefix and a separate model allowlist', () =>
	Effect.gen(function* () {
		const seen: Request[] = [];
		const provided = proxy(Users.testLayer({ alice: 'alice-key' }), async (incoming) => {
			seen.push(incoming);
			return new Response('data: {"type":"response.completed"}\n\n', {
				headers: { 'content-type': 'text/event-stream' },
			});
		});
		const valid = yield* handleRequest(
			request('/codex/v1/responses', {
				method: 'POST',
				key: 'alice-key',
				body: JSON.stringify({ model: 'gpt-5.4', input: 'synthetic', stream: true }),
			}),
		).pipe(Effect.provide(provided));
		expect(valid.status).toBe(200);
		expect(yield* Effect.promise(() => seen[0]!.json())).toMatchObject({
			model: 'alice/gpt-5.4',
			input: 'synthetic',
		});
		const cross = yield* handleRequest(
			request('/codex/v1/responses', {
				method: 'POST',
				key: 'alice-key',
				body: JSON.stringify({ model: 'claude-sonnet-4-6' }),
			}),
		).pipe(Effect.provide(provided));
		expect(cross.status).toBe(403);
		expect(seen).toHaveLength(1);
	}),
);

it.effect('requires editor authorization for status and filters account deletion identifiers', () =>
	Effect.gen(function* () {
		let forwarded = 0;
		const provided = proxy(Users.testLayer({ alice: 'alice-key' }), async () => {
			forwarded++;
			return Response.json({});
		});
		const denied = yield* handleRequest(request('/status', {})).pipe(Effect.provide(provided));
		expect(denied.status).toBe(401);
		for (const path of [
			'/claude/accounts',
			'/claude/accounts/bob',
			'/claude/accounts/claude-abc/extra',
		]) {
			const result = yield* handleRequest(
				request(path, { method: 'DELETE', key: 'alice-key' }),
			).pipe(Effect.provide(provided));
			expect(result.status).toBe(path === '/claude/accounts' ? 405 : 404);
		}
		expect(forwarded).toBe(0);
	}),
);

it.effect('keeps a user registered when runtime returns an unverified deletion result', () =>
	Effect.gen(function* () {
		const users = Users.testLayer({ alice: 'alice-key' });
		yield* Effect.gen(function* () {
			const result = yield* handleRequest(
				request('/admin/users/alice', { method: 'DELETE', key: 'admin-only' }),
			);
			expect(result.status).toBe(503);
			expect(yield* (yield* Users.Service).has(Users.UserId.make('alice'))).toBe(true);
		}).pipe(Effect.provide(proxy(users, async () => Response.json({ state: 'disconnected' }))));
	}),
);

it.effect(
	'preserves native conversation headers for CPA account affinity while removing keys',
	() =>
		Effect.gen(function* () {
			const sessionHeaders = {
				'x-claude-code-session-id': 'claude-session',
				'session-id': 'codex-session',
				session_id: 'codex-session-2',
				'thread-id': 'thread-1',
				'x-codex-turn-metadata': '{"turn_id":"turn-1"}',
			};
			let seen: Headers | undefined;
			const result = yield* handleRequest(
				request('/codex/v1/responses', {
					method: 'POST',
					key: 'alice-key',
					headers: sessionHeaders,
					body: '{"model":"gpt-5.4"}',
				}),
			).pipe(
				Effect.provide(
					proxy(Users.testLayer({ alice: 'alice-key' }), async (value) => {
						seen = value.headers;
						return Response.json({});
					}),
				),
			);
			expect(result.status).toBe(200);
			for (const [name, value] of Object.entries(sessionHeaders))
				expect(seen?.get(name)).toBe(value);
			expect(seen?.get('authorization')).toBeNull();
		}),
);
