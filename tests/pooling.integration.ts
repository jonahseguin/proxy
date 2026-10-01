import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { expect, it } from '@effect/vitest';
import { Effect, Schema } from 'effect';

const run = promisify(execFile);
const imageConfig = Schema.Struct({ image: Schema.Struct({ localReference: Schema.String }) });

it.live(
	'keeps native pool affinity, retries quota failures before output, and readmits expired accounts',
	() =>
		Effect.tryPromise(async () => {
			const directory = await mkdtemp(join(tmpdir(), 'proxy-pools-'));
			const seen: { key: string; path: string }[] = [];
			const failures = new Map<string, 'quota' | 'bootstrap' | 'partial'>();
			const server = createServer((request, response) => {
				void (async () => {
					const chunks: Buffer[] = [];
					for await (const chunk of request) chunks.push(chunk);
					const key =
						request.headers['x-api-key'] ??
						request.headers.authorization?.replace('Bearer ', '') ??
						'';
					const parsed = Schema.decodeUnknownSync(Schema.String)(key);
					seen.push({ key: parsed, path: request.url ?? '' });
					const failure = failures.get(parsed);
					const quotaError = parsed.includes('codex')
						? { type: 'usage_limit_reached', message: 'synthetic quota', resets_in_seconds: 10 }
						: { type: 'rate_limit_error', message: 'synthetic quota' };
					if (failure === 'quota') {
						response.writeHead(429, {
							'content-type': 'application/json',
							'retry-after': '10',
							'anthropic-ratelimit-unified-5h-status': 'rejected',
							'anthropic-ratelimit-unified-5h-reset': String(Math.ceil(Date.now() / 1000) + 10),
						});
						response.end(JSON.stringify({ error: quotaError }));
						return;
					}
					if (failure === 'bootstrap' || failure === 'partial') {
						response.setHeader('content-type', 'text/event-stream');
						if (failure === 'partial') {
							response.write(
								parsed.includes('codex')
									? `data: ${JSON.stringify({ type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'partial output' })}\n\n`
									: `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial output' } })}\n\n`,
							);
						}
						const errorFrame = parsed.includes('codex')
							? { type: 'error', status: 429, error: quotaError }
							: { type: 'error', error: quotaError };
						const finish = () =>
							response.end(
								`${parsed.includes('codex') ? '' : 'event: error\n'}data: ${JSON.stringify(errorFrame)}\n\n`,
							);
						if (failure === 'partial') setTimeout(finish, 100);
						else finish();
						return;
					}
					if (parsed.includes('codex')) {
						response.setHeader('content-type', 'text/event-stream');
						response.end(
							`data: ${JSON.stringify({ type: 'response.completed', response: { id: 'synthetic-response', object: 'response', model: 'gpt-5.5', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'synthetic' }] }], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } })}\n\n`,
						);
					} else if (JSON.parse(Buffer.concat(chunks).toString()).stream === true) {
						response.setHeader('content-type', 'text/event-stream');
						response.end(
							`event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: 'synthetic-message', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6', content: [], usage: { input_tokens: 1, output_tokens: 0 } } })}\n\nevent: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'synthetic' } })}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n`,
						);
					} else {
						response.setHeader('content-type', 'application/json');
						response.end(
							JSON.stringify({
								id: 'synthetic-message',
								type: 'message',
								role: 'assistant',
								model: 'claude-sonnet-4-6',
								content: [{ type: 'text', text: 'synthetic' }],
								stop_reason: 'end_turn',
								usage: { input_tokens: 1, output_tokens: 1 },
							}),
						);
					}
				})().catch(() => response.writeHead(500).end());
			});
			await new Promise<void>((done) => server.listen(0, '0.0.0.0', done));
			const address = server.address();
			if (address === null || typeof address === 'string')
				throw new Error('Fixture TCP unavailable');
			const upstream = `http://host.docker.internal:${address.port}`;
			const key = (prefix: string, provider: 'claude' | 'codex', suffix: string) => ({
				'api-key': `synthetic-${provider}-${prefix}-${suffix}`,
				prefix,
				'base-url': upstream,
				models: [{ name: provider === 'claude' ? 'claude-sonnet-4-6' : 'gpt-5.5' }],
			});
			const config = {
				host: '',
				port: 8317,
				'auth-dir': '/tmp/pool-auths',
				'api-keys': ['synthetic-editor'],
				'force-model-prefix': true,
				'request-log': false,
				'logging-to-file': false,
				'usage-statistics-enabled': false,
				'request-retry': 0,
				'max-retry-credentials': 0,
				'max-retry-interval': 0,
				streaming: { 'bootstrap-retries': 0 },
				routing: {
					strategy: 'round-robin',
					'session-affinity': true,
					'session-affinity-ttl': '1h',
				},
				'remote-management': {
					'secret-key': 'synthetic-management',
					'allow-remote': true,
					'disable-control-panel': true,
					'disable-auto-update-panel': true,
				},
				'claude-api-key': [
					key('alice', 'claude', 'one'),
					key('alice', 'claude', 'two'),
					key('bob', 'claude', 'one'),
					key('bootstrap', 'claude', 'one'),
					key('bootstrap', 'claude', 'two'),
					key('exhausted', 'claude', 'one'),
					key('exhausted', 'claude', 'two'),
					key('http', 'claude', 'one'),
					key('http', 'claude', 'two'),
				],
				'codex-api-key': [
					key('alice', 'codex', 'one'),
					key('alice', 'codex', 'two'),
					key('bob', 'codex', 'one'),
					key('bootstrap', 'codex', 'one'),
					key('bootstrap', 'codex', 'two'),
					key('exhausted', 'codex', 'one'),
					key('exhausted', 'codex', 'two'),
					key('http', 'codex', 'one'),
					key('http', 'codex', 'two'),
				],
			};
			const configPath = join(directory, 'config.json');
			await writeFile(configPath, JSON.stringify(config));
			const metadata = Schema.decodeUnknownSync(imageConfig)(
				JSON.parse(
					await readFile(
						'.cloudflare/output/v0/containers/proxy-cpa/container.config.json',
						'utf8',
					),
				),
			);
			let containerId: string | undefined;
			try {
				const created = await run('docker', [
					'run',
					'--detach',
					'--entrypoint',
					'/CLIProxyAPI/CLIProxyAPI',
					'--publish',
					'127.0.0.1::8317',
					'--mount',
					`type=bind,src=${configPath},dst=/tmp/pool-config.json,readonly`,
					metadata.image.localReference,
					'-config',
					'/tmp/pool-config.json',
				]);
				containerId = created.stdout.trim();
				const port = await run('docker', ['port', containerId, '8317/tcp']);
				const origin = `http://${port.stdout.trim()}`;
				let ready = false;
				for (let attempt = 0; attempt < 60; attempt++) {
					try {
						const response = await fetch(`${origin}/v1/models`, {
							headers: { authorization: 'Bearer synthetic-editor' },
						});
						if (response.ok) {
							ready = true;
							break;
						}
					} catch {}
					await new Promise((done) => setTimeout(done, 100));
				}
				expect(ready).toBe(true);
				const post = async (provider: 'claude' | 'codex', owner: string, session: string) => {
					const response = await fetch(
						`${origin}/v1/${provider === 'claude' ? 'messages' : 'responses'}`,
						{
							method: 'POST',
							headers: {
								authorization: 'Bearer synthetic-editor',
								'content-type': 'application/json',
								[provider === 'claude' ? 'x-claude-code-session-id' : 'session_id']: session,
							},
							body: JSON.stringify(
								provider === 'claude'
									? {
											model: `${owner}/claude-sonnet-4-6`,
											max_tokens: 1,
											messages: [{ role: 'user', content: `synthetic ${session}` }],
										}
									: {
											model: `${owner}/gpt-5.5`,
											input: [{ role: 'user', content: `synthetic ${session}` }],
											stream: false,
										},
							),
						},
					);
					expect(response.status, `${provider} ${owner} ${session}: ${await response.text()}`).toBe(
						200,
					);
					return seen.at(-1)?.key;
				};
				for (const provider of ['claude', 'codex'] as const) {
					const selections: string[] = [];
					for (let index = 0; index < 4; index++)
						selections.push((await post(provider, 'alice', `${provider}-session-${index}`)) ?? '');
					expect(selections[0]).not.toBe(selections[1]);
					expect(selections[0]).toBe(selections[2]);
					expect(selections[1]).toBe(selections[3]);
					expect(
						selections.every((value) => value.startsWith(`synthetic-${provider}-alice-`)),
					).toBe(true);
					expect(await post(provider, 'alice', `${provider}-session-0`)).toBe(selections[0]);
					expect(await post(provider, 'bob', `${provider}-session-0`)).toBe(
						`synthetic-${provider}-bob-one`,
					);
				}
				const transcript = async (provider: 'claude' | 'codex', thread: string, turns: number) => {
					const messages = [
						{ role: 'user', content: `Review ${thread}.ts and explain its imports.` },
					];
					for (let turn = 0; turn < turns; turn++)
						messages.push(
							{ role: 'assistant', content: `synthetic review ${thread} turn ${turn}` },
							{ role: 'user', content: `Continue ${thread} review with step ${turn + 1}.` },
						);
					const system = 'You review code carefully. Preserve the full conversation history.';
					const response = await fetch(
						`${origin}/v1/${provider === 'claude' ? 'messages' : 'responses'}`,
						{
							method: 'POST',
							headers: {
								authorization: 'Bearer synthetic-editor',
								'content-type': 'application/json',
							},
							body: JSON.stringify(
								provider === 'claude'
									? {
											model: 'alice/claude-sonnet-4-6',
											max_tokens: 1,
											system,
											messages: messages.map((message) => ({
												...message,
												content: [{ type: 'text', text: message.content }],
											})),
										}
									: {
											model: 'alice/gpt-5.5',
											instructions: system,
											input: messages.map((message) => ({
												...message,
												type: 'message',
												content: [
													{
														type: message.role === 'assistant' ? 'output_text' : 'input_text',
														text: message.content,
													},
												],
											})),
											stream: false,
										},
							),
						},
					);
					expect(
						response.status,
						`${provider} ${thread} turn ${turns}: ${await response.text()}`,
					).toBe(200);
					return seen.at(-1)?.key;
				};
				for (const provider of ['claude', 'codex'] as const) {
					const firstA = await transcript(provider, 'alpha', 0);
					const firstB = await transcript(provider, 'beta', 0);
					expect(firstA).not.toBe(firstB);
					expect(firstA).toMatch(new RegExp(`^synthetic-${provider}-alice-`));
					expect(firstB).toMatch(new RegExp(`^synthetic-${provider}-alice-`));
					expect(await transcript(provider, 'alpha', 1)).toBe(firstA);
					expect(await transcript(provider, 'beta', 1)).toBe(firstB);
					expect(await transcript(provider, 'alpha', 2)).toBe(firstA);
					expect(await transcript(provider, 'beta', 2)).toBe(firstB);
				}
				expect(seen).toHaveLength(24);
				const stream = async (provider: 'claude' | 'codex', session: string, owner = 'alice') => {
					const response = await fetch(
						`${origin}/v1/${provider === 'claude' ? 'messages' : 'responses'}`,
						{
							method: 'POST',
							headers: {
								authorization: 'Bearer synthetic-editor',
								'content-type': 'application/json',
								[provider === 'claude' ? 'x-claude-code-session-id' : 'session_id']: session,
							},
							body: JSON.stringify({
								model: `${owner}/${provider === 'claude' ? 'claude-sonnet-4-6' : 'gpt-5.5'}`,
								...(provider === 'claude'
									? { max_tokens: 8, messages: [{ role: 'user', content: 'synthetic retry' }] }
									: { input: [{ role: 'user', content: 'synthetic retry' }] }),
								stream: true,
							}),
							signal: AbortSignal.timeout(5_000),
						},
					);
					return {
						status: response.status,
						headers: response.headers,
						body: await response.text(),
					};
				};
				for (const provider of ['claude', 'codex'] as const) {
					const httpSession = `${provider}-http-retry`;
					const httpOriginal = await post(provider, 'http', httpSession);
					if (httpOriginal === undefined) throw new Error('No HTTP account selected');
					failures.set(httpOriginal, 'quota');
					let offset = seen.length;
					const httpReplacement = await post(provider, 'http', httpSession);
					expect(httpReplacement).not.toBe(httpOriginal);
					expect(seen.slice(offset).map((attempt) => attempt.key)).toEqual([
						httpOriginal,
						httpReplacement,
					]);
					const bootstrapSession = `${provider}-bootstrap-retry`;
					const bootstrapOriginal = await post(provider, 'bootstrap', bootstrapSession);
					if (bootstrapOriginal === undefined) throw new Error('No bootstrap account selected');
					failures.set(bootstrapOriginal, 'bootstrap');
					offset = seen.length;
					const bootstrapped = await stream(provider, bootstrapSession, 'bootstrap');
					expect(bootstrapped.status, bootstrapped.body).toBe(200);
					const bootstrapAttempts = seen.slice(offset).map((attempt) => attempt.key);
					if (provider === 'claude') {
						expect(bootstrapAttempts).toEqual([bootstrapOriginal]);
						expect(bootstrapped.body).toContain('"type":"rate_limit_error"');
					} else {
						expect(bootstrapAttempts).toHaveLength(2);
						expect(bootstrapAttempts[0]).toBe(bootstrapOriginal);
						expect(bootstrapAttempts[1]).not.toBe(bootstrapOriginal);
						expect(bootstrapped.body).toContain('synthetic');
					}
					failures.set(`synthetic-${provider}-exhausted-one`, 'quota');
					failures.set(`synthetic-${provider}-exhausted-two`, 'quota');
					offset = seen.length;
					const emptyPool = await stream(provider, `${provider}-exhausted`, 'exhausted');
					expect(emptyPool.status, emptyPool.body).toBe(429);
					expect(
						seen
							.slice(offset)
							.map((attempt) => attempt.key)
							.toSorted(),
					).toEqual([`synthetic-${provider}-exhausted-one`, `synthetic-${provider}-exhausted-two`]);
					const session = `${provider}-quota-session`;
					const original = await post(provider, 'alice', session);
					if (original === undefined) throw new Error('No original account selected');
					const replacement = `synthetic-${provider}-alice-${original.endsWith('one') ? 'two' : 'one'}`;
					failures.set(original, 'quota');
					offset = seen.length;
					const recovered = await stream(provider, session);
					expect(recovered.status, recovered.body).toBe(200);
					expect(seen.slice(offset).map((attempt) => attempt.key)).toEqual([original, replacement]);
					expect(await post(provider, 'alice', session)).toBe(replacement);
					failures.set(replacement, 'quota');
					offset = seen.length;
					const exhausted = await stream(provider, session);
					expect(exhausted.status, exhausted.body).toBe(429);
					expect(seen.slice(offset).map((attempt) => attempt.key)).toEqual([replacement]);
					offset = seen.length;
					const cached = await stream(provider, session);
					expect(cached.status, cached.body).toBe(429);
					expect(Number(cached.headers.get('retry-after'))).toBeGreaterThan(0);
					expect(seen).toHaveLength(offset);
					failures.delete(original);
					failures.delete(replacement);
					const deadline = Date.now() + 45_000;
					let available = cached;
					while (available.status === 429 && Date.now() < deadline) {
						await new Promise((done) => setTimeout(done, 250));
						available = await stream(provider, session);
					}
					expect(available.status, available.body).toBe(200);
					expect(seen).toHaveLength(offset + 1);
					const active = seen.at(-1)?.key;
					if (active === undefined) throw new Error('No recovered account selected');
					failures.set(active, 'partial');
					offset = seen.length;
					const partial = await stream(provider, session);
					expect(partial.status, partial.body).toBe(200);
					expect(partial.body).toContain('partial output');
					expect(seen.slice(offset).map((attempt) => attempt.key)).toEqual([active]);
					failures.delete(active);
				}
			} finally {
				if (containerId !== undefined) await run('docker', ['rm', '--force', containerId]);
				server.closeAllConnections();
				await new Promise<void>((done) => server.close(() => done()));
				await rm(directory, { recursive: true, force: true });
			}
		}),
);
