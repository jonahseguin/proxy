import { expect, it } from 'vitest';

import { BodyError, inferenceBody } from '../src/inference-body.ts';

const request = (body: string) => new Request('http://proxy.test', { method: 'POST', body });

it('preserves nested models, escaped keys, surrogate pairs and lone surrogates', async () => {
	const input =
		'{"mo\\u0064el":"gpt-5.4","nested":{"model":"unchanged"},"text":"\\ud83d\\ude00\\ud800"}';
	const decoded = await inferenceBody(request(input), 'alice');
	const value = await new Response(decoded.body).json();
	expect(value).toEqual({ ...JSON.parse(input), model: 'alice/gpt-5.4' });
});

it.each([
	'{"model":"gpt-5.4","mo\\u0064el":"gpt-5.4"}',
	'{"model":"gpt-5.4"} trailing',
	'{"model":"gpt-5.4",}',
	'{"model":"gpt-5.4","data":[1,]}',
	'{"model":"gpt-5.4"',
	JSON.stringify({ model: 'x'.repeat(257) }),
	'{"model":"gpt-5.4","nested":' + '['.repeat(128) + '0' + ']'.repeat(128) + '}',
])('rejects ambiguous, malformed or structurally excessive input', async (input) => {
	await expect(inferenceBody(request(input), 'alice')).rejects.toMatchObject({ status: 400 });
});

it('releases capacity after disposal following one handed-off page and a later pull', async () => {
	const input = JSON.stringify({ model: 'gpt-5.4', data: 'A'.repeat(1024 * 1024) });
	for (let index = 0; index < 70; index++) {
		const decoded = await inferenceBody(request(input), 'alice');
		const reader = decoded.body.getReader();
		expect((await reader.read()).value!.byteLength).toBe(64 * 1024);
		decoded.dispose();
		expect((await reader.read()).done).toBe(true);
		reader.releaseLock();
	}
	const retained = [];
	try {
		for (let index = 0; index < 60; index++)
			retained.push(await inferenceBody(request(input), 'alice'));
		await expect(inferenceBody(request(input), 'alice')).rejects.toBeInstanceOf(BodyError);
		await expect(inferenceBody(request(input), 'alice')).rejects.toMatchObject({ status: 503 });
	} finally {
		for (const decoded of retained) decoded.dispose();
	}
	const recovered = await inferenceBody(request(input), 'alice');
	await recovered.body.cancel();
});

it.each([false, true])(
	'cancels a stalled validation reader after incomplete or complete JSON',
	async (complete) => {
		let cancelled = false;
		let first = true;
		const abort = new AbortController();
		const stream = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (first) {
					first = false;
					controller.enqueue(
						new TextEncoder().encode(
							'{"model":"gpt-5.4","data":"' + 'A'.repeat(128 * 1024) + (complete ? '"}' : ''),
						),
					);
				}
			},
			cancel() {
				cancelled = true;
			},
		});
		const pending = inferenceBody(
			new Request('http://proxy.test', {
				method: 'POST',
				body: stream,
				signal: abort.signal,
				duplex: 'half',
			} as RequestInit),
			'alice',
		);
		await new Promise((resolve) => setTimeout(resolve, 0));
		abort.abort();
		await expect(pending).rejects.toMatchObject({ status: 400 });
		expect(cancelled).toBe(true);
		const next = await inferenceBody(request('{"model":"gpt-5.4"}'), 'alice');
		await next.body.cancel();
	},
);
