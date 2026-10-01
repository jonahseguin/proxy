import { defineConfig } from 'oxfmt';

export default defineConfig({
	ignorePatterns: ['node_modules', 'dist', '.wrangler', '.cloudflare', '.local', 'docs'],
	singleQuote: true,
	sortImports: true,
	useTabs: true,
});
