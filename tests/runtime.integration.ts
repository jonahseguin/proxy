import { execFile } from 'node:child_process';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { expect, it } from '@effect/vitest';
import { Effect, Schema } from 'effect';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';

import { accountId, credentialKey, AccountStatus } from '../src/account.ts';
import { adminDigest, usersPath } from '../src/admin.ts';
import { accountPath, userHeader } from '../src/gateway.ts';

const run = promisify(execFile);

const containerEgressInterceptorImage =
	'cloudflare/proxy-everything:3cb1195@sha256:0ef6716c52430096900b150d84a3302057d6cd2319dae7987128c85d0733e3c8';

it.live('imports through the real Worker and CPA, survives restart, and disconnects', () =>
	Effect.tryPromise(async () => {
		const { stdout } = await run('docker', [
			'context',
			'inspect',
			'--format',
			'{{.Endpoints.docker.Host}}',
		]);

		const socketPath = stdout.trim();

		try {
			await run('docker', [
				'--host',
				socketPath,
				'image',
				'inspect',
				containerEgressInterceptorImage,
			]);
		} catch {
			await run('docker', ['--host', socketPath, 'pull', containerEgressInterceptorImage]);
		}

		const directory = await mkdtemp(join(tmpdir(), 'proxy-runtime-'));
		const server = createServer();
		await new Promise<void>((done) => {
			server.listen(0, '0.0.0.0', done);
		});
		const address = server.address();

		// Node's socket boundary returns a pipe name or TCP address; this fixture needs TCP.
		// eslint-disable-next-line anti-slop/no-runtime-typeof
		if (address === null || typeof address === 'string') throw new Error('No fixture port');

		const options = convertV4MiniflareOptions({
			modules: true,
			scriptPath: resolve('.cloudflare/output/v0/workers/default/bundle/index.js'),
			compatibilityDate: '2026-08-22',
			compatibilityFlags: ['nodejs_compat', 'enable_request_signal'],
			resourcePersistencePath: directory,
			containerEngine: { localDocker: { socketPath, containerEgressInterceptorImage } },
			durableObjects: {
				PROXY: {
					className: 'ProxyContainer',
					useSQLite: true,
					container: {
						imageName: JSON.parse(
							await readFile(
								'.cloudflare/output/v0/containers/proxy-cpa/container.config.json',
								'utf8',
							),
						).image.localReference,
					},
				},
			},
			r2Buckets: ['CREDENTIALS'],
			kvNamespaces: ['USERS'],
			bindings: {
				ADMIN_TOKEN_SHA256: adminDigest('synthetic-admin'),
				CLAUDE_MODELS: ['claude-haiku-4-5-20251001'],
				CPA_API_KEY: 'synthetic-cpa-key',
				CPA_MANAGEMENT_KEY: 'synthetic-management-key',
				CODEX_MODELS: ['gpt-5.4'],
				OBJECTSTORE_ENDPOINT: `http://host.docker.internal:${address.port}`,
				OBJECTSTORE_BUCKET: 'probe',
				OBJECTSTORE_ACCESS_KEY: 'synthetic-access',
				OBJECTSTORE_SECRET_KEY: 'synthetic-secret',
			},
		});

		let mf = new Miniflare(options);
		// Read-only S3 fixture over the same local R2 binding. No signature or provider verification.
		server.on('request', (request, response) => {
			const serve = async () => {
				const bucket = await mf.getR2Bucket('CREDENTIALS');
				const url = new URL(request.url ?? '/', 'http://fixture');

				if (request.method === 'HEAD' && url.pathname === '/probe/') {
					response.end();

					return;
				}

				if (request.method !== 'GET' && request.method !== 'HEAD') {
					response.writeHead(403);
					response.end();

					return;
				}

				if (url.pathname === '/probe/' && url.searchParams.has('location')) {
					response.setHeader('content-type', 'application/xml');
					response.end(
						'<LocationConstraint xmlns="http://s3.amazonaws.com/doc/2006-03-01/">us-east-1</LocationConstraint>',
					);

					return;
				}

				if (url.searchParams.has('list-type')) {
					const listed = await bucket.list({ prefix: url.searchParams.get('prefix') ?? '' });
					response.setHeader('content-type', 'application/xml');
					response.end(
						`<ListBucketResult><Name>probe</Name><IsTruncated>false</IsTruncated>${listed.objects.map((object) => `<Contents><Key>${object.key}</Key><Size>${object.size}</Size></Contents>`).join('')}</ListBucketResult>`,
					);

					return;
				}

				const object = await bucket.get(url.pathname.replace(/^\/probe\//, ''));

				if (object === null) {
					response.writeHead(404);
					response.end();

					return;
				}

				response.setHeader('content-length', object.size);
				response.setHeader('last-modified', object.uploaded.toUTCString());
				response.setHeader('etag', object.httpEtag);

				if (request.method === 'HEAD') {
					response.end();

					return;
				}

				response.end(await object.text());
			};

			void serve().catch(() => {
				response.writeHead(500);
				response.end();
			});
		});
		const admin = { authorization: 'Bearer synthetic-admin' };
		const auth = { authorization: 'Bearer synthetic-editor' };
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

		const team = { ...credential, organization_uuid: 'org-team', organization_name: 'Team' };
		const codex = {
			type: 'codex' as const,
			id_token: 'synthetic-id',
			access_token: 'synthetic-codex-access',
			refresh_token: 'synthetic-codex-refresh',
			account_id: 'chatgpt-account',
			email: credential.email,
			expired: credential.expired,
		};

		try {
			const namespace = await mf.getDurableObjectNamespace('PROXY');
			const object = namespace.get(namespace.idFromName('proxy'));

			expect((await object.fetch(account)).status).toBe(400);

			const direct = await object.fetch(account, { headers: { [userHeader]: 'alice' } });
			expect(await direct.json()).toEqual({ state: 'disconnected', accounts: [] });

			const unregistered = await mf.dispatchFetch(account, { headers: auth });
			expect(unregistered.status).toBe(401);

			const registered = await mf.dispatchFetch(`http://proxy.test${usersPath}/alice`, {
				method: 'PUT',
				headers: admin,
				body: JSON.stringify({ digest: adminDigest('synthetic-editor') }),
			});

			expect(await registered.json()).toEqual({ id: 'alice' });

			const denied = await mf.dispatchFetch(account, {
				headers: { authorization: 'Bearer editor-key' },
			});

			expect(denied.status).toBe(401);

			const malformed = await mf.dispatchFetch(account, {
				method: 'PUT',
				headers: auth,
				body: '{}',
			});

			expect(malformed.status).toBe(400);

			const imported = await mf.dispatchFetch(account, {
				method: 'PUT',
				headers: auth,
				body: JSON.stringify(credential),
			});

			expect(await imported.json()).toMatchObject({
				state: 'saved',
				accounts: [
					{
						id: accountId(credential),
						email: 'account@example.test',
						organizationId: 'org-personal',
					},
				],
			});
			expect(imported.status).toBe(200);
			expect(
				await (
					await mf.getR2Bucket('CREDENTIALS')
				)
					.get(credentialKey('alice', 'claude', accountId(credential)))
					.then((o) => o?.json()),
			).toEqual({ ...credential, prefix: 'alice' });
			const teamImported = await mf.dispatchFetch(account, {
				method: 'PUT',
				headers: auth,
				body: JSON.stringify(team),
			});
			expect(teamImported.status).toBe(200);
			const codexImported = await mf.dispatchFetch(`http://proxy.test${accountPath('codex')}`, {
				method: 'PUT',
				headers: auth,
				body: JSON.stringify(codex),
			});
			expect(codexImported.status).toBe(200);
			expect(
				(await (await mf.getR2Bucket('CREDENTIALS')).list({ prefix: 'auths/' })).objects,
			).toHaveLength(3);
			await mf.dispose();
			mf = new Miniflare(options);
			const restored = await mf.dispatchFetch(account, { headers: auth });
			const restoredStatus = Schema.decodeUnknownSync(AccountStatus)(await restored.json());
			expect(restoredStatus.state).toBe('saved');
			expect(
				restoredStatus.accounts.map((connection) => connection.organizationId).toSorted(),
			).toEqual(['org-personal', 'org-team']);
			for (const connection of restoredStatus.accounts) {
				expect(connection.health.state).toBe('ready');
				expect(connection.usage).toMatchObject({
					state: 'observed',
					success: 0,
					failed: 0,
					quotaState: 'unavailable',
				});
			}
			expect(JSON.stringify(restoredStatus)).not.toContain('synthetic-access');

			const deleted = await mf.dispatchFetch(`${account}/${accountId(credential)}`, {
				method: 'DELETE',
				headers: auth,
			});

			expect(deleted.status).toBe(200);
			expect(
				Schema.decodeUnknownSync(AccountStatus)(await deleted.json()).accounts.map(
					(connection) => connection.organizationId,
				),
			).toEqual(['org-team']);
			expect(
				(
					await mf.dispatchFetch(`${account}/${accountId(team)}`, {
						method: 'DELETE',
						headers: auth,
					})
				).status,
			).toBe(200);
			await mf.dispose();
			mf = new Miniflare(options);
			const status = await mf.dispatchFetch(account, { headers: auth });
			expect(await status.json()).toEqual({ state: 'disconnected', accounts: [] });
			expect(
				await (
					await mf.getR2Bucket('CREDENTIALS')
				).get(credentialKey('alice', 'claude', accountId(credential))),
			).toBeNull();

			// Removing a user revokes the key and deletes the credential in one administrator call.
			const reimported = await mf.dispatchFetch(account, {
				method: 'PUT',
				headers: auth,
				body: JSON.stringify(credential),
			});

			expect(reimported.status).toBe(200);

			const removed = await mf.dispatchFetch(`http://proxy.test${usersPath}/alice`, {
				method: 'DELETE',
				headers: admin,
			});

			expect(removed.status).toBe(200);
			expect(await removed.json()).toEqual({ state: 'disconnected', accounts: [] });
			expect(
				(await (await mf.getR2Bucket('CREDENTIALS')).list({ prefix: 'auths/' })).objects,
			).toEqual([]);
			expect((await mf.dispatchFetch(account, { headers: auth })).status).toBe(401);
			expect(
				await (
					await mf.getR2Bucket('CREDENTIALS')
				).get(credentialKey('alice', 'claude', accountId(credential))),
			).toBeNull();
			expect(
				await (await mf.dispatchFetch(`http://proxy.test${usersPath}`, { headers: admin })).json(),
			).toEqual({ users: [] });
		} finally {
			await mf.dispose();
			await new Promise<void>((done, reject) =>
				server.close((error) => (error ? reject(error) : done())),
			);
			await rm(directory, { recursive: true, force: true });
		}
	}),
);
