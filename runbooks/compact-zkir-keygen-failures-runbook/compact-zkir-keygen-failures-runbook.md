# Runbook: Compact compile fails at the proving keys (`zkir returned a non-zero exit status`)

`compact compile` prints `Compiling N circuits:` and then stops with
`Exception: zkir returned a non-zero exit status N`, or sits on that line for a long time. The contract
itself compiled: the compiler checks it, writes each circuit to `zkir/` and only then starts zkir, the
program that writes each circuit's prover and verifier keys. The number says what stopped zkir: a CPU
without the ADX instructions it's built with, too little memory, a public-parameter download that
failed or a damaged cached copy, or a zkir bug with a known issue. Run the checker below on the
compile's output, on the machine where it ran. It names the cause and the fix, and checks that
machine for the others.

_Compiled 2026-10-17. Each cause below was reproduced that day on at least one of compilers 0.31.1,
0.34.0 and 0.35.0 (each section names the versions), on x86_64 macOS and x86_64 Linux in Docker, with
QEMU for the CPU models. The checker was run on the real output of each, and the page was reviewed by
an independent fact-check and by a fresh agent working through it as an operator. Method and results are in
[`scripts/check-zkir-crash.NOTES.md`](scripts/check-zkir-crash.NOTES.md). Sources, pinned:_

