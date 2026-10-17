# check-zkir-crash: how the causes were reproduced and the checker tested

Everything here was run on 2026-10-17 unless a line says otherwise.

- **Machine:** an Intel Core i5-1038NG7 (x86_64, with ADX and BMI2), macOS 14, 16 GB, Docker Desktop
  28.0.4. Containers were Ubuntu 24.04 with `qemu-user`, compact 0.5.3 and the 0.31.1, 0.34.0 and
  0.35.0 toolchains (`x86_64-unknown-linux-musl`), plus Node 20.18.0 for the live checker runs.
- **Compilers:** 0.31.1, 0.34.0 and 0.35.0 for every cause; the 0.28.0 to 0.31.0 binaries for the
  parameter table and hosts.
- **Contracts:**
  - a counter (one circuit, k = 5);
  - `multi.compact` (four circuits of four `persistentHash` each, k = 14 and 15);
  - `mid.compact` (eight `persistentHash` in a `fold`, k = 16);
  - `heavy.compact` (64 in a `fold`, k = 19);
  - the contracts from the panic issues, and one variant each where noted.

## How compactc runs zkir

`compiler/passes.ss` at `compactc-v0.31.1`, lines 138 to 172: after its passes, compactc deletes
`compiler/`, `zkir/` and `keys/` in the output directory (not `contract/`), writes `zkir/<circuit>.zkir`,
and then, unless `--skip-zk`:

```scheme
(if (zero? (system "command -v zkir > /dev/null"))
  (let ([res (system (format "exec ~a compile-many '~a/zkir' '~a/keys'" (if (feature-zkir-v3) "zkir-v3" "zkir") …))])
    (unless (zero? res) (external-errorf "zkir returned a non-zero exit status ~d" res)))
  … "Warning: ZKIR not found; skipping final circuit compilation.\n")
```

`contract/index.js` is written after this step. `Compiling N circuits:` is zkir's own line (it's in the
zkir binary's strings, next to its progress-bar template).

**Exit statuses.** A fake `zkir` on `PATH`, with `compactc.bin` run directly, gave this mapping:

| The fake zkir | compactc prints |
|---|---|
| kill -ILL | -4 |
| kill -KILL | -9 |
| kill -SEGV | -11 |
| kill -ABRT | -6 |
| exit 101 | 101 |
| exit 1 | 1 |

compactc then exits 255, and so does `compact compile`.

**After a failure.** The handler at lines 120 to 125 deletes every file compactc created in this run
(`compiler/contract-info.json`, `zkir/<circuit>.zkir`), then every directory it created, if empty.

- What was left, per cause:
  - status 1 and -9: `keys/` with 0-byte files for the circuit zkir stopped at, and `zkir/` with only
    the `.bzkir` zkir wrote;
  - status 101: an empty `keys/`, and `zkir/` with the `.bzkir`;
  - status -4 (under QEMU Denverton and Snowridge): only an empty `keys/`;
  - status 127: no output directory at all.
- `contract/` is untouched. A compile that failed with status 1, into a directory holding an earlier
  build, left that build's `contract/index.js` (timestamp unchanged) next to 0-byte keys.
- `ZKIR not found`: running `compactc.bin` with `PATH=/usr/bin:/bin` exits 0 and writes `compiler/`,
  `contract/` and `zkir/`, with no `keys/`.

## Reproductions

