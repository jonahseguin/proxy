export * as Account from './account.ts';

import { createHash } from 'node:crypto';

import { Context, Data, Effect, Layer, Schema } from 'effect';

export const Provider = Schema.Literals(['claude', 'codex']);
export type Provider = typeof Provider.Type;
export const isProvider = Schema.is(Provider);
export const credentialLimit = 64 * 1024;

const Expiry = Schema.String.check(
	Schema.isPattern(/^\d{4}-\d{2}-\d{2}T/),
	Schema.makeFilter((value) => Number.isFinite(Date.parse(value))),
);
const common = {
	prefix: Schema.optionalKey(Schema.String),
	access_token: Schema.NonEmptyString,
	refresh_token: Schema.NonEmptyString,
	expired: Expiry,
	email: Schema.NonEmptyString,
	last_refresh: Schema.optionalKey(Schema.String),
};
export const ClaudeCredential = Schema.Struct({
	...common,
	type: Schema.Literal('claude'),
	id_token: Schema.optionalKey(Schema.String),
	account_uuid: Schema.NonEmptyString,
	organization_uuid: Schema.NonEmptyString,
	organization_name: Schema.optionalKey(Schema.String),
	claude_device_ids: Schema.optionalKey(Schema.Array(Schema.String)),
});
export type ClaudeCredential = typeof ClaudeCredential.Type;
export const CodexCredential = Schema.Struct({
	...common,
	type: Schema.Literal('codex'),
	id_token: Schema.NonEmptyString,
	account_id: Schema.NonEmptyString,
});
export type CodexCredential = typeof CodexCredential.Type;
export const Credential = Schema.Union([ClaudeCredential, CodexCredential]);
export type Credential = typeof Credential.Type;
export const AccountId = Schema.String.check(Schema.isPattern(/^(claude|codex)-[a-f0-9]{32}$/));
export const AccountIdentity = Schema.Struct({
	id: AccountId,
	provider: Provider,
	email: Schema.String,
	accessTokenExpiresAt: Schema.String,
	accountId: Schema.optionalKey(Schema.String),
	organizationId: Schema.optionalKey(Schema.String),
	organizationName: Schema.optionalKey(Schema.String),
});
export type AccountIdentity = typeof AccountIdentity.Type;
export const AccountHealth = Schema.Struct({
	state: Schema.Literals(['ready', 'disabled', 'unavailable', 'unknown']),
	retryAt: Schema.optionalKey(Schema.String),
});
export const UsageWindow = Schema.Struct({
	name: Schema.String,
	usedPercent: Schema.Number,
	resetAt: Schema.optionalKey(Schema.String),
});
export const AccountUsage = Schema.Struct({
	state: Schema.Literals(['observed', 'unavailable']),
	quotaState: Schema.Literals(['observed', 'unavailable']),
	success: Schema.optionalKey(Schema.Number),
	failed: Schema.optionalKey(Schema.Number),
	countsSince: Schema.optionalKey(Schema.String),
	quota: Schema.optionalKey(
		Schema.Struct({
			observedAt: Schema.String,
			signals: Schema.Record(Schema.String, Schema.String),
		}),
	),
	windows: Schema.optionalKey(Schema.Array(UsageWindow)),
	observedAt: Schema.optionalKey(Schema.String),
});
export type AccountUsage = typeof AccountUsage.Type;
export const AccountInfo = Schema.Struct({
	...AccountIdentity.fields,
	health: AccountHealth,
	usage: AccountUsage,
});
export type AccountInfo = typeof AccountInfo.Type;
export const AccountStatus = Schema.Union([
	Schema.Struct({ state: Schema.tag('disconnected'), accounts: Schema.Array(AccountInfo) }),
	Schema.Struct({ state: Schema.tag('recovery_required'), accounts: Schema.Array(AccountInfo) }),
	Schema.Struct({ state: Schema.tag('saved'), accounts: Schema.Array(AccountInfo) }),
]).pipe(Schema.toTaggedUnion('state'));
export type AccountStatus = typeof AccountStatus.Type;
export const ProxyStatus = Schema.Struct({
	providers: Schema.Struct({ claude: AccountStatus, codex: AccountStatus }),
	runtime: Schema.Struct({
		state: Schema.Literals(['running', 'stopped', 'recovery_required']),
		startedAt: Schema.optionalKey(Schema.String),
		uptimeSeconds: Schema.optionalKey(Schema.Number),
	}),
	observedAt: Schema.String,
});
export type ProxyStatus = typeof ProxyStatus.Type;

