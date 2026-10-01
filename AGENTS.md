# Proxy

Read [README.md](README.md) before changing account or editor-key lifecycle.
This is a TypeScript Worker with a private CPA container. Its public origins
are sanctioned by [ADR 0003](docs/adr/0003-public-ingress.md); deployment is
a manual `cf deploy`, not a CI job.

- Keep CPA pinned and unchanged. Validate editor authorization, routes, models,
  and request size in the Worker before obtaining the Durable Object.
- Account mutations stop CPA before changing R2. Report success only after
  read-back confirms the write or deletion. Preserve the recovery-required gate.
- Forward generation requests once. Preserve streamed tool data and propagate
  cancellation across the Worker, Durable Object, and container boundaries.
- Runtime tests use Docker and synthetic credentials. Keep them serial because
  Miniflare instances share Docker container names. A Worker restart does not
  imply a container restart. Local workerd on Linux notices a vanished client
  only on its next write, so keep a held upstream stream flowing when a test
  waits for cancellation to propagate.
- Use synthetic tests for routine verification. Live OAuth, provider requests,
  and deployment require separate authorization. Keep credentials and message
  content out of test output.
- Verify with `bun run typecheck`, `bun run lint`, `bun run test`, and
  `bun run format:check`.