| Cause | How | Output (last lines) | `keys/` after |
|---|---|---|---|
| no ADX | zkir run under `qemu-x86_64 -cpu Haswell` (and `Westmere`, `qemu64`, `kvm64`, `Denverton`, `Snowridge`) | `qemu: uncaught target signal 4 (Illegal instruction)`, `Exception: zkir returned a non-zero exit status -4` | empty |
| ADX present | the same under `-cpu Broadwell`, `-cpu max`, and natively | keys written | 2 files per circuit |
| out of memory | `mid.compact` in `docker run --memory 500m --memory-swap 500m` | `Exception: zkir returned a non-zero exit status -9` | 0-byte `.prover` and `.verifier` |
| enough memory | the same with `--memory 1500m` | keys written | 19.5 MB prover |
| compactc killed | the counter with `--memory 192m`, `128m` and `96m` (256m works) | `Error: Failed to run compactc` / `Caused by: compiler toolchain was terminated by a signal`; `compact` exits 1 | none |
| address-space limit | `mid.compact` under `ulimit -v 600000` | nothing after `Compiling 1 circuits:` for 20 min (stopped); the same slowdown as below, not the limit | not reached |
| offline | `docker run --network none`, empty cache, 0.31.1 and 0.35.0 | `Error: Failed to fetch data from <default host>/bls_midnight_2p5 after 3 attempts. Giving up.`, status 1 | 0-byte |
| srs on 0.31.1 | `MIDNIGHT_PARAM_SOURCE=https://srs.midnight.network/` (and without the slash), online, natively and in Docker | the same `Failed to fetch data` line, status 1 | 0-byte |
| damaged cache | 8 bytes overwritten at offset 1000 in a cached `bls_midnight_2p5` | `Error: Hash mismatch in data stored at …/bls_midnight_2p5. Found hash 900bdfd5…, but expected 0a1c9229….`, status 1 | 0-byte |
| broken install | `compactc.bin` cut to 6 MB and `zkir` moved away, in a container | `compiler toolchain was terminated by a signal`, with `--skip-zk` too | none |
| no `zkir-v3` | a scratch `COMPACT_DIRECTORY` copy of 0.31.1 without `zkir-v3`, `--feature-zkir-v3` | `sh: line 0: exec: zkir-v3: not found`, `Exception: zkir returned a non-zero exit status 127` | no output directory |

The ADX step was also run end to end on Haswell with 0.31.1, 0.34.0 and 0.35.0, each with the default
backend and `--feature-zkir-v3`: all six print `-4`.

## The CPU: ADX in zkir

`llvm-objdump -d`, counting `adcx` and `adox`:

| Binary | ADX instructions |
|---|---|
| 0.31.1 `zkir` and `zkir-v3`, `x86_64-unknown-linux-musl` | 1,106 each |
| 0.34.0 `zkir` and `zkir-v3`, `x86_64-unknown-linux-musl` | 8,225 each |
| 0.35.0 `zkir`, `x86_64-unknown-linux-musl` | 8,225 |
| 0.31.1 `zkir`, `x86_64-apple-darwin` | 1,106 |

0.35.0's `zkir-v3` wasn't counted. The Linux binaries are stripped; the macOS one keeps its symbols.

- **blst:** most of its 1,106 are in blst's `__mulx_mont_384` (169), `__mulx_mont_383_nonred` (152),
  `__mulx_by_1_mont_384` (78), `__mulx_mont_sparse_256` (73), `__mulx_384` (71), `__sqrx_384` (43)
  and the functions around them.
- **ring:** the rest are in ring's ADX variants (`bn_sqrx8x_internal`, the `ecp_nistz256_*_adx` and
  `fiat_curve25519_adx_*` functions). ring picks those at run time
  (`ring_core_0_17_14__adx_bmi2_available`).
- **No run-time check in blst:** its functions are called whatever the CPU, which the SIGILL under
  Haswell shows.

midnightntwrk/compact#42 traces the same SIGILL with gdb to `adox` in `__mulx_mont_sparse_256`,
called from `midnight_curves::bls12_381::fq::Fq::from_bytes_le`, on an AMD A6-9225, compilers
0.29.0, 0.31.0 and 0.31.1.

**The checker's CPU read.** qemu-user doesn't change `/proc/cpuinfo`, so inside the QEMU runs it
still showed the host's `adx`. The no-ADX, VM and ARM-emulation branches were tested with recorded
`/proc/cpuinfo` and `sysctl` contents, not live. A real container's `/proc/cpuinfo` (Docker Desktop on
this Intel Mac) showed `adx`, `bmi2` and `hypervisor`, and `memory.max` = `max`, with an `oom_kill`
line in `memory.events`.

## Memory

zkir's peak RSS was taken by running the real zkir under `/usr/bin/time -l` from a wrapper on `PATH`,
with compactc 0.31.1 run directly, natively on macOS. The parameter files came from a local server, so
the run also recorded which ones each contract fetched.

| Contract | Fetched | zkir peak | Prover keys | Wall time |
|---|---|---|---|---|
| counter | `2p5` | 14 MB | 14,071 B | 8 s |
| multi (4 circuits) | `2p14`, `2p15` | 373 MB | 9,975,709, 9,975,711, 5,213,796, 9,977,742 B | 301 s |
| mid | `2p16` | 705 MB | 19,502,770 B | 149 s |
| heavy | `2p19` | 2,808 MB | 152,898,256 B | 2,261 s |

