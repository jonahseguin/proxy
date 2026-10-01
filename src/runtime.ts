import { Container } from '@cloudflare/containers';
import { Effect, Layer, Schema } from 'effect';

import {
	Account,
	AccountId,
	AccountStatus,
	credentialPrefix,
	credentialLimit,
	decodeCredential,
	isProvider,
	readAccount,
	replaceAccount,
	removeUserAccounts,
	type Provider,
	type ProxyStatus,
	type AccountInfo,
	type AccountUsage,
} from './account.ts';
import { allAccountsPath, BodyError, inferencePath, readBody, userHeader } from './gateway.ts';
import { accountMetrics, quotaRequest, quotaWindows } from './metrics.ts';
import { isUserId } from './users.ts';

const stateKey = (id: string, provider: Provider) => `account-state:${id}:${provider}`;
const gateKey = 'runtime-gate';
const startedKey = 'runtime-started-at';
const QuotaResponse = Schema.Struct({ status_code: Schema.Number, body: Schema.String });

export class ProxyContainer extends Container<Env> {
	defaultPort = 8317;
	sleepAfter = '30m';
	private busy = false;
	private reading = 0;
	private starting: Promise<void> | null = null;
	private quotaCache = new Map<
		string,
		{ expires: number; usage: Pick<AccountUsage, 'quotaState' | 'windows' | 'observedAt'> }
	>();

	override async onStop(): Promise<void> {
		await this.ctx.storage.delete(startedKey);
		this.quotaCache.clear();
	}

	private async startRuntime(): Promise<void> {
		await this.env.CREDENTIALS.put(
			'config/config.yaml',
			JSON.stringify({
				host: '',
				port: 8317,
				'api-keys': [this.env.CPA_API_KEY],
				'request-log': false,
				'logging-to-file': false,
				'usage-statistics-enabled': false,
				debug: false,
				'request-retry': 0,
				'max-retry-credentials': 0,
				'max-retry-interval': 0,
				streaming: { 'bootstrap-retries': 0 },
				'quota-exceeded': {
					'switch-project': false,
					'switch-preview-model': false,
					'antigravity-credits': false,
				},
				'oauth-model-alias': {},
				'force-model-prefix': true,
				routing: {
					strategy: 'round-robin',
					'session-affinity': true,
					'session-affinity-ttl': '1h',
				},
				'remote-management': {
					'allow-remote': true,
					'secret-key': this.env.CPA_MANAGEMENT_KEY,
					'disable-control-panel': true,
					'disable-auto-update-panel': true,
				},
			}),
		);
		await this.startAndWaitForPorts({
			ports: [8317],
			startOptions: {
				envVars: {
					OBJECTSTORE_ENDPOINT: this.env.OBJECTSTORE_ENDPOINT,
					OBJECTSTORE_BUCKET: this.env.OBJECTSTORE_BUCKET,
					OBJECTSTORE_ACCESS_KEY: this.env.OBJECTSTORE_ACCESS_KEY,
					OBJECTSTORE_SECRET_KEY: this.env.OBJECTSTORE_SECRET_KEY,
				},
			},
		});
		await this.ctx.storage.put(startedKey, new Date().toISOString());
		this.quotaCache.clear();
	}

	private ports(user: string, provider?: Provider) {
		return Layer.mergeAll(
			Account.storageLayer({
				list: async () => {
					const entries: Account.StoredCredential[] = [];
					let cursor: string | undefined;
					do {
						const listed = await this.env.CREDENTIALS.list({
							prefix: credentialPrefix(user, provider),
							...(cursor === undefined ? {} : { cursor }),
						});
						for (const object of listed.objects) {
							const value = await this.env.CREDENTIALS.get(object.key);
							if (value === null) throw new Error('Credential disappeared');
							entries.push({ key: object.key, value: await value.text() });
						}
						cursor = listed.truncated ? listed.cursor : undefined;
					} while (cursor !== undefined);
					return entries;
				},
				read: async (key) => {
					const value = await this.env.CREDENTIALS.get(key);
					return value === null ? null : value.text();
				},
				write: async (key, value) => {
					await this.env.CREDENTIALS.put(key, value);
				},
				remove: async (keys) => {
					if (keys.length > 0) await this.env.CREDENTIALS.delete([...keys]);
				},
			}),
			Account.runtimeLayer({
				setState: async (state) => {
					if (state === 'recovery_required')
						await this.ctx.storage.put(gateKey, 'recovery_required');
					for (const selected of provider === undefined
						? (['claude', 'codex'] as const)
						: [provider])
						await this.ctx.storage.put(stateKey(user, selected), state);
					if (state !== 'recovery_required') await this.ctx.storage.put(gateKey, 'ready');
				},
				stop: async () => {
					await this.destroy();
					this.quotaCache.clear();
				},
				load: async () => {
					const any = await this.env.CREDENTIALS.list({ prefix: 'auths/', limit: 1 });
					if (any.objects.length > 0) await this.startRuntime();
				},
			}),
		);
	}

