import { Effect } from 'effect';

import { handleRequest, layer } from './gateway.ts';
import { Users } from './users.ts';

export { ProxyContainer } from './runtime.ts';

export default {
	fetch(request, env) {
		return Effect.runPromise(
			handleRequest(request).pipe(
				Effect.provide(
					layer(
						{
							adminDigest: env.ADMIN_TOKEN_SHA256,
							models: { claude: env.CLAUDE_MODELS, codex: env.CODEX_MODELS },
						},
						Users.layer(env.USERS),
						(incoming) => env.PROXY.getByName('proxy').fetch(incoming),
					),
				),
			),
		);
	},
} satisfies ExportedHandler<Env>;
