# Runbook: Compact contract won't compile (AI-written or copied code)

A coding agent writes a Compact contract that looks right, and `compact compile` rejects it. The code
borrows from other languages (`while`, `msg.sender`, `Map.get`), from older Compact (`CurvePoint`,
`Void`, `ledger { }` blocks), or from newer Compact that the networks don't run yet (`keccak256`,
`kernel.caller()`). The compiler reports one error at a time, often as a bare
`unbound identifier X`, so a model fixing errors one by one can go round in circles. Run the
checker below: it flags the known mistakes in one pass and explains the compiler's message with a
fix that compiles. Then compile with 0.31.1, the compiler the networks need.

_Compiled 2026-10-08 from 139 reproduced cases (413 contracts), each compiled with 0.31.1 and 0.35.0
(and once with 0.34.0, for comparison). Where a fix's behaviour was in question, it was also run with
the Compact runtime (40 cases). The checker was then run on 1,100 contracts from 31 public repos.
Method and results are in [`scripts/check-compact.NOTES.md`](scripts/check-compact.NOTES.md).
Sources, pinned:_

- _Compact compiler `compactc-v0.31.1` (`0da5b0452eb0c1053d42418bf34b12cc29c7d63e`, language
  0.23.0) and `compactc-v0.35.0` (`debb05f9414b9d1e176741c2be289bb32233f0fc`, language 0.27.0):
  `compiler/standard-library.compact`, `midnight-natives.ss`, `midnight-ledger.ss`,
  `standard-library-aliases.ss`_
- _`@midnight-ntwrk/compact-runtime` 0.16.0 (the runtime 0.31.1 contracts target)_
- _midnight-expert `main` at `db9afac4d8472f3c9c698f4bf376f48373ae1714` (the catalogue of known
  mistakes that was reproduced)_
- _servicedesk, midnight-expert, Compact and midnight-docs issues cited below_

_Compilers move: re-check messages and names before asserting anything._

---

## Symptom

The compiler exits with code 255 and prints one error:

```text
Exception: contract.compact line 12 char 10:
  operation get undefined for ledger field type Map<Bytes<32>, Uint<64>>
```

The messages below come from 0.31.1 unless marked otherwise. Each was reproduced, along with a fix that
compiles.

