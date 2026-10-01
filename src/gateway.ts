export * as Gateway from './gateway.ts';

import { Context, Data, Effect, Layer, Option, Schema } from 'effect';

import { AccountId, AccountStatus, credentialLimit, isProvider, type Provider } from './account.ts';
import { isAdministrator, matchesToken, usersPath } from './admin.ts';
import { Digest, type UserId, Users } from './users.ts';

export interface SettingsValue {
	readonly adminDigest: string;
	readonly models: Readonly<Record<Provider, readonly string[]>>;
}

export class Settings extends Context.Service<Settings, SettingsValue>()('proxy/Settings') {}

export class RuntimeUnavailable extends Data.TaggedError('Gateway.RuntimeUnavailable') {}

export interface ForwarderInterface {
	readonly fetch: (request: Request) => Effect.Effect<Response, RuntimeUnavailable>;
}

export class Forwarder extends Context.Service<Forwarder, ForwarderInterface>()(
	'proxy/Forwarder',
) {}

export const inferenceBodyLimit = 8 * 1024 * 1024;

/** Editor-key route for the caller's own Claude account. */
export const accountPath = (provider: Provider): string => `/${provider}/accounts`;
export const allAccountsPath = '/accounts';

/** Set by the gateway after authentication; the Durable Object trusts no other header. */
export const userHeader = 'x-proxy-user';

export function inferencePath(pathname: string): string | null {
	switch (pathname) {
		case '/claude/v1/messages':
			return '/v1/messages';
		case '/claude/v1/messages/count_tokens':
			return '/v1/messages/count_tokens';
		case '/codex/v1/responses':
			return '/v1/responses';
		case '/codex/v1/chat/completions':
			return '/v1/chat/completions';
		default:
			return null;
	}
}

type Route = Data.TaggedEnum<{
	Health: { readonly path: '/healthz' };
	Users: { readonly path: typeof usersPath };
	User: { readonly id: UserId };
	Account: { readonly provider: Provider; readonly id?: string };
	Status: {};
	Models: { readonly provider: Provider };
	Inference: { readonly provider: Provider };
}>;

const Route = Data.taggedEnum<Route>();

/**
 * The Anthropic SDK's beta client appends this marker to inference requests. Beta
 * features travel in the `anthropic-beta` header, so the marker is accepted and dropped.
 */
const betaMarker = '?beta=true';

function route(url: URL): Route | null {
	if (url.search === betaMarker && inferencePath(url.pathname) !== null) {
		return url.pathname.startsWith('/claude/') ? Route.Inference({ provider: 'claude' }) : null;
	}

	if (url.search) return null;

	if (url.pathname === '/healthz') return Route.Health({ path: '/healthz' });

	if (url.pathname === usersPath) return Route.Users({ path: usersPath });

	if (url.pathname.startsWith(`${usersPath}/`)) {
		const id = Schema.decodeUnknownOption(Users.UserId)(url.pathname.slice(usersPath.length + 1));

		return Option.isSome(id) ? Route.User({ id: id.value }) : null;
	}

	if (url.pathname === '/status') return Route.Status();
	const parts = url.pathname.slice(1).split('/');
	const provider = parts[0];
	if (!isProvider(provider)) return null;
	if (parts[1] === 'accounts' && parts.length === 2) return Route.Account({ provider });
	if (
		parts[1] === 'accounts' &&
		parts.length === 3 &&
		Schema.is(AccountId)(parts[2]) &&
		parts[2]?.startsWith(`${provider}-`)
	)
		return Route.Account({ provider, id: parts[2] });
	if (url.pathname === `/${provider}/v1/models`) return Route.Models({ provider });
	if (inferencePath(url.pathname) !== null) return Route.Inference({ provider });

	return null;
}

export class BodyError extends Data.TaggedError('Gateway.BodyError')<{
	readonly status: 400 | 413;
}> {}

const readChunk = (reader: ReadableStreamDefaultReader<Uint8Array>) =>
	Effect.tryPromise({
		try: () => reader.read(),
		catch: () => new BodyError({ status: 400 }),
	});

