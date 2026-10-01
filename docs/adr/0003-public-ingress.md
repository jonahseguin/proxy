# 0003: Public ingress with proxy keys

Status: accepted

The Worker uses its workers.dev origin. Preview URLs are disabled. No custom domain is configured.

Only health is public. Provider model discovery, generation, account management, and status require an editor key. User administration requires a separate administrator key. The Worker rejects unknown paths before reaching the private container. CPA management and raw credential APIs have no public routes.

The private container accepts inference and internal management requests from the Durable Object. Its two keys are Worker secrets and are never handed to editors. Keep Cloudflare logs and CPA request logging off so provider credentials and prompts cannot enter application logs.

Model routing uses separate /claude and /codex paths with one editor key. Both resolve to the same user's isolated credential pools. HTTPS is required for remote editors such as Amp.
