import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';

import { deployment } from '../deployment.ts';

export interface WorkerTarget {
	worker: string;
	accountId: string;
}

export interface WorkerSecret {
	name: 'ADMIN_TOKEN_SHA256';
	digest: string;
}

export const workerTarget = (): WorkerTarget => deployment;

const runCf = async (args: string[], accountId: string): Promise<void> => {
	const env: Record<string, string> = { CLOUDFLARE_ACCOUNT_ID: accountId };
	for (const key of ['PATH', 'HOME', 'USER', 'LANG', 'XDG_CONFIG_HOME']) {
		const value = process.env[key];
		if (value !== undefined) env[key] = value;
	}
	await promisify(execFile)('cf', args, { cwd: tmpdir(), env, timeout: 60_000 });
};

export async function syncWorkerKey(
	input: WorkerTarget & WorkerSecret,
	dependencies: { run(args: string[], accountId: string): Promise<void> } = { run: runCf },
): Promise<void> {
	if (
		!/^[a-z0-9-]{1,63}$/.test(input.worker) ||
		!/^[a-f0-9]{32}$/.test(input.accountId) ||
		!/^[a-f0-9]{64}$/.test(input.digest)
	)
		throw new Error('Sync requires a Worker name, a Cloudflare account ID, and a digest.');
	try {
		await dependencies.run(
			[
				'workers',
				'secrets',
				'update',
				input.name,
				'--worker',
				input.worker,
				'--type',
				'secret_text',
				'--text',
				input.digest,
			],
			input.accountId,
		);
	} catch {
		throw new Error('Cloudflare rejected the key update.');
	}
}