- **Threads:** multi with `RAYON_NUM_THREADS=1` peaked at 339 MB against 368 MB with the default, in an
  earlier run of the same contract.
- **compactc itself:** peaked at 228 MB on `mid.compact`.
- **Wall times** were on a machine running other jobs at the same time; they are a scale, not a
  benchmark.

## The Linux build in Docker on this Mac

`mid.compact` (k = 16) builds its keys in 149 s with the native macOS 0.31.1 build. With the Linux
build in Docker Desktop on the same Mac (8 vCPUs, 7.8 GB), none of these finished; each was stopped:

| Run | Stopped after | What zkir was doing |
|---|---|---|
| default threads, no limit | 12 min | RSS 110 MB |
| default threads, `--memory 500m` | 20 min | 26 threads, about 6.5 CPUs busy, 96% of its CPU time in the kernel (utime 294 s, stime 7,762 s), no page scanning, no major faults, no sockets, 0 OOM kills |
| default threads, `ulimit -v 600000` | 20 min | RSS 108 MB, peak 227 MB |
| `RAYON_NUM_THREADS=1` | 15 min (`timeout 900`) | not sampled |
| `RAYON_NUM_THREADS=2` | 10 min | 20 threads; at 9 min, utime 283 s and stime 2,642 s |
| `--cpuset-cpus 0` | 20 min (`timeout 1200`) | 3 threads; at 2 min, utime 81 s, stime 42 s, RSS 12 MB |

- **Earlier the same day the same setup did finish:** the keys in a 1500 MB container, and `-9` in a
  500 MB one. Those runs weren't timed.
- **The cause isn't known.** Kernel time stays high on a single vCPU, so it isn't cross-CPU work
  alone. The Linux build links musl (`x86_64-unknown-linux-musl`), and its allocator is one suspect.
- **Not tested:** a native Linux machine, and a Linux VM other than Docker Desktop's.

## Public parameters

- **Hosts.** `strings` on each zkir:
  - 0.28.0, 0.29.0, 0.31.0 and 0.31.1 contain the S3 URL;
  - 0.34.0 and 0.35.0 don't contain either URL as a plain string, but the offline runs show
    `https://srs.midnight.network/` as their default;
  - the 0.31.1 offline run shows the S3 URL.
  `compact list` shows no 0.32 or 0.33 release, and aarch64 Linux builds from 0.29.0.
- **User-Agent.** A local server that logs request headers, with `MIDNIGHT_PARAM_SOURCE` pointing at
  it:
  - 0.31.1 sent `GET /bls_midnight_2p5` with no `User-Agent`;
  - 0.34.0 and 0.35.0 sent `User-Agent: Midnight Data Provider`;
  - none sent a `Range` header.
  `curl -H 'User-Agent:'` to srs gets HTTP 403 from CloudFront (`The request could not be satisfied`),
  and 200 with any `User-Agent`; S3 answers 200 either way. 0.31.0 fails against srs the same way as
  0.31.1.
- **Sizes.** `Content-Length` on both hosts for k = 4, 10 and 16 to 25 equals 192 × 2^k + 388
  (k = 25: 6,442,451,332 B). k = 26 is 403 on both (no such file). The files downloaded for k = 0 to 19 have the same
  sizes.
- **Hashes.**
  - **The table:** the SHA-256 of `bls_midnight_2p5` from the hash-mismatch message was found as raw
    bytes in each zkir, at the head of a table of 26 entries of 64 bytes (a hash and two string
    references). All ten binaries checked (zkir 0.28.0 to 0.35.0, zkir-v3 0.31.0 to 0.35.0) hold the
    same table.
  - **Checked against files:** the files for k = 0 to 3 (both hosts), 4 to 16 (from the cache, first
    downloaded from S3) and 17 to 19 (srs) all match it.
- **The cache directory.** `MIDNIGHT_PP=<dir>` is the directory itself: a compile with
  `MIDNIGHT_PP` pointing at a directory holding `bls_midnight_2p5`, and an unreachable
  `MIDNIGHT_PARAM_SOURCE`, built the keys.
- **Fetching with curl.** `curl -fL -o <cache>/bls_midnight_2p5 https://srs.midnight.network/bls_midnight_2p5`,
  then a compile with an unreachable `MIDNIGHT_PARAM_SOURCE`, built the keys.