export const accountId = (credential: Credential): string => {
	const identity =
		credential.type === 'claude'
			? [credential.account_uuid, credential.organization_uuid]
			: credential.account_id;
	return `${credential.type}-${createHash('sha256')
		.update(JSON.stringify([credential.type, identity]))
		.digest('hex')
		.slice(0, 32)}`;
};
export const credentialPrefix = (user: string, provider?: Provider): string =>
	`auths/${user}__${provider === undefined ? '' : `${provider}__`}`;
export const credentialKey = (user: string, provider: Provider, id: string): string =>
	`${credentialPrefix(user, provider)}${id}.json`;

export class AccountError extends Data.TaggedError('AccountError')<{
	readonly code: 'invalid_credential' | 'storage_failed' | 'runtime_failed';
}> {}
export const decodeCredential = Effect.fn('Account.decode')(function* (
	value: unknown,
	provider: Provider,
) {
	const credential = yield* Schema.decodeUnknownEffect(Credential)(value).pipe(
		Effect.mapError(() => new AccountError({ code: 'invalid_credential' })),
	);
	if (credential.type !== provider) return yield* new AccountError({ code: 'invalid_credential' });
	return credential;
});
export interface StoredCredential {
	readonly key: string;
	readonly value: string;
}
export interface StorageInterface {
	readonly list: () => Effect.Effect<readonly StoredCredential[], AccountError>;
	readonly read: (key: string) => Effect.Effect<string | null, AccountError>;
	readonly write: (key: string, value: string) => Effect.Effect<void, AccountError>;
	readonly remove: (keys: readonly string[]) => Effect.Effect<void, AccountError>;
}
export class Storage extends Context.Service<Storage, StorageInterface>()('proxy/AccountStorage') {}
export type GateState = 'saved' | 'disconnected' | 'recovery_required';
export interface RuntimeInterface {
	readonly setState: (state: GateState) => Effect.Effect<void, AccountError>;
	readonly stop: () => Effect.Effect<void, AccountError>;
	readonly load: () => Effect.Effect<void, AccountError>;
}
export class Runtime extends Context.Service<Runtime, RuntimeInterface>()('proxy/AccountRuntime') {}
const attempt = <A>(code: AccountError['code'], work: () => Promise<A>) =>
	Effect.tryPromise({ try: work, catch: () => new AccountError({ code }) });
export const storageLayer = (port: {
	list(): Promise<readonly StoredCredential[]>;
	read(key: string): Promise<string | null>;
	write(key: string, value: string): Promise<void>;
	remove(keys: readonly string[]): Promise<void>;
}): Layer.Layer<Storage> =>
	Layer.succeed(
		Storage,
		Storage.of({
			list: () => attempt('storage_failed', () => port.list()),
			read: (key) => attempt('storage_failed', () => port.read(key)),
			write: (key, value) => attempt('storage_failed', () => port.write(key, value)),
			remove: (keys) => attempt('storage_failed', () => port.remove(keys)),
		}),
	);
export const runtimeLayer = (port: {
	setState(state: GateState): Promise<void>;
	stop(): Promise<void>;
	load(): Promise<void>;
}): Layer.Layer<Runtime> =>
	Layer.succeed(
		Runtime,
		Runtime.of({
			setState: (state) => attempt('storage_failed', () => port.setState(state)),
			stop: () => attempt('runtime_failed', () => port.stop()),
			load: () => attempt('runtime_failed', () => port.load()),
		}),
	);
