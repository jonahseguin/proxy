import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import { Data, Effect, Schema } from 'effect';

import { deployment } from '../deployment.ts';
import {
	AccountId,
	AccountStatus,
	ProxyStatus,
	credentialLimit,
	decodeCredential,
	type Provider as AccountProvider,
} from '../src/account.ts';
import { adminDigest, adminOrigin, usersPath } from '../src/admin.ts';
import { isDigest, isUserId } from '../src/users.ts';
import type { WorkerSecret } from './cloudflare.ts';
import { type Host, locateCpa } from './cpa.ts';

export interface Choice<Value extends string> {
	value: Value;
	label: string;
	hint?: string;
}

export interface Spinner {
	message(line: string): void;
	stop(line: string): void;
	error(line: string): void;
}

/**
 * Everything the guided flow shows or asks. Interactive sessions render menus
 * and spinners; piped sessions take the first choice, read secrets from stdin,
 * and answer confirmations with no.
 */
export interface Terminal {
	intro(title: string): void;
	outro(message: string): void;
	/** A completed step. */
	step(line: string): void;
	/** Context or a warning that is not a step. */
	info(line: string): void;
	/** A boxed block, such as settings to copy into another program. */
	note(body: string, title: string): void;
	select<Value extends string>(message: string, choices: readonly Choice<Value>[]): Promise<Value>;
	/** Reads a secret without echoing it. */
	password(message: string): Promise<string>;
	confirm(message: string): Promise<boolean>;
	spinner(message: string): Spinner;
	/** Copies a value to the clipboard; false when no clipboard is available. */
	clipboard(value: string): Promise<boolean>;
}

export interface CliDependencies {
	secrets: {
		get(options: { service: string; name: string }): Promise<string | null>;
		set(options: { service: string; name: string; value: string }): Promise<void>;
	};
	fetch(url: string, init: RequestInit): Promise<Response>;
	terminal: Terminal;
	host: Host;
	loginEnvironment: Record<string, string | undefined>;
	/** Writes the digest to the Worker declared in `deployment.ts`. */
	syncDigest(input: WorkerSecret): Promise<void>;
}

/**
 * Account providers the proxy can route to. The Worker serves each under
 * `<basePath>/accounts` and `<basePath>/v1/...`; CPA owns the browser login.
 */
export const providers = {
	claude: {
		label: 'Claude',
		hint: 'Anthropic account, signed in through the browser',
		basePath: '/claude',
		loginFlag: '--claude-login',
		editorPath: '/claude',
		apiFormat: 'anthropic-messages',
		formatLabel: 'Anthropic Messages',
	},
	codex: {
		label: 'ChatGPT / Codex',
		hint: 'ChatGPT subscription, signed in through the browser',
		basePath: '/codex',
		editorPath: '/codex/v1',
		loginFlag: '--codex-login',
		apiFormat: 'openai-responses',
		formatLabel: 'OpenAI Responses',
	},
} as const;

export type ProviderId = keyof typeof providers;

type Provider = (typeof providers)[ProviderId];

const accountUrl = (origin: string, provider: Provider) => `${origin}${provider.basePath}/accounts`;

const modelsUrl = (origin: string, provider: Provider) => `${origin}${provider.basePath}/v1/models`;

/** Amp names models `<vendor>/<model>`; this is the vendor for each provider's models. */
const ampVendors = { claude: 'anthropic', codex: 'openai' } satisfies Record<ProviderId, string>;

const ampMappings = (provider: ProviderId, models: readonly string[]) =>
	models.map((model) => `${ampVendors[provider]}/${model} -> ${model}`);

/** pi's `api` value for each provider's wire format. */
const piApis = { claude: 'anthropic-messages', codex: 'openai-responses' } satisfies Record<
	ProviderId,
	string
>;

/**
 * Model limits pi applies client-side; the proxy does not report them. Without
 * these pi assumes 128k context and 16k output, compacts early, and truncates.
 * Measured against the current allowlist by sending an oversized prompt and
 * `max_tokens`: the provider's error names each maximum. Re-measure when
 * `CLAUDE_MODELS` changes.
 */
const piLimits = {
	claude: { contextWindow: 1_000_000, maxTokens: 128_000 },
	codex: {},
} satisfies Record<ProviderId, { contextWindow?: number; maxTokens?: number }>;