- **Proxies.** Through a small CONNECT-logging proxy in `HTTPS_PROXY`, with an empty cache, 0.31.1
  sent `CONNECT midnight-s3-fileshare-dev-eu-west-1.s3.eu-west-1.amazonaws.com:443` and 0.35.0
  `CONNECT srs.midnight.network:443`, and both built the keys.
- **A leftover partial download.** A 3,000-byte `.bls_midnight_2p5.OLD123` in the cache was left
  alone; zkir downloaded a full new `bls_midnight_2p5`.
- **Speed.** S3 took about a minute for each of the 0.5 to 2 KB files for k = 0 to 3. Earlier the
  same day, a compile of `heavy.compact` against S3 had written 136 KB of the 96 MB `2p19` and stopped
  moving. srs gave 25 MB (k = 17) in 13 to 15 s. The checker's 787 KB test gave 241 KB/s (S3) and
  476 KB/s (srs) in one run.

## Panics

| Contract | 0.31.1 | 0.31.1 zkir-v3 | 0.34.0 | 0.34.0 zkir-v3 | 0.35.0 | 0.35.0 zkir-v3 |
|---|---|---|---|---|---|---|
| #299 (`((255 as Uint<8>) + (1 as Uint<8>)) as Uint<8>`) | panic | panic | panic | panic | panic | panic |
| #299 with the value from an argument | keys | | | | keys | keys |
| #616 (`Secp256k1Point`) | unbound identifier | | | panic | unbound identifier | panic |
| #616, a circuit returning `ecMulGenerator(…)` | | | keys | panic | keys | panic |
| #757 (`r != 0 as JubjubScalar`) | unbound identifier | | keys | panic | keys | keys |
| #757 with `(r as Field) != (0 as Field)` | | | | keys | | |
| #280 (`p0 == p1` on `JubjubPoint`) | keys | panic | keys | keys | keys | keys |

Blank cells weren't run. The panic lines in the test are the real output, verbatim.

## Broken installs

- **Found here:** this machine's 0.30.0 install was broken:
  - `artifact.zip` was 68,394,315 B, and `unzip` warned of 42,325,711 extra bytes;
  - `compactc.bin` was 6,881,280 B, against 8,849,916 in the archive;
  - `zkir` and `zkir-v3` were missing.
  `compact compile +0.30.0 --skip-zk` fails with `compiler toolchain was terminated by a signal`, and
  `compact update 0.30.0 --no-set-default` answers `already installed` and changes nothing.
- **Repaired twice:**
  - in a container, with `rm -r ~/.compact/versions/0.31.1` and
    `compact update 0.31.1 --no-set-default`;
  - on this Mac, in a scratch `COMPACT_DIRECTORY` copy with a 1 MB `compactc.bin`, by the runbook's
    snippet as written (`rm -rf "${COMPACT_DIRECTORY:-$HOME/.compact}/versions/$v"`, then
    `compact update "$v" --no-set-default`).
  Both times every file came back with the archive's size and the compile worked. The real
  `~/.compact` wasn't touched. The toolchain files are read-only, so a plain `rm -r` stops to ask about
  each one in a terminal; the runbook uses `-f`.
- **The checker's zip reader** finds the end record and reads the central directory backwards from
  it, so the 0.30.0 archive with bytes prepended still lists its seven files.

## The checker

- **Test:** [`test-check-zkir-crash.mjs`](test-check-zkir-crash.mjs) runs 78 cases in 60 to 100 s,
  with no network and no compiler (it fails if any case reaches a real host). It fakes the machine with:
  - `CHECK_ZKIR_PLATFORM`, `_ARCH`, `_CPUINFO`, `_SYSCTL`, `_CGROUP`, `_TOTALMEM` and `_COMPACT`;
  - `COMPACT_DIRECTORY`, with installs built from a real zip layout;
  - `MIDNIGHT_PP`, with the real 580-byte `bls_midnight_2p0` embedded;
  - a mock host on 127.0.0.1 for `CHECK_ZKIR_SRS` and `CHECK_ZKIR_S3`, which can be wrong, refuse
    (403), stall or trickle.
