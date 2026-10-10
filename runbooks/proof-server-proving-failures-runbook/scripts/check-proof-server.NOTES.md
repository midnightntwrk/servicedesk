# check-proof-server.mjs: notes

How the proof-server runbook's claims were reproduced, and how the checker was tested. Everything
ran on 2026-10-10 on macOS (x86_64, 8 CPUs, 16 GB) with Docker Desktop 28.0.4 (8 GB VM) and
Node 24.20.0, over a slow link (12 to 87 KB/s measured). That made the download failures easy to
reproduce.

## Setup

- **Local network:** `midnight-local-dev` at `902561d` (`standalone.yml`), with the node image
  changed to `midnightntwrk/midnight-node:1.0.400` (indexer-standalone 4.3.3, `CFG_PRESET=dev`).
  Its proof server was started with a single-string command, verbose logging and a key-cache bind
  mount.
- **Proof servers:** `midnightntwrk/proof-server` 8.1.3
  (`sha256:63e775263596a5681f599fe608a2496d9ec1f97c3854e67ed7768c1807742510`, amd64), 8.1.0 and
  8.0.3, plus one container per case with the setting under test.
- **Client:** midnight-js 4.1.1 (`midnight-js-contracts`, `http-client-proof-provider`,
  `node-zk-config-provider`, `indexer-public-data-provider`), `testkit-js` 4.1.1 for the wallet
  (`MidnightWalletProvider` on the dev genesis seed), wallet SDK 1.2.0
  (`wallet-sdk-prover-client` 1.2.3), `compact-runtime` 0.16.0.
- **Contracts,** compiled with `compact compile +0.31.1` (keys included):
  - `export ledger round: Counter; export circuit increment(): [] { round.increment(1); }`
  - a one-circuit shielded mint (`mintShieldedToken(…, left<ZswapCoinPublicKey, ContractAddress>(disclose(ownPublicKey())))`)
- **Harness:** a script built the wallet once, deployed the contract, then called `increment` once
  per case. midnight-js got the case's proof-server URL, the wallet got `PS_WALLET`, and every
  error's cause chain was printed.
- **Two helpers:**
  - a logging proxy that saved each request body and recorded its status and time;
  - a fake server that answers GETs like a healthy proof server and every POST with a chosen
    status, or drops the connection.

