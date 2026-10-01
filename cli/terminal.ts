import { spawn } from 'node:child_process';
import { stdin, stderr } from 'node:process';

import {
	type CANCEL_SYMBOL,
	confirm,
	intro,
	isCancel,
	log,
	note,
	outro,
	password,
	select,
	spinner,
} from '@clack/prompts';

import type { Choice, Spinner, Terminal } from './commands.ts';

const pipeInto = (binary: string, args: readonly string[], value: string) =>
	new Promise<boolean>((resolve) => {
		const child = spawn(binary, args, { stdio: ['pipe', 'ignore', 'ignore'] });

		child.once('error', () => resolve(false));
		child.once('exit', (code) => resolve(code === 0));
		child.stdin.end(value);
	});

/** Copies to the system clipboard; tries the Wayland and X11 tools in turn on Linux. */
async function clipboard(value: string): Promise<boolean> {
	if (process.platform === 'darwin') return pipeInto('pbcopy', [], value);

	return (
		(await pipeInto('wl-copy', [], value)) || pipeInto('xclip', ['-selection', 'clipboard'], value)
	);
}

/** Prompts render on stderr so stdout stays clean for piping keys. */
const output = { output: stderr };

/** Turns clack's cancel sentinel (Ctrl+C or Escape) into a rejection. */
const answer = <Value>(value: Value | typeof CANCEL_SYMBOL): Value => {
	if (isCancel(value)) throw new Error('Cancelled');

	return value;
};

/** Menus, masked input, and spinners for a person at a terminal. */
export const interactiveTerminal: Terminal = {
	intro: (title) => intro(title, output),
	outro: (message) => outro(message, output),
	step: (line) => log.success(line, output),
	info: (line) => log.info(line, output),
	note: (body, title) => note(body, title, output),
	select: async <Value extends string>(message: string, choices: readonly Choice<Value>[]) => {
		const chosen = answer<string>(
			await select<string>({
				message,
				options: choices.map(({ value, label, hint }) =>
					hint === undefined ? { value, label } : { value, label, hint },
				),
				...output,
			}),
		);

		// SAFETY: clack resolves with one of the supplied option values, which are all Value.
		return chosen as Value;
	},
	password: async (message) =>
		answer<string>(
			await password({
				message,
				validate: (value) => (value === undefined || value.length === 0 ? 'Required' : undefined),
				...output,
			}),
		),
	confirm: async (message) =>
		answer<boolean>(await confirm({ message, initialValue: true, ...output })),
	spinner: (message) => {
		const progress = spinner(output);
		progress.start(message);

		return progress;
	},
	clipboard,
};

const line = (text: string) => {
	stderr.write(`${text}\n`);
};

const quietSpinner = (message: string): Spinner => {
	line(message);

	return { message: line, stop: line, error: line };
};

/** Piped sessions: first choice, secret from stdin, no clipboard, plain lines. */
export const pipedTerminal: Terminal = {
	intro: line,
	outro: line,
	step: line,
	info: line,
	note: (body, title) => line(`${title}\n${body}`),
	select: async (_message, choices) => {
		const [first] = choices;

		if (first === undefined) throw new Error('No choices');

		return first.value;
	},
	password: () => new Response(stdin).text(),
	confirm: async () => false,
	spinner: quietSpinner,
	clipboard: async () => false,
};

export const terminal = stdin.isTTY ? interactiveTerminal : pipedTerminal;