export const readBody = Effect.fn('Proxy.readBody')(function* (request: Request, limit: number) {
	if (request.body === null) return yield* new BodyError({ status: 400 });
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;

	try {
		while (true) {
			const chunk = yield* readChunk(reader);

			if (chunk.done) break;
			size += chunk.value.byteLength;

			if (size > limit) {
				yield* Effect.promise(() => reader.cancel());

				return yield* new BodyError({ status: 413 });
			}

			chunks.push(chunk.value);
		}
	} finally {
		reader.releaseLock();
	}

	const bytes = new Uint8Array(size);
	let offset = 0;

	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.length;
	}

	return new TextDecoder().decode(bytes);
});

const InferenceEnvelope = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown));

const inferenceBody = Effect.fn('Proxy.inferenceBody')(function* (request: Request) {
	const text = yield* readBody(request, inferenceBodyLimit);

	const envelope = yield* Schema.decodeUnknownEffect(InferenceEnvelope)(text).pipe(
		Effect.mapError(() => new BodyError({ status: 400 })),
	);

	const model = yield* Schema.decodeUnknownEffect(Schema.NonEmptyString)(envelope['model']).pipe(
		Effect.mapError(() => new BodyError({ status: 400 })),
	);

	return { envelope, model };
});

const RegisterBody = Schema.fromJsonString(Schema.Struct({ digest: Digest }));

const anthropicError = (
	status: number,
	type: 'authentication_error' | 'permission_error' | 'invalid_request_error',
	message: string,
) => Response.json({ type: 'error', error: { type, message } }, { status });

const notFound = () => new Response('Not found', { status: 404 });

const methodNotAllowed = () => new Response('Method not allowed', { status: 405 });

const registryUnavailable = () => Response.json({ error: 'registry_unavailable' }, { status: 503 });

/** Resolves the editor key to a user id. Fails closed when the key is ambiguous or administrative. */
const authenticateEditor = Effect.fn('Proxy.editor')(function* (request: Request) {
	const settings = yield* Settings;
	const users = yield* Users.Service;
	const authorization = request.headers.get('authorization');
	const apiKey = request.headers.get('x-api-key');
	const bearer = authorization?.startsWith('Bearer ') ? authorization.slice(7) : null;
	const key = apiKey ?? bearer;

	if (
		key === null ||
		(authorization !== null && bearer === null) ||
		(apiKey !== null && bearer !== null && apiKey !== bearer) ||
		matchesToken(key, settings.adminDigest)
	)
		return Option.none();

	return yield* users
		.find(key)
		.pipe(Effect.catchTag('Users.RegistryError', () => Effect.succeed(Option.none())));
});

const forward = Effect.fn('Proxy.forward')(function* (request: Request) {
	const forwarder = yield* Forwarder;

	const response = yield* forwarder
		.fetch(request)
		.pipe(
			Effect.catchTag('Gateway.RuntimeUnavailable', () =>
				Effect.succeed(Response.json({ error: 'runtime_unavailable' }, { status: 503 })),
			),
		);

	const headers = new Headers(response.headers);
	headers.set('cache-control', 'no-store');

	return new Response(response.body, { status: response.status, headers });
});

const accountRequest = (
	request: Request,
	id: UserId,
	init: { method: 'GET' | 'DELETE' } | { method: 'PUT'; body: string },
	path: string,
) => {
	const url = new URL(request.url);
	url.pathname = path;
	const headers = new Headers({ [userHeader]: id });

	if (init.method === 'PUT') headers.set('content-type', 'application/json');

	return new Request(url.href, { ...init, headers, signal: request.signal });
};

const administerUsers = Effect.fn('Proxy.admin.users')(function* (request: Request) {
	const settings = yield* Settings;

	if (!isAdministrator(request, settings.adminDigest)) {
		return Response.json({ error: 'unauthorized' }, { status: 401 });
	}

	if (request.method !== 'GET') return methodNotAllowed();
	const users = yield* Users.Service;

	const listed = yield* users
		.list()
		.pipe(Effect.catchTag('Users.RegistryError', () => Effect.succeed(null)));

	return listed === null ? registryUnavailable() : Response.json({ users: listed });
});

