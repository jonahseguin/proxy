const stages = new Set([
	'startup-storage',
	'startup-ports',
	'startup-models',
	'startup-timestamp',
	'model-signal-create',
	'model-signal-check',
	'model-credential-list',
	'model-credential-list-result',
	'model-poll-wait',
	'account-state',
	'runtime-readiness',
	'requested-model',
	'model-readiness',
	'generation-forward',
]);
const names = new Set([
	'Error',
	'TypeError',
	'RangeError',
	'SyntaxError',
	'AbortError',
	'TimeoutError',
	'DataCloneError',
	'InvalidStateError',
]);
const messages = new Set([
	'Durable Object reset because its code was updated.',
	'The operation was aborted.',
	'The operation timed out.',
	'Runtime unavailable',
	'Management unavailable',
	'Network connection lost.',
]);

export function runtimeFailure(stage: string, error: unknown): void {
	const caught = error instanceof Error ? error : null;
	const location = caught?.stack?.match(/\b(?:index|worker)\.js:\d+:\d+\b/)?.[0] ?? null;
	console.error(
		JSON.stringify({
			type: 'proxy-runtime-error',
			stage: stages.has(stage) ? stage : 'unknown',
			name: caught && names.has(caught.name) ? caught.name : 'Error',
			message:
				caught && messages.has(caught.message) ? caught.message : 'Unclassified runtime error',
			location,
		}),
	);
}
