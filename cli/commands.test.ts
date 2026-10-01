import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from '@effect/vitest';
import { Effect } from 'effect';

import { deployment } from '../deployment.ts';
import { adminDigest } from '../src/admin.ts';
import {
	type CliDependencies,
	commandName,
	editors,
	keyCommands,
	loginLocally,
	runCli,
	type Terminal,
	usage,
} from './commands.ts';

const noSync = async () => {
	throw new Error('Unexpected remote key update');
};

const noPrompt = async () => {
	throw new Error('Unexpected prompt');
};

const noFetch = async () => {
	throw new Error('Unexpected request');
};

/** In-memory credential store keyed by `service:origin`, plus request and terminal logs. */
function harness(fetch: CliDependencies['fetch'] = noFetch, entered?: string) {
	const values = new Map<string, string>();
	const requests: { method: string; url: string; bearer: string | null; body: unknown }[] = [];
	/** Every line the flow showed, prefixed by its kind. */
	const screen: string[] = [];
	const menus: { message: string; labels: string[] }[] = [];
	/** Yes/no questions in the order asked. */
	const questions: string[] = [];
	/** Yes/no answers by question; unanswered questions get yes. */
	const answers = new Map<string, boolean>();
	/** Prompts the user cancels (Escape or Ctrl-C), by message. */
	const cancels = new Set<string>();
	/** Menu choices by question label; unanswered menus take the first choice. */
	const picks = new Map<string, string>([['What would you like to do?', 'Editor settings only']]);
	const clipboard: string[] = [];

	const cancelled = (message: string) => {
		if (cancels.has(message)) throw new Error(`Cancelled at: ${message}`);
	};

	const terminal: Terminal = {
		intro: (title) => screen.push(`intro ${title}`),
		outro: (message) => screen.push(`outro ${message}`),
		step: (line) => screen.push(`step ${line}`),
		info: (line) => screen.push(`info ${line}`),
		note: (body, title) => screen.push(`note ${title}\n${body}`),
		select: async (message, choices) => {
			cancelled(message);
			menus.push({ message, labels: choices.map(({ label }) => label) });
			const wanted = picks.get(message);
			const chosen = wanted === undefined ? choices[0] : choices.find((c) => c.label === wanted);

			if (chosen === undefined) throw new Error(`No choice for: ${message}`);

			return chosen.value;
		},
		password: entered === undefined ? noPrompt : async () => entered,
		confirm: async (message) => {
			cancelled(message);
			questions.push(message);

			return answers.get(message) ?? true;
		},
		spinner: (message) => {
			screen.push(`spinner ${message}`);

			return {
				message: (line) => screen.push(`spinner ${line}`),
				stop: (line) => screen.push(`spinner-stop ${line}`),
				error: (line) => screen.push(`spinner-error ${line}`),
			};
		},
		clipboard: async (value) => {
			clipboard.push(value);

			return true;
		},
	};

	const dependencies: CliDependencies = {
		secrets: {
			get: ({ service, name }) => Promise.resolve(values.get(`${service}:${name}`) ?? null),
			set: ({ service, name, value }) => {
				values.set(`${service}:${name}`, value);

				return Promise.resolve();
			},
		},
		fetch: async (url, init) => {
			const request = new Request(url, init);
			requests.push({
				method: request.method,
				url,
				bearer: request.headers.get('authorization')?.replace('Bearer ', '') ?? null,
				body: request.body === null ? null : await request.json(),
			});

			return fetch(url, init);
		},
		terminal,
		host: { platform: 'darwin', arch: 'arm64' },
		loginEnvironment: {},
		syncDigest: noSync,
	};

	return {
		values,
		requests,
		screen,
		menus,
		questions,
		answers,
		cancels,
		picks,
		clipboard,
		dependencies,
	};
}

const origin = 'https://proxy.example';

const bare = (args: readonly string[]) => keyCommands.has(commandName(args).name);

