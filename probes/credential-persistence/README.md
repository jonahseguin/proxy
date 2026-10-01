# Reproduce CPA credential persistence failures

This test-only code executes unchanged CPA storage and manager
code against a local HTTP S3 fixture. All credentials are synthetic. It does not
connect to Cloudflare or a model provider.

## Run

Install Docker and clone the upstream reference if it is absent:

```sh
git clone https://github.com/router-for-me/CLIProxyAPI.git .reference/CLIProxyAPI
```

Update the reference, then run from the repository root:

```sh
git -C .reference/CLIProxyAPI fetch origin --tags
bash probes/credential-persistence/run.sh
```

The default revision is CPA v7.3.8. To test v7.3.9 or v7.3.15:

```sh
bash probes/credential-persistence/run.sh 61fdfc341b96178a8dcb53f2efc46cbc341d267c
bash probes/credential-persistence/run.sh 673131f57484517c3a1eae7e36c4cfa7b9bb4efc
```

The runner archives the selected revision into a disposable directory and adds
only the probe test. It does not edit the reference checkout or upstream
production code. Docker downloads the Go toolchain and Go modules as needed.
The container and temporary source directory are removed after the run.

## Interpret the result

These are characterization tests, not a durability certification. A passing
defect test means the named failure was reproduced. An upstream fix can make
that test fail and requires updating the expected behavior after investigation.

- Successful writes, replacement, and deletion establish the fixture's normal path.
- An identical retry after a failed upload can return success without uploading.
- The auth manager can report successful refresh installation despite failed persistence.
- An explicit second `PersistAuthFiles` call can repair remote state while the
  local disk survives. Upstream's watcher has no durable retry queue.
- Failed remote deletion can restore a credential on a fresh disk. Retrying the
  delete explicitly can repair it.
- Independent store instances can overwrite newer credentials without fencing.

Fresh-disk restoration invokes CPA's actual startup auth-download routine with
a new empty directory. This models loss of the old filesystem, not an actual
container kill. Configuration bootstrap, fsnotify scheduling, OAuth token
rotation at the provider, R2 authentication/signing compatibility, and Cloudflare
rollout behavior are outside this probe. The S3 fixture does not verify request
signatures. A temporary 403 write denial models an exhausted persistence failure;
it does not measure MinIO's transient-network retries.