/**
 * The provider block for `~/.pi/agent/models.json`. The key is read by running
 * `proxy editor key`, so the file never contains it.
 */
const piConfig = (origin: string, provider: ProviderId, models: readonly string[]) =>
	JSON.stringify(
		{
			providers: {
				[`${provider}-proxy`]: {
					baseUrl: `${origin}${providers[provider].editorPath}`,
					api: piApis[provider],
					apiKey: `!proxy editor key ${origin}`,
					models: models.map((id) => ({
						id,
						reasoning: true,
						input: ['text', 'image'],
						...piLimits[provider],
					})),
				},
			},
		},
		null,
		2,
	);

/**
 * Editors that can point at the proxy. `setup` is the settings a person types
 * in; `prompt` is text they paste into the editor's agent so it does the setup.
 * `key` says how the editor gets the key: `pasted` into its settings (so join
 * offers to show it), or `command`, read by running `proxy editor key` at
 * startup (so nobody needs it in hand).
 */
export const editors = {
	amp: {
		label: 'Amp',
		hint: 'ampcode.com',
		key: 'pasted',
		setup: (origin: string, provider: ProviderId, models: readonly string[]) =>
			[
				'Settings > Model Routing > add a Custom URL connection:',
				`  Base URL  ${origin}${providers[provider].editorPath}`,
				`  API format ${providers[provider].formatLabel}`,
				'  API key   your editor key',
				`  Models    ${models.length === 0 ? 'none configured' : models.join(', ')}`,
				...(models.length === 0
					? []
					: ['  Mappings', ...ampMappings(provider, models).map((mapping) => `    ${mapping}`)]),
			].join('\n'),
		prompt: (origin: string, provider: ProviderId, models: readonly string[]) =>
			[
				`Set up Amp to use my ${providers[provider].label} proxy.`,
				'',
				'1. In Model Routing (https://ampcode.com/settings/model-routing) add a Custom URL connection:',
				`   - Name: ${provider}-proxy`,
				`   - API format: ${providers[provider].formatLabel}`,
				`   - Base URL: ${origin}${providers[provider].editorPath}`,
				`   - Models: ${models.length === 0 ? 'ask me' : models.join(', ')}`,
				...(models.length === 0
					? []
					: [
							'   - Mappings:',
							...ampMappings(provider, models).map((mapping) => `     - ${mapping}`),
						]),
				'2. The API key is my editor key. Ask me for it through a masked prompt. Never print it,',
				`   store it in the thread, or ask me to paste it in chat. I get it with: proxy editor key ${origin}`,
				`3. Verify: GET ${modelsUrl(origin, providers[provider])} with the key returns 200 and lists`,
				'   the models above; then send a one-word message to each model and confirm it answers.',
				'4. Ask which modes should use these models and pin them under Settings > Mode Dial > Tune Modes.',
			].join('\n'),
	},
	pi: {
		label: 'pi',
		hint: 'pi.dev',
		key: 'command',
		setup: (origin: string, provider: ProviderId, models: readonly string[]) =>
			[
				'Merge this into ~/.pi/agent/models.json (create it if missing):',
				...piConfig(origin, provider, models)
					.split('\n')
					.map((line) => `  ${line}`),
				'The apiKey runs `proxy editor key`, which needs `bun link` in this repository.',
				'Without it, put "$PROXY_EDITOR_KEY" there and export that variable instead.',
				...(models.length === 0
					? []
					: [`Then run: pi --provider ${provider}-proxy --model ${models[0]}`]),
			].join('\n'),
		prompt: (origin: string, provider: ProviderId, models: readonly string[]) =>
			[
				`Set up pi to use my ${providers[provider].label} proxy.`,
				'',
				'1. Merge this provider into ~/.pi/agent/models.json. Create the file if it is missing;',
				'   keep every other provider and model already in it.',
				...piConfig(origin, provider, models)
					.split('\n')
					.map((line) => `   ${line}`),
				`2. The apiKey runs the \`proxy\` command. Check that \`proxy editor key ${origin}\` works`,
				'   without printing its output. If the command is missing, replace the apiKey value with',
				'   "$PROXY_EDITOR_KEY" and tell me to export that variable; never ask me to paste the key',
				'   in chat, never print it, and never store it in the thread or in the file.',
				...(models.length === 0
					? []
					: [
							`3. Verify: send a one-word message to each of ${models.join(', ')} through the`,
							`   ${provider}-proxy provider and confirm it answers.`,
						]),
			].join('\n'),
	},
} as const;

