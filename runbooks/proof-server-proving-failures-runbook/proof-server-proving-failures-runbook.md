# Runbook: Proof server and proving failures (`ECONNREFUSED …:6300`, `Failed Proof Server response`, `Wallet.Proving: Failed to prove transaction`)

A deploy or a contract call fails before it reaches the network, while it's being proved. The
error names the proof server, or names nothing at all: `Wallet.Proving: Failed to prove
transaction` hides its reason in the cause chain. Most cases come down to how the proof server
was started: it's still downloading keys, it exited, its flags were silently dropped, or it's
published on a port it doesn't listen on. The rest are a wrong URL, a request the server rejects
without saying why, a full job queue, a timeout, or memory. Use this runbook to match the error
to the cause, confirm it with one read-only script, and start the proof server so it stays up and
logs its errors. Since the ledger 9 upgrade, every network is tested with proof server 9.0.0
(Preprod since 2026-11-09): 8.x can't read the ZKIR v3 circuits Compact 0.36.0 writes.

_Compiled 2026-10-10 from local reproductions; re-checked 2026-11-08 and 2026-11-09 for ledger 9 against
proof servers 9.0.0 and 8.1.3 run side by side, midnight-ledger `proof-server-9.0.0`
(`31c90b8bac8c`), and midnight-js 5.0.0's proof provider (method and results in
[`scripts/check-proof-server.NOTES.md`](scripts/check-proof-server.NOTES.md)). Sources, pinned:_