| Message (start) | What it usually means | Fix |
|---|---|---|
| `unbound identifier X` | A name that doesn't exist: invented (`public_key`, `hash`, `verify`, `random`, `now`, `Address`, `msg`), from older Compact (`Cell`, `Void`, `QualifiedCoinInfo`), newer than 0.31.1 (`keccak256`, `JubjubSchnorrSignature`, `ecNeg`, `PublicAddress`, `JubjubScalar`), or a standard-library name without `import CompactStandardLibrary;` (`Counter`) | Remediation 2, 8 |
| `apparent use of an old standard-library / ledger operator name X: the new name is Y` | Older Compact: `CurvePoint`, `persistent_hash`, `own_public_key`, `receive`, `send`, `mintToken`, `nativePointX`, `m.is_empty()` | Remediation 1 |
| `operation X undefined for ledger field type T` | A method the ledger type doesn't have: `Map.get` / `.has` / `.set`, `Counter.value()`; `kernel.caller()` (exists only from 0.35.0); `operation =` means assigning to a `Counter` | Remediation 3 |
| `potential witness-value disclosure must be declared but is not: …` | A private value (witness result or circuit parameter) reaches the ledger, a return, a condition or a token call without `disclose()`. All of these errors print in the same run | Remediation 7 |
| `no compatible function named X is in scope` | A missing type argument (`persistentHash(x)`, `none()`, `left(x)`), or the wrong argument types, count or order (`persistentCommit` without its randomness, `tokenType` arguments swapped, a `Uint` passed where a `Field` is declared on 0.34.0 and later) | Remediation 6 |
| `language version X mismatch` | The pragma doesn't accept this compiler. `X` is the compiler's own language version: 0.23.0 for 0.31.1, 0.26.0 for 0.34.0, 0.27.0 for 0.35.0 | Remediation 8 |
| `structure X has no field named Y` | camelCase field names (`goesLeft`, `isSome`, `isLeft`, `mtIndex`): the fields are `goes_left`, `is_some`, … | Remediation 1 |
| `parse error: found keyword "X" (which is reserved for future use)` | `let`, `var`, `while`, `do`, `switch`, `try`, `throw`, `break`, `continue`, `function`, `class`, `this`, `null`, `void`, `public`, `private`, `delete`, and `event` on 0.34.0 and later. Most are syntax from another language, so the fix is the Compact form, not a new name | Remediation 4 |
| `parse error: found … looking for …` | Syntax from another language; the token it found points at the mistake (`found "<" looking for "["`: a `Bytes<32>{…}` literal; `found "i" looking for "("`: `for i in …`; `found ")" looking for ","`: `assert` without a message; `found "{" looking for ";", ","…` after `match x`: a match; `found "event" looking for a program element`: an `event` declaration) | Remediation 4 |
| `invalid context for reference to variable name X` / `… ledger field name X` / `… struct name X` | A loop range (or size) that isn't a constant: `for (const i of 0..count)`. For a struct, `S(a, b)` instead of `S { a: …, b: … }` | Remediation 4 |
| `unexpected character ' '`, `'^'`, `'~'`, `'%'`, or a parse error mentioning `expression4` | Bitwise, shift, `%` or `/` operators, which Compact doesn't have. For `a & b` the compiler blames the space after `&` | Remediation 5 |
| `expected … to have type Uint<64> but received Uint<0..…>`, `mismatch between actual type …`, `incompatible types …`, `Uint width 256 …`, `resulting value might exceed largest representable Uint value`, `cannot cast from type …` | Types: an arithmetic result not cast back (0.31.1 words it as "expected … but received"), a Field compared with `<`, a Uint wider than 248 bits or two `Uint<248>` added, a string where Bytes is needed | Remediation 6 |
| `recursion involving X`, `return is not supported within for loops`, `unreachable statement`, `expected left-hand side of = to have an ADT type` | Control flow from other languages: recursion, early return in a loop, reassigning a `const` | Remediation 4 |
| `failed to locate file "…"` | An `include`/`import` path that doesn't resolve, `include "std"`, or `include "x.compact"` with the extension | Remediation 9 |
| `error opening …/contract-info.json; try (re)compiling X.compact`, then `cross-contract calls are not yet supported` | Calling another contract: not on 0.31.1 (0.34.0 and 0.35.0 compile it). The first message comes until the other contract is compiled next to the output | Remediation 8 |
| `another binding found for X in the same scope` | A name the standard library already defines (`send`, `receive`), or a name declared twice | Rename it, or `import CompactStandardLibrary prefix S_;` |

**One error per run.** A parse error stops the compiler at the first one. Unknown names come next:
across the file's declarations the last one is reported first, but within one circuit it's the
first. Type errors then come in file order, and disclosure errors all arrive together. After a fix,
the next error is often earlier in the file or a different kind, so recompile after each one.

**Not this runbook:**

- It compiles, but the contract won't load or deploy (`Version mismatch: compiled code expects …`):
  see the [toolchain version mismatch runbook](../toolchain-version-mismatch-runbook/toolchain-version-mismatch-runbook.md).
- It compiles and deploys, but transactions are rejected (`1010: Invalid Transaction: Custom error: N`):
  see the [node rejection codes runbook](../node-1010-custom-error-runbook/node-1010-custom-error-runbook.md).

## Root cause

Models don't know Compact well (friction report Issue 3). They fill gaps from four places, and each
leaves a recognisable error:

1. **Other languages.** Solidity (`msg.sender`, `Address`, `Uint<256>`, `emit`), Rust (`Enum::Variant`,
   `match`, `let`), TypeScript (`while`, `break`, `x / y`, `a & b`, `str.toString()`), and generic
   helpers that don't exist (`hash()`, `verify()`, `random()`, `encrypt()`).
2. **Older Compact.** Names that were renamed (`CurvePoint` → `JubjubPoint`, `persistent_hash` →
   `persistentHash`, `receive`/`send` → `receiveShielded`/`sendShielded`) and syntax that was removed
   (`ledger { }` blocks, `Void`, `Cell<T>`). 0.31.1 recognises the old names and prints the new one.
