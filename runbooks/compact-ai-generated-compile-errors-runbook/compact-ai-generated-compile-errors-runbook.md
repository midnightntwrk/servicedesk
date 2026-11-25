---
title: "Compact contract won't compile (AI-written or copied code)"
when_to_use: "`compact compile` rejects a contract an agent wrote or copied: invented or old names (`unbound identifier`, `apparent use of an old … name`), methods a ledger type doesn't have, missing `disclose()`, syntax from other languages, a pragma for another compiler, or the contract-type rules of 0.36."
audience: "developers support-agents"
owner: "mn-servicedesk"
compiled: "2026-10-08"
last_reviewed: "2026-11-23"
error_strings:
  - "unbound identifier"
  - "apparent use of an old standard-library / ledger operator name"
  - "undefined for ledger field type"
  - "potential witness-value disclosure must be declared but is not"
  - "no compatible function named"
  - "has no field named"
  - "(which is reserved for future use)"
  - "cross-contract calls are not yet supported"
  - "another binding found for"
  - "a contract type cannot declare circuit"
  - "contract implements failure"
  - "cannot cast from type contract"
  - "expected structure type, received contract"
review_when:
  - "The support matrix moves every network to a compiler other than 0.36.1: the checker's NETWORK_COMPILER and LANGUAGE, the pragma advice, and Remediation 8"
  - "A Compact release changes a message in the Symptom table: run `node scripts/test-check-compact.mjs --compile` to see which"
  - "Compact makes contract implements reject callees that are pure without the keyword or call a witness (servicedesk#298): drop the implements-unprovable warning"
---

# Runbook: Compact contract won't compile (AI-written or copied code)

An agent's Compact contract looks right and `compact compile` rejects it. The code borrows from other languages (`while`, `msg.sender`, `Map.get`), from Compact written for 0.31.1 (`CurvePoint`, a Field literal, `pragma … <= 0.23`), or breaks a 0.36 rule for contracts that call contracts. The compiler prints one error per run (disclosure errors excepted), so fixing them one by one goes round in circles. The checker flags known mistakes in one pass, with fixes. Then compile with 0.36.1, which every network needs.

Each fact is in Key identifiers with its source. A claim marked **measured**, **reported**, **inferred** or **not tested** has none, so trust it less.

## Symptom