	private async management(
		path: '/v0/management/auth-files' | '/v0/management/api-call',
		body?: unknown,
	): Promise<unknown> {
		const container = this.ctx.container;
		if (!container?.running || this.busy) throw new Error('Runtime unavailable');
		const response = await container.getTcpPort(this.defaultPort).fetch(
			new Request(`http://cpa.internal${path}`, {
				method: body === undefined ? 'GET' : 'POST',
				headers: {
					authorization: `Bearer ${this.env.CPA_MANAGEMENT_KEY}`,
					'content-type': 'application/json',
				},
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
				signal: AbortSignal.timeout(10_000),
				redirect: 'manual',
			}),
		);
		if (!response.ok) throw new Error('Management unavailable');
		const text = await Effect.runPromise(
			readBody(
				new Request('http://private.response', { method: 'POST', body: response.body }),
				1024 * 1024,
			),
		);
		return JSON.parse(text) as unknown;
	}

	private async quota(
		account: AccountInfo,
		authIndex: string,
	): Promise<Pick<AccountUsage, 'quotaState' | 'windows' | 'observedAt'>> {
		const cached = this.quotaCache.get(authIndex);
		if (cached !== undefined && cached.expires > Date.now()) return cached.usage;
		let usage: Pick<AccountUsage, 'quotaState' | 'windows' | 'observedAt'> = {
			quotaState: 'unavailable',
		};
		try {
			const response = Schema.decodeUnknownSync(QuotaResponse)(
				await this.management('/v0/management/api-call', quotaRequest(account, authIndex)),
			);
			if (response.status_code >= 200 && response.status_code < 300) {
				const observedAt = new Date().toISOString();
				const windows = quotaWindows(
					account.provider,
					JSON.parse(response.body) as unknown,
					observedAt,
				);
				if (windows.length > 0) usage = { quotaState: 'observed', windows, observedAt };
			}
		} catch {}
		if (!this.busy) this.quotaCache.set(authIndex, { expires: Date.now() + 30_000, usage });
		return usage;
	}

	private async status(user: string, includeQuota: boolean): Promise<ProxyStatus> {
		const gate = await this.ctx.storage.get<string>(gateKey);
		const providers = {} as Record<Provider, AccountStatus>;
		const ports = this.ports(user);
		for (const provider of ['claude', 'codex'] as const) {
			const status = await Effect.runPromise(
				readAccount(user, provider).pipe(Effect.provide(ports)),
			);
			const state = await this.ctx.storage.get<Account.GateState>(stateKey(user, provider));
			providers[provider] =
				state === 'recovery_required'
					? AccountStatus.cases.recovery_required.make({ accounts: status.accounts })
					: status;
		}
		const running = this.ctx.container?.running === true;
		const startedAt = running ? await this.ctx.storage.get<string>(startedKey) : undefined;
		if (running && gate !== 'recovery_required') {
			let files: unknown;
			try {
				files = await this.management('/v0/management/auth-files');
			} catch {}
			for (const provider of ['claude', 'codex'] as const) {
				const accounts = await Promise.all(
					providers[provider].accounts.map(async (account) => {
						const metrics = accountMetrics(user, account, files, startedAt);
						if (metrics.authIndex === undefined || !includeQuota) return metrics.account;
						const usage = await this.quota(metrics.account, metrics.authIndex);
						return { ...metrics.account, usage: { ...metrics.account.usage, ...usage } };
					}),
				);
				providers[provider] = { ...providers[provider], accounts };
			}
		}
		return {
			providers,
			runtime: {
				state: gate === 'recovery_required' ? 'recovery_required' : running ? 'running' : 'stopped',
				...(startedAt === undefined
					? {}
					: {
							startedAt,
							uptimeSeconds: Math.max(0, Math.floor((Date.now() - Date.parse(startedAt)) / 1000)),
						}),
			},
			observedAt: new Date().toISOString(),
		};
	}