export type EditorId = keyof typeof editors;

type MenuRow = { readonly label: string; readonly hint: string };

function choices(table: typeof providers): Choice<ProviderId>[];
function choices(table: typeof editors): Choice<EditorId>[];
function choices(table: Record<string, MenuRow>): Choice<string>[] {
	return Object.entries(table).map(([value, { label, hint }]) => ({
		value,
		label,
		hint,
	}));
}

export class CliError extends Data.TaggedError('CliError')<{ readonly message: string }> {}

export const usage = [
	'Usage: proxy join <origin>',
	'       proxy admin <init|rotate|digest> <origin>',
	'       proxy admin sync <origin>',
	'       proxy admin user list <origin>',
	'       proxy admin user <add|rotate|key|remove> <origin> <user-id>',
	'       proxy editor <login|key> <origin>',
	'       proxy status <origin>',
	'       proxy <claude|codex> <connect|status|list> <origin>',
	'       proxy <claude|codex> disconnect <origin> <account-id>',
].join('\n');

const services = {
	admin: 'jonah.proxy.admin',
	editor: 'jonah.proxy.editor',
	user: (id: string) => `jonah.proxy.user.${id}`,
};

const fail = (message: string) => Effect.fail(new CliError({ message }));

const newToken = () =>
	Array.from(randomBytes(32), (byte) => byte.toString(16).padStart(2, '0')).join('');

export const loginLocally = Effect.fn('CLI.login')(function* (
	binary: string,
	environment: Record<string, string | undefined>,
	providerId: ProviderId,
) {
	if (!isAbsolute(binary))
		return yield* fail('Provide the absolute path to the CLIProxyAPI binary.');

	return yield* Effect.tryPromise({
		try: async (signal) => {
			const directory = await mkdtemp(join(tmpdir(), 'proxy-login-'));

			try {
				const authDirectory = join(directory, 'auths');
				await mkdir(authDirectory, { mode: 0o700 });
				const config = join(directory, 'config.yaml');
				await writeFile(
					config,
					`auth-dir: ${JSON.stringify(authDirectory)}\nrequest-log: false\nlogging-to-file: false\n`,
					{ mode: 0o600 },
				);
				const env: Record<string, string | undefined> = {};

				for (const key of [
					'PATH',
					'HOME',
					'USER',
					'LANG',
					'DISPLAY',
					'WAYLAND_DISPLAY',
					'DBUS_SESSION_BUS_ADDRESS',
				]) {
					if (environment[key] !== undefined) env[key] = environment[key];
				}

				await new Promise<void>((resolve, reject) => {
					const child = spawn(binary, [providers[providerId].loginFlag, '--config', config], {
						cwd: directory,
						env,
						stdio: 'inherit',
						signal,
						timeout: 360_000,
						killSignal: 'SIGKILL',
					});

					child.once('error', reject);
					child.once('exit', (code) => {
						if (code === 0) resolve();
						else reject(new Error('Login process failed'));
					});
				});
				const files = (await readdir(authDirectory)).filter((name) => name.endsWith('.json'));
				const [file] = files;

				if (files.length !== 1 || file === undefined)
					throw new Error('Login produced no unique credential');
				const path = join(authDirectory, file);

				if ((await stat(path)).size > credentialLimit) throw new Error('Credential too large');
				const value: unknown = JSON.parse(await readFile(path, 'utf8'));

				return value;
			} finally {
				await rm(directory, { recursive: true, force: true });
			}
		},
		catch: () =>
			new CliError({
				message: `${providers[providerId].label} login failed or produced no valid credential. Nothing was uploaded.`,
			}),
	}).pipe(
		Effect.flatMap((value) => decodeCredential(value, providerId)),
		Effect.mapError(
			() =>
				new CliError({
					message: `${providers[providerId].label} login failed or produced no valid credential. Nothing was uploaded.`,
				}),
		),
	);
});

