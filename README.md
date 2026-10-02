# proxy

One editor key for your Claude and ChatGPT subscriptions, hosted on a Cloudflare Worker with one private [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) container and private R2 credential storage.

Connect multiple accounts, including Claude Personal and Team workspaces on the same email. New sessions use round-robin selection. CPA attempts to keep recognized sessions on their selected account, but the selection can reset after expiry, a model change, account failure, or a container restart. This shares work across subscriptions; it does not reduce the tokens a request consumes. Claude and Codex have separate provider URLs and account pools.

## Install and connect

Requires Bun 1.3.14 or newer and a browser. From a checkout:

```sh
git clone git@github.com:jonahseguin/proxy.git
cd proxy
bun install
bun link
proxy editor login
proxy claude connect
proxy claude connect
proxy codex connect
proxy codex connect
proxy status
```

`proxy editor login` asks for the editor key without echoing it. The CLI stores it in the OS credential store. The default origin is `https://proxy.jonahseguin.workers.dev`; append another HTTPS origin to use a different deployment, for example `proxy claude connect https://proxy.example.com`.

Each `connect` downloads the pinned CPA v7.3.15 login helper if needed, verifies its archive checksum, and opens browser login. The Codex callback uses local port 1455. Temporary credentials are uploaded and then removed from disk. Claude credentials are identified by account ID plus workspace organization ID; Codex credentials by account ID. Connecting the same identity again replaces its saved credential instead of adding a duplicate.

For your two Claude subscriptions, choose Personal during one login and Team during the other. Check that `proxy claude list` shows different workspace IDs. Email alone does not distinguish subscriptions. A credential missing its provider identity is rejected.

`proxy join` guides you through choosing Claude or Codex, adding an account, and configuring Amp or pi. When accounts already exist, it offers **Add or reconnect an account** or **Editor settings only**.

## Accounts and usage

```sh
proxy status
proxy claude list
proxy codex list
proxy claude disconnect <account-id>
proxy codex disconnect <account-id>
```

Use the full account ID printed by `list` or `status`. To specify another deployment for removal, use `proxy claude disconnect https://proxy.example.com <account-id>`.

Status shows saved identities, runtime/account health, time since CPA became ready, available provider usage windows and their reset times. Missing usage is reported as unavailable, never as zero usage. Request counts cover the current CPA process, not account history. A saved credential does not by itself prove that the provider will accept inference.

Account selection depends on the session information sent by the editor. When an editor omits a session ID, CPA compares earlier messages to select the account. Rewritten or compacted context can select another account. Live Amp tests with Claude Opus 5.5 and GPT-6 Astra confirmed that successive turns in each thread used the same account.

On a quota rejection before output begins, CPA tries the remaining eligible accounts for the same user, provider, and model. It tries each credential once in that initial selection round. It does not wait for a cooldown or repeat the round. After any nonempty streamed frame reaches the caller, including a lifecycle event, it never retries that request. If no account can serve the request, the caller receives an error.

CPA makes an account eligible again when its provider cooldown expires. Recovery adds the original account back to the pool; an existing session keeps its replacement account. `proxy status` shows retry and quota reset times; quota observations may be cached for 30 seconds. Claude's cooldown can include up to 30 seconds of grace, so its retry time may be later than the displayed quota reset. No manual reset or reconnect is needed for a quota cooldown. Reconnect only when the saved credential needs replacing.

Adding, reconnecting, or removing an account restarts the shared container and interrupts active streams. Removal is confirmed only after durable deletion. Failed account mutations keep the affected account pool blocked until recovery succeeds.

## Amp

Create a **Custom URL** connection for each provider you want to route through the proxy:

| Setting        | Claude                                         | ChatGPT / Codex                                  |
| -------------- | ---------------------------------------------- | ------------------------------------------------ |
| Base URL       | `https://proxy.jonahseguin.workers.dev/claude` | `https://proxy.jonahseguin.workers.dev/codex/v1` |
| API format     | Anthropic Messages                             | OpenAI Responses                                 |
| API key        | Your editor key                                | The same editor key                              |
| Extra headers  | None                                           | None                                             |
| Model mappings | `anthropic/<model> -> <model>`                 | `openai/<model> -> <model>`                      |

Use `proxy join` to see the current model list and complete mappings. In Amp, map its model IDs to the names returned by the proxy, then choose those models for your modes. Only configured models are accepted. If you prefer Amp's native ChatGPT sign-in, configure only the Claude connection here.

The Codex model list includes the native `gpt-6.1-sol` ID. Its Amp mapping is `openai/gpt-6.1-sol` → `gpt-6.1-sol`.

To print your editor key in a private terminal:

```sh
proxy editor key
```

Keep keys out of chat and repository files. Amp's HTTPS Custom URL connection uses the Anthropic Messages or OpenAI Responses API with HTTP streaming. This deployment does not expose a separate WebSocket/Rivet endpoint.

The CLI also offers pi settings that read the editor key at runtime through `!proxy editor key <origin>`.

## Administration

All admin commands take an explicit origin. On a new deployment:

```sh
proxy admin init https://proxy.example.com
proxy admin digest https://proxy.example.com
proxy admin user add https://proxy.example.com jonah
proxy admin user key https://proxy.example.com jonah
```

`admin init` generates an administrator key in the OS credential store and prints only its SHA-256 digest. Configure that digest as `ADMIN_TOKEN_SHA256` during deployment. `admin user add` registers a generated editor-key digest and stores the editor key locally; running it again reuses the stored key.

```sh
proxy admin user list https://proxy.example.com
proxy admin user rotate https://proxy.example.com jonah
proxy admin user remove https://proxy.example.com jonah
proxy admin rotate https://proxy.example.com
proxy admin sync https://proxy.example.com
```

Removing a user clears both provider pools before revoking their key. Administrator rotation changes the local key first; `admin sync` publishes its digest using the authenticated `cf` CLI and verifies the new key against the Worker. If sync fails, retry it with the stored key.

## Hosting

Requires a Cloudflare Workers Paid account with Containers and R2 enabled. Docker is required to build the CPA image and run runtime tests. The Go CPA binary runs inside the private container; it does not run directly in the Worker.

`deployment.ts` defines the Worker name, account, and default origin. `cloudflare.config.ts` defines the container, KV user registry, private R2 bucket, model lists, and secret bindings. The public Worker exposes editor routes; CPA management routes stay private.

For a separate deployment, create your own KV namespace and private R2 bucket, update those configuration files, and create bucket-scoped R2 S3 credentials. Do not enable a public R2 URL. Authenticate using `cf auth login`.

Set these Worker secrets through a protected deployment secret file:

| Secret                   | Value                                      |
| ------------------------ | ------------------------------------------ |
| `ADMIN_TOKEN_SHA256`     | Digest from `proxy admin digest <origin>`  |
| `CPA_API_KEY`            | Random private key between Worker and CPA  |
| `CPA_MANAGEMENT_KEY`     | Separate random private CPA management key |
| `OBJECTSTORE_ENDPOINT`   | Your Cloudflare account's R2 S3 endpoint   |
| `OBJECTSTORE_BUCKET`     | Your private credential bucket name        |
| `OBJECTSTORE_ACCESS_KEY` | Bucket-scoped S3 access key                |
| `OBJECTSTORE_SECRET_KEY` | Bucket-scoped S3 secret key                |

```sh
bun run typecheck
bun run lint
bun run test
bun run format:check
cf deploy --secrets-file /path/to/protected-secrets.json
```

Do not commit the secret file. Remove it after successful deployment. Routine code updates use `bun run deploy`, preserving deployed secrets.

CPA startup settings take effect when the container starts. After changing those settings, use a Cloudflare container rollout or restart after deploying the Worker. A Worker deployment can leave the existing CPA process running. Verify the replacement uses the new settings and retains the saved accounts.