it('prints bare output only for the two key commands', () => {
	expect(bare(['admin', 'user', 'key', origin, 'alice'])).toBe(true);
	expect(bare(['editor', 'key', origin])).toBe(true);
	// Newline-delimited output must keep its final newline for `while read` and `wc -l`.
	expect(bare(['admin', 'user', 'list', origin])).toBe(false);
	expect(bare(['admin', 'digest', origin])).toBe(false);
	expect(bare(['join', origin])).toBe(false);
	expect(commandName(['admin', 'user', 'key', origin, 'alice'])).toEqual({
		name: 'admin user key',
		operands: [origin, 'alice'],
	});
});

it.effect('keeps admin init idempotent and never prints the stored key', () =>
	Effect.gen(function* () {
		const { values, dependencies } = harness();

		const message = yield* runCli(['admin', 'init', origin], dependencies);
		const token = values.get(`jonah.proxy.admin:${origin}`);
		expect(token).toMatch(/^[a-f0-9]{64}$/);
		expect(message).not.toContain(token);
		expect(yield* runCli(['admin', 'init', `${origin}/`], dependencies)).toBe(message);
		const digest = yield* runCli(['admin', 'digest', origin], dependencies);
		expect(digest).toBe(adminDigest(token ?? ''));
		yield* runCli(['admin', 'rotate', origin], dependencies);
		expect(values.get(`jonah.proxy.admin:${origin}`)).not.toBe(token);
		expect(values.size).toBe(1);
	}),
);

it.effect('registers users with a fresh key, reuses it on repeat, and rotates on request', () =>
	Effect.gen(function* () {
		const { values, requests, dependencies } = harness(async (url, init) => {
			if (init.method === 'DELETE') return Response.json({ state: 'disconnected', accounts: [] });

			if (init.method === 'PUT') return Response.json({ id: url.split('/').at(-1) });

			return Response.json({ users: ['alice', 'bob'] });
		});

		yield* runCli(['admin', 'init', origin], dependencies);
		const admin = values.get(`jonah.proxy.admin:${origin}`);

		const added = yield* runCli(['admin', 'user', 'add', origin, 'alice'], dependencies);
		const key = yield* runCli(['admin', 'user', 'key', origin, 'alice'], dependencies);
		expect(key).toMatch(/^[a-f0-9]{64}$/);
		expect(key).not.toBe(admin);
		expect(added).not.toContain(key);
		expect(added).toContain('registered');

		// Re-running add repairs the registry with the same key instead of silently rotating it.
		yield* runCli(['admin', 'user', 'add', origin, 'alice'], dependencies);
		expect(yield* runCli(['admin', 'user', 'key', origin, 'alice'], dependencies)).toBe(key);

		yield* runCli(['admin', 'user', 'rotate', origin, 'alice'], dependencies);
		const rotated = yield* runCli(['admin', 'user', 'key', origin, 'alice'], dependencies);
		expect(rotated).not.toBe(key);

		expect(yield* runCli(['admin', 'user', 'list', origin], dependencies)).toBe('alice\nbob');
		const removed = yield* runCli(['admin', 'user', 'remove', origin, 'alice'], dependencies);
		expect(removed).toContain('alice removed');

		expect(requests).toEqual([
			{
				method: 'PUT',
				url: `${origin}/admin/users/alice`,
				bearer: admin,
				body: { digest: adminDigest(key) },
			},
			{
				method: 'PUT',
				url: `${origin}/admin/users/alice`,
				bearer: admin,
				body: { digest: adminDigest(key) },
			},
			{
				method: 'PUT',
				url: `${origin}/admin/users/alice`,
				bearer: admin,
				body: { digest: adminDigest(rotated) },
			},
			{ method: 'GET', url: `${origin}/admin/users`, bearer: admin, body: null },
			{ method: 'DELETE', url: `${origin}/admin/users/alice`, bearer: admin, body: null },
		]);
		expect(JSON.stringify(requests)).not.toContain(key);
		expect(values.get(`jonah.proxy.user.alice:${origin}`)).toBe(rotated);
	}),
);