- _support matrix: `midnight-docs` `docs/relnotes/support-matrix.json` at
  `5263f4045dfbfb3ec9c62fa07a8f806134ac272e` (2026-10-09): proof server 8.1.3 on preview,
  preprod and mainnet; at `c28b72b` (2026-11-09, after midnight-docs#1669): 9.0.0 on all three_
- _midnight-ledger `proof-server-8.1.3` (`c85535d0ff8e799f629df127c21fa251199b4332`) and
  `proof-server-9.0.0` (`31c90b8bac8c`)_
- _midnight-js `v4.1.1` (`5f8a5d14247cb238b52187f33ed31695a5fde85d`); wallet SDK 1.2.0 with
  `@midnight-ntwrk/wallet-sdk-prover-client` 1.2.3_
- _Docker images `midnightntwrk/proof-server` 8.1.3, 8.1.0 and 8.0.3 on Docker Desktop 28.0.4
  (macOS, x86_64); a local network from `midnight-local-dev` (`902561d`) with node 1.0.400 and
  indexer 4.3.3_

_Versions and download sizes move with every release: re-check them before asserting anything._

---

## Symptom

Two clients talk to the proof server, and they report the same failure differently. Every error
below was reproduced unless marked otherwise.

**midnight-js 5.0.0** (Mainnet and Preview). A server that answers with an error gives
`ProofServerError: Failed Proof Server response: url="…", code="400"` (or 404, 429, and 500 after
retries) directly. One that never answers gives, after about 7 s of retries,
`ProviderFailedError: proveTx rejected the transaction (circuit '…')`, with the reason three
causes down: `ProofServerError: Proof Server request failed: url="…"`, then `TypeError: fetch
failed`, then `connect ECONNREFUSED …`, `getaddrinfo ENOTFOUND …`, `… wrong version number`
(`https://` to plain HTTP) or `TimeoutError: The operation was aborted due to timeout` (5.0.0's
request code, run against a stand-in server). The codes and reasons map to the same causes as
the table below.

**midnight-js 4.1.1** (`httpClientProofProvider`, which proves the contract's circuits). The message
starts `Unexpected error submitting scoped transaction '<unnamed>': Error: 'check' returned an
error:` (or `'prove' returned an error:`) and ends with one of these:

| End of the message | Cause |
|---|---|
| `FetchError: request to http://127.0.0.1:6300/check failed, reason: connect ECONNREFUSED 127.0.0.1:6300` (after 7 s of retries) | Nothing listens there (→ 1) |
| `… failed, reason: read ECONNRESET` | Docker Desktop: the container is up but the server isn't listening yet, or listens on another port inside the container (→ 1, 2) |
| `… failed, reason: socket hang up` | The connection closed mid-request: the server died, usually out of memory (→ 6) |
| `… failed, reason: getaddrinfo ENOTFOUND <host>` | The host name doesn't resolve (→ 3) |
| `… failed, reason: write EPROTO … wrong version number` | `https://` to a server that speaks plain HTTP (→ 3) |
| `Error: Failed Proof Server response: url="http://127.0.0.1:6300/api/check", code="404", status="Not Found"` | The URL has a path (→ 3) |
| `Error: Failed Proof Server response: url="…/check", code="400", status="Bad Request"` | The server rejected the request; on 8.x the reason is only in its log, and from 9.0.0 the body says why (→ 4) |
| `Error: Failed Proof Server response: url="…", code="429", status="Too Many Requests"` | The job queue is full (→ 5) |
| `Error: Failed Proof Server response: url="…", code="500", status="Internal Server Error"` (after 7 s of retries) | A job ran past its timeout, or the server failed (→ 5) |
| `'prove' returned an error: AbortError: The user aborted a request.` | The client's timeout (300 s by default) ran out. Nobody aborted anything (→ 5) |

Two more come from midnight-js before any request is sent. Building the provider throws
`TypeError: Invalid URL` for `127.0.0.1:6300`, and `Invalid protocol scheme: 'localhost:'.
Allowable schemes are one of: http:,https:` for `localhost:6300` (→ 3). Proving throws `ENOENT:
no such file or directory, open '<dir>/keys/<circuit>.verifier'` when the zk-config directory is
wrong (→ 4).

**The wallet SDK** (it proves the fee: the DUST spend, and any shielded coins it balances). The
error message is only:

```text
(FiberFailure) Wallet.Proving: Failed to prove transaction
```

This is also what testkit's `MidnightWalletProvider`, `WalletFacade` users and the faucet show.
The reason sits in the cause chain. `console.error(err)` prints it, but `err.message` doesn't:

```text
(FiberFailure) Wallet.Proving: Failed to prove transaction
  [cause]: ClientError: Failed to prove transaction
    [cause]: Error: 'prove' returned an error: (FiberFailure) ClientError: Failed to connect to Proof Server: Transport error (POST http://127.0.0.1:6300/prove)
```

| Innermost cause | Cause |
|---|---|
| `Failed to connect to Proof Server: Transport error (POST …/prove)` | Unreachable, or the connection dropped (→ 1, 2, 6); or the content-length bug (→ 7) |
| `Failed to prove: internal error` | 500: a job timeout or a server failure (→ 5) |
| `Failed to prove: Job Queue full` | 429 (→ 5) |
| `Failed to prove: bad input` (from source and [midnight-ledger#733](https://github.com/midnightntwrk/midnight-ledger/issues/733), not reproduced here) | 400 (→ 4) |

The wallet client doesn't retry, so these come back in about a second.

**The proof server itself.** It shows one of these in `docker ps -a` and `docker logs`:

- **It exits with code 1 a few minutes after starting:**

  ```text
  Error: Custom { kind: InvalidData, error: "Failed to fetch data from https://srs.midnight.network/bls_midnight_2p15 after 3 attempts. Giving up." }
  ```

  (→ 2)
- **It stays up, but the log ends in download progress and never says `listening on`:**

  ```text
  INFO midnight_base_crypto::data_provider: Fetching 'zswap/9/spend.prover' - 4218875 / 11020001 bytes downloaded
  ```

  (→ 2)
- **It exits with code 2 at once, with `bash: --: invalid option`:** flags were given after the
  image name (→ 1).
- **It exits with code 137:** `docker inspect` says `"OOMKilled": true` (→ 6).
- **Its verbose log shows `Error in response: …`:**
  - `JobQueueFull` (→ 5)
  - `InternalError("failed to complete job")` (→ 5)
  - `BadInput("couldn't find built-in key increment")` (→ 4)

  Without verbose logging, the log shows only the request line.

## Root cause

Proving runs in a separate service, and one contract call keeps it busy several times. In the
reproductions, a Counter `increment` sent three requests:
- **midnight-js `/check`:** 213 bytes, 20–70 ms.
- **midnight-js `/prove`:** 15.7 KB, under a second. midnight-js uploads the circuit's prover key,
  verifier key and ZKIR every time. A one-line shielded mint uploads 5.2 MB.
- **The wallet's `/prove` for the DUST spend:** 1.5 KB, about 4 s. It uses the server's built-in
  key.

A call that creates shielded coins adds a zswap proof (about 20 s here). midnight-js and the
wallet are configured separately and can point at different proof servers.

1. **Nothing listens at the URL.** The container isn't running, has exited, publishes another
   port, or publishes none. Docker Desktop answers a port with no mapping with `ECONNREFUSED`. A
   mapped port whose container isn't listening yet, or listens on another port inside the
   container, gets `ECONNRESET`: the forwarder accepts the connection and closes it. (On Linux
   without Docker Desktop this may surface as `ECONNREFUSED` instead; not reproduced.)
2. **The server downloads its keys before it listens.** On start it fetches six public-parameter
   files (k = 10 to 15) and four built-in proving keys, about 34 MB in all, from
   `https://srs.midnight.network/` (zswap spend, output and sign; DUST spend). Only then does it bind the port
   (`proof-server/src/main.rs:61-94`).
   - **On a slow link it gives up.** Each file gets 3 attempts
     (`base-crypto/src/data_provider.rs:359,482`), and if one fails the process exits with code 1.
     On a link of about 80 KB/s, a first start took 6 minutes. Another gave up after 7 minutes and
     exited.
   - **The keys go into the container unless a volume holds them.** The image runs with
     `HOME=/`, so they land in `/.cache/midnight/zk-params` and a new container starts from
     nothing. With the cache in a volume, startup took 3–6 s, and a restart fetched only the
     missing files.
   - **`--no-fetch-params` doesn't stop downloads.** It only moves each one to first use: the
     first DUST proof then took 27 s instead of 4 s.
   - **The download source can be changed.** `MIDNIGHT_PARAM_SOURCE` replaces the host; the
     cache path is `$MIDNIGHT_PP`, then `$XDG_CACHE_HOME/midnight/zk-params`, then
     `$HOME/.cache/midnight/zk-params` (`data_provider.rs:39-40,69,225-242`).
3. **Flags after the image name never reach the server.** The image's entrypoint is `bash -c`,
   and its command is the single string `midnight-proof-server --port $PORT` with `PORT=6300`
   (`flake.nix:236-242`).
   - **Extra words vanish.** `docker run … midnightntwrk/proof-server:8.1.3 midnight-proof-server
     -v` runs `bash -c midnight-proof-server` with `-v` as `$0`, so the flag is lost. The same
     happens to Compose `command: ['midnight-proof-server', '-v']` (the docs' `local-proving`
     example and `midnight-local-dev`'s `standalone.yml`), to the `--` form, to `--port`, and to
     `--network`, which no longer exists anyway.
   - **A flag alone is a bash error.** `docker run IMAGE --port 7000` fails with `bash: --:
     invalid option` (exit 2).
   - **Two consequences.** First, the documented `-v` never turns on verbose logging, so the
     reason for a 400 is never logged. Second, the port settings misbehave. With the image's own
     command, `MIDNIGHT_PROOF_SERVER_PORT` is overridden by `--port $PORT`. With a replaced
     command it's honoured, so the server listens on a port the `-p` mapping doesn't target, and
     clients get `ECONNRESET`.
4. **The request is rejected (400).** On 8.x the body is only `bad input`, and the reason is
   logged at DEBUG level, so only with verbose logging (`proof-server/src/worker_pool.rs:39`,
   `main.rs` `init_logging`). From 9.0.0 the body carries it: `bad input: \`<reason>\``. Seen causes:
   - **The circuit's ZKIR isn't readable (reproduced).** midnight-js 4.1.1 swallows any
     zk-config error for the circuit ([midnight-js#781](https://github.com/midnightntwrk/midnight-js/issues/781)) and sends `/check` without the IR. The
     server logs `couldn't find built-in key <circuit>`. Typical reasons: the provider points at
     the wrong directory, a web server doesn't serve `zkir/*.bzkir`, or the files weren't copied.
     A wrong directory usually fails earlier, with the `ENOENT … .verifier` error above.
   - **The ZKIR version doesn't match the server (reproduced on `/k`).** 8.x answers
     `Unsupported ZKIR version` for any ZKIR v3, including every 0.36.0 build: run 9.0.0. 9.0.0
     reads ZKIR v2 and 0.36.0's v3, and answers `Unsupported ZKIR tag: 'ir-source[v3]'` for a
     0.31.1 build made with `--feature-zkir-v3`: rebuild without the flag, or with 0.36.0. See the
     [toolchain runbook](../toolchain-version-mismatch-runbook/toolchain-version-mismatch-runbook.md),
     Remediation 5.
   - **The DUST secret key doesn't own the coins being spent** (a wrong seed:
     [midnight-ledger#733](https://github.com/midnightntwrk/midnight-ledger/issues/733)).
   - **Circuit-level mismatches:** `Inputs did not match alignment` ([midnight-ledger#625](https://github.com/midnightntwrk/midnight-ledger/issues/625)) and
     `Public transcript input mismatch` ([midnight-ledger#686](https://github.com/midnightntwrk/midnight-ledger/issues/686)).

   A server from another ledger generation can't read the request at all. It answers with
   `expected header tag 'midnight:(proof-preimage-versioned,…)', got …` or, for the old
   `midnightnetwork/proof-server:4.0.0`, `Unknown discriminant 109` ([midnight-ledger#391](https://github.com/midnightntwrk/midnight-ledger/issues/391)).
5. **Capacity and time.**
   - **Queue full (429).** `--job-capacity` caps the waiting jobs, and extra requests get 429
     `Job Queue full` immediately. It's unlimited (0) by default on 8.x and 10 from 9.0.0: 14
     proofs sent at once to 9.0.0 got two 429s, and none on 8.1.3 (reproduced). midnight-js retries only
     500 and 503, so a 429 fails the call.
   - **Job timeout (500).** `--job-timeout` defaults to 600 s. A job that runs past it finishes
     anyway, then the client gets 500 `internal error`, and the log says only `failed to complete
     job` (`worker_pool.rs:90-91`; [midnight-ledger#223](https://github.com/midnightntwrk/midnight-ledger/issues/223)). midnight-js retries a 500 three times,
     at 1, 2 and 4 s, so a proof that is too slow is computed four times before it fails.
   - **Client timeout.** midnight-js's own timeout is 300 s and produces the `AbortError` above.
     `httpClientProofProvider(url, zkConfigProvider, { timeout })` changes it; verified with
     200 ms.
6. **Memory.** A DUST proof peaked at about 85 MB, and under a 48 MB limit the container was
   OOM-killed mid-proof (exit 137).
   - **Real circuits need far more.** [servicedesk#203](https://github.com/midnightntwrk/servicedesk/issues/203) reports prover keys of about 90 to 570 MB and
     server peaks of 11.4 GB. On Preview with 9.0.0 and 0.36.0 (measured, Nov 7–8), signature
     checks and `sha512` took prover keys of 170 to 230 MB and peaks of 3.3 to 6.2 GB, which is
     close to the limit of an 8 GB Docker.
   - **What clients see.** The request in flight gets `socket hang up` (midnight-js) or
     `Transport error` (wallet). Later requests get `ECONNREFUSED`, because the container stays
     down unless it has a restart policy.
7. **A client transport bug.** `wallet-sdk-prover-client` before 1.2.3 sends an explicit
   `content-length` header that undici 8.2 and later rejects when it is the global dispatcher.
   The request never leaves the process: `TypeError: fetch failed` / `cause:
   UND_ERR_INVALID_ARG: invalid content-length header`, under `Transport error`
   ([servicedesk#38](https://github.com/midnightntwrk/servicedesk/issues/38), [midnight-wallet#456](https://github.com/midnightntwrk/midnight-wallet/pull/456); not reproduced here). The proof-server log shows no
   `/prove` at all.

**Within a ledger, version is rarely the cause on its own.** Every network is tested with 9.0.0.
Proof servers 8.0.3, 8.1.0 and 8.1.3 all proved midnight-js 4.1.1's
requests, both through the checker's test proof and in an end-to-end deploy and call, and 9.0.0
proves the same ledger 8 test request. The one hard line is ZKIR v3: a 0.36.0 build needs 9.0.0
(cause 4). Do switch, though, if the server
is from another generation (the 400 above), or from the old `midnightnetwork/proof-server`
repository, whose `latest` is a 7.0.0 release candidate.

**Not causes (checked):**
- **Built-in keys with a self-hosted proof server work.** A shielded mint through
  `httpClientProofProvider` sent `midnight/zswap/output` with no key material (513 bytes), and
  the proof server proved it with its own key (200). The "no fallback for built-in keys" claim
  in [midnight-expert#209](https://github.com/midnightntwrk/midnight-expert/pull/209) doesn't hold for the HTTP proof server.
- **CORS is permissive.** The server reflects the request's origin (`Cors::permissive()`,
  `proof-server/src/lib.rs`).
- **`localhost` and a trailing slash both work** from Node 24.
- **Two failures look like proving but aren't.** Hangs where no `/prove` ever reaches the server
  ([servicedesk#107](https://github.com/midnightntwrk/servicedesk/issues/107), [#167](https://github.com/midnightntwrk/servicedesk/issues/167)) are upstream of it. `1010` rejections after a successful proof
  belong to the
  [node rejection runbook](../node-1010-custom-error-runbook/node-1010-custom-error-runbook.md).

## Key identifiers

- **Image:** `docker.io/midnightntwrk/proof-server:<tag>`. The matrix tag is 9.0.0 on every
  network (8.1.3 before ledger 9). Every tag from 7.0.0 on is published for amd64 and arm64. The old
  `docker.io/midnightnetwork/proof-server` is stale.
- **Port 6300**, set inside the image by `PORT`. On the host, change only the `-p` side.
- **Endpoints:**
  - `GET /health` returns `{"status":"ok",…}`.
  - `GET /version` returns plain text, e.g. `9.0.0`.
  - `GET /proof-versions` returns `["V2", "V3"]` on 9.0.0 and `["V2"]` on 8.x.
  - `GET /ready` returns `jobsProcessing`, `jobsPending` and `jobCapacity`, with 503 when busy.
  - `POST /check` and `POST /prove` are what midnight-js and the wallet call.
  - `POST /prove-tx` and `POST /k` are the other routes.
- **Settings** (environment variables, because flags are dropped, see cause 3):
  - `MIDNIGHT_PROOF_SERVER_VERBOSE`
  - `MIDNIGHT_PROOF_SERVER_JOB_CAPACITY` (10 on 9.0.0; 0, unlimited, on 8.x)
  - `MIDNIGHT_PROOF_SERVER_NUM_WORKERS` (2)
  - `MIDNIGHT_PROOF_SERVER_JOB_TIMEOUT` (600 s)
  - `MIDNIGHT_PROOF_SERVER_NO_FETCH_PARAMS`
  - `MIDNIGHT_PARAM_SOURCE` (default `https://srs.midnight.network/`)
  - `MIDNIGHT_PP` (the cache directory)
- **Key cache:** `/.cache/midnight/zk-params` in the container, `~/.cache/midnight/zk-params`
  natively. It holds 18 files:
  - `bls_midnight_2p10` to `bls_midnight_2p15`
  - `zswap/9/{spend,output,sign}.{prover,verifier,bzkir}`
  - `dust/9/spend.{prover,verifier,bzkir}`
- **Request formats** (ledger 8):
  - `/check` bodies start `midnight:(proof-preimage-versioned,option(wrapped-ir)):`
  - `/prove` bodies start `midnight:(proof-preimage-versioned,option(proving-data),option(fr-bls)):`
  - Answers start `midnight:vec(option(u64)):` and `midnight:proof-versioned:`
- **Clients:**
  - midnight-js `httpClientProofProvider(url, zkConfigProvider, { timeout, headers })`, from
    `packages/http-client-proof-provider`: timeout 300 000 ms, 3 retries on 500 and 503.
  - The wallet SDK's `HttpProverClient`, from `wallet-sdk-prover-client`: it sets the URL from
    the wallet's `provingServerUrl`, which is `proofServer` in testkit's environment, and
    effectively doesn't retry.

## Diagnose (no API key)

1. **Tell which client failed.**
   - `'check' returned an error` or `'prove' returned an error` is midnight-js, using the URL
     passed to `httpClientProofProvider`.
   - `Wallet.Proving` is the wallet, using its own proving URL.

   Print the whole error with `console.error(err)` or `util.inspect(err, { depth: null })`, not
   `err.message`, or the wallet's reason stays hidden.
2. **Run the checker against that URL**, on the machine that runs the proof server. It needs
   Node 20 or later and no install:

   ```bash
   node runbooks/proof-server-proving-failures-runbook/scripts/check-proof-server.mjs http://127.0.0.1:6300 --network preprod
   ```

   What it does:
   - **URL:** reads it the way midnight-js 4.1.1 does.
   - **Status:** asks `/health`, `/version`, `/proof-versions` and `/ready`, and compares the
     version with the support matrix.
   - **Test proof:** runs one `/check` and one `/prove` of a known-good circuit (a Counter
     `increment` compiled with 0.31.1, sent as midnight-js 4.1.1 sends it). This one test tells
     a broken proof server apart from a broken client.
   - **Docker:** if a proof-server container publishes the port, it reads `docker inspect` and
     `docker logs` for:
     - the image and tag;
     - the state, exit code and `OOMKilled`;
     - key-download progress or a "Giving up";
     - the published port against the port the server really listens on;
     - dropped flags, verbose logging and the key-cache volume;
     - `Job Queue full`, `failed to complete job` and `BadInput(…)` in the log.

   It starts, stops and submits nothing. Exit code 0 means no `FAIL`, 2 means at least one, and 1
   means it couldn't run.

   On a healthy 9.0.0 container started as in Remediation 1, on host port 16300 (2026-11-09,
   `--network preprod`; other proof-server containers on the machine left out):

   ```text
   check                             found                                         expected      status  note
   URL                               http://127.0.0.1:16300/                                     OK
   GET /health                       200 in 31 ms                                  200           OK
   Version                           9.0.0                                         9.0.0         OK
   GET /proof-versions               ["V2", "V3"]                                                INFO
   GET /ready                        processing 0, pending 0, capacity 10                        OK
   Job capacity                      10                                            10 (default)  INFO    requests beyond it get 429 Job Queue full
   Test /check                       200 in 58 ms                                  200           OK
   Test /prove                       200 in 2.3 s                                  200           OK
   Container ps-runbook-9 image      midnightntwrk/proof-server:9.0.0              9.0.0         OK      publishes :16300
   Container ps-runbook-9 state      running, listening                            running       OK
   Container ps-runbook-9 ports      16300->6300; listens on 6300                                OK
   Container ps-runbook-9 logging    verbose                                                     OK
   Container ps-runbook-9 key cache  /.cache/midnight                                            OK

   RESULT: this proof server can prove. If the app still fails, the cause is on the client side (URL, zk config files, timeout, wallet); see the runbook.
   ```

   A 9.0.0 container on a key volume filled by 8.x still downloads keys on first start (under a
   minute here); until then the checker reports `read ECONNRESET` and "downloading keys".

   If the test proof passes and the app still fails, look at the client:
   - the URL each client actually uses;
   - whether the zk-config provider can read `keys/` and `zkir/`;
   - the timeout;
   - the wallet's own proving URL.
3. **Without Node,** the same checks by hand:
   - `curl -sS http://127.0.0.1:6300/health` and `curl -sS http://127.0.0.1:6300/version`
   - `docker ps -a --filter ancestor=midnightntwrk/proof-server:9.0.0`, or list all containers
     and look for `proof-server`
   - `docker logs --tail 50 <name>`: look for `listening on`, `Fetching`, `Giving up` and
     `Error in response`
   - `docker inspect -f '{{.State.OOMKilled}} {{.State.ExitCode}} {{json .Config.Cmd}}' <name>`

## Remediation

1. **Start the proof server so it keeps its keys and logs its errors.** Set options with
   environment variables, give it no command, and keep the keys in a volume:

   ```bash
   docker run -d --name proof-server -p 127.0.0.1:6300:6300 \
     -e MIDNIGHT_PROOF_SERVER_VERBOSE=true \
     -v midnight-zk-params:/.cache/midnight \
     --restart unless-stopped \
     midnightntwrk/proof-server:9.0.0
   ```

   With Compose:

   ```yaml
   services:
     proof-server:
       image: 'midnightntwrk/proof-server:9.0.0'
       ports: ['127.0.0.1:6300:6300']
       environment:
         MIDNIGHT_PROOF_SERVER_VERBOSE: 'true'
       volumes: ['midnight-zk-params:/.cache/midnight']
       restart: unless-stopped
   volumes:
     midnight-zk-params:
   ```

   - **The first start downloads about 34 MB.** Wait for `listening on: 0.0.0.0:6300` in `docker
     logs proof-server` before you prove; later starts take seconds.
   - **For another host port, change only the host side:** `-p 127.0.0.1:6301:6300`.
   - **If you must replace the command, pass one string:** `'midnight-proof-server --port 6300
     -v'`. Remove a stray `MIDNIGHT_PROOF_SERVER_PORT` too, or the server listens on that port
     instead.

   *Trade-off:* verbose logging prints every request's bytes in hex, so the log grows fast.
   Turn it off once the problem is found. The restart policy brings the server back after an
   OOM kill or a failed download, and with the volume each restart only fetches what's missing.
2. **Get the keys through a slow or filtered link.**
   - **Keep the volume and restart.** Completed files stay, and each attempt fetches only what's
     missing.
   - **Allow outbound HTTPS** to `srs.midnight.network`.
   - **Use a mirror** with `-e MIDNIGHT_PARAM_SOURCE=https://<mirror>/`. The server verifies
     what it downloads.
   - **Seed the volume from a machine that already has the keys:**

     ```bash
     docker run --rm -v midnight-zk-params:/dst -v ~/.cache/midnight:/src:ro alpine cp -a /src/. /dst/
     ```

     The source is any `midnight` cache directory that holds `zk-params`: a native install's
     `~/.cache/midnight`, or a copy of a working container's volume. A partial cache is fine,
     because the server fetches only the files that are missing.

   *Trade-off:* a mirror is a host you have to keep in step with releases.
3. **Fix the URL.**
   - **Give it a scheme:** `http://127.0.0.1:6300`, not `127.0.0.1:6300` or `localhost:6300`.
   - **Use `http://` for a local server.** It doesn't speak TLS.
   - **Leave out any path.** midnight-js appends `/check` and `/prove` to it.
   - **Set both clients.** midnight-js takes the URL in `httpClientProofProvider`, and the
     wallet takes its own (`provingServerUrl`; `proofServer` in testkit).
   - **For a remote proof server, use `https://`.** A proof request carries the circuit's
     private inputs, and midnight-js warns about plain `http://` to any host but loopback:
     `proof server URL uses unencrypted http:// for non-loopback host '…'; sensitive data may be
     transmitted in clear text`.
4. **Find out why a request was rejected (400).** Turn on verbose logging (Remediation 1),
   repeat the call, and read the `Error in response: BadInput(…)` line. Then match it:
   - **`couldn't find built-in key <circuit>`:** the app's zk-config provider can't read
     `zkir/<circuit>.bzkir`. `NodeZkConfigProvider` must point at the compiler's output
     directory, the one with `keys/` and `zkir/`. A browser app's `FetchZkConfigProvider` base
     URL must serve both folders and return 404, not an HTML fallback page, for anything missing
     ([midnight-js#603](https://github.com/midnightntwrk/midnight-js/issues/603)).
   - **`Unsupported ZKIR version`:** the server is 8.x and the circuit is ZKIR v3 (every 0.36.0
     build): run 9.0.0. **`Unsupported ZKIR tag: 'ir-source[v3]'`** from 9.0.0 means a 0.31.1 build
     made with `--feature-zkir-v3`: rebuild with 0.36.0. See the toolchain runbook, Remediation 5.
   - **`bad input` on `midnight/dust/spend` from the wallet:** check that the wallet seed owns
     the DUST it spends ([midnight-ledger#733](https://github.com/midnightntwrk/midnight-ledger/issues/733)).
   - **`Inputs did not match alignment` or `Public transcript input mismatch`:** the open issues
     [midnight-ledger#625](https://github.com/midnightntwrk/midnight-ledger/issues/625) and [#686](https://github.com/midnightntwrk/midnight-ledger/issues/686) describe a workaround, a single unconditional
     `sendShielded`.
   - **`expected header tag …` or `Unknown discriminant`:** use the matrix version of the proof
     server.
5. **Make room for the load.**
   - **For 429, send fewer proofs at once,** or raise `MIDNIGHT_PROOF_SERVER_JOB_CAPACITY` (10 by
     default on 9.0.0; 0 is unlimited) and `MIDNIGHT_PROOF_SERVER_NUM_WORKERS`.
   - **For 500 with `failed to complete job`,** raise `MIDNIGHT_PROOF_SERVER_JOB_TIMEOUT` or give
     the server more CPU.
   - **For `AbortError: The user aborted a request.` or `TimeoutError`,** raise the client
     timeout: `httpClientProofProvider({ url, zkConfigProvider, timeout: 900_000 })` on
     midnight-js 5.0.0, or `httpClientProofProvider(url, zkConfigProvider, { timeout: 900_000 })`
     on 4.1.1.

   *Trade-off:* more workers prove in parallel but each needs its own memory (Remediation 6).
6. **Give proving enough memory.** If `docker inspect` shows `"OOMKilled": true`, raise Docker
   Desktop's memory limit (Settings → Resources) and remove any `--memory` limit on the
   container. Then start it again; the restart policy in Remediation 1 does that for you. Large
   circuits need several GB ([servicedesk#203](https://github.com/midnightntwrk/servicedesk/issues/203)); on 9.0.0, signature and `sha512` circuits peaked at 3.3 to 6.2 GB, close to
   the limit of an 8 GB Docker.
7. **Fix the wallet's transport.** If the proof-server log shows no `/prove` while the wallet
   reports `Transport error`, install the matrix wallet SDK: 2.0.0, which brings
   `@midnightntwrk/wallet-sdk-prover-client` 2.0.0 (on the ledger 8 set, 1.2.0 with 1.2.3). Then check with `npm ls @midnightntwrk/wallet-sdk-prover-client` (`@midnight-ntwrk/…` on 1.2.0) that no older copy is
   left ([servicedesk#38](https://github.com/midnightntwrk/servicedesk/issues/38)).

## Upstream follow-ups

- **[servicedesk#242](https://github.com/midnightntwrk/servicedesk/issues/242), the proof-server
  image:**
  - The `bash -c` entrypoint drops every argument after the image name (cause 3). This also
    covers the 18 compose files in the example repos, `midnight-local-dev` and midnight-expert's
    project template.
  - Startup exits after three back-to-back failed attempts at one key file (cause 2).

  Job timeouts surfacing as a bare `internal error` are already open as
  [midnight-ledger#223](https://github.com/midnightntwrk/midnight-ledger/issues/223).
- **[servicedesk#243](https://github.com/midnightntwrk/servicedesk/issues/243), midnight-js:**
  - `Failed Proof Server response` drops the server's response body.
  - A timeout reads `AbortError: The user aborted a request.`

  Swallowed zk-config errors are already open as
  [midnight-js#781](https://github.com/midnightntwrk/midnight-js/issues/781).
- **[midnight-docs#1527](https://github.com/midnightntwrk/midnight-docs/issues/1527), the docs:**
  - The documented `docker run`, `--` and Compose commands lose their flags.
  - `--network` no longer exists.
  - The `--no-fetch-params` and port advice doesn't work in the image.
  - The pages disagree with the matrix on the tag.
- **[midnight-expert#209](https://github.com/midnightntwrk/midnight-expert/pull/209):** its
  built-in-key claim is contradicted by the shielded-mint reproduction above. Not yet commented on.

## Reference material

- **Worked cases:**
  - [servicedesk#38](https://github.com/midnightntwrk/servicedesk/issues/38): the content-length transport bug.
  - [servicedesk#40](https://github.com/midnightntwrk/servicedesk/issues/40): hosted proof-server URLs that no longer resolve.
  - [servicedesk#81](https://github.com/midnightntwrk/servicedesk/issues/81): `/check` 400 `bad input`, root cause never confirmed. A missing ZKIR
    reproduces it exactly.
  - [servicedesk#107](https://github.com/midnightntwrk/servicedesk/issues/107) and [#167](https://github.com/midnightntwrk/servicedesk/issues/167): hangs before any `/prove`.
  - [servicedesk#203](https://github.com/midnightntwrk/servicedesk/issues/203): prover key sizes and memory.
- **Upstream:**
  - [midnight-ledger#223](https://github.com/midnightntwrk/midnight-ledger/issues/223): job timeouts surface as a generic 500.
  - [midnight-ledger#391](https://github.com/midnightntwrk/midnight-ledger/issues/391): the old image and `Unknown discriminant 109`.
  - [midnight-ledger#625](https://github.com/midnightntwrk/midnight-ledger/issues/625) and [#686](https://github.com/midnightntwrk/midnight-ledger/issues/686): circuit-level 400s.
  - [midnight-ledger#733](https://github.com/midnightntwrk/midnight-ledger/issues/733): a wrong seed gives `bad input` on the DUST spend.
  - [midnight-ledger#135](https://github.com/midnightntwrk/midnight-ledger/issues/135): arm64 hangs on images older than 8.0.0-rc.4.
  - [midnight-js#781](https://github.com/midnightntwrk/midnight-js/issues/781): zk-config errors are swallowed.
  - [midnight-js#603](https://github.com/midnightntwrk/midnight-js/issues/603): an HTML fallback page served as key material.
  - [midnight-js#974](https://github.com/midnightntwrk/midnight-js/issues/974): the `proveTxConfig` timeout is ignored in 4.x.
  - [midnight-wallet#456](https://github.com/midnightntwrk/midnight-wallet/pull/456): the content-length fix.
  - [midnight-expert#209](https://github.com/midnightntwrk/midnight-expert/pull/209).
  - [midnight-docs#1377](https://github.com/midnightntwrk/midnight-docs/issues/1377): the Kapa clusters, 38 "unreachable on 6300", 32 proving failures and
    14 image pulls.
  - [midnight-docs#1383](https://github.com/midnightntwrk/midnight-docs/issues/1383): proving topology.
- **Source, midnight-ledger `proof-server-8.1.3`:**
  - `flake.nix:212-242`: the image, entrypoint and command.
  - `proof-server/src/main.rs:61-112`: flags, the startup fetch, logging.
  - `proof-server/src/lib.rs:32-58`: the routes and CORS.
  - `proof-server/src/endpoints.rs:158-328`: `/check`, `/prove`, `couldn't find (built-in) key`.
  - `proof-server/src/worker_pool.rs:27-95,172`: error texts and status codes, the queue.
  - `base-crypto/src/data_provider.rs:39-69,225-242,359-482`: the cache path, the source,
    retries.
- **Source, clients:**
  - midnight-js `v4.1.1`: `packages/http-client-proof-provider/src/http-client-proving-provider.ts`
    (URL building, retries, timeout, the swallowed zk-config error).
  - `@midnight-ntwrk/wallet-sdk-prover-client` 1.2.3: `dist/effect/HttpProverClient.js`
    (`Failed to connect to Proof Server`, `Failed to prove: <body>`, the retry condition).
- **Docs:** `docs/guides/local-proving.mdx`, `docs/guides/run-proof-server.mdx`,
  `docs/relnotes/support-matrix.json`.
- **Related runbooks:**
  - [Toolchain mismatch](../toolchain-version-mismatch-runbook/toolchain-version-mismatch-runbook.md)
    for ZKIR v3 and the version set.
  - [Node rejection codes](../node-1010-custom-error-runbook/node-1010-custom-error-runbook.md)
    for failures after proving.