- _[LFDT-Minokawa/compact](https://github.com/LFDT-Minokawa/compact) tag `compactc-v0.31.1`,
  `compiler/passes.ss` lines 120 to 125 and 138 to 172 (how compactc runs zkir, reports it and cleans
  up after it)_
- _The `zkir` and `zkir-v3` binaries in the 0.28.0 to 0.35.0 toolchains (download hosts, the parameter
  hashes, the ADX instructions)_
- _The parameter hosts `srs.midnight.network` and
  `midnight-s3-fileshare-dev-eu-west-1.s3.eu-west-1.amazonaws.com`, files k = 0 to 25_
- _The issues linked in each section, read on 2026-10-17_

_Versions and issues move: re-check anything you quote from this page against the current release._

---

## Symptom

```text
Compiling 1 circuits:
Exception: zkir returned a non-zero exit status -4
```

`compact compile` exits 255. The number, and the line just before it, tell the causes apart:

| Status | Line before it | Cause |
|---|---|---|
| `-4` | none | zkir was killed by SIGILL: the CPU has no ADX |
| `-9` | none | zkir was killed by SIGKILL: out of memory (or a CI time limit) |
| `1` | `Error: Failed to fetch data from https://…/bls_midnight_2p<k> after 3 attempts. Giving up.` | the public parameters didn't download |
| `1` | `Error: Hash mismatch in data stored at …/bls_midnight_2p<k>. Found hash …, but expected …. Please try removing this file to force a re-fetch. If that does not work, you may be subject to an attack.` | the cached parameters are damaged |
| `101` | `thread 'main' (…) panicked at …` and a message | a zkir bug; four have issues ([Root cause 4](#4-status-101-a-zkir-panic)) |
| `127` | `exec: zkir-v3: not found` | the install has no `zkir-v3` ([Root cause 5](#5-the-compiler-install-is-broken)) |

Three related endings without that line:

- `Error: Failed to run compactc` and `Caused by: compiler toolchain was terminated by a signal`
  (`compact` exits 1): the compiler itself was killed, from a broken install or very little memory.
- `Warning: ZKIR not found; skipping final circuit compilation.` and exit 0: there's no `keys/`
  directory at all.
- `Compiling N circuits:` and nothing for minutes: the first download of a large parameter file on a
  slow link, key generation for a large circuit, which takes minutes too, or the Linux build in
  Docker on a Mac ([Root cause 6](#6-key-generation-far-slower-in-a-linux-container-on-a-mac)).

What gives it away: the contract compiles with `--skip-zk`, and the failure comes after
`Compiling N circuits:`, a line zkir prints itself. When zkir fails, compactc deletes what it wrote in
this run, and any directory it created that is then empty. What's left in the output directory:

| After | `keys/` | `zkir/` | `compiler/` | `contract/` |
|---|---|---|---|---|
| status 1 (download, hash), status -9 | 0-byte `.prover` and `.verifier` for the circuit zkir stopped at; none for circuits it hadn't reached | only the `.bzkir` files zkir wrote | removed | not written |
| status 101 | empty | only the `.bzkir` files zkir wrote | removed | not written |
| status -4 | empty | removed | removed | not written |
| status 127 | none (zkir never ran) | removed | removed | not written |
| `ZKIR not found` | absent | written | written | written |

compactc writes `contract/` only after zkir succeeds, and doesn't delete an existing one. So after a
failure in a directory that held an earlier build, the old `contract/index.js` sits next to the new
empty keys.

**Not this runbook:**

- `Exception: <file> line N char M:` with no `Compiling N circuits:` line: the compiler rejected the
  contract. See [Compact compile errors](../compact-ai-generated-compile-errors-runbook/compact-ai-generated-compile-errors-runbook.md).
- `Internal error (please report)`: a compiler bug that `--skip-zk` doesn't avoid (for example
  [servicedesk#130](https://github.com/midnightntwrk/servicedesk/issues/130), in compactc's zkir-v3
  pass, not in zkir).
- A deploy or circuit call that fails while proving, with the same `Failed to fetch data … Giving up.`
  line from the proof server: see [Proof server and proving failures](../proof-server-proving-failures-runbook/proof-server-proving-failures-runbook.md).
  It downloads the same parameter files into the same cache.
- `Version mismatch: compiled code expects …` when the contract loads: see
  [Toolchain mismatch](../toolchain-version-mismatch-runbook/toolchain-version-mismatch-runbook.md).

## Root cause

After its own passes succeed, compactc runs zkir once for the whole contract
(`compiler/passes.ss`, `compactc-v0.31.1`, lines 154 to 169):

```text
zkir compile-many '<out>/zkir' '<out>/keys'          # zkir-v3 with --feature-zkir-v3
```

For each circuit, zkir fetches the public parameters for the circuit's size, `bls_midnight_2p<k>` for
up to 2^k rows, and writes `<circuit>.prover` and `<circuit>.verifier`. If zkir exits non-zero,
compactc prints `zkir returned a non-zero exit status` with the status from Chez Scheme's `system`:
zkir's exit code, or minus the signal that killed it (-4 is SIGILL, -9 SIGKILL, -11 SIGSEGV, -6 SIGABRT,
the same numbers on Linux and macOS). It then deletes the files it wrote in this run
(`compiler/contract-info.json`, `zkir/<circuit>.zkir`) and any directory it created that is left empty
(lines 120 to 125). If no `zkir` is on its `PATH`, compactc prints the `ZKIR not found` warning and
exits 0. The toolchain's `compactc` wrapper puts its own directory first on `PATH`, so through
`compact compile` that only happens when zkir is missing from the install.

### 1. Status -4: the CPU has no ADX

zkir's BLS12-381 arithmetic is blst's assembly, built to use the ADX instructions (`adcx`, `adox`)
without a fallback: in `__mulx_mont_sparse_256`, `__mulx_mont_384`, `__sqrx_384` and the functions
around them. A CPU without ADX stops at the first one with SIGILL, on any contract with a circuit.

- **Reproduced** by running the x86_64 Linux zkir under QEMU's CPU models. On Haswell, which has BMI2
  but no ADX, 0.31.1, 0.34.0 and 0.35.0 all print `-4`, with the default backend and with
  `--feature-zkir-v3`. With 0.31.1, Westmere, `qemu64`, `kvm64`, Denverton (an Atom, Goldmont) and
  Snowridge (an Atom, Tremont) print `-4` too, and Broadwell and `max` build the keys.
- **Who has it:** check the `adx` flag rather than the date.
  - Intel Core and Xeon before Broadwell (2014).
  - Intel's Atom-class Celeron and Pentium chips up to Tremont (Jasper Lake, about 2021), such as the
    N4020 and N5105.
  - AMD before Zen (2017), such as the A6-9225 in
    [midnightntwrk/compact#42](https://github.com/midnightntwrk/compact/issues/42).
  - Virtual machines whose CPU model hides ADX. The generic models do: `qemu64`, `kvm64`, and the
    `x86-64-v2`, `v3` and `v4` levels, none of which includes ADX. Proxmox's default for new VMs,
    `x86-64-v2-AES`, is one of them (not run here; this QEMU has no `x86-64-v*` models). A VM shows
    the `hypervisor` flag in `/proc/cpuinfo`.
- **Not affected:** the native arm64 builds for Apple Silicon and Linux (from 0.29.0). An x86_64
  build running under emulation on an ARM machine (a `linux/amd64` container on Apple Silicon, or
  Rosetta 2) wasn't tested: whether it works depends on whether the emulator implements ADX.
- **Upstream:** [midnightntwrk/compact#42](https://github.com/midnightntwrk/compact/issues/42), open
  since 2026-08-05 with no replies. It traces the same crash with gdb to `__mulx_mont_sparse_256`
  on 0.29.0, 0.31.0 and 0.31.1.

### 2. Status -9: zkir ran out of memory

zkir is the biggest process in a compile, so when memory runs out the kernel's out-of-memory killer
stops it with SIGKILL, and zkir leaves 0-byte keys. Its peak grows with the largest circuit: four
circuits of k=14 and 15 peaked at half of what one k=16 circuit did. Limiting it to one thread
(`RAYON_NUM_THREADS=1`) changed the peak by under 10%. Measured with compiler 0.31.1:

| Largest circuit | zkir peak | Prover key | Time (a busy 4-core laptop) |
|---|---|---|---|
| k = 5 (the counter example) | 14 MB | 14 KB | 8 s |
| k = 15 (four circuits of k=14 and 15, 4 `persistentHash` each) | 373 MB | 5 to 10 MB each | 5 min |
| k = 16 (8 `persistentHash` in a `fold`) | 705 MB | 19.5 MB | 2.5 min |
| k = 19 (64 `persistentHash` in a `fold`) | 2,808 MB | 153 MB | 38 min |

The k=16 contract built its keys in a 1500 MB container and printed `-9` in a 500 MB one. compactc
itself peaked at 228 MB. In a container with less than that (192 MB, 128 MB and 96 MB were tried) the
killer stops compactc instead, and `compact` prints `compiler toolchain was terminated by a signal`.
SIGKILL can also come from outside: a CI step's time limit, or `kill -9`.


### 3. Status 1: the public parameters didn't download, or the cached copy is damaged

Each `bls_midnight_2p<k>` is downloaded once and kept in a cache. Before using a file, zkir checks its
SHA-256 against a table built into it; the table is the same in every `zkir` and `zkir-v3` from
0.28.0 to 0.35.0.

- **Where they come from.** With `MIDNIGHT_PARAM_SOURCE` unset, 0.28.0 to 0.31.1 download from the
  S3 host `https://midnight-s3-fileshare-dev-eu-west-1.s3.eu-west-1.amazonaws.com/`, and 0.34.0 and
  0.35.0 from `https://srs.midnight.network/` (no 0.32 or 0.33 was released). Both serve the same
  files. Connections to the S3 host often stall before any data arrives. On 2026-10-17, 2 of 6
  connections waited 20 s; zkir 0.31.1 took 101 s, 102 s and 105 s for the 6,532-byte k=5 file in three
  runs and 12 s in a fourth, where curl took under a second; and a compile's k=19 download stopped
  after 136 KB of 96 MB.
- **Sizes.** 192 × 2^k + 388 bytes: k=10 is 192 KB, k=12 768 KB, k=16 12 MB, k=19 96 MB, k=22
  768 MB, k=25 6 GB (1 KB = 1,024 bytes here and in the checker).
- **The cache** is `$MIDNIGHT_PP` if set, else `$XDG_CACHE_HOME/midnight/zk-params`, else
  `~/.cache/midnight/zk-params`. A download in progress is a hidden temporary file in the same
  directory, `.bls_midnight_2p<k>.<random>`. zkir doesn't resume one left by a compile that stopped:
  it starts a new download, so the old file is safe to delete.
- **Download failed.** After 3 tries zkir prints `Failed to fetch data from <url> … Giving up.` and
  exits 1, with 0-byte keys: no network, a proxy or firewall, or the host refusing the request.
- **Proxies.** zkir uses `HTTPS_PROXY`: through a logging proxy, 0.31.1 connected to the S3 host and
  0.35.0 to srs.
- **srs.midnight.network and 0.31.x.** srs answers HTTP 403 to any request without a `User-Agent`
  header, and the zkir in 0.31.1 sends none (0.34.0 and 0.35.0 send `Midnight Data Provider`). Setting
  `MIDNIGHT_PARAM_SOURCE=https://srs.midnight.network/` on 0.31.0 or 0.31.1 fails every time, with or
  without the trailing slash.
- **Damaged cache.** If the file's hash is wrong, zkir prints `Hash mismatch in data stored at …`,
  exits 1, leaves 0-byte keys and doesn't download it again. Delete the file to get a new copy.

### 4. Status 101: a zkir panic

A Rust panic in zkir, printed as `thread 'main' (…) panicked at <file>:<line>:<col>:` and a message.
Four are known; each was reproduced on 2026-10-17:

| Message | Compilers and backend | Issue | Fix |
|---|---|---|---|
| `Trying to convert Fq(0x…) to an AssignedBounded less than 2^N!` | 0.31.1 to 0.35.0, both backends | [LFDT-Minokawa/compact#299](https://github.com/LFDT-Minokawa/compact/issues/299) (open) | The circuit casts a value fixed at compile time to a `Uint<…>` it doesn't fit, as in `((255 as Uint<8>) + (1 as Uint<8>)) as Uint<8>`, so no proof could ever be made. A cast to a smaller `Uint` doesn't wrap around: it fails when the value doesn't fit. Keep the wider type or change the constant, and if the code meant to wrap, write that out another way. The same cast on a value from an argument or witness compiles. The panic doesn't name the circuit. |
| `ZkStdLibArch must enable jubjub` | 0.34.0 and 0.35.0, `--feature-zkir-v3` | [LFDT-Minokawa/compact#616](https://github.com/LFDT-Minokawa/compact/issues/616) (open) | Build without `--feature-zkir-v3`: the default backend builds keys for a circuit that returns `ecMulGenerator(…)`. `Secp256k1Point` exists only with `--feature-zkir-v3` (0.34.0 and 0.35.0), so a circuit that uses it has no workaround yet. |
| `Unsupported test_eq: JubjubScalar == JubjubScalar` | 0.34.0, `--feature-zkir-v3` | [LFDT-Minokawa/compact#757](https://github.com/LFDT-Minokawa/compact/issues/757) (open) | Upgrade to 0.35.0, which builds keys for the same code on both backends. On 0.34.0, compare as `Field`: `assert((r as Field) != (0 as Field), "zero")`. |
| `cannot convert JubjubPoint to "Native"` | 0.30.0 and 0.31.1, `--feature-zkir-v3` | [LFDT-Minokawa/compact#280](https://github.com/LFDT-Minokawa/compact/issues/280) (closed) | Build without `--feature-zkir-v3`, or use 0.34.0 or later. The issue was filed on Apple Silicon; it reproduced here on x86_64 macOS. |

`JubjubScalar` and `Secp256k1Point` don't exist in 0.31.1 (`unbound identifier`), so #616 and #757
only reach contracts written for the newer compilers. A new panic is a zkir bug. Three of the four
known ones happen only with `--feature-zkir-v3`, so the other backend is worth a try while the issue is
open.

### 5. The compiler install is broken

`compact update` unpacks each version into `~/.compact/versions/<version>/<platform>/` and keeps the
archive it came from, `artifact.zip`, next to the files. An install whose unpacking was cut short has
files missing or cut short:

- **A truncated `compactc.bin`** crashes with `compiler toolchain was terminated by a signal`, even
  with `--skip-zk`.
- **No `zkir`** gives `ZKIR not found`.
- **No `zkir-v3`** fails only with `--feature-zkir-v3`: compactc checks that `zkir` exists, then runs
  `zkir-v3`, and the shell answers `exec: zkir-v3: not found` (status 127).

Running `compact update <version>` again only says `already installed`. One 0.30.0 install was found
like this on 2026-10-17: its archive was 68 MB instead of about 26 MB, `compactc.bin` was 6.9 MB
against 8.8 MB in the archive, and `zkir`, `zkir-v3`, `fixup-compact` and `format-compact` were
missing.

### 6. Key generation far slower in a Linux container on a Mac

The k=16 contract from Root cause 2 builds its keys in 149 s with the native macOS build of 0.31.1. With
the Linux build in Docker Desktop on the same Intel Mac, it hadn't finished in any of six runs, each
stopped after 10 to 20 minutes:

- three with the default threads: no memory limit, a 500 MB limit, and `ulimit -v`;
- with `RAYON_NUM_THREADS` at 1 and at 2;
- pinned to one vCPU (`--cpuset-cpus 0`).

zkir kept using CPU throughout, a third or more of it in the kernel, and its memory stayed far below
the 705 MB it needs. Earlier the same day the same setup did build the keys (1500 MB limit) and
reached `-9` (500 MB), so it isn't every run. The cause isn't known, and a native Linux machine wasn't
tested.

## Key identifiers

- **The zkir step:** `zkir compile-many '<out>/zkir' '<out>/keys'` (`zkir-v3` with
  `--feature-zkir-v3`), run by compactc after its passes; `--skip-zk` skips it.
- **Exit status:** zkir's exit code (1 an error, 101 a panic, 127 zkir-v3 not found), or minus the
  signal (-4 SIGILL, -9 SIGKILL). `compact compile` then exits 255.
- **Parameter files:** `bls_midnight_2p<k>`, k = 0 to 25, 192 × 2^k + 388 bytes. Their SHA-256 table
  is in [`scripts/check-zkir-crash.mjs`](scripts/check-zkir-crash.mjs) (`PARAM_SHA256`): read from
  the zkir binaries, and checked against downloaded files for k = 0 to 19 (k = 0 to 12 from both
  hosts).
- **Parameter hosts:** `https://srs.midnight.network/` (default from 0.34.0; needs a `User-Agent`),
  `https://midnight-s3-fileshare-dev-eu-west-1.s3.eu-west-1.amazonaws.com/` (default up to 0.31.1).
  `MIDNIGHT_PARAM_SOURCE` replaces the host.
- **Cache:** `$MIDNIGHT_PP`, else `$XDG_CACHE_HOME/midnight/zk-params`, else
  `~/.cache/midnight/zk-params`. A native proof server uses the same directory.
- **CPU flags:** `adx` in `/proc/cpuinfo` on Linux; `ADX` in `sysctl -n machdep.cpu.leaf7_features`
  on an Intel Mac. `hypervisor` on Linux means a VM.
- **Builds:** `x86_64-unknown-linux-musl`, `aarch64-unknown-linux-musl` (from 0.29.0),
  `x86_64-apple-darwin` and the Apple Silicon build, under `~/.compact/versions/<version>/` (or
  `$COMPACT_DIRECTORY/versions/`).
- **Issues:** [midnightntwrk/compact#42](https://github.com/midnightntwrk/compact/issues/42) (ADX),
  [LFDT-Minokawa/compact#299](https://github.com/LFDT-Minokawa/compact/issues/299),
  [#616](https://github.com/LFDT-Minokawa/compact/issues/616),
  [#757](https://github.com/LFDT-Minokawa/compact/issues/757) and
  [#280](https://github.com/LFDT-Minokawa/compact/issues/280) (panics).

## Diagnose

1. **Save the compile's output** and keep its output directory:
   `compact compile +0.31.1 src/contract.compact out 2>&1 | tee compile.log`.
2. **Run the checker where the compile ran, with the same environment.** That means the same machine,
   VM or container, and the same shell or CI job: `MIDNIGHT_PP`, `XDG_CACHE_HOME`,
   `MIDNIGHT_PARAM_SOURCE` and `COMPACT_DIRECTORY` decide which cache and install it checks. If you
   compiled with `compact --directory <dir>`, pass `--directory <dir>` to the checker too. It needs
   Node >= 20 and no install. It reads the CPU flags, the memory limit, the compiler install and the
   parameter cache, and downloads one 768 KB parameter file from each host to test them.

   ```sh
   mkdir -p /tmp/check-zkir-crash
   curl -fsSL -o /tmp/check-zkir-crash/check-zkir-crash.mjs \
     https://raw.githubusercontent.com/midnightntwrk/servicedesk/main/runbooks/compact-zkir-keygen-failures-runbook/scripts/check-zkir-crash.mjs
   node /tmp/check-zkir-crash/check-zkir-crash.mjs --log compile.log --out out --compiler 0.31.1
   node /tmp/check-zkir-crash/check-zkir-crash.mjs --compile src/contract.compact --compiler 0.31.1   # compiles into a temporary directory
   node /tmp/check-zkir-crash/check-zkir-crash.mjs --machine --compiler 0.31.1                        # no compile output: only the checks
   ```

   - **Input:** `--log <file>`, `--error '<text>'`, the output on stdin, or `--compile <file>`, which
     runs `compact compile` itself (add `--zkir-v3` for `--feature-zkir-v3`).
   - **`--compiler`:** the version the compile used. Give it whenever the compile ran with
     `+<version>`. Without it the checker can only ask `compact` for the default version, and it then
     can't tell whether the srs User-Agent problem applies.
   - **`--out`:** the compile's output directory. The checker reports each circuit's keys, and an old
     `contract/index.js` left from an earlier build.
   - **Other options:** `--offline` skips the download test, `--json` prints everything as JSON (its
     `result.ok` is true when nothing failed), and `--timeout <seconds>` (default 20) bounds the
     download test.

   Exit code: 0 = a known cause (the output names the fix), or no failure; 2 = no known cause, or
   nothing in the input to go on; 1 = it could not run. With `--machine`: 0 = nothing found that stops
   zkir, 2 = something was. A run in a Docker container with no network (`--network none`), on the
   counter example's output (exit 0):

   ```text
   Compile: zkir stopped with exit status 1, after "Compiling 1 circuits:"
   Machine: linux x64, Intel(R) Core(TM) i5-1038NG7 CPU @ 2.00GHz; ADX yes, BMI2 yes; virtual machine
   Memory: 7,839 MB, container limit 2,048 MB, out-of-memory kills in this cgroup: 0
   Compiler: 0.31.1, /root/.compact/versions/0.31.1/x86_64-unknown-linux-musl, install complete
   Parameter cache: /root/.cache/midnight/zk-params (HOME): no parameter files
   Download test, https://midnight-s3-fileshare-dev-eu-west-1.s3.eu-west-1.amazonaws.com/: the host name doesn't resolve: no network or no DNS (EAI_AGAIN)
   Download test, https://srs.midnight.network/: the host name doesn't resolve: no network or no DNS (EAI_AGAIN)
   Keys in out/keys: 0 of 1 circuit complete; increment: empty prover, empty verifier
   Contract: no contract/index.js (the compiler writes it only after zkir succeeds)

   Known cause: zkir couldn't download the public parameters bls_midnight_2p5 (7 KB) from midnight-s3-fileshare-dev-eu-west-1.s3.eu-west-1.amazonaws.com after 3 tries, so it stopped (exit status 1) and left empty key files. This machine can't reach either host now: midnight-s3-fileshare-dev-eu-west-1.s3.eu-west-1.amazonaws.com: the host name doesn't resolve: no network or no DNS (EAI_AGAIN); srs.midnight.network: the host name doesn't resolve: no network or no DNS (EAI_AGAIN).
   Fix:
     - Fix the network (DNS, proxy or firewall), or download the file on a machine that has network and copy it into this cache:
       mkdir -p '/root/.cache/midnight/zk-params'
       curl -fL --retry 5 -C - -o '/root/.cache/midnight/zk-params/bls_midnight_2p5.part' https://srs.midnight.network/bls_midnight_2p5 && mv '/root/.cache/midnight/zk-params/bls_midnight_2p5.part' '/root/.cache/midnight/zk-params/bls_midnight_2p5'
     - Then run this check with --machine to confirm the file's SHA-256, and compile again.
   Don't use this output: a deploy needs every circuit's verifier key, and proving needs the prover keys. Compile again after the fix.
   Runbook: compact-zkir-keygen-failures-runbook.md
   ```

3. **By hand, without the script:**
   - **CPU:** `grep -o -w -m1 adx /proc/cpuinfo` on Linux prints `adx` if the CPU has it; on an Intel
     Mac, `sysctl -n machdep.cpu.leaf7_features | grep -o -w ADX`.
   - **Memory:** `cat /sys/fs/cgroup/memory.max` in a container (`max` is no limit), and
     `grep oom_kill /sys/fs/cgroup/memory.events` for the number of out-of-memory kills.
   - **Cache:** `ls -la ~/.cache/midnight/zk-params` (or `$MIDNIGHT_PP`, or
     `$XDG_CACHE_HOME/midnight/zk-params`). Compare each file's size with 192 × 2^k + 388 and its
     `sha256sum` (`shasum -a 256` on macOS) with `PARAM_SHA256[k]` in the checker.
   - **Install:** `unzip -l ~/.compact/versions/<version>/*/artifact.zip` against
     `ls -l ~/.compact/versions/<version>/*/`.

## Remediation

1. **No ADX (status -4).**
   - **A VM:** give it the host's CPU model (Proxmox CPU type `host` instead of the default
     `x86-64-v2-AES`, libvirt `<cpu mode='host-passthrough'/>`, QEMU `-cpu host`), then check with
     `--machine` inside it.
   - **The hardware itself:** compile on a machine with ADX (Root cause 1 lists which), and use that
     compile's whole output directory.
   - **Meanwhile:** `compact compile --skip-zk` still checks the contract and writes `contract/`,
     enough for development and the simulator; only the keys need ADX.
   - **On Apple Silicon:** use the native build. In Docker, use an arm64 image (drop
     `--platform linux/amd64`) and the installer picks `aarch64-unknown-linux-musl`; on the Mac
     itself, install from a terminal where `uname -m` prints `arm64`.
2. **Out of memory (status -9, or compactc killed in a small container).** Give the compile more
   memory than the table in Root cause 2 shows for its largest circuit: `docker run --memory 4g`,
   Docker Desktop's memory setting (Settings, Resources), or a bigger CI runner. Splitting the
   largest circuit into smaller ones lowers the peak; fewer threads don't.
3. **Download failed (status 1, `Failed to fetch data`).** Fetch the file with curl, which zkir then
   finds in its cache and checks. It downloads to a `.part` file and renames it only when it's
   complete, so a cut-off download never sits under the name zkir reads; run it again to resume:

   ```sh
   k=5   # from the error: bls_midnight_2p<k>
   d=~/.cache/midnight/zk-params
   mkdir -p "$d"
   curl -fL --retry 5 -C - -o "$d/bls_midnight_2p$k.part" "https://srs.midnight.network/bls_midnight_2p$k" \
     && mv "$d/bls_midnight_2p$k.part" "$d/bls_midnight_2p$k"
   ```

   Use `$MIDNIGHT_PP` or `$XDG_CACHE_HOME/midnight/zk-params` for `d` if either is set; the checker
   prints the command with the right path.
   - **No network on this machine:** run the same commands on one that has it, and copy the file into
     this machine's cache.
   - **Behind a proxy:** set `HTTPS_PROXY` for the compile; zkir uses it.
   - **0.31.x with `MIDNIGHT_PARAM_SOURCE=https://srs.midnight.network/`:** remove the variable, or
     fetch with curl as above; zkir can't download from srs on these versions.
   - **CI, containers and many machines:** keep the cache directory between runs (a CI cache or a
     Docker volume on `~/.cache/midnight`), so each file is downloaded once.
   - **A compile stuck on `Compiling N circuits:`:** if a `.bls_midnight_2p<k>.*` file in the cache is
     growing, zkir is downloading; stop it, fetch the same file with curl, and compile again. zkir
     can't resume a download, so its partial file is of no use to it anyway.
4. **Damaged cache (status 1, `Hash mismatch`).** Delete the named file. On 0.31.x, whose zkir
   downloads from the slow S3 host, put a copy fetched with curl in its place (step 3); on 0.34.0 and
   later, compiling again downloads a new one. `--machine` hashes every cached file.
5. **A panic (status 101).** Follow the table in Root cause 4. For a panic that isn't there, open an
   issue at [LFDT-Minokawa/compact](https://github.com/LFDT-Minokawa/compact/issues) with the
   smallest contract that does it, the compiler version, the backend and the panic lines.
6. **Broken install (`terminated by a signal` with `--skip-zk` too, `ZKIR not found`, or status 127).**
   Remove that version and install it again. The toolchain's files are read-only, so `rm` needs `-f`.
   Check the path first: it's the version under the directory you compile with. If you compile with
   `compact --directory <dir>`, use `<dir>` in both lines.

   ```sh
   v=0.31.1   # the broken version
   rm -rf "${COMPACT_DIRECTORY:-$HOME/.compact}/versions/${v:?set v first}"
   compact update "$v" --no-set-default
   ```

   Leave out `--no-set-default` if it should become the default. The checker prints both commands with
   the exact path. Tested on a deliberately truncated 0.31.1 install in Docker and in a scratch copy of
   `~/.compact`. If the install is complete and you still get `ZKIR not found`, compile through
   `compact compile` rather than running `compactc.bin` directly.
7. **Stuck in a Linux container on a Mac (Root cause 6).** Compile with the native macOS build instead,
   and copy the output directory into the container if the rest of the build runs there.
8. **After any of these:** compile into the same directory again, or a clean one. Don't deploy an
   output whose keys are 0 bytes, or whose `contract/` is older than its `zkir/`.
9. **No known cause.** Exit 2 from the checker: open an issue at the servicedesk front door with the
   compile output, the checker's `--json` output and the contract if you can share it.

## Upstream follow-ups

- [midnightntwrk/compact#42](https://github.com/midnightntwrk/compact/issues/42) (to raise): no reply
  since 2026-08-05. A build without ADX, or a clear error naming ADX instead of `exit status -4`, would
  turn this into a one-line answer.
- zkir 0.31.x sends no `User-Agent`, and srs.midnight.network refuses requests without one (to
  report): `MIDNIGHT_PARAM_SOURCE` can't point the network compiler at the faster host.
- [LFDT-Minokawa/compact#757](https://github.com/LFDT-Minokawa/compact/issues/757): open, but 0.35.0
  builds keys for its contract on both backends.
- After a failed zkir step, compactc leaves 0-byte keys and any older `contract/` in place (to
  report): a later deploy can pick them up.

## Reference material

- **Checker and test:** [`scripts/check-zkir-crash.mjs`](scripts/check-zkir-crash.mjs) and
  [`scripts/test-check-zkir-crash.mjs`](scripts/test-check-zkir-crash.mjs). The reproductions, live
  runs, test and mutation runs are in [`scripts/check-zkir-crash.NOTES.md`](scripts/check-zkir-crash.NOTES.md).
- **Source:** `compiler/passes.ss` at
  [`compactc-v0.31.1`](https://github.com/LFDT-Minokawa/compact/blob/compactc-v0.31.1/compiler/passes.ss)
  (the zkir step and its messages).
- **Issues:** [midnightntwrk/compact#42](https://github.com/midnightntwrk/compact/issues/42) and
  [#26](https://github.com/midnightntwrk/compact/issues/26) (`-4` on 0.27.0, closed by its reporter
  without a cause);
  [LFDT-Minokawa/compact#299](https://github.com/LFDT-Minokawa/compact/issues/299),
  [#616](https://github.com/LFDT-Minokawa/compact/issues/616),
  [#757](https://github.com/LFDT-Minokawa/compact/issues/757),
  [#280](https://github.com/LFDT-Minokawa/compact/issues/280).
- **Related runbooks:** [Proof server and proving failures](../proof-server-proving-failures-runbook/proof-server-proving-failures-runbook.md)
  (the same parameter files, downloaded by the proof server),
  [Compact compile errors](../compact-ai-generated-compile-errors-runbook/compact-ai-generated-compile-errors-runbook.md)
  (errors before zkir runs) and
  [Toolchain mismatch](../toolchain-version-mismatch-runbook/toolchain-version-mismatch-runbook.md).
