# Notes: `check-compact.mjs`

How the [Compact compile errors runbook](../compact-ai-generated-compile-errors-runbook.md) was
reproduced, what the checker does, and how it was tested and reviewed. **The user runs it** on their
own contracts; it never edits them.

## Where the cases came from

- **midnight-expert's catalogue.** These are 97 distinct mistake patterns from the Compact references
  in midnightntwrk/midnight-expert at `db9afac4d8472f3c9c698f4bf376f48373ae1714`
  (`compact-structure/references/common-mistakes.md`, `compact-review/references/compilation-review.md`,
  `compact-language-ref/references/troubleshooting.md`, `commands/debug-contract.md` and others),
  each with the wrong code, the fix and the error text the references claim.
- **Real-world reports.** These are 27 more patterns from servicedesk, midnight-expert, Compact and
  midnight-docs issues and the Technical Moderator reports (for example compact#19, midnight-expert#229,
  servicedesk#180, #202, #170, #86, compact#296, #833, #834, midnight-expert#256).
  - Two mistakes dominate the hard evidence: version and pragma drift, and missing or misplaced
    `disclose()`.
  - The friction report's headline hallucinations (`Map.get`, `Cell<T>`, `Void`) appear mostly in
    the catalogues, not in pasted user errors.
  - The 34 Kapa compile-failure queries counted in midnight-docs#1377 aren't public; their texts
    weren't available.
- **The end-to-end test** (below) added 7 patterns, **the fact-check** added 2 (reserved words used
  as syntax, and a struct called like a function), and **the real-contract test** added 6 (an
  `assert` with type arguments and no message, a method a nested Map's values don't have, the older
  `Unsigned Integer[N]`, `.x` on a `JubjubPoint`, a ledger type used as a value, and `Map` with one
  type argument).

## How each case was reproduced

Each case is a folder with `wrong*.compact` (one mistake each), `right*.compact` (the minimal fix)
and its metadata. Every file was compiled with `compact compile +0.31.1 --skip-zk` and `+0.35.0`, and
the exit code and exact message were recorded. All of it is in [`cases.json`](cases.json), including
helper files for the include and module cases (`extra_files`) and the probe contracts some runtime
checks use (`runtime_files`).

| | Count |
|---|---|
| Cases | 139 |
| Wrong contracts | 240: 210 rejected by 0.31.1; 30 (in 24 cases) compile |
| Corrected contracts | 173: all compile on 0.31.1; 169 also on 0.35.0 |
| Wrong contracts that behave differently on 0.31.1 and 0.35.0 | 14 compile on one and not the other; 23 get a different message |
| Distinct compiler messages | 198 |

The 4 corrected contracts that fail on 0.35.0 are 0.31.1 workarounds: the `ecMulGenerator` forms,
which take a `JubjubScalar` on 0.35.0, and the exact pragma pin `0.23`.

**0.34.0**, the default compiler on many machines, was run over the corpus once for comparison (385
files, before the last eight cases were added). Its first errors match 0.35.0's everywhere except
`PublicAddress` and `kernel.caller()`, which 0.34.0 doesn't have, and the pragmas that pin 0.26 or 0.27.
Its language version is 0.26.0.

**The catalogue's "wrong" code compiles on 0.31.1** in 20 cases, so the claim is false or the
"mistake" isn't a compile error:

- **Valid Compact:** `else if`; `map`, `slice<N>` and `List.length()`; `Uint<64> as Bytes<32>`; Boolean
  to Field casts; `Field + Uint<64>`; `Field == Uint<64>` (rejected by 0.34.0 and 0.35.0); `pragma
  language_version >= 0.22` and `>= 0.22.0`; an enum used without `export` (the TypeScript side loses
  the names); Uint subtraction (the compiler adds an underflow check).
- **Disclosure that isn't needed:** an `assert` on a witness-versus-ledger comparison doesn't need
  `disclose()`; disclosing at the witness call compiles; branching on `checkRoot` after
  `disclose(root)` compiles.
- **Design or security problems, not compile errors:** `ownPublicKey()` for authorization,
  `unshieldedBalance()` in a condition, `Map.lookup` without `member`, a Merkle path not bound to the
  caller, and the token cases (`kernel.mintShielded` directly, a deposit without `receiveShielded`,
  the self-mint).

In 4 more cases some of the wrong files compile: `event` and `log` as names (`event` is reserved on
0.34.0 and 0.35.0), a `Uint<64>` amount to `sendShielded` / `sendImmediateShielded` (it widens to the
declared `Uint<128>`), a `Uint<64>` index to `evolveNonce`, and a `Uint<64>` passed to a `Field`
parameter (0.31.1 converts it; 0.34.0 and 0.35.0 don't).

**Error texts the catalogue claims, against what the compiler prints** (0.31.1):

| Catalogue says | Compiler prints |
|---|---|
| `implicit disclosure of witness value` | `potential witness-value disclosure must be declared but is not: …` (the only disclosure message) |
| `unknown type "Void"` / `found "{" looking for ";"` | `unbound identifier Void` |
| `unbound identifier "function"` | `found keyword "function" (which is reserved for future use) looking for "circuit"` |
| `cannot reassign const binding` | `expected left-hand side of = to have an ADT type, received …` |
| `unknown function "hash"` | `unbound identifier hash` |
| `operation "get" undefined for Map` | `operation get undefined for ledger field type Map<…>` (and `delete` is a reserved word, so `Map.delete` never gets that far) |
| `recursive circuit call` | `recursion involving <name>` |
| `~s is a reserved word` | `found keyword "X" (which is reserved for future use) …` |
| `requires 2 type parameters` (MerkleTree) | `mismatch between actual number 1 and declared number 2 of ADT parameters for MerkleTree` |

The catalogue's own files also disagree with each other on 33 patterns (different error texts,
different fixes, or one file calling valid code a mistake). For the compile-time ones, each case's
`notes` in `cases.json` record what the compiler actually does.

**Behaviour that matters for the runbook:**

- **One error per run.** Disclosure errors are the exception: all of them are printed together. A
  parse error stops the compiler first. Then unknown names: across the file's declarations the last
  one is reported first (as in compact#19), but within one circuit it's the first. Type errors come
  in file order, and an unknown name hides a type error wherever it sits.
- **0.31.1 names the replacement for old names** (`apparent use of an old standard-library /
  ledger operator name CurvePoint: the new name is JubjubPoint`). 0.34.0 and 0.35.0 dropped the two
  type aliases (`CurvePoint` and `NativePoint`), so they say `unbound identifier CurvePoint`; they
  kept the 33 function and 20 ledger-operation aliases.
- **`compact fixup`:**
  - It uses the default compiler and ignores `+version` (`compact fixup +0.31.1 --version` printed
    0.34.0, the default here).
  - 0.31.1's own binary, `~/.compact/versions/0.31.1/<platform>/fixup-compact <file>`, prints the
    result to stdout and leaves the file alone; `fixup-compact <file> <target>` writes the target.
  - With 0.31.1 (tested in an isolated `COMPACT_DIRECTORY` and with the binary directly) it rewrote
    `persistent_hash`, `CurvePoint`, `nativePointX` and `m.is_empty()`. It stops on a remaining name or
    type error (`m.get()`, a `Uint<8>` width mismatch) but not on a disclosure error, and it reformats
    the whole file.
  - The 0.34.0 and 0.35.0 fixup binaries fail on `CurvePoint`.
- **Not in 0.31.1:** `keccak256`, `jubjubSchnorrVerify`, `JubjubSchnorrSignature`, `ecNeg`,
  `JubjubScalar`, `emit` (standard-library event types only; a user struct gets `is not a declared event
  type`) and cross-contract calls compile on 0.34.0 and 0.35.0. `PublicAddress` and `kernel.caller()`
  compile only on 0.35.0. On 0.31.1, a cross-contract call first fails with `error opening
  …/contract-info.json; try (re)compiling X.compact`, and with the other contract compiled next to the
  output, `cross-contract calls are not yet supported`.
- **Changed since 0.31.1** (on 0.34.0 and 0.35.0): a bare number literal is a `Uint` (`const x: Field = 1`
  and `return 0` from a `Field` circuit fail), a `Uint` no longer converts to a `Field` implicitly, and
  `Field == Uint<64>` is rejected.

## Runtime checks

A fix that compiles isn't necessarily right. 40 cases were run with `@midnight-ntwrk/compact-runtime`
0.16.0: each contract was compiled with 0.31.1, deployed in memory, and its circuits called. Each
case's `runtime.checks` in `cases.json` says exactly what was checked. Most checks cover both the
accepting and the rejecting path; a few disclosure checks only confirm that the fixed contract
stores the right value.

| Result | Cases |
|---|---|
| PASS | 34, including `division-modulo`, where the catalogue's own fix fails |
| UNVERIFIABLE in memory (token settlement needs a network) | 5: `kernel-mintshielded-direct`, `missing-receive-shielded`, `cross-contract-call`, `disclose-exported-param-ledger`, `disclose-stdlib-call-args` (every in-memory check in the last two passed) |
| The catalogue's fix is wrong | `mint-unshielded-to-self-without-receive`: `mintUnshieldedToken` to the contract itself already records the receipt (`unshieldedInputs[color]` equals the mint), and the catalogue's added `receiveUnshielded` doubles it |

Not run, on purpose: the `keccak256` → `persistentHash` swap (a different hash by design), the
hand-written Schnorr check in `newer-compiler-features/right2.compact` (it compiles on 0.31.1, but the
runbook doesn't recommend it), and the `blockheight-now` fixes (the time comparisons are covered by
`record-current-time`).

**Catalogue fixes that are wrong:**

- **Division (when run):** a check of only `q * b <= a` accepts a too-small quotient (100 / 9 with
  q = 10), and any quotient when b = 0. The witness quotient-and-remainder version rejects all of them
  (the catalogue's version is kept as `catalogue-fix.compact` in the case's `runtime_files`).
- **The self-mint (when run):** described above.
- **Recursion (doesn't compile):** the catalogue's bounded-loop rewrite reassigns a `const`
  (`expected left-hand side of = to have an ADT type`). The corpus's own first fold rewrite was wrong
  too: it returned 20! for every n > 20 until it asserted n <= 20.
- **Sealed fields (doesn't compile):** moving the write into a non-exported circuit called from an
  exported one is rejected the same way; only the constructor can write a sealed field.

**Other runtime facts the runbook relies on:**

- **`disclose()` leaves no trace** in the generated JavaScript or ZKIR (checked in every disclosure
  case). In the two cases where the code compiles both with and without it, the output is
  byte-identical once file names are normalised.
- **`Map.lookup` on a missing key throws** `expected a cell, received null`; it doesn't return a
  default.
- **`if (tree.checkRoot(root))` with a bad root is a silent no-op.**
- **`ownPublicKey()` returns the caller's own coin key** (the context's `coinPublicKey`). A caller
  passes `ownPublicKey() == owner` by copying the public owner key. In the compiled ZKIR it is a
  private input compared to the ledger value. The hash-of-secret pattern rejects a wrong secret and
  the public value used as a secret.
- **`unshieldedBalance()` in a condition records the exact balance in the transcript.** Replayed
  with `QueryContext.runTranscript` at other balances, it fails; the `…Gt`/`…Lt` forms record only
  the Boolean.
- **Arithmetic:** a Uint cast fails at runtime when the value doesn't fit, and two `Uint<248>` values
  can't be added directly. Subtraction keeps the type, and the compiler adds an underflow check:
  `0 - 1` fails with `result of subtraction would be negative`.
- **Shifts:** `(x * 8) as Uint<16>` equals `x << 3` only because it widens. Cast to `Uint<8>`, it fails
  for every x ≥ 32.
- **Time:** `blockTimeLt` and the others compare with seconds since the Unix epoch. With the block time
  at T, the runbook's time window accepted T and T − 599 and rejected T + 1 and T − 600.
- **Merkle membership:** a path that isn't bound to the caller's own leaf lets anyone pass with another
  member's path; `assert(path.leaf == commitment, …)` stops that.
- **`Counter`:** `increment(5)` adds 5 on every call (5, then 10); `resetToDefault()` then
  `increment(5)` sets it to 5 each time.
- **`ecNeg` on 0.31.1:** `constructJubjubPoint(0 - jubjubPointX(p), jubjubPointY(p))` added to `p` gives
  the identity, and negating twice gives `p` back. While testing it, `ecMulGenerator(k)` with a `Field`
  at or above the Jubjub scalar order failed at runtime (`failed to decode for built-in type
  EmbeddedFr`).

## End-to-end test

A fresh agent with only the runbook and the checker fixed four AI-written contracts (a vault, an
auction, a vote and an escrow) until they compiled with 0.31.1. Where it got stuck, or the runbook
was silent, the runbook and checker were changed and a case was added to the corpus:

- `blockTime()`, and recording the current time
- `event` declarations
- a loop bound that isn't a constant (`invalid context for reference …`)
- 0.31.1's "expected … but received" wording for widened arithmetic
- the disclosure output and the summary line
- Uint subtraction
- a Merkle path not bound to the caller

## Reviews

**Fact-check.** An independent pass re-ran every claim in the runbook and these notes against the
compilers (0.34.0 included) and the runtime. All 25 problems it found are fixed:

- **Wrong `--explain` answers for look-alike messages.** A shift was read as an angle-bracket cast,
  `match` as a witness with a body, 0.35.0's `emit` as missing `if` parentheses. The type-argument
  forms had the wrong number of arguments, and reserved words used as syntax (`void`, `throw`, `null`,
  `this`) were told to rename. The test runner now checks 25 such messages.
- **The `--compile` disclosure line** showed where the path starts, not where the value becomes public.
- **The "0.35.0-only" list:** most of it is already in 0.34.0.
- **Overstatements:** stale counts, the `fixup` description, the error order, signature advice that
  trusted a witness, and the factorial blame.

**Real contracts.** The checker was run on 1,100 `.compact` files from 31 public repos, each compiled
with 0.31.1 first. The repos include midnight-expert at HEAD, LFDT-Minokawa/compact at
`compactc-v0.31.1`, compact-end-2-end, midnight-contracts, midnight-examples, OpenZeppelin
compact-contracts at `v0.3.0-rc.2` and the example-* repos. Adversarial inputs were added on top.

| | Before | After |
|---|---|---|
| 509 files that compile with 0.31.1 | 53 false errors in 28 files | 0 errors, 5 warnings |
| Adversarial inputs that compile | 18 false findings | 0 |
| `--explain` on the 591 real failures | 457 explained | 574 explained |
| 5 MB file of `a / b` lines | killed at 400 s | 2.4 s |
| 1 MB files of `caller` and `send(` | 49–52 s | 0.6 s |

The 5 warnings are names defined in an included or imported file, and a `Uint<1000>` in a generic
module that's never instantiated, which the compiler doesn't check until the module is used. Of the
591 real files that fail on 0.31.1, 263 are now flagged statically. The 17 failures `--explain` still
has no answer for come from the Compact repo's regression tests for compiler edge cases (external
contract declarations, tuple slicing, a 300-digit literal), and one is the hang below.

What was fixed:

- **Coin methods:** `insertCoin` and `pushFrontCoin` were missing. The extraction skipped functions
  whose kind is a parenthesised form.
- **Imports:** `import { … } from CompactStandardLibrary` wasn't recognised, and standard-library names
  were matched when used as field or enum names.
- **Loops:** `for` bodies without braces, and `return` inside an anonymous circuit in a loop.
- **Identifiers:** `$` in identifiers. Names defined in an included or imported file are now warnings.
- **Smaller misreads:**
  - `if  (` with extra spaces
  - a user struct's own camelCase fields
  - parameters of constructors and lambdas, and destructured consts
  - a `<` comparison read as a type argument
  - pragma `!` and parentheses
  - a `#depth` size parameter
  - the same field name in two modules
- **Files `--compile` skipped:** files with an inline module or only `export pure circuit` were never
  compiled. Now every file with a pragma, or with exports outside a module, is compiled, and the
  summary says how many weren't.
- **A hanging compile:** the timeout killed only the `compact` CLI and left the compiler running. It
  now kills the process group, and the limit is `--timeout` (default 300 s).
  `midnight-contracts/contracts/bugs/execution/pm_16012.compact` hangs both compilers.
- **Symlinks:** loops, broken links and duplicate files.
- **Speed:** line numbers were recomputed for every finding.
- **Missed by the static scan:** an `assert` with a comma inside type arguments and no message, and
  `m.lookup(a).get(b)` on a nested Map. Both are flagged now.
- **Messages with no explanation:** a ledger type used as a value, `.x` on a `JubjubPoint`, wrong type
  argument counts for any ledger type, ambiguous overloads, include and type cycles, out-of-range
  literals, lengths and Uint ranges, keywords in the wrong place, and the older `Unsigned Integer[N]`.

## What the checker does

- **Static scan.** It blanks comments and strings (keeping positions), then applies rules taken from
  the reproduced cases:
  - pragma against the target compiler's language version
  - include paths
  - old names (from the compiler's alias tables)
  - invented functions and types (a warning, not an error, when the file includes or imports other
    code)
  - names newer than 0.31.1
  - methods each ledger type doesn't have (from `midnight-ledger.ss`), including on a nested Map's
    values
  - camelCase struct fields
  - syntax from other languages (loops, `let`/`var`, `break`, `switch`/`match`, `try`, `::`, tuple
    `.0`, `if` without parentheses, `emit`, top-level `const`, `default<T>()`, `Bytes<N>{}`,
    one-argument `assert`, the old `assert x "msg"` form, modifier order, reserved words used as
    syntax, a struct called like a function)
  - operators Compact lacks (`& | ^ ~ << >> / %`)
  - Uint widths outside 1 to 248 (a warning inside a generic module), the older `Unsigned Integer[N]`,
    and MerkleTree depth
  - missing type arguments
  - a missing standard-library import
  - assignment to a ledger type, or to a `const` declared earlier in the same circuit
  - `return` inside `for`
- **`--compile`.** It compiles each contract with 0.31.1 into a temporary directory. Each compile is
  stopped after `--timeout` seconds (300 by default). It explains the first error using the source
  line it points at, or lists every disclosure error with the point where the value becomes public.
  If 0.31.1 fails and 0.35.0 is installed, it also tries 0.35.0.
- **`--explain`.** It explains a pasted message.
- **Names.** All names come from the compiler source at `compactc-v0.31.1` and `compactc-v0.35.0`.

## Script test runs

[`test-check-compact.mjs`](test-check-compact.mjs) re-runs the whole corpus. On Node 20.19.1, macOS:

| Run | Result |
|---|---|
| Static scan over 413 contracts | 143 of the 210 rejected wrong contracts flagged; the other 67 (mostly disclosure and type errors) are left to `--compile`. No errors on the 173 corrected contracts |
| Look-alike messages through `--explain` | 25 of 25 get the expected fix |
| `--compile` (826 compiles, both compilers) | Every first error and exit code matches the recorded one, and every message has an explanation |

Bugs these runs caught, all fixed:

- A table lookup matched `constructor` through `Object.prototype`.
- The `Bytes<N>{` rule fired on circuit return types.
- The `assert`-message check read `<` as a bracket.
- `--compile` told a user to rename `while`.

Also checked by hand:

- the runbook's example (`vault.compact` with `Map.get` and `while`), and `--compile` on it
- a missing path, a directory, broken and looping links
- a hanging file with `--timeout 20`: stopped at 20 s, no compiler process left running
- Node 18 (refused)

## Not reproduced

- **Token settlement on a network:** whether the ledger rejects the double-counted self-mint, a
  direct `kernel.mintShielded`, or a coin sent without `receiveShielded`. These need a devnet.
- **The Kapa compile-failure query texts.**
- **IDEs, Windows, and agents other than Claude Code** (only the patterns they produce are covered).

## Re-verify when versions move

- **When the networks change compiler:** run `node test-check-compact.mjs --compile` with the new
  compiler installed. Any result that changed is printed with the recorded and new text, as is any
  message without an explanation.
- **Rebuild the names lists:** take them from the new tag's `standard-library.compact`,
  `midnight-natives.ss`, `midnight-ledger.ss` and `standard-library-aliases.ss`. For ledger methods,
  match each `(function <kind> <name>`, where `<kind>` may be a parenthesised form and the declaration
  may span several lines, and leave out `js-only` ones.
- **Update the version notes:** the `NETWORK_COMPILER` and `LANGUAGE` constants, and the runbook's
  version sections.