const readToken = (dependencies: CliDependencies, service: string, origin: string) =>
	Effect.tryPromise({
		try: () => dependencies.secrets.get({ service, name: origin }),
		catch: () => new CliError({ message: 'Could not read the OS credential store.' }),
	});

const saveToken = (dependencies: CliDependencies, service: string, origin: string, value: string) =>
	Effect.tryPromise({
		try: () => dependencies.secrets.set({ service, name: origin, value }),
		catch: () => new CliError({ message: 'Could not save the key in the OS credential store.' }),
	});

interface ProxyInit {
	method?: string;
	body?: string | undefined;
}

/** One proxy request with a bounded wait. The caller decides what a non-2xx status means. */
const proxyRequest = (
	dependencies: CliDependencies,
	url: string,
	bearer: string,
	init: ProxyInit = {},
) =>
	Effect.tryPromise({
		try: (signal) =>
			dependencies.fetch(url, {
				method: init.method ?? 'GET',
				headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
				body: init.body,
				redirect: 'error',
				signal,
			}),
		catch: () => 'failed',
	}).pipe(
		Effect.timeout('90 seconds'),
		Effect.mapError(
			() =>
				new CliError({
					message:
						'Proxy request failed. Remote state is unconfirmed; check status before retrying.',
				}),
		),
	);

const decodeJson = <S extends Schema.Top>(schema: S) =>
	Effect.fn(function* (response: Response) {
		const json: unknown = yield* Effect.tryPromise({
			try: () => response.json(),
			catch: () => new CliError({ message: 'Proxy returned an invalid response.' }),
		});

		return yield* Schema.decodeUnknownEffect(schema)(json).pipe(
			Effect.mapError(() => new CliError({ message: 'Proxy returned an invalid response.' })),
		);
	});

const describeAccount = (status: AccountStatus, providerId: ProviderId) => {
	const label = providers[providerId].label;
	const lines = status.accounts.map((account) => {
		const organization = account.organizationName
			? `${account.organizationName}${account.organizationId ? ` (${account.organizationId})` : ''}`
			: account.organizationId;
		const details = [
			`${account.id}: ${account.email}${organization ? ` — ${organization}` : ''}${account.accountId ? ` (account ${account.accountId})` : ''}`,
			`  Health: ${account.health.state}${account.health.retryAt ? `; retry after ${account.health.retryAt}` : ''}`,
			`  Access token expires: ${account.accessTokenExpiresAt}`,
		];
		if (account.usage.success !== undefined || account.usage.failed !== undefined)
			details.push(
				`  Requests${account.usage.countsSince ? ` since ${account.usage.countsSince}` : ''}: ${account.usage.success ?? 'unknown'} succeeded, ${account.usage.failed ?? 'unknown'} failed`,
			);
		if (account.usage.windows && account.usage.windows.length > 0) {
			for (const window of account.usage.windows)
				details.push(
					`  ${window.name}: ${window.usedPercent}% used${window.resetAt ? `; resets ${window.resetAt}` : ''}`,
				);
		} else details.push('  Subscription quota: unavailable');
		if (account.usage.observedAt) details.push(`  Usage checked: ${account.usage.observedAt}`);
		return details.join('\n');
	});
	if (status.state === 'recovery_required')
		lines.unshift(`${label}: account update incomplete. Reconnect or retry disconnect.`);
	else
		lines.unshift(
			`${label}: ${status.accounts.length === 0 ? 'no connected accounts.' : `${status.accounts.length} connected account(s).`}`,
		);
	return lines.join('\n');
};

const statusCommand = Effect.fn('CLI.status')(function* (
	dependencies: CliDependencies,
	origin: string,
) {
	const token = yield* readToken(dependencies, services.editor, origin);
	if (token === null) return yield* fail('Run editor login first.');
	const response = yield* proxyRequest(dependencies, `${origin}/status`, token);
	if (!response.ok) return yield* fail(`Proxy rejected status (HTTP ${response.status}).`);
	const status = yield* decodeJson(ProxyStatus)(response);
	return [
		`Proxy: ${status.runtime.state}`,
		`Uptime: ${status.runtime.uptimeSeconds === undefined ? 'unavailable' : `${Math.floor(status.runtime.uptimeSeconds / 3600)}h ${Math.floor((status.runtime.uptimeSeconds % 3600) / 60)}m ${status.runtime.uptimeSeconds % 60}s`}${status.runtime.startedAt ? `; started ${status.runtime.startedAt}` : ''}`,
		`Checked: ${status.observedAt}`,
		describeAccount(status.providers.claude, 'claude'),
		describeAccount(status.providers.codex, 'codex'),
	].join('\n\n');
});