Before forwarding generation, the Worker verifies CPA has registered the saved accounts and requested model. Each registration check has a 30-second deadline. An open container port alone does not mark the runtime ready.

Worker error logs persist fixed operation stages, error names, recognized platform messages, and compiled source locations. Other error text is omitted. Invocation logs, traces, and container logs are disabled; application logs contain no prompts, credentials, account filenames, or request details.

Keys use OS credential-store services `jonah.proxy.admin`, `jonah.proxy.editor`, and `jonah.proxy.user.<id>`, indexed by origin. The login-helper cache is `~/.cache/jonah.proxy` (or `$XDG_CACHE_HOME/jonah.proxy`). Provider OAuth credentials are private R2 objects.

## Verification and limits

```sh
bun run typecheck
bun run lint
bun run test
bun run format:check
bun run test:runtime
bun run test:request-size
```

Runtime tests require Docker and synthetic credentials; they do not prove live subscription access. Account login and real provider requests are separate verification steps.

Inference requests accept up to 32 MiB of incoming UTF-8 JSON, including base64 images and conversation history. The gateway validates JSON incrementally and keeps only the rewritten body, capped at 33 MiB for serialization overhead. It rejects duplicate root `model` fields, models longer than 256 characters, and nesting deeper than 128 levels. Credential and administrator limits remain separate. Provider limits still apply.

Each Worker isolate holds at most 64 MiB of inference body pages across requests. A full body budget returns a temporary 503; an oversized request returns 413. Pages are released when consumed, cancelled, or rejected. The private runtime receives the validated model as internal metadata and streams the body without parsing it again.

The request-size test uses real workerd with a 128 MiB V8 heap limit and a local upstream fixture. It checks 32 MiB ASCII/base64-shaped and multibyte requests, dense JSON, exact byte limits, and cancellation. This heap setting does not measure total isolate memory.

The pinned CPA image and its Claude and Codex executors were tested with two synthetic static-key accounts per provider against local upstream fixtures. Within that running process, new recognized sessions alternate accounts, repeated sessions keep their selected account, and another user's matching session stays in that user's pool. Both providers also kept each account across interleaved growing conversations without session IDs. The Worker and container tests also cover account replacement and deletion, restart recovery, streamed tool data, and cancellation.

Native CPA tests also cover HTTP and stream quota failures before output, each eligible account attempted once, exhausted pools returning an error, cooldown expiry, and sessions keeping their replacement. They verify that a failure after streamed output does not replay the request.

The deployment at `https://proxy.jonahseguin.workers.dev` passed hosted checks on October 1, 2026: public health, rejected unauthorized requests, private CPA routes, authenticated model discovery, account collections, and status. After OAuth login, Claude Fable 5.1 and GPT-6 Luna passed live text and tool streaming checks. Provider quota windows were observed. Actual Amp medium and high turns passed through Claude Opus 5.5 and GPT-6 Astra; follow-ups stayed on their selected accounts. One Claude account returned HTTP 429 while the other continued working, so account health and real request results matter alongside quota percentages.

The inherited CPA storage limitation remains: a failed token-refresh upload followed by container disk loss can restore an older credential. If that token no longer works, reconnect that account. Keep one active CPA writer for the credential bucket. See [the credential durability decision](docs/adr/0002-credential-durability-gate.md).

| Path                               | Purpose                                                            |
| ---------------------------------- | ------------------------------------------------------------------ |
| `src/gateway.ts`                   | Authentication, provider routes, model and request-size validation |
| `src/inference-body.ts`            | Incremental JSON validation and bounded body storage               |
| `src/runtime.ts`                   | Private CPA container, account changes, status and forwarding      |
| `src/account.ts`                   | Provider identities and account collections                        |
| `cli/`                             | Login, keys, accounts, usage and editor setup                      |
| `Dockerfile`, `container-start.sh` | Pinned CPA runtime                                                 |