The compiler exits 255 with `Exception: <file> line N char M:` and one message (0.36.1's wording; each reproduced with a fix, **measured**).

| Message (start) | Usually means | Go to |
|---|---|---|
| `unbound identifier X` | An invented name (`hash`, `verify`, `now`, `Address`), an old one (`Void`, `CurvePoint`), a missing `import CompactStandardLibrary;`, or an older compiler than 0.36.1 (`keccak256`, `sha512`) | Remediation 2, 1, 8 |
| `apparent use of an old standard-library / ledger operator name X: the new name is Y` | Older Compact (`persistent_hash`) | Remediation 1 |
| `operation X undefined for ledger field type T` | A method the type lacks: `Map.get`, `.set`, `Counter.value()`; `operation =` assigns a `Counter` | Remediation 3 |
| `potential witness-value disclosure must be declared but is not` | A private value reaches the ledger, a return, a condition, a token call or another contract without `disclose()`. All of them print in one run | Remediation 7 |
| `no compatible function named X` | A missing type argument (`persistentHash(x)`, `none()`), or wrong argument types, count or order; `ecMulGenerator` given a `Field` (0.31.1's form) | Remediation 6 |
| `language version X mismatch` | The pragma doesn't accept the compiler's language, X (0.28.0 for 0.36.1) | Remediation 8 |
| `structure X has no field named Y` | camelCase: `goesLeft` is `goes_left` | Remediation 1 |
| `parse error: found keyword "X" (which is reserved for future use)` | `let`, `while`, `switch`, `try`, `throw`, `null`, `void`, `function`, `this`, `public`, `event` | Remediation 4 |
| `parse error: found … looking for …`, `recursion involving X`, `return is not supported within for loops`, `invalid context for reference to …` | Other-language syntax: `for i in`, `Bytes<32>{…}`, `match x {`, recursion, a loop bound that isn't constant | Remediation 4 |
| `unexpected character`, or `expression4` | Operators Compact lacks: `&`, `%`, `/`, `<<` | Remediation 5 |
| `expected … to have type Uint<64> but received Uint<0..…>`, `mismatch between actual type`, `incompatible types`, `cannot cast from type` | Arithmetic not cast back, a Field compared with `<`, a literal used as a Field | Remediation 6 |
| `failed to locate file "…"` | A path that doesn't resolve, or `include "x.compact"` | Remediation 9 |
| `a contract type cannot declare circuit X pure`, `contract implements failure`, `cannot cast from type contract …`, `expected structure type, received contract …` | Contract-type rules: no pure circuits in a type, an implemented circuit declared `pure`, no address from a contract reference | Remediation 10 |
| `error opening …/contract-info.json`, `cross-contract calls are not yet supported` | A compiler older than 0.34.0 | Remediation 8 |
| `another binding found for X in the same scope` | A standard-library name (`send`), or a name declared twice | Remediation 9 |

### Not this runbook

- **Compiles but won't deploy** (`EraMismatchError`): the [version mismatch runbook](https://github.com/midnightntwrk/servicedesk/blob/main/runbooks/toolchain-version-mismatch-runbook/toolchain-version-mismatch-runbook.md).
- **Transactions rejected** (`Custom error: N`): the [1010 runbook](https://github.com/midnightntwrk/servicedesk/blob/main/runbooks/node-1010-custom-error-runbook/node-1010-custom-error-runbook.md).
- **`zkir returned a non-zero exit status`**: the [zkir runbook](https://github.com/midnightntwrk/servicedesk/blob/main/runbooks/compact-zkir-keygen-failures-runbook/compact-zkir-keygen-failures-runbook.md).

## Root cause

Models fill gaps in their Compact from:

1. **Other languages:** Solidity, Rust and TypeScript syntax, and helpers that don't exist.
2. **Older Compact:** renamed names, removed syntax, and code for 0.31.1 that 0.34.0 and later reject: a bare literal is a `Uint`, not a `Field`; a `Uint` doesn't convert to a `Field`; `ecMulGenerator` takes a `JubjubScalar`; `event` is reserved; pragmas pinned to language 0.23 (**measured**: 8 contracts that compile on 0.31.1 fail on 0.36.1).
3. **0.36's contract-type rules.**
4. **Wrong references:** trust the compiler.

## Before you start

- **You need** Node 20 or later; for `--compile`, the `compact` CLI with 0.36.1 (`compact update 0.36` installs it).
- **Safety.** Read-only, and compiles go to a temporary directory. No keys.

## Diagnose

1. **Run the checker.** The static scan reads the files; `--compile` also compiles each with 0.36.1:

   ```sh
   curl -fsSL -o check-compact.mjs \
     https://raw.githubusercontent.com/midnightntwrk/servicedesk/main/runbooks/compact-ai-generated-compile-errors-runbook/scripts/check-compact.mjs
   node check-compact.mjs contracts/                     # every .compact file
   node check-compact.mjs --compile contracts/main.compact
   node check-compact.mjs --explain 'operation get undefined for ledger field type Map<Field, Field>'
   ```

   Each finding comes with its fix:

   ```text
   contracts/vault.compact:7:10  error  ledger-method  Map has no get().
       fix: Use `balances.lookup(…)`. Map methods: insert, insertCoin, insertDefault, isEmpty, lookup, member, remove, resetToDefault, size.
   ```

   `error` lines are what 0.36.1 rejects; `warning` lines compile but are wrong (Remediation 11). `--compile` explains each compiler error, says where `disclose()` goes, and marks code that compiles only on 0.31.1. Exit code: 0 clean, 2 a problem, 1 couldn't run.

2. **Fix what it flags, then compile** with `compact compile +0.36.1 <src> <out>`, fixing each error printed (table, or `--explain`) until clean.

## Remediation

1. **Old names.** Use the name the compiler prints (`persistent_hash` → `persistentHash`, `.goesLeft` → `.goes_left`, `CurvePoint` → `JubjubPoint`). To rewrite them at once: `compact update 0.31.1 --no-set-default`, then `~/.compact/versions/0.31.1/<platform>/fixup-compact <in> <out>`. It stops while a name or type error remains.

   *Trade-off:* fixup reformats the whole file: keep a copy.

2. **Invented functions and types.** Use the pattern that does the job:

   | Invented | Use |
   |---|---|
   | `msg.sender`, `caller`, `public_key()` | The hashed-secret pattern below (`kernel.caller()` reads `none` for a user's call) |
   | `hash(x)` | `persistentHash<T>(x)` (for the ledger) or `transientHash<T>(x)` |
   | `verify(…)`, `verify_signature(…)` | `jubjubSchnorrVerify`, `secp256k1EcdsaVerify`, `secp256r1EcdsaVerify` or `ed25519Verify`. Never a result from a witness |
   | `random()`, `encrypt()` | A witness; `persistentCommit<T>(value, rand)` to hide a value |
   | `now()`, `blockHeight()` | `blockTimeLt`, `blockTimeGte` and the like (seconds since the Unix epoch) |
   | `Address`, `String`, `Void` | `ContractAddress`, `UserAddress` or `PublicAddress`; `Bytes<N>`; `[]` |

   ```compact
   import CompactStandardLibrary;
   witness secretKey(): Bytes<32>;
   export ledger owner: Bytes<32>;
   circuit publicKey(sk: Bytes<32>): Bytes<32> {
     return persistentHash<Vector<2, Bytes<32>>>([pad(32, "myapp:pk:"), sk]);
   }
   constructor() { owner = disclose(publicKey(secretKey())); }
   export circuit withdraw(): [] { assert(owner == publicKey(secretKey()), "Not the owner"); }
   ```

   *Trade-off:* witness values aren't checked as random.

3. **Ledger methods.** `Map`: `lookup`, `member`, `insert`, `remove`. `Counter`: `read`, `increment`, `resetToDefault`, never `=`. Check `member` before `lookup`.
4. **Syntax from other languages.** One loop: `for (const i of 0..N)`, constant bound, no `break` or `return` inside (guard with `if`, or `fold`). `const` locals; `circuit`; `if`/`else if`; `assert(cond, "message")`; `Enum.Variant`; `S { a: … }`; `Bytes[1, 2]` or `pad(32, "text")`; no recursion.
5. **Operators Compact doesn't have.** For `/` and `%`, take quotient and remainder from a witness and check `b != 0`, `r < b` and `q * b + r == a` (only `q * b <= a` accepts a wrong quotient). For flags, `Vector<N, Boolean>`.
6. **Types and casts.** Cast arithmetic back: `(a + b) as Uint<64>`. Write `0 as Field`, and cast the Uint side with `as Field` where a Field is meant (`f == u as Field`), and `ecMulGenerator(x as JubjubScalar)`. Compare `Uint` values, not `Field`. Give generics their types: `persistentHash<Bytes<32>>(x)`, `none<T>()`. The widest Uint is `Uint<248>`.
7. **Disclosure.** Wrap the value in `disclose(…)` where it becomes public, the last step of the message's path: for a ledger read, the argument (`member(disclose(x))`); for a cross-contract call, the argument and a contract reference taken as a parameter. An `assert` comparing a witness-derived value with a ledger value needs none (the pattern above compiles). Don't over-disclose: return `disclose(balance >= amount)`.
8. **Version drift.** Every network needs 0.36.1 (language 0.28.0): `compact compile +0.36.1`, with `pragma language_version >= 0.28;` so an older compiler fails straight away. Code for 0.31.1 needs Remediation 6's casts and the new pragma. If an older compiler says a 0.36.1 name is unbound, update the compiler, not the code.

   *Trade-off:* 0.36.1 output deploys only to ledger 9 networks (all of them today).

9. **Imports and files.** `import CompactStandardLibrary;`, not `include "std"`. `include` adds `.compact` itself; paths are relative to the including file (`--trace-search`). A module file holds one module, named like the file. For a name clash, rename, or `import CompactStandardLibrary prefix S_;`.
10. **Contracts calling contracts.** A contract type can't list a `pure` circuit: drop it, or import the other contract's module. Under `contract implements T;`, each circuit `T` lists needs a proof: not `pure`, touching the ledger, calling no witness. There's no `ContractAddress` from a contract-typed value: store a contract's address in its own ledger field to pay it.
11. **Compiles, but still wrong.** The checker warns on these:
    - `ownPublicKey()` compared with a key isn't authorization: anyone can copy a public key.
    - `unshieldedBalance()` in a condition publishes the balance: use `unshieldedBalanceGt` and the like.
    - Branching on `checkRoot` does nothing on a bad root: `assert` it.
    - A Merkle path not tied to the caller only proves some member exists.
    - `receiveUnshielded` after minting to yourself counts the receipt twice.
    - A `contract implements` callee that's pure without the keyword, or calls a witness: calls fail with `is not among the module's provable circuits` (**measured** on Preview; servicedesk#298).

## Confirm fixed

- `compact compile +0.36.1 <src> <out>` exits 0.
- The checker shows no `error` lines; each `warning` is read.

## Stop and escalate

Open an issue at the [servicedesk front door](https://github.com/midnightntwrk/servicedesk/issues/new/choose) when:

- 0.36.1 prints `Internal error (please report)`: report it with the file to [LFDT-Minokawa/compact](https://github.com/LFDT-Minokawa/compact/issues).
- The checker can't explain a message, or its fix doesn't compile.
- A source in Key identifiers disagrees with its row and no step covers that.

Include the contract (or a minimal one), the full compiler output and the compiler version.

## Key identifiers

Each row names a public source and text it must contain: a repo file (`github:`), a published package file (`npm:`), or an issue's state (`issue:`). [check-runbook.mjs](https://github.com/midnightntwrk/servicedesk/blob/main/runbooks/authoring/check-runbook.mjs) tests every row daily against each source's newest version, or the npm version a row pins. For your installed version, look under `node_modules/<package>/<path>`. If a source disagrees with a row, the source is right.

| Fact this runbook relies on | Source of truth | Must contain |
|---|---|---|
| Every network needs compiler 0.36.1 | `github:midnightntwrk/midnight-docs/docs/relnotes/support-matrix.json` | `"component": "Compact toolchain"` `"version": "0.36.1"` |
| The rename hint's wording | `github:LFDT-Minokawa/compact/compiler/utils.ss` | `apparent use of an old standard-library / ledger operator name` |
| The disclosure error's wording | `github:LFDT-Minokawa/compact/compiler/analysis-passes/track-witness-data.ss` | `potential witness-value disclosure must be declared but is not` |
| Reserved words are reported as reserved | `github:LFDT-Minokawa/compact/compiler/parser.ss` | `(which is reserved for future use)` |
| Map has member and lookup | `github:LFDT-Minokawa/compact/compiler/midnight-ledger.ss` | `Returns if a key is contained within this Map.` `Looks up the value of a key within this Map.` |
| `kernel.caller()` reads none for a top-level call | `github:LFDT-Minokawa/compact/compiler/midnight-ledger.ss` | `Off-chain execution cannot yet know a top-level caller` |
| A contract type can't list a pure circuit | `github:LFDT-Minokawa/compact/compiler/lparser-to-lsrc.ss` | `a contract type cannot declare circuit ~a pure` |
| `contract implements` rejects a circuit declared pure | `github:LFDT-Minokawa/compact/compiler/analysis-passes/infer-types.ss` | `it is declared pure, and a circuit declared in a contract type must have a proof` |
| The signature checks are in the standard library | `github:LFDT-Minokawa/compact/compiler/standard-library.compact` | `export circuit secp256k1EcdsaVerify(` `export circuit ed25519Verify<#n>(` `export circuit jubjubSchnorrVerify<#N>(` |
| `contract implements` doesn't catch callees with no proof, still open | `issue:midnightntwrk/servicedesk#298` | `open` |
| The deserialize crash in 0.35.0 and 0.36.0 is closed | `issue:LFDT-Minokawa/compact#856` | `closed` |

## Reference material

- **Corpus and scripts:** [scripts/cases.json](https://github.com/midnightntwrk/servicedesk/blob/main/runbooks/compact-ai-generated-compile-errors-runbook/scripts/cases.json) (146 cases with the results of 0.31.1, 0.35.0 and 0.36.1), the checker [scripts/check-compact.mjs](https://github.com/midnightntwrk/servicedesk/blob/main/runbooks/compact-ai-generated-compile-errors-runbook/scripts/check-compact.mjs), and [scripts/test-check-compact.mjs](https://github.com/midnightntwrk/servicedesk/blob/main/runbooks/compact-ai-generated-compile-errors-runbook/scripts/test-check-compact.mjs), whose `--compile` reports messages a compiler release changed.
- **Measurements:** [scripts/check-compact.NOTES.md](https://github.com/midnightntwrk/servicedesk/blob/main/runbooks/compact-ai-generated-compile-errors-runbook/scripts/check-compact.NOTES.md).
- **Worked cases:** [servicedesk#180](https://github.com/midnightntwrk/servicedesk/issues/180), [#170](https://github.com/midnightntwrk/servicedesk/issues/170), [#86](https://github.com/midnightntwrk/servicedesk/issues/86), [#298](https://github.com/midnightntwrk/servicedesk/issues/298); [compact#19](https://github.com/midnightntwrk/compact/issues/19).