const adminCommand = Effect.fn('CLI.admin')(function* (
	dependencies: CliDependencies,
	command: string,
	origin: string,
) {
	let token = yield* readToken(dependencies, services.admin, origin);

	if (command === 'rotate' || (command === 'init' && token === null)) {
		token = newToken();
		yield* saveToken(dependencies, services.admin, origin, token);
	}

	if (token === null) return yield* fail('Run admin init first.');
	const digest = adminDigest(token);

	if (command === 'digest') return digest;

	if (command === 'sync') {
		yield* Effect.tryPromise({
			try: () => dependencies.syncDigest({ digest, name: 'ADMIN_TOKEN_SHA256' }),
			catch: () =>
				new CliError({
					message:
						'Key sync failed. Check the cf login and deployment.ts. The remote state is unconfirmed; retry sync with the same stored key.',
				}),
		});

		const accepted = yield* proxyRequest(dependencies, `${origin}${usersPath}`, token).pipe(
			Effect.flatMap((response) =>
				response.ok
					? decodeJson(Schema.Struct({ users: Schema.Array(Schema.String) }))(response).pipe(
							Effect.as(true),
						)
					: Effect.succeed(false),
			),
			Effect.mapError(
				() =>
					new CliError({
						message:
							'Digest updated, but the deployed key check failed. Keep the stored key and retry sync; do not rotate again.',
					}),
			),
		);

		if (!accepted)
			return yield* fail(
				`Digest updated, but ${origin} has not accepted the key. Confirm that origin is served by the Worker in deployment.ts, keep the stored key, and retry sync after propagation.`,
			);

		return `Administrator key synced and accepted by ${origin}.`;
	}

	return `Administrator key saved in the OS credential store.\nSet Cloudflare secret ADMIN_TOKEN_SHA256 to:\n${digest}\nNo remote configuration was changed.`;
});

const userCommand = Effect.fn('CLI.user')(function* (
	dependencies: CliDependencies,
	command: string,
	origin: string,
	id: string | undefined,
) {
	const admin = yield* readToken(dependencies, services.admin, origin);

	if (admin === null) return yield* fail('Run admin init and configure the Worker digest first.');

	if (command === 'list') {
		const response = yield* proxyRequest(dependencies, `${origin}${usersPath}`, admin);

		if (!response.ok) return yield* fail(`Proxy rejected the request (HTTP ${response.status}).`);

		const { users } = yield* decodeJson(Schema.Struct({ users: Schema.Array(Schema.String) }))(
			response,
		);

		return users.length === 0 ? 'No users registered.' : users.join('\n');
	}

	if (id === undefined || !isUserId(id))
		return yield* fail(
			'User ids are 1-32 lowercase letters, digits, or hyphens, starting with a letter.',
		);
	const service = services.user(id);
	const url = `${origin}${usersPath}/${id}`;

	if (command === 'remove') {
		const response = yield* proxyRequest(dependencies, url, admin, { method: 'DELETE' });

		if (response.status === 404) return yield* fail(`User ${id} is not registered.`);

		if (!response.ok)
			return yield* fail(
				`Proxy rejected the removal (HTTP ${response.status}). The key may still be active; retry.`,
			);
		yield* decodeJson(AccountStatus)(response);

		return `User ${id} removed. All Claude and Codex accounts disconnected.`;
	}

	let token = yield* readToken(dependencies, service, origin);

	if (command === 'key') {
		if (token === null) return yield* fail(`No key is stored for ${id}. Run admin user add first.`);

		return token;
	}

	if (command === 'rotate' || token === null) {
		token = newToken();
		yield* saveToken(dependencies, service, origin, token);
	}

	const response = yield* proxyRequest(dependencies, url, admin, {
		method: 'PUT',
		body: JSON.stringify({ digest: adminDigest(token) }),
	});

	if (!response.ok)
		return yield* fail(
			`Proxy rejected the registration (HTTP ${response.status}). The stored key is kept; retry with the same command.`,
		);
	yield* decodeJson(Schema.Struct({ id: Schema.Literal(id) }))(response);

	return `User ${id} ${command === 'rotate' ? 'key rotated' : 'registered'} at ${origin}.\nShare the key privately: proxy admin user key ${origin} ${id}`;
});

