# Jonah's account proxy

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

Account selection depends on the session information sent by the editor. When an editor omits a session ID, CPA compares earlier messages to select the account. Rewritten or compacted context can select another account. Amp's actual requests have not yet been checked against connected OAuth accounts, so this deployment does not guarantee that an Amp thread keeps one account or reuses its provider cache.

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

Keys use OS credential-store services `jonah.proxy.admin`, `jonah.proxy.editor`, and `jonah.proxy.user.<id>`, indexed by origin. The login-helper cache is `~/.cache/jonah.proxy` (or `$XDG_CACHE_HOME/jonah.proxy`). Provider OAuth credentials are private R2 objects.

## Verification and limits

```sh
bun run typecheck
bun run lint
bun run test
bun run format:check
bun run test:runtime
```

Runtime tests require Docker and synthetic credentials; they do not prove live subscription access. Account login and real provider requests are separate verification steps.

The pinned CPA image and its Claude and Codex executors were tested with two synthetic static-key accounts per provider against local upstream fixtures. Within that running process, new recognized sessions alternate accounts, repeated sessions keep their selected account, and another user's matching session stays in that user's pool. The Worker and container tests also cover account replacement and deletion, restart recovery, streamed tool data, and cancellation.

The deployment at `https://proxy.jonahseguin.workers.dev` passed hosted checks on October 1, 2026: public health, rejected unauthorized requests, private CPA routes, authenticated model discovery, empty account collections, and status. Real OAuth login, live provider generation, and provider quota values remain unverified until accounts are connected.

The inherited CPA storage limitation remains: a failed token-refresh upload followed by container disk loss can restore an older credential. If that token no longer works, reconnect that account. Keep one active CPA writer for the credential bucket. See [the credential durability decision](docs/adr/0002-credential-durability-gate.md).

| Path                               | Purpose                                                            |
| ---------------------------------- | ------------------------------------------------------------------ |
| `src/gateway.ts`                   | Authentication, provider routes, model and request-size validation |
| `src/runtime.ts`                   | Private CPA container, account changes, status and forwarding      |
| `src/account.ts`                   | Provider identities and account collections                        |
| `cli/`                             | Login, keys, accounts, usage and editor setup                      |
| `Dockerfile`, `container-start.sh` | Pinned CPA runtime                                                 |