	private async infer(
		request: Request,
		user: string,
		provider: Provider,
		path: string,
	): Promise<Response> {
		if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
		if (this.busy) return Response.json({ error: 'account_busy' }, { status: 409 });
		try {
			if (
				(await this.ctx.storage.get(stateKey(user, provider))) !== 'saved' ||
				(await this.ctx.storage.get(gateKey)) === 'recovery_required'
			)
				return Response.json({ error: 'account_unavailable' }, { status: 503 });
			this.starting ??= (async () => {
				if (!this.ctx.container?.running) await this.startRuntime();
			})().finally(() => {
				this.starting = null;
			});
			await this.starting;
			if (this.busy) return Response.json({ error: 'account_busy' }, { status: 409 });
			const container = this.ctx.container;
			if (!container?.running)
				return Response.json({ error: 'runtime_unavailable' }, { status: 503 });
			request.signal.throwIfAborted();
			const abort = new AbortController();
			const headers = new Headers(request.headers);
			headers.delete(userHeader);
			headers.set('authorization', `Bearer ${this.env.CPA_API_KEY}`);
			const upstream = new Request(`http://cpa.internal${path}`, {
				method: 'POST',
				headers,
				body: request.body,
				signal: AbortSignal.any([request.signal, abort.signal]),
				redirect: 'manual',
			});
			this.renewActivityTimeout();
			const response = await container.getTcpPort(this.defaultPort).fetch(upstream);
			if (response.body === null) return response;
			const reader = response.body.getReader();
			let released = false;
			const release = () => {
				if (!released) {
					released = true;
					reader.releaseLock();
				}
			};
			const body = new ReadableStream<Uint8Array>({
				pull: async (controller) => {
					try {
						const chunk = await reader.read();
						this.renewActivityTimeout();
						if (chunk.done) {
							release();
							controller.close();
						} else controller.enqueue(chunk.value);
					} catch (error) {
						release();
						controller.error(error);
					}
				},
				cancel: async (reason) => {
					abort.abort();
					try {
						await reader.cancel(reason);
					} finally {
						release();
						this.renewActivityTimeout();
					}
				},
			});
			return new Response(body, response);
		} catch {
			return Response.json({ error: 'runtime_unavailable' }, { status: 503 });
		}
	}

	override async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const user = request.headers.get(userHeader);
		if (url.search) return new Response('Not found', { status: 404 });
		if (user === null || !isUserId(user))
			return Response.json({ error: 'invalid_user' }, { status: 400 });
		const parts = url.pathname.slice(1).split('/');
		const provider = parts[0];
		const upstream = inferencePath(url.pathname);
		if (upstream !== null && isProvider(provider))
			return this.infer(request, user, provider, upstream);
		const selectedId = parts[2];
		const accounts =
			isProvider(provider) &&
			parts[1] === 'accounts' &&
			(parts.length === 2 ||
				(parts.length === 3 &&
					Schema.is(AccountId)(selectedId) &&
					selectedId?.startsWith(`${provider}-`)));
		const all = url.pathname === allAccountsPath;
		const status = url.pathname === '/status';
		if (!accounts && !all && !status) return new Response('Not found', { status: 404 });
		if (
			(status && request.method !== 'GET') ||
			(all && request.method !== 'DELETE') ||
			(accounts &&
				(selectedId === undefined
					? !['GET', 'PUT'].includes(request.method)
					: request.method !== 'DELETE'))
		)
			return new Response('Method not allowed', { status: 405 });
		if (this.busy || this.starting)
			return Response.json({ error: 'account_busy' }, { status: 409 });
		if (status || (accounts && request.method === 'GET')) {
			try {
				this.reading++;
				const result = await this.status(user, status);
				return Response.json(status ? result : result.providers[provider as Provider]);
			} catch {
				return Response.json({ error: 'account_operation_failed' }, { status: 503 });
			} finally {
				this.reading--;
			}
		}
		let credential: Account.Credential | undefined;
		if (request.method === 'PUT' && isProvider(provider)) {
			const body = await Effect.runPromise(
				readBody(request, credentialLimit).pipe(
					Effect.flatMap((text) =>
						Effect.try({
							try: () => JSON.parse(text) as unknown,
							catch: () => new Account.AccountError({ code: 'invalid_credential' }),
						}),
					),
					Effect.flatMap((value) => decodeCredential(value, provider)),
					Effect.match({
						onSuccess: (value) => ({ ok: true as const, value }),
						onFailure: (error) => ({ ok: false as const, error }),
					}),
				),
			);
			if (!body.ok) {
				const tooLarge = body.error instanceof BodyError && body.error.status === 413;
				return Response.json(
					{ error: tooLarge ? 'credential_too_large' : 'invalid_credential' },
					{ status: tooLarge ? 413 : 400 },
				);
			}
			credential = body.value;
		}
		if (this.busy || this.starting || this.reading > 0)
			return Response.json({ error: 'account_busy' }, { status: 409 });
		this.busy = true;
		try {
			const mutation = all
				? removeUserAccounts(user)
				: replaceAccount(
						user,
						provider as Provider,
						credential === undefined ? { id: selectedId! } : { credential },
					);
			return await Effect.runPromise(
				mutation.pipe(
					Effect.provide(this.ports(user, all ? undefined : (provider as Provider))),
					Effect.match({
						onSuccess: (result) => Response.json(result),
						onFailure: () => Response.json({ error: 'account_operation_failed' }, { status: 503 }),
					}),
				),
			);
		} catch {
			return Response.json({ error: 'account_operation_failed' }, { status: 503 });
		} finally {
			this.busy = false;
		}
	}
}