const safeIdentity = (credential: Credential): AccountInfo => ({
	id: accountId(credential),
	provider: credential.type,
	email: credential.email,
	accessTokenExpiresAt: credential.expired,
	...(credential.type === 'claude'
		? {
				...(credential.account_uuid === undefined ? {} : { accountId: credential.account_uuid }),
				organizationId: credential.organization_uuid,
				...(credential.organization_name === undefined
					? {}
					: { organizationName: credential.organization_name }),
			}
		: { accountId: credential.account_id }),
	health: { state: 'unknown' },
	usage: { state: 'unavailable', quotaState: 'unavailable' },
});
export const readAccount = Effect.fn('Account.read')(function* (user: string, provider: Provider) {
	const storage = yield* Storage;
	const entries = yield* storage.list();
	const accounts: AccountInfo[] = [];
	for (const entry of entries) {
		if (!entry.key.startsWith(credentialPrefix(user, provider))) continue;
		const credential = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Credential))(
			entry.value,
		).pipe(Effect.mapError(() => new AccountError({ code: 'storage_failed' })));
		if (
			credential.type !== provider ||
			credential.prefix !== user ||
			entry.key !== credentialKey(user, provider, accountId(credential))
		)
			return yield* new AccountError({ code: 'storage_failed' });
		accounts.push(safeIdentity(credential));
	}
	accounts.sort((a, b) => a.id.localeCompare(b.id));
	return accounts.length === 0
		? AccountStatus.cases.disconnected.make({ accounts })
		: AccountStatus.cases.saved.make({ accounts });
});
export type AccountMutation =
	| { readonly credential: Credential }
	| { readonly id: string }
	| { readonly clear: true };
export const replaceAccount = Effect.fn('Account.replace')(function* (
	user: string,
	provider: Provider,
	mutation: AccountMutation,
) {
	const storage = yield* Storage;
	const runtime = yield* Runtime;
	yield* runtime.setState('recovery_required');
	yield* runtime.stop();
	if ('credential' in mutation) {
		if (mutation.credential.type !== provider)
			return yield* new AccountError({ code: 'invalid_credential' });
		const value = JSON.stringify({ ...mutation.credential, prefix: user });
		const key = credentialKey(user, provider, accountId(mutation.credential));
		yield* storage.write(key, value);
		if ((yield* storage.read(key)) !== value)
			return yield* new AccountError({ code: 'storage_failed' });
	} else {
		const keys =
			'clear' in mutation
				? (yield* storage.list())
						.filter((entry) => entry.key.startsWith(credentialPrefix(user, provider)))
						.map((entry) => entry.key)
				: [credentialKey(user, provider, mutation.id)];
		yield* storage.remove(keys);
		for (const key of keys)
			if ((yield* storage.read(key)) !== null)
				return yield* new AccountError({ code: 'storage_failed' });
		if (
			'clear' in mutation &&
			(yield* storage.list()).some((entry) =>
				entry.key.startsWith(credentialPrefix(user, provider)),
			)
		)
			return yield* new AccountError({ code: 'storage_failed' });
	}
	const status = yield* readAccount(user, provider);
	yield* runtime.load();
	yield* runtime.setState(status.state);
	return status;
});

export const removeUserAccounts = Effect.fn('Account.removeUser')(function* (user: string) {
	const storage = yield* Storage;
	const runtime = yield* Runtime;
	yield* runtime.setState('recovery_required');
	yield* runtime.stop();
	const keys = (yield* storage.list())
		.filter((entry) => entry.key.startsWith(credentialPrefix(user)))
		.map((entry) => entry.key);
	yield* storage.remove(keys);
	for (const key of keys)
		if ((yield* storage.read(key)) !== null)
			return yield* new AccountError({ code: 'storage_failed' });
	if ((yield* storage.list()).some((entry) => entry.key.startsWith(credentialPrefix(user))))
		return yield* new AccountError({ code: 'storage_failed' });
	yield* runtime.load();
	yield* runtime.setState('disconnected');
	return AccountStatus.cases.disconnected.make({ accounts: [] });
});
