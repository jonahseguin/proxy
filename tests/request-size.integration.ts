import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';

import { accountId } from '../src/account.ts';
import { adminDigest, usersPath } from '../src/admin.ts';
import { accountPath } from '../src/gateway.ts';

const run = promisify(execFile);
const limit = 32 * 1024 * 1024;
const model = 'claude-haiku-4-5-20251001';
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

function summary(bytes: Buffer) {
	const decoded = JSON.parse(bytes.toString()) as {
		model: string;
		messages: { content: { text?: string; source?: { data: string } }[] }[];
		max_tokens: number;
		metadata?: unknown[];
	};
	const first = decoded.messages[0]?.content[0];
	const content = Buffer.from(first?.text ?? first?.source?.data ?? '');
	return {
		model: decoded.model,
		contentBytes: content.byteLength,
		contentDigest: digest(content),
		maxTokens: decoded.max_tokens,
		metadataLength: decoded.metadata?.length ?? 0,
		metadataZeros: decoded.metadata?.every((value) => value === 0) ?? true,
	};
}

function payload(size: number, pattern: string, image = false, selectedModel = model): Buffer {
	const opening = Buffer.from(
		image
			? `{"model":"${selectedModel}","messages":[{"role":"user","content":[{"type":"image","source":{"type":"base64","media_type":"image/png","data":"`
			: `{"model":"${selectedModel}","messages":[{"role":"user","content":[{"type":"text","text":"`,
	);
	const closing = Buffer.from(image ? '"}}]}],"max_tokens":1}' : '"}]}],"max_tokens":1}');
	const repeated = Buffer.from(pattern);
	const contentSize = size - opening.byteLength - closing.byteLength;
	const content = Buffer.alloc(contentSize);
	const completeSize = contentSize - (contentSize % repeated.byteLength);
	content.subarray(0, completeSize).fill(repeated);
	content.fill('a', completeSize);
	return Buffer.concat([opening, content, closing]);
}

async function post(
	url: URL,
	body: Buffer,
	mode: string,
	options: { chunked?: boolean; unauthorized?: boolean; cancel?: boolean } = {},
): Promise<{ status: number; body: string }> {
	let offset = 0;
	const init = {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			'x-api-key': options.unauthorized ? 'wrong-key' : 'editor-only',
			'anthropic-beta': mode,
			'anthropic-version': '2023-06-01',
			'x-proxy-model': 'forbidden',
			'x-proxy-user': 'mallory',
			...(options.chunked ? {} : { 'content-length': body.byteLength.toString() }),
		},
		body: new ReadableStream<Uint8Array>({
			pull(controller) {
				if (offset === body.byteLength) {
					controller.close();
					return;
				}
				const end = Math.min(offset + 65_537, body.byteLength);
				controller.enqueue(body.subarray(offset, end));
				offset = end;
			},
		}),
		duplex: 'half',
	};
	const response = await fetch(url.href, init);
	if (options.cancel) {
		const reader = response.body?.getReader();
		const first = await reader?.read();
		await reader?.cancel();
		return { status: response.status, body: new TextDecoder().decode(first?.value) };
	}
	return { status: response.status, body: await response.text() };
}

