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
	'uses pinned CPA round robin and session affinity inside each owner and provider pool',
	() =>
		Effect.tryPromise(async () => {
			const directory = await mkdtemp(join(tmpdir(), 'proxy-pools-'));
			const seen: { key: string; path: string }[] = [];
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
					if (parsed.includes('codex')) {
						response.setHeader('content-type', 'text/event-stream');
						response.end(
							`data: ${JSON.stringify({ type: 'response.completed', response: { id: 'synthetic-response', object: 'response', model: 'gpt-5.5', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'synthetic' }] }], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } })}\n\n`,
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
				'max-retry-credentials': 1,
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
				],
				'codex-api-key': [
					key('alice', 'codex', 'one'),
					key('alice', 'codex', 'two'),
					key('bob', 'codex', 'one'),
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
				expect(seen).toHaveLength(12);
			} finally {
				if (containerId !== undefined) await run('docker', ['rm', '--force', containerId]);
				server.closeAllConnections();
				await new Promise<void>((done) => server.close(() => done()));
				await rm(directory, { recursive: true, force: true });
			}
		}),
);
