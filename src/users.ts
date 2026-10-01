export * as Users from './users.ts';

import { Context, Data, Effect, Layer, Option, Ref, Schema } from 'effect';

import { adminDigest } from './admin.ts';

export const UserId = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,31}$/)).pipe(
	Schema.brand('UserId'),
);

export type UserId = typeof UserId.Type;

export const isUserId = Schema.is(UserId);

export const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));

export type Digest = typeof Digest.Type;

export const isDigest = Schema.is(Digest);

export class RegistryError extends Data.TaggedError('Users.RegistryError')<{
	readonly operation: string;
}> {}

export interface Interface {
	readonly find: (key: string) => Effect.Effect<Option.Option<UserId>, RegistryError>;
	readonly has: (id: UserId) => Effect.Effect<boolean, RegistryError>;
	readonly register: (id: UserId, digest: Digest) => Effect.Effect<void, RegistryError>;
	readonly remove: (id: UserId) => Effect.Effect<boolean, RegistryError>;
	readonly list: () => Effect.Effect<readonly UserId[], RegistryError>;
}

export class Service extends Context.Service<Service, Interface>()('proxy/Users') {}

export interface TestInterface extends Interface {
	readonly failNextFind: () => Effect.Effect<void>;
}

export class TestService extends Context.Service<TestService, TestInterface>()(
	'proxy/Users/Test',
) {}

/** The subset of `KVNamespace` the registry needs; Miniflare test handles satisfy it too. */
export interface KeyValueStore {
	get(key: string): Promise<string | null>;
	put(key: string, value: string): Promise<void>;
	delete(key: string): Promise<void>;
	list(options: { prefix: string; cursor?: string | null }): Promise<KeyValuePage>;
}

export type KeyValuePage =
	| { keys: { name: string }[]; list_complete: true }
	| { keys: { name: string }[]; list_complete: false; cursor: string };

const keyEntry = (digest: string) => `key:${digest}`;

const userEntry = (id: string) => `user:${id}`;

const stored = <A>(operation: string, work: () => Promise<A>) =>
	Effect.tryPromise({
		try: work,
		catch: () => new RegistryError({ operation }),
	});

export const layer = (kv: KeyValueStore): Layer.Layer<Service> =>
	Layer.sync(Service, () => {
		// `user:<id>` holds the one current digest. A `key:` mapping only authenticates while it
		// agrees with that record, so a mapping left behind by an interrupted rotation is inert.
		const find = Effect.fn('Users.find')(function* (key: string) {
			const digest = adminDigest(key);
			const id = yield* stored('Users.find', () => kv.get(keyEntry(digest)));

			if (id === null) return Option.none();
			const user = Schema.decodeUnknownOption(UserId)(id);

			if (Option.isNone(user)) return Option.none();
			const current = yield* stored('Users.find', () => kv.get(userEntry(user.value)));

			if (current === digest) return user;

			yield* stored('Users.find', () => kv.delete(keyEntry(digest))).pipe(Effect.ignore);

			return Option.none();
		});

		const has = Effect.fn('Users.has')(function* (id: UserId) {
			return (yield* stored('Users.has', () => kv.get(userEntry(id)))) !== null;
		});

		const register = Effect.fn('Users.register')(function* (id: UserId, digest: Digest) {
			const previous = yield* stored('Users.register', () => kv.get(userEntry(id)));

			// The mapping first, then the record that activates it: a failure in between leaves the
			// previous key working and the new one inert, and a retry completes the rotation.
			yield* stored('Users.register', () => kv.put(keyEntry(digest), id));
			yield* stored('Users.register', () => kv.put(userEntry(id), digest));

			if (previous !== null && previous !== digest)
				yield* stored('Users.register', () => kv.delete(keyEntry(previous)));
		});

		const remove = Effect.fn('Users.remove')(function* (id: UserId) {
			const digest = yield* stored('Users.remove', () => kv.get(userEntry(id)));

			if (digest === null) return false;
			yield* stored('Users.remove', () => kv.delete(keyEntry(digest)));
			yield* stored('Users.remove', () => kv.delete(userEntry(id)));

			return true;
		});

		const list = Effect.fn('Users.list')(function* () {
			const ids: UserId[] = [];
			let cursor: string | null = null;

			do {
				const page = yield* stored('Users.list', () => kv.list({ prefix: 'user:', cursor }));

				for (const entry of page.keys) {
					const id = Schema.decodeUnknownOption(UserId)(entry.name.slice('user:'.length));

					if (Option.isSome(id)) ids.push(id.value);
				}

				cursor = page.list_complete ? null : page.cursor;
			} while (cursor !== null);

			return ids.toSorted();
		});

		return Service.of({ find, has, register, remove, list });
	});

export const testLayer = (
	initial: Record<string, string> = {},
): Layer.Layer<Service | TestService> =>
	Layer.effectContext(
		Effect.gen(function* () {
			const digests = yield* Ref.make(
				new Map(
					Object.entries(initial).map(([id, key]) => [UserId.make(id), adminDigest(key)] as const),
				),
			);

			const failFind = yield* Ref.make(false);

			const service = TestService.of({
				find: Effect.fn('Users.Test.find')(function* (key: string) {
					if (yield* Ref.getAndSet(failFind, false))
						return yield* new RegistryError({ operation: 'Users.find' });
					const digest = adminDigest(key);

					for (const [id, storedDigest] of yield* Ref.get(digests)) {
						if (storedDigest === digest) return Option.some(id);
					}

					return Option.none();
				}),
				has: Effect.fn('Users.Test.has')(function* (id: UserId) {
					return (yield* Ref.get(digests)).has(id);
				}),
				register: Effect.fn('Users.Test.register')(function* (id: UserId, digest: Digest) {
					yield* Ref.update(digests, (current) => new Map(current).set(id, digest));
				}),
				remove: Effect.fn('Users.Test.remove')(function* (id: UserId) {
					const current = yield* Ref.get(digests);

					if (!current.has(id)) return false;
					yield* Ref.update(digests, (value) => {
						const next = new Map(value);
						next.delete(id);

						return next;
					});

					return true;
				}),
				list: Effect.fn('Users.Test.list')(function* () {
					return [...(yield* Ref.get(digests)).keys()].toSorted();
				}),
				failNextFind: Effect.fn('Users.Test.failNextFind')(function* () {
					yield* Ref.set(failFind, true);
				}),
			});

			return Context.empty().pipe(Context.add(Service, service), Context.add(TestService, service));
		}),
	);
