import { Data } from 'effect';
import { none } from 'stream-chain/core';
import { jsonParser, type Token } from 'stream-json/core/parser.js';
import stringer from 'stream-json/core/stringer.js';

export const inferenceBodyLimit = 32 * 1024 * 1024;
export const modelHeader = 'x-proxy-model';
const rewrittenBodyLimit = 33 * 1024 * 1024;
const retainedBodyLimit = 64 * 1024 * 1024;
const pageSize = 64 * 1024;
const parserChunkSize = 8 * 1024;
let retainedBytes = 0;

export class BodyError extends Data.TaggedError('Gateway.BodyError')<{
	readonly status: 400 | 413 | 503;
}> {}

export async function inferenceBody(request: Request, owner: string) {
	if (request.body === null) throw new BodyError({ status: 400 });
	const reader = request.body.getReader();
	const cancel = () => {
		void reader.cancel().catch(() => undefined);
	};
	request.signal.addEventListener('abort', cancel, { once: true });
	const pages: Uint8Array[] = [];
	let page: Uint8Array | undefined;
	let used = 0;
	let allocation = 0;
	let size = 0;
	let inputSize = 0;
	let disposed = false;
	const dispose = () => {
		if (disposed) return;
		disposed = true;
		retainedBytes -= allocation;
		allocation = 0;
		pages.length = 0;
		page = undefined;
		request.signal.removeEventListener('abort', dispose);
	};
	const encoder = new TextEncoder();
	const append = (text: string) => {
		const bytes = encoder.encode(text);
		size += bytes.byteLength;
		if (size > rewrittenBodyLimit) throw new BodyError({ status: 413 });
		let offset = 0;
		while (offset < bytes.byteLength) {
			if (page === undefined || used === pageSize) {
				if (retainedBytes + pageSize > retainedBodyLimit) throw new BodyError({ status: 503 });
				retainedBytes += pageSize;
				allocation += pageSize;
				page = new Uint8Array(pageSize);
				pages.push(page);
				used = 0;
			}
			const count = Math.min(pageSize - used, bytes.byteLength - offset);
			page.set(bytes.subarray(offset, offset + count), used);
			used += count;
			offset += count;
		}
	};
	const parse = jsonParser({ packValues: false });
	const stringify = stringer();
	const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
	let depth = 0;
	let rootSeen = false;
	let rootKey: string | undefined;
	let readingKey = false;
	let readingModel = false;
	let modelSeen = false;
	let model = '';
	const token = (value: Token) => {
		if (!rootSeen) {
			if (value.name !== 'startObject') throw new BodyError({ status: 400 });
			rootSeen = true;
		}
		if (depth === 1 && value.name === 'startKey') {
			rootKey = '';
			readingKey = true;
		} else if (readingKey && value.name === 'stringChunk') {
			rootKey = (rootKey + value.value).slice(0, 6);
		} else if (readingKey && value.name === 'endKey') {
			readingKey = false;
			if (rootKey === 'model') {
				if (modelSeen) throw new BodyError({ status: 400 });
				modelSeen = true;
			}
		} else if (depth === 1 && rootKey === 'model' && !readingModel) {
			if (value.name !== 'startString') throw new BodyError({ status: 400 });
			readingModel = true;
		} else if (readingModel && value.name === 'stringChunk') {
			model += value.value;
			if (model.length > 256) throw new BodyError({ status: 400 });
		} else if (readingModel && value.name === 'endString') {
			if (model.length === 0) throw new BodyError({ status: 400 });
			readingModel = false;
			rootKey = undefined;
		}
		if (value.name === 'startObject' || value.name === 'startArray') {
			if (++depth > 128) throw new BodyError({ status: 400 });
		} else if (value.name === 'endObject' || value.name === 'endArray') {
			depth--;
		}
		const text = stringify(value);
		if (value.name === 'stringChunk') {
			append(JSON.stringify(value.value).slice(1, -1));
		} else if (text !== none) {
			append(text);
		}
		if (readingModel && value.name === 'startString')
			append(JSON.stringify(`${owner}/`).slice(1, -1));
	};
	const consume = (text: string | typeof none) => {
		const tokens = parse(text);
		if (tokens !== none) for (const value of tokens.values) token(value);
	};
	try {
		const length = request.headers.get('content-length');
		if (length !== null && /^\d+$/.test(length) && Number(length) > inferenceBodyLimit)
			throw new BodyError({ status: 413 });
		while (true) {
			request.signal.throwIfAborted();
			const chunk = await reader.read();
			request.signal.throwIfAborted();
			if (chunk.done) break;
			inputSize += chunk.value.byteLength;
			if (inputSize > inferenceBodyLimit) throw new BodyError({ status: 413 });
			for (let offset = 0; offset < chunk.value.byteLength; offset += parserChunkSize)
				consume(
					decoder.decode(chunk.value.subarray(offset, offset + parserChunkSize), { stream: true }),
				);
		}
		consume(decoder.decode());
		consume(none);
		if (!modelSeen || model.length === 0 || depth !== 0) throw new BodyError({ status: 400 });
	} catch (error) {
		dispose();
		await reader.cancel().catch(() => undefined);
		throw error instanceof BodyError ? error : new BodyError({ status: 400 });
	} finally {
		request.signal.removeEventListener('abort', cancel);
		reader.releaseLock();
	}
	let index = 0;
	let handedOff = false;
	const body = new ReadableStream<Uint8Array>(
		{
			pull(controller) {
				if (disposed) {
					controller.close();
					return;
				}
				if (handedOff) {
					retainedBytes -= pageSize;
					allocation -= pageSize;
					handedOff = false;
				}
				if (disposed || index === pages.length) {
					dispose();
					controller.close();
					return;
				}
				const next = pages[index]!;
				pages[index++] = new Uint8Array(0);
				handedOff = true;
				controller.enqueue(index === pages.length ? next.subarray(0, used) : next);
			},
			cancel: dispose,
		},
		{ highWaterMark: 0 },
	);
	page = undefined;
	request.signal.addEventListener('abort', dispose, { once: true });
	if (request.signal.aborted) dispose();
	return { model, body, dispose };
}
