# 0002: Use Cloudflare with explicit reconnect recovery

Status: accepted

## Requirement

Use Cloudflare Containers and private R2 storage with unchanged CPA. The single
user accepts that a failed refresh upload followed by disk loss may require
reconnecting Claude. Account disconnect must not report success unless durable
deletion succeeds. Integration must remain modest.

## Evidence

The [reproduction probe](../../probes/credential-persistence/README.md) runs
unchanged upstream store and auth-manager code against a disposable S3 fixture.
It restores credentials into a fresh directory through CPA's auth-download
routine. It uses synthetic tokens, not a provider login or live R2 bucket.

The inspected release baseline is
[CPA v7.3.8](https://github.com/router-for-me/CLIProxyAPI/tree/c93978c4ea2e908255a2a06c37599fda3651554a).
[v7.3.9](https://github.com/router-for-me/CLIProxyAPI/tree/61fdfc341b96178a8dcb53f2efc46cbc341d267c)
does not change the relevant object-store, manager-persistence, or watcher code.
[v7.3.15](https://github.com/router-for-me/CLIProxyAPI/tree/673131f57484517c3a1eae7e36c4cfa7b9bb4efc)
leaves the object store unchanged; its manager and watcher changes add a
scheduler epoch counter and provider attributes, not persistence behavior.
All six probe tests passed on each pinned release with the outcomes below.

The probe checks these outcomes:

| Scenario | Observed behavior on v7.3.8, v7.3.9, and v7.3.15 |
| --- | --- |
| Successful initial write, rotation, replacement | Fresh disk restores the latest token |
| Successful deletion | Fresh disk restores no credential |
| Upload fails, then identical Save succeeds | No second upload; fresh disk restores the old token |
| Manager installs refreshed credential while uploads fail | Manager returns success; remote token remains old |
| Explicit PersistAuthFiles retry after recovery | Repairs remote state while local disk survives |
| Remote deletion fails | Fresh disk restores the credential; explicit deletion retry repairs it |
| Two independent stores write the same credential | Last writer wins without fencing |

The negative cases are characterization tests: PASS means the defect was
reproduced, not that the implementation is safe.

Sources at the pinned revision:

- [ObjectTokenStore.Save](https://github.com/router-for-me/CLIProxyAPI/blob/c93978c4ea2e908255a2a06c37599fda3651554a/internal/store/objectstore.go#L158-L241)
  writes the local mirror before upload and can skip upload when local JSON matches.
- [Manager.updateInternal](https://github.com/router-for-me/CLIProxyAPI/blob/c93978c4ea2e908255a2a06c37599fda3651554a/sdk/cliproxy/auth/conductor_lifecycle.go#L250-L278)
  discards persistence errors for non-Meta providers, including Claude.
- [Watcher.persistAuthAsync](https://github.com/router-for-me/CLIProxyAPI/blob/c93978c4ea2e908255a2a06c37599fda3651554a/internal/watcher/clients.go#L444-L464)
  makes one asynchronous persistence call and logs failure, without durable retries.
- [PostgresStore.Save](https://github.com/router-for-me/CLIProxyAPI/blob/c93978c4ea2e908255a2a06c37599fda3651554a/internal/store/postgresstore.go#L210-L295)
  has the same local-equality shortcut. PostgreSQL alone is not a source-level fix.

## Decision

Proceed with Cloudflare. Do not add a CPA fork, periodic copier, or VM migration
for the observed refresh-persistence failure. Keep the reproduction tests.

CPA automatically exchanges refresh tokens before access tokens expire; routine
expiry does not require user interaction. The source does not establish whether
Claude invalidates an old refresh token when issuing a replacement. After loss
of an unsaved refresh, the older durable token may still work. If it does not,
the user explicitly reconnects through the CLI. The tests prove stale durable
state, not that every missed upload causes a logout.

This accepted recovery risk does not permit false success for account import or
disconnect. Those commands must write through to R2, report storage failures,
and prevent a running CPA process from restoring the previous account.

## Single writer and security

Allow one active refresh writer per account. Stop the old CPA process before
starting its replacement; do not assume a maximum-instance setting fences
overlapping rollout revisions. The probe shows why independent replicas are
unsafe, but does not verify Cloudflare's actual rollout lifecycle.

Use a private bucket and bucket-scoped credentials. R2's
platform encryption at rest is not application-level encryption: CPA uploads
ordinary credential JSON. No custom encryption adapter is implemented here.

## Remaining verification

This investigation does not certify a hosting solution. It has not exercised
real Claude OAuth rotation, live R2 signing, filesystem watcher scheduling,
a running-container kill, or Cloudflare deployment overlap. Runtime and account
integration must verify these before claiming deployment readiness.

No production Worker, CLI, CPA source, credentials, or shared infrastructure were
changed for the investigation. The hosting decision is resolved; live platform
verification still requires explicit approval.
