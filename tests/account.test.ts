import { expect, it } from '@effect/vitest';
import { Effect, Layer } from 'effect';

import {
	Account,
	credentialKey,
	decodeCredential,
	readAccount,
	replaceAccount,
	accountId,
} from '../src/account.ts';

const synthetic = {
	type: 'claude',
	access_token: 'synthetic-access',
	refresh_token: 'synthetic-refresh',
	email: 'account@example.test',
	expired: '2099-01-01T00:00:00Z',
	organization_uuid: 'org-personal',
	account_uuid: 'account-1',
};

function fixture() {
	const stored = new Map<string, string>();
	const events: string[] = [];
	let failure = '';
	const ports = Layer.mergeAll(
		Account.storageLayer({
			list: async () => [...stored].map(([key, value]) => ({ key, value })),
			read: async (key: string) => (failure === 'readback' ? 'stale' : (stored.get(key) ?? null)),
			write: async (key: string, value: string) => {
				events.push('write');
				if (failure === 'write') throw new Error('private storage details');
				stored.set(key, value);
			},
			remove: async (keys: readonly string[]) => {
				events.push('delete');
				if (failure === 'delete') throw new Error('private storage details');
				for (const key of keys) stored.delete(key);
			},
		}),
		Account.runtimeLayer({
			setState: async (state) => {
				events.push(state);
			},
			stop: async () => {
				events.push('stopped');
				if (failure === 'stop') throw new Error('private runtime details');
			},
			load: async () => {
				events.push('loaded');
				if (failure === 'load') throw new Error('private runtime details');
			},
		}),
	);
	return {
		stored,
		events,
		ports,
		fail: (value: string) => {
			failure = value;
		},
	};
}

it.effect(
	'keeps two Claude organizations under one email and reconnects only the matching stable identity',
	() =>
		Effect.gen(function* () {
			const f = fixture();
			const personal = yield* decodeCredential(synthetic, 'claude');
			const team = yield* decodeCredential(
				{ ...synthetic, organization_uuid: 'org-team', organization_name: 'Team' },
				'claude',
			);
			const run = <A, E>(effect: Effect.Effect<A, E, Account.Storage | Account.Runtime>) =>
				effect.pipe(Effect.provide(f.ports));
			yield* run(replaceAccount('alice', 'claude', { credential: personal }));
			const status = yield* run(replaceAccount('alice', 'claude', { credential: team }));
			expect(status.state).toBe('saved');
			expect(status.accounts).toHaveLength(2);
			expect(new Set(status.accounts.map((a) => a.id)).size).toBe(2);
			const refreshed = yield* decodeCredential(
				{ ...synthetic, refresh_token: 'replacement-refresh' },
				'claude',
			);
			yield* run(replaceAccount('alice', 'claude', { credential: refreshed }));
			expect(f.stored.size).toBe(2);
			expect(f.stored.get(credentialKey('alice', 'claude', accountId(personal)))).toContain(
				'replacement-refresh',
			);
			expect(f.events.slice(0, 5)).toEqual([
				'recovery_required',
				'stopped',
				'write',
				'loaded',
				'saved',
			]);
			const deleted = yield* run(replaceAccount('alice', 'claude', { id: accountId(personal) }));
			expect(deleted.accounts.map((a) => a.organizationId)).toEqual(['org-team']);
			expect(f.stored.size).toBe(1);
		}),
);

it.effect('keeps the gate closed on stop, write, verification, delete and reload failures', () =>
	Effect.gen(function* () {
		const credential = yield* decodeCredential(synthetic, 'claude');
		for (const failure of ['stop', 'write', 'readback', 'delete', 'load']) {
			const f = fixture();
			f.fail(failure);
			const result = yield* replaceAccount(
				'alice',
				'claude',
				failure === 'delete' ? { id: accountId(credential) } : { credential },
			).pipe(Effect.provide(f.ports), Effect.flip);
			expect(result.code).toBe(
				['stop', 'load'].includes(failure) ? 'runtime_failed' : 'storage_failed',
			);
			expect(f.events[0]).toBe('recovery_required');
			expect(f.events).not.toContain('saved');
			expect(f.events).not.toContain('disconnected');
			expect(JSON.stringify(result)).not.toContain('private');
		}
	}),
);

it.effect('rejects wrong providers and missing stable identities before importing', () =>
	Effect.gen(function* () {
		for (const value of [
			{ ...synthetic, type: 'codex' },
			{ ...synthetic, organization_uuid: '' },
			{ ...synthetic, refresh_token: '' },
			{ ...synthetic, expired: 'bad' },
		]) {
			const error = yield* decodeCredential(value, 'claude').pipe(Effect.flip);
			expect(error.code).toBe('invalid_credential');
		}
		const codex = yield* decodeCredential(
			{
				type: 'codex',
				id_token: 'synthetic-id',
				access_token: 'synthetic-access',
				refresh_token: 'synthetic-refresh',
				email: synthetic.email,
				account_id: 'chatgpt-account',
				expired: synthetic.expired,
			},
			'codex',
		);
		expect(accountId(codex)).not.toBe(accountId(yield* decodeCredential(synthetic, 'claude')));
	}),
);

it.effect('does not disclose tokens or arbitrary CPA metadata in account status', () =>
	Effect.gen(function* () {
		const f = fixture();
		const credential = yield* decodeCredential(synthetic, 'claude');
		yield* replaceAccount('alice', 'claude', { credential }).pipe(Effect.provide(f.ports));
		const status = yield* readAccount('alice', 'claude').pipe(Effect.provide(f.ports));
		expect(status.accounts[0]?.email).toBe(synthetic.email);
		expect(status.accounts[0]?.health.state).toBe('unknown');
		expect(status.accounts[0]?.usage.state).toBe('unavailable');
		expect(JSON.stringify(status)).not.toContain('synthetic-access');
		expect(JSON.stringify(status)).not.toContain('synthetic-refresh');
	}),
);

it.effect('removes both provider pools and keeps another owner with a similar id intact', () =>
	Effect.gen(function* () {
		const f = fixture();
		const claude = yield* decodeCredential(synthetic, 'claude');
		const codex = yield* decodeCredential(
			{
				type: 'codex',
				id_token: 'synthetic-id',
				access_token: 'synthetic-access',
				refresh_token: 'synthetic-refresh',
				email: synthetic.email,
				account_id: 'chatgpt-account',
				expired: synthetic.expired,
			},
			'codex',
		);
		for (const [owner, credential] of [
			['alice', claude],
			['alice', codex],
			['alice-team', claude],
		] as const)
			yield* replaceAccount(owner, credential.type, { credential }).pipe(Effect.provide(f.ports));
		const deleted = yield* Account.removeUserAccounts('alice').pipe(Effect.provide(f.ports));
		expect(deleted).toEqual({ state: 'disconnected', accounts: [] });
		expect([...f.stored.keys()]).toEqual([
			credentialKey('alice-team', 'claude', accountId(claude)),
		]);
	}),
);