it.live(
	'validates and forwards 32 MiB inference bodies in workerd without changing message bytes',
	() =>
		Effect.tryPromise(async () => {
			await run('docker', ['build', '-t', 'proxy-request-size-fixture:test', 'tests/fixtures']);
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

			const credential = {
				type: 'claude' as const,
				account_uuid: 'large-account',
				organization_uuid: 'large-organization',
				access_token: 'synthetic-access',
				refresh_token: 'synthetic-refresh',
				email: 'size@example.test',
				expired: '2099-01-01T00:00:00Z',
			};
			const directory = await mkdtemp(join(tmpdir(), 'proxy-request-size-'));
			const seen: string[] = [];
			const failures: unknown[] = [];
			const events = new EventEmitter();
			const pacers = new Set<NodeJS.Timeout>();
			const server = createServer((request, response) => {
				void (async () => {
					if (request.url?.startsWith('/v0/management/auth-files/models?')) {
						expect(request.headers.authorization).toBe('Bearer synthetic-management-key');
						expect(new URL(request.url, 'http://fixture').searchParams.get('name')).toBe(
							`alice__claude__${accountId(credential)}.json`,
						);
						response.setHeader('content-type', 'application/json');
						response.end(JSON.stringify({ models: [{ id: `alice/${model}` }] }));
						return;
					}
					if (request.method === 'GET') {
						response.end('ready');
						return;
					}
					expect(request.url).toBe('/v1/messages');
					expect(request.headers.authorization).toBe('Bearer private-cpa-key');
					expect(request.headers['x-api-key']).toBeUndefined();
					expect(request.headers['x-proxy-model']).toBeUndefined();
					const mode = request.headers['anthropic-beta'];
					expect(typeof mode).toBe('string');
					if (typeof mode !== 'string') throw new Error('Missing fixture mode');
					seen.push(mode);
					const chunks: Buffer[] = [];
					for await (const chunk of request) {
						chunks.push(chunk);
					}
					const observed = summary(Buffer.concat(chunks));
					if (mode === 'cancel') {
						response.writeHead(200, { 'content-type': 'text/event-stream' });
						response.write('event: ping\ndata: {"type":"ping"}\n\n');
						const pacer = setInterval(() => {
							response.write('event: ping\ndata: {"type":"ping"}\n\n');
						}, 100);
						pacers.add(pacer);
						response.once('close', () => {
							clearInterval(pacer);
							events.emit('cancelled');
						});
						return;
					}
					response.setHeader('content-type', 'application/json');
					response.end(JSON.stringify(observed));
				})().catch((cause: unknown) => {
					failures.push(cause);
					response.writeHead(500).end();
				});
			});
			await new Promise<void>((done) => server.listen(0, '0.0.0.0', done));
			const address = server.address();
			if (!address || typeof address === 'string') throw new Error('No fixture port');
			const mf = new Miniflare(
				convertV4MiniflareOptions({
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
							container: { imageName: 'proxy-request-size-fixture:test' },
						},
					},
					r2Buckets: ['CREDENTIALS'],
					kvNamespaces: ['USERS'],
					bindings: {
						ADMIN_TOKEN_SHA256: adminDigest('admin-only'),
						CLAUDE_MODELS: [model],
						CPA_API_KEY: 'private-cpa-key',
						CPA_MANAGEMENT_KEY: 'synthetic-management-key',
						CODEX_MODELS: ['gpt-5.4'],
						OBJECTSTORE_ENDPOINT: `http://host.docker.internal:${address.port}`,
						OBJECTSTORE_BUCKET: 'probe',
						OBJECTSTORE_ACCESS_KEY: 'synthetic-access',
						OBJECTSTORE_SECRET_KEY: 'synthetic-secret',
					},
				}),
			);
			try {
				const registered = await mf.dispatchFetch(`http://proxy.test${usersPath}/alice`, {
					method: 'PUT',
					headers: { authorization: 'Bearer admin-only' },
					body: JSON.stringify({ digest: adminDigest('editor-only') }),
				});
				expect(registered.status).toBe(200);
				const url = new URL('/claude/v1/messages', await mf.ready);
				const invalidModel = await post(
					url,
					payload(9 * 1024 * 1024, 'a', false, 'forbidden'),
					'invalid-model',
				);
				expect(invalidModel.status).toBe(403);
				expect(JSON.parse(invalidModel.body)).toMatchObject({
					error: { message: 'Model is not allowed' },
				});
				const unauthorized = await post(url, payload(9 * 1024 * 1024, 'a'), 'unauthorized', {
					unauthorized: true,
				});
				expect(unauthorized.status).toBe(401);
				const invalid = await post(
					url,
					Buffer.concat([payload(9 * 1024 * 1024, 'a'), Buffer.from(']')]),
					'invalid-json',
					{ chunked: true },
				);
				expect(invalid.status).toBe(400);
				for (const chunked of [false, true]) {
					const oversized = await post(url, payload(limit + 1, 'a'), `oversized-${chunked}`, {
						chunked,
					});
					expect(oversized.status).toBe(413);
					expect(JSON.parse(oversized.body)).toMatchObject({
						error: { message: 'Request body exceeds the 32 MiB input or 33 MiB rewritten limit' },
					});
				}
				for (const length of [256, 257]) {
					const boundedModel = await post(
						url,
						payload(9 * 1024 * 1024, 'a', false, 'a'.repeat(length)),
						`model-length-${length}`,
						{ chunked: true },
					);
					expect(boundedModel.status).toBe(length === 256 ? 403 : 400);
				}
				for (const nesting of [127, 128]) {
					const body = payload(9 * 1024 * 1024, 'a', false, 'forbidden');
					const deep = await post(
						url,
						Buffer.concat([
							body.subarray(0, body.byteLength - 1),
							Buffer.from(`,"extra":${'['.repeat(nesting)}0${']'.repeat(nesting)}}`),
						]),
						`depth-${nesting + 1}`,
						{ chunked: true },
					);
					expect(deep.status).toBe(nesting === 127 ? 403 : 400);
				}
				for (const key of ['model', 'mo\\u0064el']) {
					const body = payload(9 * 1024 * 1024, 'a');
					const duplicate = await post(
						url,
						Buffer.concat([
							body.subarray(0, body.byteLength - 1),
							Buffer.from(`,"${key}":"${model}"}`),
						]),
						'duplicate-model',
						{ chunked: true },
					);
					expect(duplicate.status).toBe(400);
				}
				expect(seen).toEqual([]);
				const imported = await mf.dispatchFetch(`http://proxy.test${accountPath('claude')}`, {
					method: 'PUT',
					headers: { authorization: 'Bearer editor-only' },
					body: JSON.stringify(credential),
				});
				expect(imported.status).toBe(200);
				for (const sample of [
					{ mode: 'ascii', pattern: 'context content ', image: false, chunked: false },
					{ mode: 'base64', pattern: 'aGVsbG9Xb3JsZA==', image: true, chunked: true },
					{ mode: 'multibyte', pattern: '界🌍', image: false, chunked: true },
					{ mode: 'repeat', pattern: 'context content ', image: false, chunked: true },
				]) {
					const body = payload(limit, sample.pattern, sample.image);
					const expected = { ...summary(body), model: `alice/${model}` };
					const response = await post(url, body, sample.mode, { chunked: sample.chunked });
					expect(response.status, sample.mode).toBe(200);
					expect(JSON.parse(response.body)).toEqual(expected);
				}
				for (const sample of [
					{ mode: 'escaped-key', before: '"model"', after: '"mo\\u0064el"' },
					{ mode: 'escaped-model', before: `"${model}"`, after: `"\\u0063${model.slice(1)}"` },
				]) {
					const body = Buffer.from(
						payload(9 * 1024 * 1024, 'a')
							.toString()
							.replace(sample.before, sample.after),
					);
					const response = await post(url, body, sample.mode, { chunked: true });
					expect(response.status, sample.mode).toBe(200);
					expect(JSON.parse(response.body)).toEqual({ ...summary(body), model: `alice/${model}` });
				}
				const earlyModel = payload(9 * 1024 * 1024, 'a')
					.toString()
					.replace(`"model":"${model}",`, '');
				const lateModel = Buffer.from(`${earlyModel.slice(0, -1)},"model":"${model}"}`);
				const lateResponse = await post(url, lateModel, 'model-last', { chunked: true });
				expect(lateResponse.status).toBe(200);
				expect(JSON.parse(lateResponse.body)).toEqual({
					...summary(lateModel),
					model: `alice/${model}`,
				});
				const denseBase = payload(256, 'a');
				const dense = Buffer.concat([
					denseBase.subarray(0, denseBase.byteLength - 1),
					Buffer.from(`,"metadata":[${'0,'.repeat(8 * 1024 * 1024 - 1)}0]}`),
				]);
				const denseResponse = await post(url, dense, 'dense', { chunked: true });
				expect(denseResponse.status).toBe(200);
				expect(JSON.parse(denseResponse.body)).toEqual({
					...summary(dense),
					model: `alice/${model}`,
				});
				const cancelled = once(events, 'cancelled', { signal: AbortSignal.timeout(20_000) });
				expect(
					(
						await post(url, payload(9 * 1024 * 1024, 'a'), 'cancel', {
							cancel: true,
							chunked: true,
						})
					).status,
				).toBe(200);
				await cancelled;
				expect(seen).toEqual([
					'ascii',
					'base64',
					'multibyte',
					'repeat',
					'escaped-key',
					'escaped-model',
					'model-last',
					'dense',
					'cancel',
				]);
				expect(failures).toEqual([]);
				expect((await mf.dispatchFetch('http://proxy.test/healthz')).status).toBe(200);
			} finally {
				for (const pacer of pacers) clearInterval(pacer);
				await mf.dispose();
				server.closeAllConnections();
				await new Promise<void>((done) => server.close(() => done()));
				await rm(directory, { recursive: true, force: true });
			}
		}),
);
