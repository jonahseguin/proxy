#!/usr/bin/env bun
import { secrets } from 'bun';
import { Effect } from 'effect';

import { syncWorkerKey, workerTarget } from './cloudflare.ts';
import { commandName, keyCommands, runCli } from './commands.ts';
import { terminal } from './terminal.ts';

const args = process.argv.slice(2);

const bare = !process.stdout.isTTY && keyCommands.has(commandName(args).name);

await Effect.runPromise(
	runCli(args, {
		secrets,
		fetch: globalThis.fetch,
		terminal,
		host: { platform: process.platform, arch: process.arch },
		loginEnvironment: process.env,
		syncDigest: async (secret) => syncWorkerKey({ ...secret, ...workerTarget() }),
	}).pipe(
		Effect.match({
			onSuccess: (message) => {
				if (message !== '') process.stdout.write(bare ? message : `${message}\n`);
			},
			onFailure: (error) => {
				process.stderr.write(`${error.message}\n`);
				process.exitCode = 1;
			},
		}),
	),
);