const ModelList = Schema.Struct({ data: Schema.Array(Schema.Struct({ id: Schema.String })) });

type KeyCheck = { ok: true; models: readonly string[] } | { ok: false; status: number };

/** Asks the proxy which models an editor key may use. Non-2xx means the key is not accepted. */
const listModels = (
	dependencies: CliDependencies,
	origin: string,
	provider: Provider,
	token: string,
): Effect.Effect<KeyCheck, CliError> =>
	proxyRequest(dependencies, modelsUrl(origin, provider), token).pipe(
		Effect.flatMap((response) =>
			response.ok
				? decodeJson(ModelList)(response).pipe(
						Effect.map(({ data }): KeyCheck => ({ ok: true, models: data.map(({ id }) => id) })),
					)
				: Effect.succeed<KeyCheck>({ ok: false, status: response.status }),
		),
	);

/** Prompts for an editor key and saves it only after the proxy accepts it. */
const promptEditorKey = Effect.fn('CLI.promptEditorKey')(function* (
	dependencies: CliDependencies,
	origin: string,
	provider: Provider,
) {
	const entered = yield* Effect.tryPromise({
		try: () => dependencies.terminal.password(`Editor key for ${origin}`),
		catch: () => new CliError({ message: 'No key was entered.' }),
	}).pipe(Effect.map((value) => value.trim()));

	if (!isDigest(entered)) return yield* fail('Editor keys are 64 hexadecimal characters.');
	const check = yield* listModels(dependencies, origin, provider, entered);

	if (!check.ok)
		return yield* fail(
			`The proxy did not accept this key (HTTP ${check.status}). Nothing was saved.`,
		);
	yield* saveToken(dependencies, services.editor, origin, entered);

	return { token: entered, models: check.models };
});

const editorCommand = Effect.fn('CLI.editor')(function* (
	dependencies: CliDependencies,
	command: string,
	origin: string,
) {
	if (command === 'key') {
		const token = yield* readToken(dependencies, services.editor, origin);

		if (token === null) return yield* fail('Run editor login first.');

		return token;
	}

	yield* promptEditorKey(dependencies, origin, providers.claude);

	return `Editor key accepted by ${origin} and saved in the OS credential store.`;
});

/** One provider account collection call. Failures leave account state unconfirmed. */
const accountRequest = Effect.fn('CLI.account')(function* (
	dependencies: CliDependencies,
	origin: string,
	provider: Provider,
	token: string,
	init: ProxyInit,
	accountId?: string,
) {
	const response = yield* proxyRequest(
		dependencies,
		`${accountUrl(origin, provider)}${accountId === undefined ? '' : `/${encodeURIComponent(accountId)}`}`,
		token,
		init,
	).pipe(
		Effect.mapError(
			() =>
				new CliError({
					message:
						'Proxy request failed. Account state is unconfirmed; check status before retrying.',
				}),
		),
	);

	if (!response.ok)
		return yield* fail(
			`Proxy rejected the operation (HTTP ${response.status}). No success confirmed.`,
		);

	return yield* decodeJson(AccountStatus)(response);
});

const connectAccount = Effect.fn('CLI.connect')(function* (
	dependencies: CliDependencies,
	origin: string,
	providerId: ProviderId,
	token: string,
	binary: string,
) {
	const credential = yield* loginLocally(binary, dependencies.loginEnvironment, providerId);

	return yield* accountRequest(dependencies, origin, providers[providerId], token, {
		method: 'PUT',
		body: JSON.stringify(credential),
	});
});