3. **Newer Compact.** Agents read the latest docs and compiler, but the networks need 0.31.1 (language
   0.23.0). Code using 0.34.0 or 0.35.0 features fails on 0.31.1. The reverse breaks too: some 0.31.1
   code fails on 0.34.0 and 0.35.0, so upgrading the compiler isn't a fix.
4. **Wrong reference material.** midnight-expert's Compact references were the main guardrail in
   Claude Code, but they disagree with each other in places, and some of their error texts and fixes
   are wrong when tested (Upstream follow-ups). An agent following them can be told the wrong fix with
   confidence.

The compiler's one-error-per-run behaviour makes this worse. It never lists every mistake at once, and
a bare `unbound identifier X` doesn't say whether X is invented, renamed, newer, or just not imported.

## Key identifiers

- **Compilers:** `compact compile --version` (default compiler), `compact compile +0.31.1 …` (one build
  with a given compiler), `compact compile +0.31.1 --language-version` (0.23.0; 0.34.0 is 0.26.0 and
  0.35.0 is 0.27.0).
  Install side by side with `compact update 0.31.1 --no-set-default`.
- **Pragma:** `pragma language_version >= 0.22 && <= 0.23;` accepts only 0.31.1, so a build with a
  newer default compiler fails at compile time instead of at deploy. `>= 0.22` compiles on 0.31.1,
  0.34.0 and 0.35.0. An exact `pragma language_version 0.23;` also accepts only 0.31.1. Combine bounds
  with `&&`.
- **What exists on 0.31.1:** the standard library exports and native circuits, and each ledger type's
  methods, are in `check-compact.mjs` (taken from the compiler source at the tags above). For example,
  `Map`: `insert`, `insertCoin`, `insertDefault`, `isEmpty`, `lookup`, `member`, `remove`,
  `resetToDefault`, `size`.
- **Not in 0.31.1:** `keccak256`, `jubjubSchnorrVerify`, `JubjubSchnorrSignature`, `ecNeg`,
  `JubjubScalar`, `emit` (standard-library event types only) and cross-contract calls are already in
  0.34.0; `PublicAddress` and `kernel.caller()` are only in 0.35.0. So code that builds with a default
  compiler of 0.34.0 or 0.35.0 can still fail on 0.31.1.
- **Changed since 0.31.1** (0.31.1 code that breaks on 0.34.0 and 0.35.0):
  - A bare number literal is a `Uint`, not a `Field`: `const x: Field = 1` and `return 0` from a `Field`
    circuit fail; write `1 as Field`.
  - A `Uint` value no longer converts to a `Field` implicitly: passing a `Uint<64>` to a `Field`
    parameter fails; write `x as Field`.
  - `Field == Uint<64>` is rejected.
  - `ecMulGenerator` takes a `JubjubScalar`.
  - `event` is reserved.
  - The old type names get `unbound identifier CurvePoint` instead of the rename hint.