it.effect('rejects bad user ids and unknown users before or after contacting the proxy', () =>
	Effect.gen(function* () {
		const { requests, dependencies } = harness(
			async () => new Response(JSON.stringify({ error: 'unknown_user' }), { status: 404 }),
		);

		yield* runCli(['admin', 'init', origin], dependencies);

		for (const id of ['Alice', 'a/b', '', 'x'.repeat(33)]) {
			const result = yield* runCli(['admin', 'user', 'add', origin, id], dependencies).pipe(
				Effect.flip,
			);

			expect(result.message, id).toMatch(id === '' ? /^Usage/ : /lowercase/);
		}

		expect(requests).toEqual([]);

		const missing = yield* runCli(['admin', 'user', 'remove', origin, 'carol'], dependencies).pipe(
			Effect.flip,
		);

		expect(missing.message).toContain('not registered');
		expect(requests).toHaveLength(1);
	}),
);

it.effect(
	'saves an editor key only after the proxy accepts it, then uses it for account calls',
	() =>
		Effect.gen(function* () {
			const key = 'a'.repeat(64);

			const rejected = harness(async () => new Response(null, { status: 401 }), key);

			const denied = yield* runCli(['editor', 'login', origin], rejected.dependencies).pipe(
				Effect.flip,
			);

			expect(denied.message).toContain('HTTP 401');
			expect(rejected.values.size).toBe(0);

			const malformed = harness(noFetch, 'not-a-key');

			const invalid = yield* runCli(['editor', 'login', origin], malformed.dependencies).pipe(
				Effect.flip,
			);

			expect(invalid.message).toContain('64 hexadecimal');
			expect(malformed.requests).toEqual([]);

			const { values, requests, dependencies } = harness(async (url, init) => {
				if (url.endsWith('/claude/v1/models')) return Response.json({ data: [] });

				if (init.method === 'DELETE') return Response.json({ state: 'disconnected', accounts: [] });

				return Response.json(savedAccount);
			}, ` ${key}\n`);

			const saved = yield* runCli(['editor', 'login', origin], dependencies);
			expect(saved).toContain('accepted');
			expect(saved).not.toContain(key);
			expect(values.get(`jonah.proxy.editor:${origin}`)).toBe(key);
			expect(yield* runCli(['editor', 'key', origin], dependencies)).toBe(key);

			const status = yield* runCli(['claude', 'status', origin], dependencies);
			expect(status).toContain('alice@example.test');
			expect(
				yield* runCli(
					['claude', 'disconnect', origin, 'claude-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
					dependencies,
				),
			).toBe('Claude: no connected accounts.');

			expect(requests.map(({ method, url, bearer }) => [method, url, bearer])).toEqual([
				['GET', `${origin}/claude/v1/models`, key],
				['GET', `${origin}/claude/accounts`, key],
				['DELETE', `${origin}/claude/accounts/claude-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`, key],
			]);
		}),
);

it.effect('requires a login before account commands and prints usage for unknown shapes', () =>
	Effect.gen(function* () {
		const { requests, dependencies } = harness();

		const status = yield* runCli(['claude', 'status', origin], dependencies).pipe(Effect.flip);
		expect(status.message).toBe('Run editor login first.');

		for (const args of [
			[],
			['admin'],
			['admin', 'user'],
			['admin', 'user', 'list'],
			['admin', 'user', 'add', origin],
			['editor', 'init', origin],
			['admin', 'sync', origin, '0123456789abcdef0123456789abcdef'],
			['editor', 'sync', origin],
			['claude', 'connect', origin, 'extra'],
			['claude', 'status', origin, 'extra'],
		]) {
			const result = yield* runCli(args, dependencies).pipe(Effect.flip);
			expect(result.message, args.join(' ')).toBe(usage);
		}

		expect(requests).toEqual([]);
	}),
);

it.effect('rejects unsafe destinations before reading the keychain', () =>
	Effect.gen(function* () {
		for (const destination of [
			'http://proxy.example',
			'https://user:password@proxy.example',
			'https://proxy.example/path',
		]) {
			const { dependencies } = harness();
			dependencies.secrets.get = () => {
				throw new Error('keychain should not be read');
			};

			const result = yield* runCli(['claude', 'status', destination], dependencies).pipe(
				Effect.flip,
			);

			expect(result.message).toBe('Use an HTTPS origin, or loopback HTTP for local development.');
		}
	}),
);

const identity = {
	id: 'claude-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
	provider: 'claude',
	email: 'alice@example.test',
	accountId: 'account-a',
	organizationId: 'org-personal',
	organizationName: 'Personal',
	accessTokenExpiresAt: '2099-01-01T00:00:00Z',
	health: { state: 'unknown' },
	usage: { state: 'unavailable', quotaState: 'unavailable' },
};
const savedAccount = { state: 'saved', accounts: [identity] };

const modelList = () =>
	Response.json({ data: [{ id: 'claude-fable-5-1' }, { id: 'claude-opus-5' }] });

it.effect('join can configure an editor without changing connected accounts', () =>
	Effect.gen(function* () {
		const key = 'b'.repeat(64);

		const { values, requests, screen, menus, answers, clipboard, dependencies } = harness(
			async (url) => {
				if (url.endsWith('/claude/v1/models')) return modelList();

				return Response.json(savedAccount);
			},
			key,
		);

		const message = yield* runCli(['join', origin], dependencies);
		expect(message).toBe('');
		expect(menus).toEqual([
			{ message: 'Which account will you connect?', labels: ['Claude', 'ChatGPT / Codex'] },
			{ message: 'Which editor are you setting up?', labels: ['Amp', 'pi'] },
			{
				message: 'What would you like to do?',
				labels: ['Add or reconnect an account', 'Editor settings only'],
			},
		]);
		const note = screen.find((line) => line.startsWith('note Amp settings')) ?? '';
		expect(note).toContain(`Base URL  ${origin}/claude`);
		expect(note).toContain('claude-fable-5-1, claude-opus-5');
		expect(note).toContain('anthropic/claude-opus-5 -> claude-opus-5');
		const prompt = clipboard[0] ?? '';
		expect(clipboard).toHaveLength(1);
		expect(prompt).toContain(`Base URL: ${origin}/claude`);
		expect(prompt).toContain('anthropic/claude-fable-5-1 -> claude-fable-5-1');
		expect(prompt).toContain(`proxy editor key ${origin}`);
		expect(prompt).not.toContain(key);
		expect(screen).toContain('step Setup prompt copied. Paste it into Amp.');
		expect(screen).toContain(`note Editor key\n${key}`);
		expect(screen.at(-1)).toContain(
			`outro Done. When Amp asks for the key, paste it or run: proxy editor key ${origin}`,
		);
		expect(values.get(`jonah.proxy.editor:${origin}`)).toBe(key);
		expect(screen.join('\n')).toContain('Personal');
		// The key appears only where it was explicitly asked for.
		expect(screen.filter((line) => line.includes(key))).toEqual([`note Editor key\n${key}`]);

		// Second run: the stored key is verified, not prompted for again; both offers declined.
		answers.set(
			'Copy the Amp setup prompt to the clipboard? Its agent does the setup and asks you for the key.',
			false,
		);
		answers.set('Show the editor key so you can copy it now?', false);
		dependencies.terminal.password = noPrompt;
		yield* runCli(['join', origin], dependencies);
		expect(screen).toContain('step Editor key on file and accepted by the proxy.');
		expect(clipboard).toHaveLength(1);
		expect(screen.filter((line) => line.includes(key))).toHaveLength(1);
		expect(screen.at(-1)).toContain(
			`outro Done. Get the key any time with: proxy editor key ${origin}`,
		);
		expect(requests.map(({ method, url }) => [method, url])).toEqual([
			['GET', `${origin}/claude/v1/models`],
			['GET', `${origin}/claude/accounts`],
			['GET', `${origin}/claude/v1/models`],
			['GET', `${origin}/claude/accounts`],
		]);
	}),
);

it.effect('join for pi writes a models.json provider that reads the key at runtime', () =>
	Effect.gen(function* () {
		const key = 'b'.repeat(64);

		const { screen, picks, questions, clipboard, dependencies } = harness(
			async (url) =>
				url.endsWith('/claude/v1/models') ? modelList() : Response.json(savedAccount),
			key,
		);

		picks.set('Which editor are you setting up?', 'pi');

		yield* runCli(['join', origin], dependencies);

		// pi reads the key itself at startup, so join never offers to show it.
		expect(questions).toContain(
			'Copy the pi setup prompt to the clipboard? Its agent does the setup.',
		);
		expect(questions).not.toContain('Show the editor key so you can copy it now?');
		expect(screen).toContain(
			`outro Done. pi reads the key at startup by running: proxy editor key ${origin}`,
		);

		const note = screen.find((line) => line.startsWith('note pi settings')) ?? '';
		expect(note).toContain('~/.pi/agent/models.json');
		expect(note).toContain(`"baseUrl": "${origin}/claude"`);
		expect(note).toContain('"api": "anthropic-messages"');
		expect(note).toContain(`"apiKey": "!proxy editor key ${origin}"`);
		expect(note).toContain('"id": "claude-fable-5-1"');
		expect(note).toContain('"id": "claude-opus-5"');
		// pi assumes 128k/16k when these are missing and compacts and truncates early.
		expect(note).toContain('"contextWindow": 1000000');
		expect(note).toContain('"maxTokens": 128000');
		expect(note).toContain('pi --provider claude-proxy --model claude-fable-5-1');
		// pi's SDK appends /v1/messages itself; the base URL must stop at the provider path.
		expect(note).not.toContain('/claude/v1');
		const prompt = clipboard[0] ?? '';
		expect(clipboard).toHaveLength(1);
		expect(prompt).toContain(`"baseUrl": "${origin}/claude"`);
		expect(prompt).toContain(`proxy editor key ${origin}`);
		expect(prompt).not.toContain(key);
		expect(screen).toContain('step Setup prompt copied. Paste it into pi.');
		expect(screen.filter((line) => line.includes(key))).toEqual([]);
	}),
);

it.effect('join tells the truth when cancelled: nothing changed before saving, saved after', () =>
	Effect.gen(function* () {
		const key = 'b'.repeat(64);

		const respond = async (url: string) =>
			url.endsWith('/claude/v1/models') ? modelList() : Response.json(savedAccount);

		const early = harness(respond, key);
		early.cancels.add('Which editor are you setting up?');

		const before = yield* runCli(['join', origin], early.dependencies).pipe(Effect.flip);
		expect(before.message).toBe('Setup cancelled. Nothing was changed.');
		expect(early.values.size).toBe(0);
		expect(early.requests).toEqual([]);

		const late = harness(respond, key);
		late.cancels.add(
			'Copy the Amp setup prompt to the clipboard? Its agent does the setup and asks you for the key.',
		);

		const after = yield* runCli(['join', origin], late.dependencies).pipe(Effect.flip);
		expect(after.message).toBe(
			`Stopped. The editor key and account are already saved; get the key any time with: proxy editor key ${origin}`,
		);
		expect(late.values.get(`jonah.proxy.editor:${origin}`)).toBe(key);
		expect(late.clipboard).toEqual([]);
	}),
);

it.effect('join re-prompts when the stored key was rotated and saves nothing on rejection', () =>
	Effect.gen(function* () {
		const stale = 'c'.repeat(64);

		const { values, requests, dependencies } = harness(
			async () => new Response(null, { status: 401 }),
			'd'.repeat(64),
		);

		values.set(`jonah.proxy.editor:${origin}`, stale);

		const result = yield* runCli(['join', origin], dependencies).pipe(Effect.flip);
		expect(result.message).toContain('HTTP 401');
		expect(values.get(`jonah.proxy.editor:${origin}`)).toBe(stale);
		expect(requests.map(({ bearer }) => bearer)).toEqual([stale, 'd'.repeat(64)]);
	}),
);

it.effect('join connects a disconnected account through the CPA binary from the environment', () =>
	Effect.gen(function* () {
		const directory = yield* Effect.acquireRelease(
			Effect.promise(() => mkdtemp(join(tmpdir(), 'proxy-cli-test-'))),
			(path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
		);

		const binary = join(directory, 'fake-cpa');

		const credential = {
			type: 'claude',
			access_token: 'access',
			refresh_token: 'refresh',
			expired: '2099-01-01T00:00:00Z',
			email: 'alice@example.test',
			account_uuid: 'account-a',
			organization_uuid: 'org-personal',
			organization_name: 'Personal',
		};

		// Mimics `cli-proxy-api --claude-login --config <path>`: writes one credential next to the config.
		yield* Effect.promise(() =>
			writeFile(
				binary,
				`#!/bin/sh\nprintf '%s' '${JSON.stringify(credential)}' > "$(dirname "$3")/auths/claude.json"\n`,
				{ mode: 0o700 },
			),
		);

		let connected = false;

		const { requests, screen, answers, clipboard, dependencies } = harness(async (url, init) => {
			if (url.endsWith('/claude/v1/models')) return modelList();

			if (init.method === 'PUT') {
				connected = true;

				return Response.json(savedAccount);
			}

			return Response.json(connected ? savedAccount : { state: 'disconnected', accounts: [] });
		});

		answers.set(
			'Copy the Amp setup prompt to the clipboard? Its agent does the setup and asks you for the key.',
			false,
		);
		answers.set('Show the editor key so you can copy it now?', false);
		dependencies.loginEnvironment = { PROXY_CPA_BINARY: binary };
		dependencies.secrets.set({
			service: 'jonah.proxy.editor',
			name: origin,
			value: 'e'.repeat(64),
		});

		yield* runCli(['join', origin], dependencies);
		expect(screen).toContain(`spinner Using CPA from PROXY_CPA_BINARY: ${binary}`);
		expect(screen).toContain(`spinner-stop Login helper ready: ${binary}`);
		expect(screen.join('\n')).toContain('Personal');
		expect(clipboard).toEqual([]);
		expect(screen.at(-1)).toContain(
			`outro Done. Get the key any time with: proxy editor key ${origin}`,
		);
		expect(requests.map(({ method, url }) => [method, url])).toEqual([
			['GET', `${origin}/claude/v1/models`],
			['GET', `${origin}/claude/accounts`],
			['PUT', `${origin}/claude/accounts`],
		]);
		expect(requests[2]?.body).toEqual(credential);
	}),
);

it.effect('rejects successful CPA exit without a credential file', () =>
	Effect.gen(function* () {
		const directory = yield* Effect.acquireRelease(
			Effect.promise(() => mkdtemp(join(tmpdir(), 'proxy-cli-test-'))),
			(path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
		);

		const binary = join(directory, 'fake-cpa');
		yield* Effect.promise(() => writeFile(binary, '#!/bin/sh\nexit 0\n', { mode: 0o700 }));
		const result = yield* loginLocally(binary, {}, 'claude').pipe(Effect.flip);
		expect(result.message).toContain('Nothing was uploaded');
	}),
);

it.effect(
	'connects both providers with the pinned helper and keeps same-email workspaces distinct on reconnect',
	() =>
		Effect.gen(function* () {
			const directory = yield* Effect.acquireRelease(
				Effect.promise(() => mkdtemp(join(tmpdir(), 'proxy-pools-test-'))),
				(path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
			);
			const binary = join(directory, 'fake-cpa');
			const accounts = new Map<string, typeof identity>();
			const { dependencies, values, requests } = harness(async (url, init) => {
				if (init.method === 'PUT') {
					const credential = JSON.parse(String(init.body));
					expect(url).toBe(`${origin}/${credential.type}/accounts`);
					const organization = credential.organization_uuid ?? credential.account_id;
					const account = {
						...identity,
						id: `${credential.type}-${(organization === 'org-team' ? 'b' : 'a').repeat(32)}`,
						provider: credential.type,
						organizationId: organization,
						organizationName: credential.organization_name ?? 'ChatGPT',
						email: credential.email,
					};
					accounts.set(organization, account);
				}
				return Response.json({
					state: 'saved',
					accounts: [...accounts.values()].filter((account) =>
						url.includes(`/${account.provider}/`),
					),
				});
			});
			values.set(`jonah.proxy.editor:${origin}`, 'a'.repeat(64));
			dependencies.loginEnvironment = { PROXY_CPA_BINARY: binary };
			const claude = {
				type: 'claude',
				access_token: 'synthetic-access',
				refresh_token: 'synthetic-refresh',
				expired: '2099-01-01T00:00:00Z',
				email: 'same@example.test',
				account_uuid: 'same-account',
			};
			for (const credential of [
				{ ...claude, organization_uuid: 'org-personal', organization_name: 'Personal' },
				{ ...claude, organization_uuid: 'org-team', organization_name: 'Team' },
				{
					...claude,
					organization_uuid: 'org-personal',
					organization_name: 'Personal',
					access_token: 'replacement-access',
				},
				{
					type: 'codex',
					access_token: 'codex-access',
					refresh_token: 'codex-refresh',
					id_token: 'codex-id',
					expired: '2099-01-01T00:00:00Z',
					email: 'chatgpt@example.test',
					account_id: 'chatgpt-team',
				},
			]) {
				yield* Effect.promise(() =>
					writeFile(
						binary,
						`#!/bin/sh\ntest "$1" = "--${credential.type}-login" || exit 3\nprintf '%s' '${JSON.stringify(credential)}' > "$(dirname "$3")/auths/account.json"\n`,
						{ mode: 0o700 },
					),
				);
				const result = yield* runCli([credential.type, 'connect', origin], dependencies);
				expect(result).toContain(credential.email);
				expect(result).not.toContain(credential.access_token);
			}
			expect(accounts.size).toBe(3);
			const listed = yield* runCli(['claude', 'list', origin], dependencies);
			expect(listed).toContain('Personal');
			expect(listed).toContain('Team');
			expect(requests.filter((request) => request.method === 'PUT')).toHaveLength(4);
		}),
);

it.effect('join offers another login when an account already exists', () =>
	Effect.gen(function* () {
		const directory = yield* Effect.acquireRelease(
			Effect.promise(() => mkdtemp(join(tmpdir(), 'proxy-add-test-'))),
			(path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
		);
		const binary = join(directory, 'fake-cpa');
		const credential = {
			type: 'claude',
			access_token: 'synthetic',
			refresh_token: 'synthetic-refresh',
			expired: '2099-01-01T00:00:00Z',
			email: identity.email,
			organization_uuid: 'org-team',
			account_uuid: 'account-a',
		};
		yield* Effect.promise(() =>
			writeFile(
				binary,
				`#!/bin/sh\nprintf '%s' '${JSON.stringify(credential)}' > "$(dirname "$3")/auths/account.json"\n`,
				{ mode: 0o700 },
			),
		);
		const { dependencies, values, picks, requests } = harness(async (url) =>
			url.endsWith('/v1/models') ? modelList() : Response.json(savedAccount),
		);
		values.set(`jonah.proxy.editor:${origin}`, 'b'.repeat(64));
		picks.set('What would you like to do?', 'Add or reconnect an account');
		dependencies.loginEnvironment = { PROXY_CPA_BINARY: binary };
		yield* runCli(['join', origin], dependencies);
		expect(
			requests.filter((request) => request.method === 'PUT').map((request) => request.body),
		).toEqual([credential]);
	}),
);

it.effect('status reports available usage and unavailable quota without inventing values', () =>
	Effect.gen(function* () {
		const status = {
			providers: {
				claude: {
					state: 'saved',
					accounts: [
						{
							...identity,
							health: { state: 'ready' },
							usage: {
								state: 'observed',
								quotaState: 'observed',
								success: 3,
								failed: 1,
								countsSince: '2026-10-01T12:00:00Z',
								windows: [{ name: 'five_hour', usedPercent: 40, resetAt: '2026-10-01T15:00:00Z' }],
							},
						},
					],
				},
				codex: {
					state: 'saved',
					accounts: [
						{
							...identity,
							id: `codex-${'c'.repeat(32)}`,
							provider: 'codex',
							usage: { state: 'unavailable', quotaState: 'unavailable' },
						},
					],
				},
			},
			runtime: { state: 'running', startedAt: '2026-10-01T12:00:00Z', uptimeSeconds: 3661 },
			observedAt: '2026-10-01T13:00:00Z',
		};
		const { dependencies, values, requests } = harness(async () => Response.json(status));
		values.set(`jonah.proxy.editor:${origin}`, 'a'.repeat(64));
		const result = yield* runCli(['status', origin], dependencies);
		expect(result).toContain('Proxy: running');
		expect(result).toContain('Uptime: 1h 1m 1s; started 2026-10-01T12:00:00Z');
		expect(result).toContain('five_hour: 40% used; resets 2026-10-01T15:00:00Z');
		expect(result).toContain('Requests since 2026-10-01T12:00:00Z: 3 succeeded, 1 failed');
		expect(result).toContain('Subscription quota: unavailable');
		expect(result).not.toContain('100%');
		expect(requests.map((request) => request.url)).toEqual([`${origin}/status`]);
	}),
);

it.effect(
	'rejects a mismatched provider credential and unsafe disconnect identifier before upload',
	() =>
		Effect.gen(function* () {
			const { dependencies, values, requests } = harness();
			values.set(`jonah.proxy.editor:${origin}`, 'a'.repeat(64));
			for (const id of ['../admin', `codex-${'a'.repeat(32)}`]) {
				const result = yield* runCli(['claude', 'disconnect', origin, id], dependencies).pipe(
					Effect.flip,
				);
				expect(result.message).toContain('account ID');
			}
			expect(requests).toEqual([]);
			const directory = yield* Effect.acquireRelease(
				Effect.promise(() => mkdtemp(join(tmpdir(), 'proxy-wrong-provider-'))),
				(path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
			);
			const binary = join(directory, 'fake-cpa');
			const credential = {
				type: 'claude',
				access_token: 'synthetic',
				refresh_token: 'synthetic-refresh',
				expired: '2099-01-01T00:00:00Z',
				email: 'test@example.test',
				organization_uuid: 'personal',
				account_uuid: 'account-a',
			};
			yield* Effect.promise(() =>
				writeFile(
					binary,
					`#!/bin/sh\nprintf '%s' '${JSON.stringify(credential)}' > "$(dirname "$3")/auths/account.json"\n`,
					{ mode: 0o700 },
				),
			);
			const result = yield* loginLocally(binary, {}, 'codex').pipe(Effect.flip);
			expect(result.message).toContain('Nothing was uploaded');
		}),
);

it.effect('uses the default deployment origin and offers Codex Responses settings', () =>
	Effect.gen(function* () {
		const account = {
			...identity,
			id: `codex-${'c'.repeat(32)}`,
			provider: 'codex',
			email: 'codex@example.test',
		};
		const { dependencies, values, picks, screen, requests } = harness(async (url) =>
			url.endsWith('/v1/models')
				? Response.json({ data: [{ id: 'gpt-6-astra' }] })
				: Response.json({ state: 'saved', accounts: [account] }),
		);
		values.set(`jonah.proxy.editor:${deployment.origin}`, 'a'.repeat(64));
		picks.set('Which account will you connect?', 'ChatGPT / Codex');
		yield* runCli(['join'], dependencies);
		const settings = screen.find((line) => line.startsWith('note Amp settings')) ?? '';
		expect(settings).toContain(`${deployment.origin}/codex/v1`);
		expect(settings).toContain('OpenAI Responses');
		expect(settings).toContain('openai/gpt-6-astra -> gpt-6-astra');
		const prompt = editors.amp.prompt(deployment.origin, 'codex', ['gpt-6-astra']);
		expect(prompt).toContain(`Verify: GET ${deployment.origin}/codex/v1/models`);
		expect(prompt).not.toContain('/codex/v1/v1/');
		expect(requests.every((request) => request.url.startsWith(deployment.origin))).toBe(true);
	}),
);