const prepareLogin = Effect.fn('CLI.prepareLogin')(function* (dependencies: CliDependencies) {
	const spinner = dependencies.terminal.spinner('Preparing the login helper');
	const binary = yield* locateCpa({
		fetch: (url, init) => dependencies.fetch(url, init),
		environment: dependencies.loginEnvironment,
		host: dependencies.host,
		progress: (line) => spinner.message(line.trim()),
	}).pipe(
		Effect.tapError(({ message }) => Effect.sync(() => spinner.error(message))),
		Effect.mapError(({ message }) => new CliError({ message })),
	);
	spinner.stop(`Login helper ready: ${binary}`);
	return binary;
});

const providerCommand = Effect.fn('CLI.provider')(function* (
	dependencies: CliDependencies,
	providerId: ProviderId,
	command: string,
	origin: string,
	accountId?: string,
) {
	const token = yield* readToken(dependencies, services.editor, origin);
	if (token === null) return yield* fail('Run editor login first.');
	if (
		command === 'disconnect' &&
		(accountId === undefined ||
			!Schema.is(AccountId)(accountId) ||
			!accountId.startsWith(`${providerId}-`))
	)
		return yield* fail('Use the account ID shown by status or list.');
	if (command === 'connect') {
		const binary = yield* prepareLogin(dependencies);
		return describeAccount(
			yield* connectAccount(dependencies, origin, providerId, token, binary),
			providerId,
		);
	}
	return describeAccount(
		yield* accountRequest(
			dependencies,
			origin,
			providers[providerId],
			token,
			{ method: command === 'disconnect' ? 'DELETE' : 'GET' },
			accountId,
		),
		providerId,
	);
});

/**
 * Guided onboarding. Asks which account and editor to set up, then reuses
 * anything already done, so re-running is safe.
 */
const joinCommand = Effect.fn('CLI.join')(function* (
	dependencies: CliDependencies,
	origin: string,
) {
	const { terminal } = dependencies;
	const keyCommand = `proxy editor key ${origin}`;

	// Cancelling before anything is saved is a clean exit; after that, the setup already
	// happened and the message must say so.
	let saved = false;

	const ask = <Value>(prompt: () => Promise<Value>) =>
		Effect.tryPromise({
			try: prompt,
			catch: () =>
				new CliError({
					message: saved
						? `Stopped. The editor key and account are already saved; get the key any time with: ${keyCommand}`
						: 'Setup cancelled. Nothing was changed.',
				}),
		});

	terminal.intro(`Join ${origin}`);

	const providerId = yield* ask(() =>
		terminal.select('Which account will you connect?', choices(providers)),
	);

	const provider = providers[providerId];

	const editorId = yield* ask(() =>
		terminal.select('Which editor are you setting up?', choices(editors)),
	);

	const editor = editors[editorId];

	let token = yield* readToken(dependencies, services.editor, origin);
	let models: readonly string[] = [];

	if (token !== null) {
		const check = yield* listModels(dependencies, origin, provider, token);

		if (check.ok) {
			models = check.models;
			terminal.step('Editor key on file and accepted by the proxy.');
		} else {
			terminal.info(
				`The stored editor key was rejected (HTTP ${check.status}); it may have been rotated.`,
			);
			token = null;
		}
	}

	if (token === null) {
		terminal.info('Paste the key your administrator sent you. It is not shown while typing.');
		const accepted = yield* promptEditorKey(dependencies, origin, provider);
		token = accepted.token;
		models = accepted.models;
		saved = true;
		terminal.step('Editor key accepted and saved in the OS credential store.');
	}

	let status = yield* accountRequest(dependencies, origin, provider, token, { method: 'GET' });

	terminal.info(describeAccount(status, providerId));
	const action =
		status.accounts.length === 0
			? 'connect'
			: yield* ask(() =>
					terminal.select('What would you like to do?', [
						{ value: 'connect', label: 'Add or reconnect an account' },
						{ value: 'settings', label: 'Editor settings only' },
					]),
				);
	if (action === 'connect') {
		const binary = yield* prepareLogin(dependencies);
		terminal.info(
			`Sign in to ${provider.label} in the browser window that opens.${providerId === 'claude' ? ' Choose the Personal or Team workspace you want to add.' : ' The callback uses localhost port 1455.'}`,
		);
		status = yield* connectAccount(dependencies, origin, providerId, token, binary);
		if (status.state !== 'saved') return yield* fail(describeAccount(status, providerId));
		saved = true;
		terminal.step(describeAccount(status, providerId));
	}

	terminal.note(editor.setup(origin, providerId, models), `${editor.label} settings`);

	const pasted = editor.key === 'pasted';

	const copyPrompt = yield* ask(() =>
		terminal.confirm(
			`Copy the ${editor.label} setup prompt to the clipboard? Its agent does the setup${
				pasted ? ' and asks you for the key' : ''
			}.`,
		),
	);

	let copied = false;

	if (copyPrompt) {
		copied = yield* Effect.promise(() =>
			terminal.clipboard(editor.prompt(origin, providerId, models)),
		);

		if (copied) terminal.step(`Setup prompt copied. Paste it into ${editor.label}.`);
		else terminal.info('No clipboard available; the settings above cover the same steps.');
	}

	if (!pasted) {
		terminal.outro(`Done. ${editor.label} reads the key at startup by running: ${keyCommand}`);

		return '';
	}

	const showKey = yield* ask(() => terminal.confirm('Show the editor key so you can copy it now?'));

	if (showKey) terminal.note(token, 'Editor key');

	terminal.outro(
		copied
			? `Done. When ${editor.label} asks for the key, paste it or run: ${keyCommand}`
			: `Done. Get the key any time with: ${keyCommand}`,
	);

	return '';
});

