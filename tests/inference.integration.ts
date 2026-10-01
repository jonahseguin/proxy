import { execFile } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { expect, it } from '@effect/vitest';
import { Effect, Schema } from 'effect';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';

import { accountId, ProxyStatus } from '../src/account.ts';
import { adminDigest, usersPath } from '../src/admin.ts';
import { accountPath } from '../src/gateway.ts';

const run = promisify(execFile);

const payload =
	'{"model":"claude-haiku-4-5-20251001","messages":[{"role":"user","content":[{"type":"tool_result","tool_use_id":"tool-9","content":"test result"}]}],"stream":true}';

const forwardedPayload =
	'{"model":"alice/claude-haiku-4-5-20251001","messages":[{"role":"user","content":[{"type":"tool_result","tool_use_id":"tool-9","content":"test result"}]}],"stream":true}';

const firstChunk =
	'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tool-10","name":"lookup","input":{}}}\n\n';

const ping = 'event: ping\ndata: {"type":"ping"}\n\n';

it.live(
	'forwards through the real Worker and TCP container without replay, and closes on cancellation or disconnect',
	() =>
		Effect.tryPromise(async () => {
			await run('docker', ['build', '-t', 'proxy-inference-fixture:test', 'tests/fixtures']);

			const { stdout } = await run('docker', [
				'context',
				'inspect',
				'--format',
				'{{.Endpoints.docker.Host}}',
			]);

			const image =
				'cloudflare/proxy-everything:3cb1195@sha256:0ef6716c52430096900b150d84a3302057d6cd2319dae7987128c85d0733e3c8';

			try {
				await run('docker', ['image', 'inspect', image]);
			} catch {
				await run('docker', ['pull', image]);
			}

			const directory = await mkdtemp(join(tmpdir(), 'proxy-inference-'));
			const events = new EventEmitter();

			const seen: {
				path: string;
				body: string;
				authorization: string | undefined;
				editorKey: string | string[] | undefined;
				mode: string;
			}[] = [];

			const streams = new Map<string, ServerResponse>();
			const readiness: ServerResponse[] = [];
			const pacers = new Set<NodeJS.Timeout>();
			let holdStartup = false;
			let holdModels = false;
			let freshModel = false;
			const quotaCalls: unknown[] = [];

			// Local workerd on Linux only notices a client that hung up when it next writes to that
			// socket (an orderly FIN never fulfils KJ's epoll write-disconnect promise), so a held stream
			// keeps sending pings, as a live generation would. The close still has to travel from the
			// Worker through the Durable Object and the container back to this server.
			const keepStreaming = (mode: string) => {
				const pacer = setInterval(() => {
					const held = streams.get(mode);

					if (held && !held.destroyed) held.write(ping);
				}, 100);

				pacers.add(pacer);
				events.once(`closed:${mode}`, () => clearInterval(pacer));
			};

			const server = createServer((request, response) => {
				void (async () => {
					if (request.url?.startsWith('/v0/management/auth-files/models?')) {
						expect(request.headers.authorization).toBe('Bearer synthetic-management-key');
						expect(new URL(request.url, 'http://fixture').searchParams.get('name')).toBe(
							`alice__claude__${accountId(credential)}.json`,
						);
						response.setHeader('content-type', 'application/json');
						response.end(
							JSON.stringify({
								models: holdModels
									? []
									: [
											{ id: 'alice/claude-haiku-4-5-20251001' },
											...(freshModel ? [{ id: 'alice/claude-fable-5-1' }] : []),
										],
							}),
						);
						events.emit('registry');
						return;
					}
					if (request.url === '/v0/management/auth-files') {
						expect(request.headers.authorization).toBe('Bearer synthetic-management-key');
						response.setHeader('content-type', 'application/json');
						response.end(
							JSON.stringify({
								files: [
									{
										name: `alice__claude__${accountId(credential)}.json`,
										provider: 'claude',
										auth_index: 'owned-index',
										status: 'active',
										success: 7,
										failed: 2,
										access_token: 'hidden-private-token',
										recent_requests: [{ body: 'hidden-private-body' }],
									},
									{
										name: 'bob__claude__foreign.json',
										provider: 'claude',
										auth_index: 'foreign-index',
										status: 'active',
										success: 999,
										failed: 999,
									},
								],
							}),
						);
						return;
					}
					if (request.method === 'GET') {
						if (holdStartup) {
							readiness.push(response);
							events.emit('startup');
						} else response.end('ready');

						return;
					}

					const chunks: Buffer[] = [];

					for await (const chunk of request) chunks.push(chunk);
					const body = Buffer.concat(chunks).toString();
					if (request.url === '/v0/management/api-call') {
						expect(request.headers.authorization).toBe('Bearer synthetic-management-key');
						const call = Schema.decodeUnknownSync(
							Schema.Struct({
								auth_index: Schema.String,
								url: Schema.String,
								header: Schema.Record(Schema.String, Schema.String),
							}),
						)(JSON.parse(body));
						expect(call.auth_index).toBe('owned-index');
						expect(call.url).toBe('https://api.anthropic.com/api/oauth/usage');
						expect(call.header['Authorization']).toBe('Bearer $TOKEN$');
						quotaCalls.push(call);
						response.setHeader('content-type', 'application/json');
						response.end(
							JSON.stringify({
								status_code: 200,
								body: JSON.stringify({
									five_hour: { utilization: 0, resets_at: '2099-01-01T01:00:00Z' },
									seven_day: { utilization: 42, resets_at: null },
									private_token: 'hidden-private-token',
								}),
							}),
						);
						return;
					}
					const mode = Schema.decodeUnknownSync(Schema.String)(request.headers['anthropic-beta']);
					seen.push({
						path: request.url ?? '',
						body,
						authorization: request.headers.authorization,
						editorKey: request.headers['x-api-key'],
						mode,
					});

					if (mode === 'tokens') {
						response.setHeader('content-type', 'application/json');
						response.end('{"input_tokens":23}');
					} else if (mode === 'error') {
						response.writeHead(429, { 'content-type': 'application/json', 'retry-after': '19' });
						response.end('{"type":"error","error":{"type":"rate_limit_error","message":"quota"}}');
					} else {
						streams.set(mode, response);
						response.on('close', () => events.emit(`closed:${mode}`));
						response.writeHead(200, { 'content-type': 'text/event-stream' });
						response.write(firstChunk);
					}
				})().catch(() => {
					response.writeHead(500).end();
				});
			});

			await new Promise<void>((done) => {
				server.listen(0, '0.0.0.0', done);
			});
			const address = server.address();

			// Node's socket boundary can return a pipe name; this fixture requires a TCP port.
			// eslint-disable-next-line anti-slop/no-runtime-typeof
			if (!address || typeof address === 'string') throw new Error('No fixture port');

			const options = convertV4MiniflareOptions({
				modules: true,
				scriptPath: resolve('.cloudflare/output/v0/workers/default/bundle/index.js'),
				host: '127.0.0.1',
				compatibilityDate: '2026-08-22',
				compatibilityFlags: ['nodejs_compat', 'enable_request_signal'],
				resourcePersistencePath: directory,
				containerEngine: {
					localDocker: { socketPath: stdout.trim(), containerEgressInterceptorImage: image },
				},
				durableObjects: {
					PROXY: {
						className: 'ProxyContainer',
						useSQLite: true,
						container: { imageName: 'proxy-inference-fixture:test' },
					},
				},
				r2Buckets: ['CREDENTIALS'],
				kvNamespaces: ['USERS'],
				bindings: {
					ADMIN_TOKEN_SHA256: adminDigest('admin-only'),
					CLAUDE_MODELS: ['claude-haiku-4-5-20251001', 'claude-fable-5-1'],
					CPA_API_KEY: 'private-cpa-key',
					CPA_MANAGEMENT_KEY: 'synthetic-management-key',
					CODEX_MODELS: ['gpt-5.4'],
					OBJECTSTORE_ENDPOINT: `http://host.docker.internal:${address.port}`,
					OBJECTSTORE_BUCKET: 'probe',
					OBJECTSTORE_ACCESS_KEY: 'synthetic-access',
					OBJECTSTORE_SECRET_KEY: 'synthetic-secret',
				},
			});

			let mf = new Miniflare(options);
			const admin = { authorization: 'Bearer admin-only' };
			const editor = { authorization: 'Bearer editor-only' };
			const account = `http://proxy.test${accountPath('claude')}`;

			const credential = {
				type: 'claude' as const,
				account_uuid: 'account-1',
				organization_uuid: 'org-personal',
				access_token: 'synthetic-access',
				refresh_token: 'synthetic-refresh',
				email: 'account@example.test',
				expired: '2099-01-01T00:00:00Z',
			};

			const post = async (mode: string, path = '/claude/v1/messages', init: RequestInit = {}) =>
				fetch(new URL(path, await mf.ready), {
					method: 'POST',
					body: payload,
					headers: {
						'x-api-key': 'editor-only',
						'anthropic-version': '2023-06-01',
						'anthropic-beta': mode,
					},
					...init,
				});

			try {
				expect((await post('tokens')).status).toBe(401);

				const registered = await mf.dispatchFetch(`http://proxy.test${usersPath}/alice`, {
					method: 'PUT',
					headers: admin,
					body: JSON.stringify({ digest: adminDigest('editor-only') }),
				});

				expect(registered.status).toBe(200);
				expect((await post('tokens')).status).toBe(503);
				expect(seen).toEqual([]);

				const imported = await mf.dispatchFetch(account, {
					method: 'PUT',
					headers: editor,
					body: JSON.stringify(credential),
				});

				expect(imported.status).toBe(200);
				const statusUrl = 'http://proxy.test/status';
				const observed = Schema.decodeUnknownSync(ProxyStatus)(
					await (await mf.dispatchFetch(statusUrl, { headers: editor })).json(),
				);
				expect(observed.providers.claude.accounts[0]?.usage).toMatchObject({
					state: 'observed',
					success: 7,
					failed: 2,
					quotaState: 'observed',
					windows: [
						{ name: 'five_hour', usedPercent: 0 },
						{ name: 'seven_day', usedPercent: 42 },
					],
				});
				expect(observed.runtime.state).toBe('running');
				expect(observed.runtime.uptimeSeconds).toBeGreaterThanOrEqual(0);
				expect(Date.parse(observed.runtime.startedAt ?? '')).toBeGreaterThanOrEqual(
					Date.parse(observed.observedAt) - 2000,
				);
				expect(JSON.stringify(observed)).not.toMatch(
					/hidden-private|999|owned-index|foreign-index/,
				);
				expect((await mf.dispatchFetch(statusUrl, { headers: editor })).status).toBe(200);
				expect(quotaCalls).toHaveLength(1);
				await mf.dispose();

				const containers = await run('docker', [
					'ps',
					'-q',
					'--filter',
					'ancestor=proxy-inference-fixture:test',
				]);

				const containerIds = containers.stdout.trim().split(/\s+/);
				expect(containerIds).toHaveLength(1);
				await run('docker', ['stop', ...containerIds]);
				mf = new Miniflare(options);
				holdStartup = true;
				holdModels = true;
				const starting = once(events, 'startup', { signal: AbortSignal.timeout(20_000) });
				const pending = post('tokens', '/claude/v1/messages/count_tokens');
				await starting.catch((cause: unknown) => {
					throw new Error('Cold startup did not reach fixture', { cause });
				});

				const blocked = await mf.dispatchFetch(`${account}/${accountId(credential)}`, {
					method: 'DELETE',
					headers: editor,
				});

				expect(blocked.status).toBe(409);
				holdStartup = false;

				await new Promise((done) => setTimeout(done, 2100));
				const registry = once(events, 'registry', { signal: AbortSignal.timeout(20_000) });
				for (const response of readiness) response.end('ready');
				expect(
					await Promise.race([pending.then(() => 'inference'), registry.then(() => 'registry')]),
				).toBe('registry');
				expect(seen).toEqual([]);
				const readyBoundary = Date.now();
				holdModels = false;
				const counted = await pending;
				expect(counted.status).toBe(200);
				expect(await counted.json()).toEqual({ input_tokens: 23 });
				const readyStatus = Schema.decodeUnknownSync(ProxyStatus)(
					await (await mf.dispatchFetch('http://proxy.test/status', { headers: editor })).json(),
				);
				expect(Date.parse(readyStatus.runtime.startedAt ?? '')).toBeGreaterThanOrEqual(
					readyBoundary,
				);
				expect(seen).toEqual([
					{
						path: '/v1/messages/count_tokens',
						body: forwardedPayload,
						authorization: 'Bearer private-cpa-key',
						editorKey: undefined,
						mode: 'tokens',
					},
				]);
				const missingModelBody = payload.replace('claude-haiku-4-5-20251001', 'claude-fable-5-1');
				const attempts = seen.length;
				const missingSince = Date.now();
				const missingModel = await post('tokens', '/claude/v1/messages/count_tokens', {
					body: missingModelBody,
				});
				expect(missingModel.status).toBe(503);
				expect(await missingModel.json()).toEqual({ error: 'runtime_unavailable' });
				expect(Date.now() - missingSince).toBeLessThan(35_000);
				expect(seen).toHaveLength(attempts);
				freshModel = true;
				const refreshed = await post('tokens', '/claude/v1/messages/count_tokens', {
					body: missingModelBody,
				});
				expect(refreshed.status).toBe(200);
				expect(await refreshed.json()).toEqual({ input_tokens: 23 });
				expect(seen).toHaveLength(attempts + 1);
				const runningContainer = await run('docker', [
					'ps',
					'-q',
					'--filter',
					'ancestor=proxy-inference-fixture:test',
				]);
				await mf.dispose();
				mf = new Miniflare(options);
				holdModels = true;
				const restoredRegistry = once(events, 'registry', { signal: AbortSignal.timeout(20_000) });
				const restoredRequest = post('tokens', '/claude/v1/messages/count_tokens');
				expect(
					await Promise.race([
						restoredRequest.then(() => 'inference'),
						restoredRegistry.then(() => 'registry'),
					]),
				).toBe('registry');
				expect(seen).toHaveLength(attempts + 1);
				holdModels = false;
				const restoredResponse = await restoredRequest;
				expect(restoredResponse.status).toBe(200);
				expect(await restoredResponse.json()).toEqual({ input_tokens: 23 });
				const sameContainer = await run('docker', [
					'ps',
					'-q',
					'--filter',
					'ancestor=proxy-inference-fixture:test',
				]);
				expect(sameContainer.stdout.trim()).toBe(runningContainer.stdout.trim());

				const errored = await post('error');
				expect(errored.status).toBe(429);
				expect(errored.headers.get('retry-after')).toBe('19');
				expect(await errored.text()).toBe(
					'{"type":"error","error":{"type":"rate_limit_error","message":"quota"}}',
				);

				const cancelled = once(events, 'closed:cancel', { signal: AbortSignal.timeout(20_000) });
				const stream = await post('cancel');
				expect(stream.status).toBe(200);
				expect(stream.headers.get('content-type')).toBe('text/event-stream');
				const reader = stream.body?.getReader();
				expect(new TextDecoder().decode((await reader?.read())?.value)).toBe(firstChunk);
				await reader?.cancel();
				keepStreaming('cancel');
				await cancelled.catch((cause: unknown) => {
					throw new Error('Reader cancellation did not close upstream', { cause });
				});

				const aborted = once(events, 'closed:abort', { signal: AbortSignal.timeout(20_000) });
				const controller = new AbortController();

				const abortResponse = await post('abort', '/claude/v1/messages', {
					signal: controller.signal,
				});

				const abortReader = abortResponse.body?.getReader();
				expect(new TextDecoder().decode((await abortReader?.read())?.value)).toBe(firstChunk);
				controller.abort();
				await expect(abortReader?.read()).rejects.toThrow();
				keepStreaming('abort');
				await aborted.catch((cause: unknown) => {
					throw new Error('Client abort did not close upstream', { cause });
				});

				const dropped = await post('drop');
				const dropReader = dropped.body?.getReader();
				expect(new TextDecoder().decode((await dropReader?.read())?.value)).toBe(firstChunk);
				streams.get('drop')?.destroy();
				// The TCP bridge can report truncation as EOF or a transport error, never new data.
				await expect(
					dropReader?.read().catch(() => ({ done: true, value: undefined })),
				).resolves.toEqual({ done: true, value: undefined });

				const active = await post('disconnect');
				const activeReader = active.body?.getReader();
				expect(new TextDecoder().decode((await activeReader?.read())?.value)).toBe(firstChunk);

				const disconnected = await mf.dispatchFetch(`${account}/${accountId(credential)}`, {
					method: 'DELETE',
					headers: editor,
				});

				expect(disconnected.status).toBe(200);
				const stoppedStatus = Schema.decodeUnknownSync(ProxyStatus)(
					await (await mf.dispatchFetch('http://proxy.test/status', { headers: editor })).json(),
				);
				expect(stoppedStatus.runtime).toEqual({ state: 'stopped' });
				await expect(
					activeReader?.read().catch(() => ({ done: true, value: undefined })),
				).resolves.toEqual({ done: true, value: undefined });
				expect((await post('tokens')).status).toBe(503);
				await mf.dispose();
				mf = new Miniflare(options);
				expect((await post('tokens')).status).toBe(503);
				expect(seen.map(({ mode }) => mode)).toEqual([
					'tokens',
					'tokens',
					'tokens',
					'error',
					'cancel',
					'abort',
					'drop',
					'disconnect',
				]);
			} finally {
				for (const pacer of pacers) clearInterval(pacer);
				await mf.dispose();
				server.closeAllConnections();
				await new Promise<void>((done) => {
					server.close(() => done());
				});
				await rm(directory, { recursive: true, force: true });
			}
		}),
);
