import { expect, it } from '@effect/vitest';
import { Effect, Option } from 'effect';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';

import { adminDigest } from '../src/admin.ts';
import { Digest, isUserId, UserId, Users } from '../src/users.ts';

it.live('accepts short lowercase ids and rejects anything a path or file name could confuse', () =>
	Effect.sync(() => {
		for (const id of ['a', 'alice', 'bob-2', 'x'.repeat(32)]) expect(isUserId(id), id).toBe(true);

		for (const id of ['', 'Alice', '-a', '1a', 'a/b', 'a.json', 'a b', 'x'.repeat(33)])
			expect(isUserId(id), id).toBe(false);
	}),
);

it.effect(
	'resolves keys to users in real local KV, and revokes old keys on rotation or removal',
	() =>
		Effect.gen(function* () {
			const mf = yield* Effect.acquireRelease(
				Effect.sync(
					() =>
						new Miniflare(
							convertV4MiniflareOptions({
								modules: true,
								script: 'export default {fetch() {return new Response()}}',
								kvNamespaces: ['USERS'],
								compatibilityDate: '2026-08-22',
							}),
						),
				),
				(value) => Effect.promise(() => value.dispose()),
			);

			const kv = yield* Effect.promise(() => mf.getKVNamespace('USERS'));

			yield* Effect.gen(function* () {
				const users = yield* Users.Service;
				const alice = UserId.make('alice');
				const bob = UserId.make('bob');

				expect(Option.isNone(yield* users.find('alice-1'))).toBe(true);
				expect(yield* users.list()).toEqual([]);

				yield* users.register(alice, Digest.make(adminDigest('alice-1')));
				yield* users.register(bob, Digest.make(adminDigest('bob-1')));
				expect(yield* users.find('alice-1')).toEqual(Option.some(alice));
				expect(yield* users.find('bob-1')).toEqual(Option.some(bob));
				expect(Option.isNone(yield* users.find(adminDigest('alice-1')))).toBe(true);
				expect(yield* users.list()).toEqual([alice, bob]);

				yield* users.register(alice, Digest.make(adminDigest('alice-2')));
				expect(Option.isNone(yield* users.find('alice-1'))).toBe(true);
				expect(yield* users.find('alice-2')).toEqual(Option.some(alice));
				expect(yield* users.list()).toEqual([alice, bob]);

				// A rotation interrupted after writing the new mapping leaves the old one in KV.
				// It must not authenticate, and the lookup removes it.
				const stale = `key:${adminDigest('alice-1')}`;
				yield* Effect.promise(() => kv.put(stale, 'alice'));
				expect(Option.isNone(yield* users.find('alice-1'))).toBe(true);
				expect(yield* Effect.promise(() => kv.get(stale))).toBeNull();
				expect(yield* users.find('alice-2')).toEqual(Option.some(alice));

				expect(yield* users.has(alice)).toBe(true);
				expect(yield* users.remove(alice)).toBe(true);
				expect(yield* users.has(alice)).toBe(false);
				expect(yield* users.remove(alice)).toBe(false);
				expect(Option.isNone(yield* users.find('alice-2'))).toBe(true);
				expect(yield* users.find('bob-1')).toEqual(Option.some(bob));
				expect(yield* users.list()).toEqual([bob]);
			}).pipe(Effect.provide(Users.layer(kv)));
		}),
);

it.effect('lists every page of the registry, not only the first', () =>
	Effect.gen(function* () {
		const pages = new Map<string, Users.KeyValuePage>([
			[
				'first',
				{
					keys: [{ name: 'user:carol' }, { name: 'user:alice' }],
					list_complete: false,
					cursor: 'second',
				},
			],
			['second', { keys: [{ name: 'user:bob' }, { name: 'user:Bad' }], list_complete: true }],
		]);

		const requested: (string | null | undefined)[] = [];

		const store: Users.KeyValueStore = {
			get: () => Promise.reject(new Error('unused')),
			put: () => Promise.reject(new Error('unused')),
			delete: () => Promise.reject(new Error('unused')),
			list: ({ prefix, cursor }) => {
				expect(prefix).toBe('user:');
				requested.push(cursor);

				return Promise.resolve(pages.get(cursor ?? 'first') ?? { keys: [], list_complete: true });
			},
		};

		const users = yield* Users.Service.pipe(Effect.provide(Users.layer(store)));

		expect(yield* users.list()).toEqual(['alice', 'bob', 'carol']);
		expect(requested).toEqual([null, 'second']);
	}),
);
