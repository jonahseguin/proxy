import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, chmod, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import { Data, Effect } from 'effect';

/** CLIProxyAPI release used for local Claude logins. Matches the container image tag. */
export const cpaVersion = '7.3.15';

/** Release checksums for the archives this CLI can install, keyed by `<platform>_<cpu>`. */
const archiveDigests = {
	darwin_aarch64: 'c1e49c148a94c476dc43a6a0eed28bca34239d5153ebb7792048d8c18f3b92f0',
	darwin_amd64: '1dd2f2f5d57c2c9172eb51837d07f1f014d02ab1093215401a00c61d942bb972',
	linux_aarch64: '0b147342517b2f0f0cb80a4630e4f863cdd531fa0e90986f30a437c81ba82e75',
	linux_amd64: '801c3a23061d57a830e67fcd033fda26e96c2bfe93e1b2e34e4428ed7defc7e5',
} satisfies Record<string, string>;

const isArchiveTarget = (target: string): target is keyof typeof archiveDigests =>
	Object.hasOwn(archiveDigests, target);

/** Release asset CPU names for Node architecture names. */
const releaseCpu = { arm64: 'aarch64', x64: 'amd64' } satisfies Record<string, string>;

const isReleaseArch = (arch: string): arch is keyof typeof releaseCpu =>
	Object.hasOwn(releaseCpu, arch);

export class CpaError extends Data.TaggedError('CpaError')<{ readonly message: string }> {}

export interface Host {
	platform: string;
	arch: string;
}

export interface CpaDependencies {
	fetch(url: string, init: RequestInit): Promise<Response>;
	environment: Record<string, string | undefined>;
	host: Host;
	progress(line: string): void;
}

export interface ReleaseArchive {
	name: string;
	digest: string;
	url: string;
}

/** Release archive for a host, or undefined when no verified build exists for it. */
export const releaseArchive = ({ platform, arch }: Host): ReleaseArchive | undefined => {
	if (!isReleaseArch(arch)) return undefined;
	const target = `${platform}_${releaseCpu[arch]}`;

	if (!isArchiveTarget(target)) return undefined;
	const name = `CLIProxyAPI_${cpaVersion}_${target}.tar.gz`;

	return {
		name,
		digest: archiveDigests[target],
		url: `https://github.com/router-for-me/CLIProxyAPI/releases/download/v${cpaVersion}/${name}`,
	};
};

/** Where downloaded binaries live: `$XDG_CACHE_HOME/jonah.proxy` or `~/.cache/jonah.proxy`. */
export const cacheDirectory = (
	environment: Record<string, string | undefined>,
): string | undefined => {
	const base =
		environment['XDG_CACHE_HOME'] ??
		(environment['HOME'] === undefined ? undefined : join(environment['HOME'], '.cache'));

	return base === undefined ? undefined : join(base, 'jonah.proxy');
};

const exists = (path: string) =>
	access(path).then(
		() => true,
		() => false,
	);

const extract = (archive: string, directory: string) =>
	new Promise<void>((resolve, reject) => {
		const child = spawn('tar', ['-xzf', archive, '-C', directory, 'cli-proxy-api'], {
			stdio: 'ignore',
			timeout: 120_000,
		});

		child.once('error', reject);
		child.once('exit', (code) => {
			if (code === 0) resolve();
			else reject(new Error('Extraction failed'));
		});
	});

/**
 * Finds a CPA binary: `PROXY_CPA_BINARY`, then the cache, then a verified download.
 * A download whose checksum does not match the pinned release installs nothing.
 */
export const locateCpa = Effect.fn('CPA.locate')(function* (
	dependencies: CpaDependencies,
	archive = releaseArchive(dependencies.host),
) {
	const override = dependencies.environment['PROXY_CPA_BINARY'];

	if (override !== undefined) {
		if (!isAbsolute(override))
			return yield* Effect.fail(
				new CpaError({ message: 'PROXY_CPA_BINARY must be an absolute path.' }),
			);
		dependencies.progress(`  Using CPA from PROXY_CPA_BINARY: ${override}`);

		return override;
	}

	const cache = cacheDirectory(dependencies.environment);

	if (cache === undefined || archive === undefined)
		return yield* Effect.fail(
			new CpaError({
				message: `No verified CPA ${cpaVersion} build for ${dependencies.host.platform}/${dependencies.host.arch}. Set PROXY_CPA_BINARY to a CPA ${cpaVersion} binary.`,
			}),
		);
	const binary = join(cache, `cli-proxy-api-${cpaVersion}`);

	if (yield* Effect.promise(() => exists(binary))) {
		dependencies.progress(`  Using cached CPA ${cpaVersion}: ${binary}`);

		return binary;
	}

	dependencies.progress(`  Downloading CPA ${cpaVersion} (${archive.name})...`);

	const bytes = yield* Effect.tryPromise({
		try: async (signal) => {
			const response = await dependencies.fetch(archive.url, {
				method: 'GET',
				redirect: 'follow',
				signal,
			});

			if (!response.ok) throw new Error(`HTTP ${response.status}`);

			return new Uint8Array(await response.arrayBuffer());
		},
		catch: () => new CpaError({ message: 'CPA download failed. Nothing was installed.' }),
	}).pipe(
		Effect.timeout('5 minutes'),
		Effect.mapError(() => new CpaError({ message: 'CPA download failed. Nothing was installed.' })),
	);

	if (createHash('sha256').update(bytes).digest('hex') !== archive.digest)
		return yield* Effect.fail(
			new CpaError({
				message: `Downloaded ${archive.name} does not match the pinned checksum. Nothing was installed.`,
			}),
		);

	return yield* Effect.tryPromise({
		try: async () => {
			await mkdir(cache, { recursive: true, mode: 0o700 });
			const staging = await mkdtemp(join(cache, 'download-'));

			try {
				const path = join(staging, archive.name);
				await writeFile(path, bytes, { mode: 0o600 });
				await extract(path, staging);
				await chmod(join(staging, 'cli-proxy-api'), 0o755);
				await rename(join(staging, 'cli-proxy-api'), binary);
			} finally {
				await rm(staging, { recursive: true, force: true });
			}

			dependencies.progress(`  Installed CPA ${cpaVersion}: ${binary}`);

			return binary;
		},
		catch: () => new CpaError({ message: 'Could not install the downloaded CPA archive.' }),
	});
});
