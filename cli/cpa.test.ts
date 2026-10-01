import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { expect, it } from '@effect/vitest';
import { Effect } from 'effect';

import {
	cacheDirectory,
	type CpaDependencies,
	cpaVersion,
	locateCpa,
	releaseArchive,
} from './cpa.ts';

const temporaryDirectory = Effect.acquireRelease(
	Effect.promise(() => mkdtemp(join(tmpdir(), 'proxy-cpa-test-'))),
	(path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
);

function harness(home: string, fetch: CpaDependencies['fetch']) {
	const progress: string[] = [];
	const urls: string[] = [];

	const dependencies: CpaDependencies = {
		fetch: (url, init) => {
			urls.push(url);

			return fetch(url, init);
		},
		environment: { HOME: home },
		host: { platform: 'darwin', arch: 'arm64' },
		progress: (line) => {
			progress.push(line);
		},
	};

	return { progress, urls, dependencies };
}

it('names verified release archives only for supported hosts', () => {
	expect(releaseArchive({ platform: 'darwin', arch: 'arm64' })?.name).toBe(
		`CLIProxyAPI_${cpaVersion}_darwin_aarch64.tar.gz`,
	);
	expect(releaseArchive({ platform: 'linux', arch: 'x64' })?.url).toBe(
		`https://github.com/router-for-me/CLIProxyAPI/releases/download/v${cpaVersion}/CLIProxyAPI_${cpaVersion}_linux_amd64.tar.gz`,
	);
	expect(releaseArchive({ platform: 'win32', arch: 'x64' })).toBeUndefined();
	expect(releaseArchive({ platform: 'linux', arch: 'ia32' })).toBeUndefined();
	expect(cacheDirectory({ XDG_CACHE_HOME: '/cache', HOME: '/home/a' })).toBe('/cache/jonah.proxy');
	expect(cacheDirectory({ HOME: '/home/a' })).toBe('/home/a/.cache/jonah.proxy');
	expect(cacheDirectory({})).toBeUndefined();
});

it.effect('refuses an archive whose checksum differs and installs nothing', () =>
	Effect.gen(function* () {
		const home = yield* temporaryDirectory;
		const { dependencies } = harness(home, async () => new Response('not the release'));

		const result = yield* locateCpa(dependencies).pipe(Effect.flip);
		expect(result.message).toContain('does not match the pinned checksum');
		const cache = cacheDirectory(dependencies.environment) ?? '';
		expect(yield* Effect.promise(() => readdir(cache).catch(() => 'absent'))).toBe('absent');
	}),
);

it.effect('installs a verified archive once and reuses the cached binary', () =>
	Effect.gen(function* () {
		const home = yield* temporaryDirectory;
		const source = join(home, 'cli-proxy-api');
		yield* Effect.promise(() => writeFile(source, '#!/bin/sh\necho cpa\n'));
		const archive = join(home, 'release.tar.gz');
		yield* Effect.promise(() =>
			promisify(execFile)('tar', ['-czf', archive, '-C', home, 'cli-proxy-api']),
		);
		const bytes = yield* Effect.promise(() => readFile(archive));

		const release = {
			name: 'test.tar.gz',
			url: 'https://releases.example/test.tar.gz',
			digest: createHash('sha256').update(bytes).digest('hex'),
		};

		const { progress, urls, dependencies } = harness(home, async () => new Response(bytes));
		const binary = yield* locateCpa(dependencies, release);
		expect(binary).toBe(join(home, '.cache', 'jonah.proxy', `cli-proxy-api-${cpaVersion}`));
		const { stdout } = yield* Effect.promise(() => promisify(execFile)(binary));
		expect(stdout.trim()).toBe('cpa');
		expect(progress.at(-1)).toBe(`  Installed CPA ${cpaVersion}: ${binary}`);
		// The staging directory is removed after install.
		expect(yield* Effect.promise(() => readdir(join(home, '.cache', 'jonah.proxy')))).toEqual([
			`cli-proxy-api-${cpaVersion}`,
		]);

		expect(yield* locateCpa(dependencies, release)).toBe(binary);
		expect(urls).toEqual([release.url]);
		expect(progress.at(-1)).toContain('Using cached CPA');
	}),
);

it.effect('uses PROXY_CPA_BINARY without touching the network or cache', () =>
	Effect.gen(function* () {
		const home = yield* temporaryDirectory;

		const { urls, dependencies } = harness(home, async () => {
			throw new Error('Unexpected download');
		});

		dependencies.environment = { HOME: home, PROXY_CPA_BINARY: '/opt/cpa/cli-proxy-api' };
		expect(yield* locateCpa(dependencies)).toBe('/opt/cpa/cli-proxy-api');

		dependencies.environment = { HOME: home, PROXY_CPA_BINARY: 'relative/cpa' };
		const result = yield* locateCpa(dependencies).pipe(Effect.flip);
		expect(result.message).toContain('absolute path');
		expect(urls).toEqual([]);
	}),
);
