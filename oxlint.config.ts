import { defineConfig } from 'oxlint';

export default defineConfig({
	categories: { correctness: 'error', suspicious: 'warn' },
	plugins: ['typescript', 'unicorn', 'oxc'],
	ignorePatterns: ['src/env.d.ts', 'dist/**', '.wrangler/**', '.cloudflare/**', '.local/**'],
});