const administerUser = Effect.fn('Proxy.admin.user')(function* (request: Request, id: UserId) {
	const settings = yield* Settings;

	if (!isAdministrator(request, settings.adminDigest)) {
		return Response.json({ error: 'unauthorized' }, { status: 401 });
	}

	const users = yield* Users.Service;

	if (request.method === 'PUT') {
		const digest = yield* readBody(request, 4096).pipe(
			Effect.flatMap(Schema.decodeUnknownEffect(RegisterBody)),
			Effect.map((body) => body.digest),
			Effect.catch(() => Effect.succeed(null)),
		);

		if (digest === null || digest === settings.adminDigest) {
			return Response.json({ error: 'invalid_digest' }, { status: 400 });
		}

		const registered = yield* users.register(id, digest).pipe(
			Effect.as(true),
			Effect.catchTag('Users.RegistryError', () => Effect.succeed(false)),
		);

		return registered ? Response.json({ id }) : registryUnavailable();
	}

	if (request.method !== 'DELETE') return methodNotAllowed();

	const registered = yield* users
		.has(id)
		.pipe(Effect.catchTag('Users.RegistryError', () => Effect.succeed(null)));

	if (registered === null) return registryUnavailable();

	if (!registered) return Response.json({ error: 'unknown_user' }, { status: 404 });

	// Credential first, registry second. Account deletion is idempotent and read-back confirmed,
	// so if either step fails the user stays registered and the same DELETE resumes the removal;
	// a user who is gone from the registry never has a credential left behind.
	const deleted = yield* forward(
		accountRequest(request, id, { method: 'DELETE' }, allAccountsPath),
	);

	if (!deleted.ok) return deleted;
	const confirmed = yield* Effect.tryPromise({
		try: () => deleted.clone().json(),
		catch: () => null,
	}).pipe(
		Effect.flatMap(Schema.decodeUnknownEffect(AccountStatus)),
		Effect.catch(() => Effect.succeed(null)),
	);
	if (confirmed?.state !== 'disconnected' || confirmed.accounts.length !== 0)
		return Response.json({ error: 'account_operation_failed' }, { status: 503 });

	const removed = yield* users
		.remove(id)
		.pipe(Effect.catchTag('Users.RegistryError', () => Effect.succeed(null)));

	if (removed === null) return registryUnavailable();

	return deleted;
});

const handleAccount = Effect.fn('Proxy.account')(function* (
	request: Request,
	id: UserId,
	provider: Provider,
	selectedId?: string,
) {
	const path =
		selectedId === undefined ? accountPath(provider) : `${accountPath(provider)}/${selectedId}`;
	if (selectedId !== undefined)
		return request.method === 'DELETE'
			? yield* forward(accountRequest(request, id, { method: 'DELETE' }, path))
			: methodNotAllowed();
	if (request.method === 'GET')
		return yield* forward(accountRequest(request, id, { method: 'GET' }, path));
	if (request.method !== 'PUT') return methodNotAllowed();

	const body = yield* readBody(request, credentialLimit).pipe(
		Effect.catchTag('Gateway.BodyError', (error) => Effect.succeed(error)),
	);

	if (body instanceof BodyError) {
		return Response.json(
			{ error: body.status === 413 ? 'credential_too_large' : 'invalid_credential' },
			{ status: body.status },
		);
	}

	return yield* forward(accountRequest(request, id, { method: 'PUT', body }, path));
});

const handleModels = Effect.fn('Proxy.models')(function* (provider: Provider) {
	const settings = yield* Settings;
	const models = settings.models[provider];
	if (provider === 'codex')
		return Response.json(
			{
				object: 'list',
				data: models.map((id) => ({ id, object: 'model', created: 0, owned_by: 'openai' })),
			},
			{ headers: { 'cache-control': 'no-store' } },
		);
	return Response.json(
		{
			data: models.map((model) => ({
				id: model,
				type: 'model',
				display_name: model,
				created_at: '1970-01-01T00:00:00Z',
			})),
			first_id: models[0] ?? null,
			last_id: models.at(-1) ?? null,
			has_more: false,
		},
		{ headers: { 'cache-control': 'no-store' } },
	);
});

