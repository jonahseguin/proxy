import { bindings, defineConfig, defineContainer, exports } from 'cf/config';

import { deployment } from './deployment.ts';

const proxy = defineContainer({
	name: 'proxy-cpa',
	image: { dockerfile: './Dockerfile' },
	instanceType: 'lite',
	maxInstances: 1,
});

export default defineConfig({
	accountId: deployment.accountId,
	containers: [proxy],
	worker: {
		name: deployment.worker,
		compatibilityDate: '2026-08-22',
		compatibilityFlags: ['nodejs_compat', 'enable_request_signal'],
		entrypoint: 'src/index.ts',
		workersDev: true,
		previewUrls: false,
		observability: {
			enabled: true,
			redactQueryString: true,
			logs: { enabled: true, invocationLogs: false, persist: true, headSamplingRate: 1 },
			traces: { enabled: false },
			issues: { enabled: false },
		},
		exports: { ProxyContainer: exports.durableObject({ storage: 'sqlite', container: proxy }) },
		env: {
			CLAUDE_MODELS: bindings.json(['claude-fable-5-1', 'claude-opus-5', 'claude-opus-5-5']),
			CODEX_MODELS: bindings.json([
				'gpt-6.1-sol',
				'gpt-6-astra',
				'gpt-6-sol',
				'gpt-6-luna',
				'gpt-5.6-sol',
				'gpt-5.6-terra',
				'gpt-5.6-luna',
				'gpt-5.5',
			]),
			ADMIN_TOKEN_SHA256: bindings.secret(),
			CPA_API_KEY: bindings.secret(),
			CPA_MANAGEMENT_KEY: bindings.secret(),
			OBJECTSTORE_ENDPOINT: bindings.secret(),
			OBJECTSTORE_BUCKET: bindings.secret(),
			OBJECTSTORE_ACCESS_KEY: bindings.secret(),
			OBJECTSTORE_SECRET_KEY: bindings.secret(),
			USERS: bindings.kv({ id: 'a228d82cdb0e4db9bda2c86bbb8383db' }),
			CREDENTIALS: bindings.r2({ name: 'proxy-credentials' }),
			PROXY: bindings.durableObject({ worker: deployment.worker, exportName: 'ProxyContainer' }),
		},
	},
});