export interface ParsedCommand {
	readonly name: string;
	readonly operands: readonly string[];
}

/** The command words in `args`, without operands: `admin user key <origin> <id>` is `admin user key`. */
export const commandName = (args: readonly string[]): ParsedCommand => {
	// `join` is a single word; `admin user <sub>` nests one level deeper than the other groups.
	const depth =
		args[0] === 'join' || args[0] === 'status'
			? 1
			: args[0] === 'admin' && args[1] === 'user'
				? 3
				: 2;

	return { name: args.slice(0, depth).join(' '), operands: args.slice(depth) };
};

/**
 * Commands whose whole output is one key. Piped, they print it bare so
 * `... | pbcopy` does not carry a newline that a masked prompt reads as Enter.
 */
export const keyCommands: ReadonlySet<string> = new Set(['admin user key', 'editor key']);

export const runCli = Effect.fn('CLI.run')(function* (
	args: readonly string[],
	dependencies: CliDependencies,
) {
	const parsed = commandName(args);
	const name = parsed.name;
	let operands = parsed.operands;
	const defaultOriginCommands = new Set([
		'join',
		'status',
		'editor login',
		'editor key',
		'claude connect',
		'claude status',
		'claude list',
		'codex connect',
		'codex status',
		'codex list',
	]);
	if (defaultOriginCommands.has(name) && operands.length === 0) operands = [deployment.origin];
	if ((name === 'claude disconnect' || name === 'codex disconnect') && operands.length === 1)
		operands = [deployment.origin, ...operands];

	const arity = new Map([
		['join', 1],
		['status', 1],
		['admin init', 1],
		['admin rotate', 1],
		['admin digest', 1],
		['admin sync', 1],
		['admin user list', 1],
		['admin user add', 2],
		['admin user rotate', 2],
		['admin user key', 2],
		['admin user remove', 2],
		['editor login', 1],
		['editor key', 1],
		['claude status', 1],
		['claude disconnect', 2],
		['claude connect', 1],
		['claude list', 1],
		['codex status', 1],
		['codex list', 1],
		['codex disconnect', 2],
		['codex connect', 1],
	]);

	if (operands.length !== arity.get(name) || operands.some((value) => value === ''))
		return yield* fail(usage);
	const [input = '', extra] = operands;

	const origin = yield* Effect.try({
		try: () => adminOrigin(input),
		catch: () =>
			new CliError({ message: 'Use an HTTPS origin, or loopback HTTP for local development.' }),
	});

	const [group, command = '', subcommand = ''] = args;

	switch (group) {
		case 'status':
			return yield* statusCommand(dependencies, origin);
		case 'join':
			return yield* joinCommand(dependencies, origin);
		case 'admin':
			return command === 'user'
				? yield* userCommand(dependencies, subcommand, origin, extra)
				: yield* adminCommand(dependencies, command, origin);
		case 'editor':
			return yield* editorCommand(dependencies, command, origin);
		default:
			return yield* providerCommand(dependencies, group as AccountProvider, command, origin, extra);
	}
});