- **Mutations:** 38 deliberate bugs in the checker, one at a time. The final run caught 36. One of the
  two that survived (a partial download's age) was then caught after its test was tightened, so 37 of
  38 are caught. The one that still survives changes only the wording for `EAI_AGAIN`: no offline test
  can produce a DNS failure reliably, so that wording is covered only by the live run in a container
  with no network (below).
- **Live runs:**
  - `--machine` on this Mac: everything intact, both hosts reachable, exit 0. It also found a real
    leftover `.bls_midnight_2p19.7DFGtS` (136 KB, from the stalled S3 download) and called it safe to
    delete.
  - `--compile` on the counter: compiled, `1 of 1 circuit complete`, exit 0.
  - The checker on the real logs of every reproduction above gave the expected cause and exit code.
  - In a container with no network (`--network none`, 2 GB limit), the counter compile and then the
    checker in the same container. The checker reported:
    - the download failure, with both hosts unreachable (`EAI_AGAIN`);
    - the 2,048 MB limit and 0 OOM kills, from the cgroup;
    - a virtual machine with ADX, from `/proc/cpuinfo`;
    - empty keys and no `contract/`;
    - the `.part` curl command, and exit 0.
    The runbook's sample output is this run. Before the wording fixes the same run printed only
    `fetch failed (EAI_AGAIN)` and suggested curl on the machine that had no network; both were
    changed after it.
  - The `.part` curl command from the runbook, run with `bash`, `zsh` and `sh`, fetched
    `bls_midnight_2p5` with the right SHA-256. Started from a 3,000-byte `.part`, it resumed at byte
    3,000.

## Reviews

Two independent agents reviewed the runbook, the checker and these notes on 2026-10-17. Every finding
below was checked again before it was fixed.

- **Fact-check** against `passes.ss`, the issues, the installed binaries and both hosts. It reproduced
  rows of the panic table itself. It found:
  - compactc's cleanup after a failure (the checker called a `keys/`-only directory "not a compile
    output");
  - `Secp256k1Point` also exists in 0.34.0 with `--feature-zkir-v3`;
  - Atom-class chips and the `x86-64-v*` VM models without ADX (Denverton and Snowridge then
    reproduced `-4` here);
  - status 127 from a missing `zkir-v3`, which the checker reported as "no failure";
  - wording that claimed more than was run: every cause on all three versions, both hosts for the
    hash table, and the k = 15 row;
  - smaller fixes: k = 26 is 403, `${v:?}` in the `rm -rf`, units, and the `--machine` memory
    threshold.
  It also confirmed that zkir uses `HTTPS_PROXY`.
- **Operator run** by a fresh agent with only the runbook. It broke five things on purpose (a damaged
  cache, an srs download on 0.31.1, the #299 panic, a truncated install in a scratch copy, and a clean
  compile) and fixed each by following the page. It found:
  - **Unsafe reinstall:** the `rm -r ~/.compact/versions/<version>` line removed the wrong install for
    anyone using `COMPACT_DIRECTORY` or `--directory`, and `rm -r` stops on read-only files;
  - **Wrong environment:** the checker reads the environment it runs in, and the runbook didn't say to
    match the compile's (now Diagnose step 2, plus `--directory`, and the different-cache warning);
  - **Status 1 pasted alone** led to "open an issue" (it now names damaged cache files, or asks for
    the line before);
  - **`--machine` gave a false all-clear** for 0.31.1 pointed at srs;
  - **`--compiler`:** without it the User-Agent cause disappeared;
  - **S3:** its connections stall rather than run slow, and the checker's time estimate was
    misleading (removed);
  - **Circuit counts:** the checker undercounted after a failure (it now uses `Compiling N circuits:`);
  - smaller fixes: `shasum` on macOS, `result.ok` in `--json`, and the "each on one backend" wording.
- **Measured again here:** zkir 0.31.1 took 105 s and then 12 s for the k = 5 file from S3, and 2 of 6
  S3 connections waited 20 s.

## Not tested

- Real hardware without ADX; only QEMU's CPU models.
- Apple Silicon, Rosetta 2, and x86_64 containers on Apple Silicon. The checker's branch for them is
  advice, not a reproduction.
- The aarch64 builds, Windows and WSL.
- A zkir that dies with SIGSEGV or SIGABRT in real use. The mapping was only checked with the fake
  zkir.
- Corporate TLS interception on the parameter download (a plain `HTTPS_PROXY` works).
- The `x86-64-v2`, `v3` and `v4` CPU models: QEMU 8.2.2 here has none. That they lack ADX comes from
  the x86-64 psABI levels, none of which includes it.
- Compilers 0.28.0 to 0.30.0 beyond the parameter table and hosts.