One harness problem had to be fixed first. A fresh `npm install` of that set put
`onchain-runtime-v3` 3.1.2 at the root (from `compact-runtime`'s `^3.0.0`), while
`midnight-js-protocol` kept its own 3.0.0. Deploy worked, but every `callTx` failed with `Error:
expected instance of StateValue` in `new ChargedState`
(`midnight-js-contracts/src/internal/transaction.ts:165`). It took an npm `overrides` to 3.0.0
plus `npm dedupe` to leave one copy. This is the toolchain runbook's "two copies" case, but it
breaks calls, not deploys: worth adding there.

## Requests per call (logging proxy)

| Call | Client | Request | Body | Time |
|---|---|---|---|---|
| Counter `increment` | midnight-js | `POST /check` | 213 B | 67 ms |
| | midnight-js | `POST /prove` (key material included) | 15 689 B | 0.8 s |
| | wallet | `POST /prove` (`midnight/dust/spend`, no key material) | 1 514 B | 3.7 s |
| Shielded mint | midnight-js | `POST /check` | 895 B | 24–84 ms |
| | midnight-js | `POST /prove` (`midnight/zswap/output`, no key material) | 513 B | 18.9–22.7 s |
| | midnight-js | `POST /prove` (contract circuit, key material included) | 5 210 528 B | 20.3–23.0 s |
| | wallet | `POST /prove` (DUST spend) | 1 546 B | 4.3 s |

The mint's `midnight/zswap/output` proof went out with no key material, because the app's
`NodeZkConfigProvider` has none for built-ins. The proof server answered 200, with the
`midnight/zswap/output` call proved from its own keys. That contradicts
[midnight-expert#209](https://github.com/midnightntwrk/midnight-expert/pull/209)'s "no fallback for
built-in keys" for the HTTP proof server.

## Startup and keys

| Case | Result |
|---|---|
| 8.1.0, no cache, first try | Not listening for 7 min; then `Error: Custom { kind: InvalidData, error: "Failed to fetch data from https://srs.midnight.network/bls_midnight_2p15 after 3 attempts. Giving up." }`, exit 1, 08:34:45 after an 08:27:50 start. The log before it: `error decoding response body. Retrying...` and `error sending request for url (…). Retrying...` / `Giving up.` |
| 8.1.0, no cache, second try (cache bind-mounted) | `listening on` after 6 min 16 s; 18 files (listed in the runbook) |
| `/health` during the download, Docker Desktop port forward | curl `(56) Recv failure: Connection reset by peer`; midnight-js `read ECONNRESET` after 9.2 s |
| Same, a port nothing publishes | curl `(7) Couldn't connect to server`; midnight-js `connect ECONNREFUSED` after 7.2 s |
| Warm cache (bind mount or named volume) | healthy after 3–6 s, 0 downloads; 8.1.3 started from the 8.1.0 cache with 0 downloads |
| Cache with 2 files deleted | downloaded only `k=10` and the DUST verifying key, then listened |
| `MIDNIGHT_PARAM_SOURCE=https://params-mirror.invalid/` | every download went to that host |
| `MIDNIGHT_PROOF_SERVER_NO_FETCH_PARAMS=true`, empty cache | `/health` OK at once; then the first `/prove` of each kind downloaded on demand (`Missing public parameters for k=5…`, `Missing zero-knowledge proving key for Dust spends…`). Counter prove 6.1 s, DUST prove 27.0 s |
| A cold container left running | finished after about 16 minutes; the wallet then proved through it |
| Another cold container, no cache | later gave up and exited 1 (at 10:26:04Z); its last lines were `Fetching zero-knowledge proving key for Zswap inputs - hash mismatch. Giving up.` and the same `Failed to fetch data from …/bls_midnight_2p15 after 3 attempts` error. A truncated download fails verification and counts as a failed attempt |

## Flags and ports

| Command | Result |
|---|---|
| `docker run IMAGE --port 7000` | `bash: --: invalid option`, exit 2 |
| `docker run IMAGE midnight-proof-server -v` (and Compose `['midnight-proof-server', '-v']`) | starts, but no DEBUG lines, so a 400's reason isn't logged |
| `docker run IMAGE 'midnight-proof-server --port 6300 -v'` | DEBUG lines: `Received request: <hex>` and `Error in response: …` |
| `-e MIDNIGHT_PROOF_SERVER_VERBOSE=true` | the same DEBUG lines |
| `-e MIDNIGHT_PROOF_SERVER_PORT=7000`, default command | `listening on: 0.0.0.0:6300` (the image's `--port $PORT` wins) |
| `-e PORT=7000`, default command | `listening on: 0.0.0.0:7000` |
| `-e MIDNIGHT_PROOF_SERVER_PORT=7000` with command `midnight-proof-server -v`, `-p 6312:6300` | `listening on: 0.0.0.0:7000`; `/health` on 6312 → connection reset |

Checked against `flake.nix:236-242` at `proof-server-8.1.3`: entrypoint `bash -c`, command
`midnight-proof-server --port $PORT`, `PORT=6300`. 8.1.3's `--help` lists the same options as
8.1.0.

## Client errors (harness, wallet on a good proof server unless noted)

| Case | Error (end of the message) | Time |
|---|---|---|
| `http://127.0.0.1:6300` | OK | 23–32 s per call |
| `http://localhost:6300`, `http://127.0.0.1:6300/` | OK | |
| `http://127.0.0.1:6399` | `'check' returned an error: FetchError: request to http://127.0.0.1:6399/check failed, reason: connect ECONNREFUSED 127.0.0.1:6399` | 7.2 s |
| `https://127.0.0.1:6300` | `… reason: write EPROTO …:error:0A00010B:SSL routines:tls_validate_record_header:wrong version number:…` | 7.3 s |
| `http://127.0.0.1:6300/api` | `Error: Failed Proof Server response: url="http://127.0.0.1:6300/api/check", code="404", status="Not Found"` | 0.1 s |
| `http://proof-server.invalid:6300` | `… reason: getaddrinfo ENOTFOUND proof-server.invalid` (plus the midnight-js `unencrypted http://` warning) | 10.2 s |
| `127.0.0.1:6300` | `TypeError: Invalid URL` (code `ERR_INVALID_URL`) | at construction |
| `localhost:6300` | `Invalid protocol scheme: 'localhost:'. Allowable schemes are one of: http:,https:` | at construction |
| `{ timeout: 200 }` | `'prove' returned an error: AbortError: The user aborted a request.` (`/check` passed) | 7.4 s |
| zk-config directory without `keys/` | `ENOENT: no such file or directory, open '<dir>/keys/increment.verifier'` | 0.1 s |
| zk-config directory with `keys/` but no `zkir/` | `Failed Proof Server response: url="…/check", code="400", status="Bad Request"`; server body `bad input`; verbose log `Error in response: BadInput("couldn't find built-in key increment")` | 4.2 s |
| fake server, 429 | `… code="429", status="Too Many Requests"`; 1 request | 0.9 s |
| fake server, 500 | `… code="500", status="Internal Server Error"`; 4 requests, at +0, +1, +3 and +7 s | 7.2 s |
| fake server, connection dropped | `… reason: socket hang up`; 4 requests | 7.9 s |
| wallet → `http://127.0.0.1:6399` | `(FiberFailure) Wallet.Proving: Failed to prove transaction` / `[cause]: ClientError: Failed to prove transaction` / `[cause]: Error: 'prove' returned an error: (FiberFailure) ClientError: Failed to connect to Proof Server: Transport error (POST http://127.0.0.1:6399/prove)` | 3.8–4.0 s |
| wallet → fake 500 | innermost `ClientError: Failed to prove: internal error`; 1 request | 2.7 s |
| wallet → fake 429 | innermost `ClientError: Failed to prove: Job Queue full`; 1 request | 2.1 s |
| wallet → connection dropped | innermost `… Transport error (POST http://127.0.0.1:6333/prove)`; 1 request | 1.6 s |

`err.message` for every wallet case was only `(FiberFailure) Wallet.Proving: Failed to prove
transaction`. The reason is in `String(err)` (the printed cause chain).

## Server limits (captured requests replayed with curl)

| Server setting | Result |
|---|---|
| `JOB_CAPACITY=1`, `NUM_WORKERS=1`, 4 DUST proofs at once | 2 × `429 Job Queue full` within 14 ms, 2 × 200 (7.4 s, 13.8 s); log `Error in response: JobQueueFull` |
| `JOB_TIMEOUT=1`, DUST proof (normally 3.7 s) | `500 internal error` after 5.6 s. The log shows `proof created; verifying to make sure`, `proof ok`, then `Error in response: InternalError("failed to complete job")` |
| `JOB_TIMEOUT=1`, Counter proof (normally 0.8 s) | 200 in 0.96 s |
| `--memory=200m` and `96m` | DUST proof 200 (peak sampled 84.4 MiB) |
| `--memory=48m` | curl `(52) Empty reply from server` after 1.6 s; container exited 137, `OOMKilled=true`; later requests `connect ECONNREFUSED` |
| 8.0.3, the 8.1.0 client's `/check`, Counter `/prove` and DUST `/prove` | 200, 200, 200 |
| 8.1.3, same | 200, 200, 200 |
| garbage body `hello` to `/prove` and `/check` | `400 expected header tag 'midnight:(proof-preimage-versioned,option(proving-data),option(fr-bls)):', got 'hello'` (and the `wrapped-ir` tag for `/check`) |
| `OPTIONS /prove` with `Origin: http://localhost:5173` | 200, `access-control-allow-origin: http://localhost:5173` |

On a fresh chain, deploy and `increment` both succeeded through 8.1.3, with midnight-js and the
wallet both proving there (6 `POST /prove` in its log).

One unrelated lead turned up. After the shielded mint sent a custom token to the genesis wallet,
every later Counter call on that chain was rejected with `1010: Invalid Transaction: Custom
error: 117` (`Malformed.NotNormalized`; node log `Transaction Error: Malformed(NotNormalized)`),
whichever proof server was used. A fresh chain cleared it. Not investigated further; it looks
like wallet balancing with a custom shielded token in the wallet (compare [servicedesk#194](https://github.com/midnightntwrk/servicedesk/issues/194)).

## The checker

The test payloads are the Counter `/check` (213 B, SHA-256 `216c1ab1…3868`) and `/prove`
(15 689 B, `83f9014a…eb57`) captured above, gzip and base64 in the script. They carry the proof
preimage and the circuit's keys and ZKIR. The circuit has no witnesses, and the preimage comes
from a local test chain.

| Target | Result | Exit |
|---|---|---|
| 8.1.3, the Remediation 1 command exactly (named volume seeded from the cache, verbose, restart policy) | all OK; test `/check` 19 ms, `/prove` 0.9 s | 0 |
| 8.1.0 (`midnight-local-dev` proof server) | Version `WARN` (8.1.0 vs 8.1.3), test proof OK; other containers listed as one `INFO` line each | 0 |
| 8.0.3 | Version `WARN`, test `/prove` 2.4 s OK, logging `WARN` | 0 |
| `localhost:6300` / `127.0.0.1:6300` | URL `FAIL` with the midnight-js error text | 2 |
| `http://127.0.0.1:6300/api` | URL path `WARN`, `/health` 404 `FAIL` blamed on the path | 2 |
| `https://127.0.0.1:6300` | `EPROTO … wrong version number` `FAIL` | 2 |
| cold container (downloading) | `/health` `ECONNRESET` `FAIL`; container "downloading keys (file, bytes)" `FAIL`; key cache `WARN` | 2 |
| array command and `MIDNIGHT_PROOF_SERVER_PORT=7000` | ports "6312->6300; listens on 7000" `FAIL`; command "-v ignored" `WARN`; logging `WARN` | 2 |
| fake 429 / 500 / 400 / drop | test `/check` `FAIL` with queue full / internal error / rejected / connection closed | 2 |
| container that gave up downloading (exited 1) | `/health` `ECONNREFUSED` `FAIL`; state "exited 1, key download failed" `FAIL` quoting the `Failed to fetch data …` line | 2 |
| a port nothing publishes, 10 proof-server containers | `ECONNREFUSED` `FAIL`; "no container publishes :6399" `FAIL` naming the published ports; every container checked: one exited 137 `OOMKilled` `FAIL`, one downloading `FAIL` | 2 |

Not tested: the Docker daemon being down (it would have stopped the test network). Also not
tested: Windows, Linux without Docker Desktop (the connection-reset vs refused split may differ
there), Podman, and a remote proof server behind TLS.