- **`compact fixup`:** rewrites old names (and reformats the file). It uses your default compiler and
  ignores `+version` (`compact fixup +0.31.1` still runs the default). 0.31.1's fixup rewrites old
  function, method and type names; 0.34.0's and 0.35.0's can't handle `CurvePoint`/`NativePoint`. It
  stops while a name or type error remains in the file (a disclosure error doesn't stop it).

## Diagnose (no API key)

1. **Run the checker.** It needs Node >= 20 and no install. The static scan only reads files;
   `--compile` also needs the `compact` CLI and writes only to a temporary directory.

   ```sh
   mkdir -p /tmp/check-compact
   curl -fsSL -o /tmp/check-compact/check-compact.mjs \
     https://raw.githubusercontent.com/midnightntwrk/servicedesk/main/runbooks/compact-ai-generated-compile-errors-runbook/scripts/check-compact.mjs
   node /tmp/check-compact/check-compact.mjs contracts/                # static scan of every .compact file
   node /tmp/check-compact/check-compact.mjs --compile contracts/main.compact
   node /tmp/check-compact/check-compact.mjs --explain 'operation get undefined for ledger field type Map<Field, Field>'
   ```

   - **Static scan:** flags every known mistake it can see, with the line and the fix. On the
     reproduction corpus it flags 143 of the 210 contracts the compiler rejects, and none of the 173
     corrected ones; its rules came from that corpus, so expect it to catch less on new code. The
     rest (mostly disclosure and type errors) need the compiler. On 509 public contracts that compile
     with 0.31.1 (midnight-expert, the Compact repo's examples, OpenZeppelin, midnight-examples and
     others) it reports no errors. A name it doesn't know, in a file that includes or imports other
     code, is only a warning, as is a problem inside a generic module that's never used.
   - **`--compile`:** compiles with 0.31.1 and explains the error. Disclosure errors are listed
     one by one: the private value, where it becomes public (the last step of the compiler's path,
     which is where `disclose()` goes), and the path. If 0.31.1 fails and 0.35.0 is installed, it
     tries 0.35.0 too, and says so when the code only works on the newer compiler. A file with no
     pragma and nothing exported (a fragment other files include) isn't compiled on its own, and a
     compile that runs past 300 s is stopped (`--timeout`).
   - **`--explain`:** turns a pasted compiler message into the fix. It has an answer for every
     message in the corpus and for 574 of the 591 failures from those public repos (the rest are
     compiler regression tests for edge cases).

   Exit code: 0 = nothing found (and it compiles, with --compile), 2 = at least one problem, 1 = it
   could not run. Example:

   ```text
   contracts/vault.compact:7:10  error  ledger-method  Map has no get().
       fix: Use `balances.lookup(…)`. Map methods: insert, insertCoin, insertDefault, isEmpty, lookup, member, remove, resetToDefault, size.
   contracts/vault.compact:11:3  error  while  There are no while loops.
       fix: Use a bounded loop: `for (const i of 0..N) { … }`.
   ```

2. **Fix what it flags, then compile with 0.31.1:** `compact compile +0.31.1 <src> <out>`. Fix the one
   error it prints (the table above, or `--explain`), and recompile until it's clean.
3. **If it compiles on 0.35.0 but not 0.31.1**, the code uses a newer feature: Remediation 8. If the
   default compiler isn't 0.31.1, see the toolchain runbook before anything else.

## Remediation

1 to 9 are compile fixes and were each reproduced on 0.31.1 and 0.35.0. Where a fix's behaviour was in
question, it was also run with the Compact runtime (the NOTES list which, and what was checked).

1. **Old names.** Use the name the compiler prints (`CurvePoint` → `JubjubPoint`, `persistent_hash` →
   `persistentHash`, `receive` → `receiveShielded`, `m.is_empty()` → `m.isEmpty()`, `.goesLeft` →
   `.goes_left`). To rewrite them all at once, use 0.31.1's fixup,
   `~/.compact/versions/0.31.1/<platform>/fixup-compact <file> <new-file>`, and compare the two (with
   one argument it prints to stdout; `compact fixup` uses your default compiler). Remove invented
   names first, because fixup stops while a name or type error remains. The camelCase field names
   (`goesLeft`, `isSome`) are planned but not available on either compiler.

   *Trade-off:* fixup also reformats the whole file, so the diff is larger than the renames.
2. **Invented functions and types.** There's no direct replacement for most of them; use the pattern
   that does the job:

   | Invented | On 0.31.1 |
   |---|---|
   | `public_key()`, `msg.sender`, `caller`, `kernel.caller()` | Keep a secret in private state, return it from a witness, and compare a hash of it with a key stored in the ledger (below) |
   | `hash(x)` | `persistentHash<T>(x)` (stable, for the ledger) or `transientHash<T>(x)` |
   | `encrypt` / `decrypt` | No encryption in circuits. To bind to a hidden value, store `persistentCommit<T>(value, rand)` with `rand` from a witness |
   | `random()`, `randomBytes()` | A witness that returns the value. The circuit can't check it's random |
   | `verify(…)`, `verify_signature(…)`, `sign(…)` | Nothing built in on 0.31.1 (`jubjubSchnorrVerify` is newer). Don't pass a verification result in through a witness: the prover can return true. To authorize a caller, use the identity pattern below |
   | `now()`, `blockTime()`, `blockHeight()`, `blockTimestamp` | `blockTimeLt`, `blockTimeGt`, `blockTimeLte`, `blockTimeGte(t)`, where `t` is a `Uint<64>` of seconds since the Unix epoch: `assert(blockTimeLt(deadline), "Deadline passed");`. No circuit can read the time as a value; to record it, see below |
   | `Address` | `ContractAddress`, `UserAddress`, `ZswapCoinPublicKey`, or `Either<ContractAddress, UserAddress>` |
   | `Cell<T>` (older Compact) | The type itself: `export ledger owner: Bytes<32>;` |
   | `Void` (older Compact) | `[]` |
   | `CoinInfo`, `QualifiedCoinInfo`, `SendResult` (older names), `EllipticCurvePoint` | `ShieldedCoinInfo`, `QualifiedShieldedCoinInfo`, `ShieldedSendResult`, `JubjubPoint` |
   | `String`, `toString`, `concat`, `push`, `filter`, `sort`, … | `Bytes<N>` (`pad(32, "text")` for a constant), fixed-size `Vector`s with `map` and `fold`, or a ledger `List` |

   The identity pattern, run with the right secret (accepted) and a wrong one (rejected):

   ```compact
   witness secretKey(): Bytes<32>;
   export ledger owner: Bytes<32>;
   circuit publicKey(sk: Bytes<32>): Bytes<32> {
     return persistentHash<Vector<2, Bytes<32>>>([pad(32, "myapp:pk:"), sk]);
   }
   constructor() {
     owner = disclose(publicKey(secretKey()));
   }
   export circuit withdraw(): [] {
     assert(owner == publicKey(secretKey()), "Not the owner");
   }
   ```

   To record when something happened, take the time as an argument and accept it only inside a
   window that ends at the block time. With the block time at T, this accepted T and T − 599 and
   rejected T + 1 and T − 600:

   ```compact
   export ledger fundedAt: Uint<64>;
   export circuit deposit(now: Uint<64>): [] {
     const t = disclose(now);
     assert(blockTimeGte(t), "Time is in the future");
     assert(blockTimeLt((t + 600) as Uint<64>), "Time is too old");
     fundedAt = t;
   }
   ```

   *Trade-off:* there's no built-in signature check or randomness on 0.31.1. A witness can supply a
   random value, but the circuit can't check that it's random, and a signature result from a witness
   proves nothing.
3. **Ledger methods that don't exist.** `Map`: `get` → `lookup`, `has` → `member`, `set` → `insert`,
   `delete` → `remove`. `Counter`: `value()` → `read()`. `count = 5` isn't allowed:
   `count.resetToDefault(); count.increment(5);` sets it to 5 (run: 5 after every call), while
   `count.increment(5)` alone adds 5 each time. `Map.lookup` on a missing key fails at runtime
   ("expected a cell, received null"), so check `member` first when the key may be missing.
4. **Syntax from other languages.**

   | Wrong | Right |
   |---|---|
   | `while (…)`, `do { } while (…)`, `for (let i = 0; …)`, `for i in 0..10`, `range(0, 10)` | `for (const i of 0..10) { … }` (or `of` a Vector) |
   | `break`, `continue`, `return` inside `for` | Guard the loop body with `if`; compute the result with `fold` and return after the loop |
   | `for (const i of 0..count)` with `count` a ledger field or parameter | A constant range with a guard: `for (const i of 0..8) { if (i < count) { … } }` (circuits are unrolled, so the bound must be known when compiling) |
   | Recursion | A bounded loop or `fold`. Keep the original's bounds: for example, factorial in `Uint<64>` needs `assert(n <= 20, …)`, or values above 20 come out wrong instead of failing |
   | `let x = …`, `var x`, reassigning a `const` | `const x = …;`, and a new name for each new value |
   | `function`, `pure function` | `circuit`, `pure circuit` |
   | `switch`, `match`, `try`/`catch`, `throw` | `if` / `else if` / `else` (`else if` is valid); `assert(cond, "message")` |
   | `void`, `null`, `this.x`, `public`/`private` | `[]`; `none<T>()` or `default<T>` (or `is_some` on a `Maybe`); the field name `x`; `export` for a circuit callable from outside, nothing for an internal one |
   | `Enum::Variant` | `Enum.Variant` |
   | `t.0` | `const [a, b] = t;` or `t[0]` |
   | `if x > 0 {` | `if (x > 0) {` |
   | `assert(cond)`, `assert cond "message";` (older form) | `assert(cond, "message")` |
   | `S(a, b)` to build a struct | `S { a: …, b: … }` |
   | `Bytes<32>{…}` | `Bytes[1, 2, 3]`, `default<Bytes<32>>` or `pad(32, "text")` |
   | `default<T>()` | `default<T>` |
   | `const` at the top level | Inside a circuit, or a `pure circuit` that returns the value |
   | `sealed export ledger`, `sealed ledger export` | `export sealed ledger` |
   | `emit Event(…)`, `event Event(…);` | Public ledger fields written by the circuit (0.31.1 has no events; remove the declaration too) |
   | `from` as a name | Any other name (`from` is a keyword) |

5. **Operators Compact doesn't have.** There are no bitwise, shift, `/` or `%` operators.
   - **Division and remainder:** get both from a witness and check them in the circuit. This version
     rejects every wrong quotient and remainder, and division by zero:

     ```compact
     witness divmod(a: Uint<64>, b: Uint<64>): [Uint<64>, Uint<64>];
     export circuit verified_divmod(a: Uint<64>, b: Uint<64>): [Uint<64>, Uint<64>] {
       assert(b != 0, "division by zero");
       const qr = divmod(a, b);
       const q = qr[0];
       const r = qr[1];
       assert(r < b, "remainder out of range");
       assert(q * b + r == a, "bad quotient");
       return [disclose(q), disclose(r)];
     }
     ```

     A check of only `q * b <= a` (as midnight-expert suggests) accepts a quotient that is too small,
     and any quotient when `b` is 0.
   - **Flags:** use `Vector<N, Boolean>` and `&&`, `||`, `!`, `!=`. There's no cast between a Uint
     and a `Vector<N, Boolean>`, so convert to and from bits in JavaScript.
   - **`<<`:** multiply: `(x * 8) as Uint<16>` for `x << 3` on a `Uint<8>`. That matches only while the
     result stays 16 bits wide; cast it back to `Uint<8>` and the circuit fails for every x ≥ 32
     instead of wrapping like an 8-bit shift.
   - **`>>`:** get the quotient from a witness as above.
6. **Types and casts.**
   - **Arithmetic results:** they widen (the compiler reports `Uint<64> + Uint<64>` as
     `Uint<0..36893488147419103231>`). Cast back:
     `(a + b) as Uint<64>`. The cast fails at runtime if the value doesn't fit.
   - **Subtraction:** keeps the type (`Uint<64> - Uint<64>` is `Uint<64>`), and the compiler adds an
     underflow check: `0 - 1` fails at runtime with `result of subtraction would be negative`. An
     explicit `assert(a <= b, "…")` only gives a clearer message.
   - **Width:** the widest Uint is `Uint<248>`. Adding two of them fails with `resulting value might
     exceed largest representable Uint value`: do the sum in `Field` and cast back.
   - **Field comparisons:** `Field` has no `<` or `>`; compare Uint values.
   - **Missing type arguments:** standard-library generics need them. Write `persistentHash<Bytes<32>>(x)`,
     `none<T>()`, `left<A, B>(x)`, `merkleTreePathRoot<N, T>(path)`, `persistentCommit<T>(value, rand)`.
     `--explain` gives the form from the compiler's message.
   - **Strings:** a string literal isn't `Bytes<32>`; use `pad(32, "text")`.
   - **Moving between 0.31.1 and newer compilers:** write literals as `0 as Field` where a Field is
     meant, and cast Uint values with `as Field`; 0.34.0 and 0.35.0 don't convert them.
7. **Disclosure.** The error names the private value and where it leaks ("the value of parameter reward
   of exported circuit create_quest … the second argument to receiveUnshielded"). Wrap the value in
   `disclose(…)` where it becomes public, the last step of the path in the message: the ledger write,
   the return, the condition, or the standard-library argument. For a ledger read (`member`,
   `lookup`) that's the argument, `nullifiers.member(disclose(nul))`; wrapping the result,
   `disclose(!nullifiers.member(nul))`, still fails. Only do this if revealing it is intended. A hash
   of a private value is still private (`disclose(persistentHash<…>(sk))`). `disclose()` leaves no
   trace in the generated JavaScript or ZKIR, and in the two cases where the code compiles both with
   and without it, the output was byte-identical. It only changes what the compiler accepts.
   - **What doesn't need `disclose()`:** an `assert` on a comparison between a witness and a ledger
     value compiles without it, and behaves the same with it.
   - **Don't over-disclose:** returning `disclose(balance)` publishes the exact balance. Return
     `disclose(balance >= amount)` if the yes/no is all that's needed.
8. **Version drift.** For the networks, code must compile with 0.31.1.
   - **Replace the features 0.31.1 doesn't have:**
     - **Hashes:** `keccak256` → `persistentHash` (a different hash: anything that needs Keccak
       compatibility can't be done on 0.31.1).
     - **Caller identity:** `kernel.caller()` → the identity pattern above.
     - **Negation:** `ecNeg(p)` → `constructJubjubPoint(0 - jubjubPointX(p), jubjubPointY(p))` (run:
       `p` plus its negation is the identity).
     - **Addresses:** `PublicAddress` → `Either<ContractAddress, UserAddress>`.
     - **Signatures:** `jubjubSchnorrVerify` → nothing built in; don't trust a result from a witness.
       For authorization, use the identity pattern.
     - **Events:** `emit` → a ledger write.
     - **Cross-contract calls:** not possible on 0.31.1.
   - **Fix the pragma:** `pragma language_version >= 0.22 && <= 0.23;` accepts only 0.31.1, so a
     build with a newer compiler fails straight away instead of at deploy. Use `>= 0.22` if the code
     should also build on newer compilers.

   *Trade-off:* staying on 0.31.1 means no newer features until the networks move. Upgrading the
   compiler instead breaks deployment (toolchain runbook) and some 0.31.1 code (Key identifiers).
9. **Imports and files.**
   - **Standard library:** `import CompactStandardLibrary;`, never `include "std"`.
   - **`include`:** it adds `.compact` itself.
   - **Paths:** they're relative to the including file, then each `--compact-path` / `COMPACT_PATH`
     directory. `compact compile --trace-search` shows every place it looked.
   - **Modules:** a module file holds exactly one module, named like the file.
10. **Stop the agent from repeating it.** Point it at this runbook and have it run the checker before
    every compile. Pin the compiler (`compact compile +0.31.1`) and the pragma (`>= 0.22 && <= 0.23`).
    Treat older midnight-expert error texts with care until its references are corrected.

**Compiles, but still wrong.** These came up while reproducing the catalogue. The compiler accepts
them, and each was checked with the Compact runtime:

- **`ownPublicKey()` as authorization:** `assert(ownPublicKey() == owner)` is not authentication. The
  caller supplies `ownPublicKey()`, and the owner's key is public ledger state, so anyone passes by
  copying it. Use the identity pattern above.
- **`unshieldedBalance()` in a condition:** it records the exact balance in the public transcript, and
  the transaction fails if the balance changes before it lands. Use `unshieldedBalanceGt` / `…Gte` /
  `…Lt` / `…Lte`, which record only the yes/no.
- **Branching on `checkRoot`:** `if (tree.checkRoot(root)) { … }` does nothing on a bad root, silently.
  For a guard, use `assert(tree.checkRoot(disclose(root)), "bad root")`.
- **A Merkle membership check that isn't tied to the caller:** checking that a witness-supplied
  `MerkleTreePath` leads to a known root proves that *some* member exists, not that the caller is
  one. Anyone can pass by supplying another member's path, which is public. Bind it:
  `assert(path.leaf == commitment, "Path is not for this voter")`, where `commitment` comes from the
  caller's secret ([midnight-expert#254](https://github.com/midnightntwrk/midnight-expert/issues/254)
  was the same bug in its own examples). The binding doesn't stop a member using it twice; that
  needs a nullifier.
- **Minting to yourself:** `mintUnshieldedToken` to the contract's own address already records the
  receipt. Adding `receiveUnshielded` (as midnight-expert advises) counts it twice. Whether the ledger
  rejects that transaction wasn't run on a network (Upstream follow-ups).

## Upstream follow-ups

- midnight-expert ([#276](https://github.com/midnightntwrk/midnight-expert/issues/276)): error texts that don't match the compiler, contradictions between its own
  files, and fixes that are wrong when run. Specifically:
  - It documents `implicit disclosure of witness value`, but the compiler prints
    `potential witness-value disclosure must be declared but is not`.
  - Its claimed messages for `Void`, `hash`, `function`, const reassignment and recursion don't match
    what the compiler prints.
  - It says `else if`, `map`, `slice` and `List.length()` don't exist, but they do.
  - Its division check and its `receiveUnshielded`-after-mint advice are wrong when run. Its factorial
    rewrite (which reassigns a `const`) and its sealed-field fix don't compile.
  - Its `get_public_key()` "fix" doesn't exist either.

  The full list, with cases, is in the NOTES.
- Compact compiler (to file):
  - `a & b` reports `unexpected character ' '`.
  - Shift operators report an internal grammar name, `expression4`.
  - A one-argument `assert` reports `found ")" looking for ","` without saying a message is required.
  - 0.34.0 and 0.35.0 no longer give the rename hint for `CurvePoint`/`NativePoint`.
  - Unknown names are reported last-first. That was acknowledged as a usability issue in
    `midnightntwrk/compact#19`, but never re-filed in the current repo.
- midnight-docs (to propose): a common-mistakes page agents can retrieve, as the friction report
  recommends for Issue 3, drawing on this runbook's tables.
- Devnet (to do): whether the ledger rejects the double-counted self-mint, and the token-settlement
  behaviour the in-memory runtime can't show (NOTES).

## Reference material

- **Reproductions:** [`scripts/check-compact.NOTES.md`](scripts/check-compact.NOTES.md): how the cases
  were built and tested, the runtime checks, and what wasn't reproduced.
- **Corpus:** [`scripts/cases.json`](scripts/cases.json) holds every case: the wrong and corrected
  contracts, the exact output of both compilers, and the runtime verdict.
  [`scripts/test-check-compact.mjs`](scripts/test-check-compact.mjs) re-scores the checker against it,
  and with `--compile` reports any compiler message that changed.
- **Worked cases:**
  - [compact#19](https://github.com/midnightntwrk/compact/issues/19) (`unbound identifier Address`
    from Claude on Windsurf; Kapa called it a compiler bug)
  - [midnight-expert#229](https://github.com/midnightntwrk/midnight-expert/issues/229) (`goesLeft`)
  - [servicedesk#180](https://github.com/midnightntwrk/servicedesk/issues/180) (disclosure on an
    exported-circuit parameter)
  - [servicedesk#202](https://github.com/midnightntwrk/servicedesk/issues/202) (a called contract
    can't read its caller: no `kernel.caller` before 0.35.0)
  - [servicedesk#170](https://github.com/midnightntwrk/servicedesk/issues/170) (`persistentHash`
    without its type argument)
  - [servicedesk#86](https://github.com/midnightntwrk/servicedesk/issues/86) (`blockHeight()` / `now()`)
  - [midnight-expert#256](https://github.com/midnightntwrk/midnight-expert/issues/256) (include path)
  - [compact#296](https://github.com/LFDT-Minokawa/compact/issues/296) (`Uint<256>`)
  - [compact#833](https://github.com/LFDT-Minokawa/compact/issues/833) (docs gaps: the `Either`
    example, bitwise operators, the pragma form)
- **Context:** the internal AI Dev Friction Report (Notion), Issue 3, "Models don't know Compact".
- **Source:** the compiler's `standard-library.compact`, `midnight-natives.ss`, `midnight-ledger.ss`
  and `standard-library-aliases.ss` at the two tags above.
