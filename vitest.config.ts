import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		include: ['tests/**/*.test.ts', 'cli/**/*.test.ts'],
		// The KV and R2 tests boot a Miniflare instance each; CI runners take several seconds.
		testTimeout: 30_000,
	},
});