const handleInference = Effect.fn('Proxy.inference')(function* (
	request: Request,
	id: UserId,
	provider: Provider,
) {
	const settings = yield* Settings;

	const decoded = yield* inferenceBody(request).pipe(
		Effect.catchTag('Gateway.BodyError', (error) => Effect.succeed(error)),
	);

	if (decoded instanceof BodyError) {
		return anthropicError(
			decoded.status,
			'invalid_request_error',
			decoded.status === 413 ? 'Request body exceeds 8 MiB' : 'Invalid JSON or missing model',
		);
	}

	if (!settings.models[provider].includes(decoded.model)) {
		return anthropicError(403, 'permission_error', 'Model is not allowed');
	}

	const headers = new Headers({ 'content-type': 'application/json', [userHeader]: id });

	for (const name of [
		'anthropic-version',
		'anthropic-beta',
		'accept',
		'openai-beta',
		'x-session-id',
		'x-claude-code-session-id',
		'session-id',
		'session_id',
		'thread-id',
		'x-codex-turn-metadata',
	]) {
		const value = request.headers.get(name);

		if (value !== null) headers.set(name, value);
	}

	// CPA routes `<user>/<model>` to that user's credential.
	const body = JSON.stringify({ ...decoded.envelope, model: `${id}/${decoded.model}` });
	const url = new URL(request.url);
	url.search = '';

	return yield* forward(
		new Request(url.href, { method: 'POST', headers, body, signal: request.signal }),
	);
});

export const handleRequest = Effect.fn('Proxy.request')(function* (request: Request) {
	const target = route(new URL(request.url));

	if (target === null) return notFound();

	return yield* Route.$match(target, {
		Health: () =>
			Effect.succeed(
				request.method === 'GET' ? Response.json({ status: 'ok' }) : methodNotAllowed(),
			),
		Users: () => administerUsers(request),
		User: ({ id }) => administerUser(request, id),
		Account: ({ provider, id: selectedId }) =>
			Effect.gen(function* () {
				const id = yield* authenticateEditor(request);

				if (Option.isNone(id))
					return anthropicError(401, 'authentication_error', 'Invalid editor key');

				return yield* handleAccount(request, id.value, provider, selectedId);
			}),
		Status: () =>
			Effect.gen(function* () {
				const id = yield* authenticateEditor(request);
				if (Option.isNone(id))
					return anthropicError(401, 'authentication_error', 'Invalid editor key');
				if (request.method !== 'GET') return methodNotAllowed();
				return yield* forward(accountRequest(request, id.value, { method: 'GET' }, '/status'));
			}),
		Models: ({ provider }) =>
			Effect.gen(function* () {
				const id = yield* authenticateEditor(request);

				if (Option.isNone(id))
					return anthropicError(401, 'authentication_error', 'Invalid editor key');

				if (request.method !== 'GET') return methodNotAllowed();

				return yield* handleModels(provider);
			}),
		Inference: ({ provider }) =>
			Effect.gen(function* () {
				const id = yield* authenticateEditor(request);

				if (Option.isNone(id))
					return anthropicError(401, 'authentication_error', 'Invalid editor key');

				if (request.method !== 'POST') return methodNotAllowed();

				return yield* handleInference(request, id.value, provider);
			}),
	});
});

export const layer = <UsersOut>(
	settings: SettingsValue,
	users: Layer.Layer<UsersOut>,
	fetch: (request: Request) => Promise<Response>,
): Layer.Layer<Settings | UsersOut | Forwarder> =>
	Layer.mergeAll(
		Layer.succeed(Settings, Settings.of(settings)),
		users,
		Layer.succeed(
			Forwarder,
			Forwarder.of({
				fetch: Effect.fn('Proxy.forwarder')(function* (request: Request) {
					return yield* Effect.tryPromise({
						try: () => fetch(request),
						catch: () => new RuntimeUnavailable(),
					});
				}),
			}),
		),
	);
