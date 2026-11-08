# check-night-usage: how the failures were reproduced and the checker tested

Everything here was run on 2026-10-19.

- **Machine:** an Intel Core i5-1038NG7 (x86_64), macOS 14, Docker Desktop 28.0.4, Node 22.20.0 (a
  standalone build for the experiment) and Node 18.20.5, 20.19.1 and 24.20.0 for the checker.
- **Units:** NIGHT amounts are in STAR (1 NIGHT = 1,000,000 STAR) and DUST in SPECK (1 DUST = 10^15
  SPECK), as the SDK reports them.
- **Local network:** the `compose.yml` from midnight-examples `examples/token-transfers` (main at
  `7c8c0a0`, 2026-10-16): `midnightntwrk/midnight-node:1.0.0`, `indexer-standalone:4.3.3` and
  `proof-server:8.1.0`. The whole run was done twice, once with that node and once with the node
  image swapped for `midnight-node:1.0.400`, the version Preview, Preprod and Mainnet run.
- **Packages** (the example's lockfile): `@midnight-ntwrk/midnight-js-contracts` 4.1.1,
  `wallet-sdk` 1.2.0 (`wallet-sdk-facade` 4.1.0, `wallet-sdk-unshielded-wallet` 3.1.0,
  `wallet-sdk-capabilities` 3.3.1), `ledger-v8` 8.1.2, `compact-runtime` 0.16.0.
- **Compiler:** `compact compile +0.31.1`, the version the networks support.

## The question

On Mainnet, NIGHT is held on Cardano as cNIGHT. Registering cNIGHT generates DUST on Midnight, so a
Mainnet wallet can pay fees, but it has no NIGHT on Midnight. A contract circuit that moves NIGHT
(`receiveUnshielded`, `sendUnshielded` or a balance check with `nativeToken()`) was expected to fail
there. What does each kind of circuit actually do, what does the developer see, and is anything
charged?

Mainnet can't be used to test this: there is no NIGHT on Midnight to try the working case with, and new
deploys weren't landing on Mainnet at the time ([midnightntwrk/servicedesk#257](https://github.com/midnightntwrk/servicedesk/issues/257); fixed on
2026-10-20).
A local network can be set up the same way: a wallet with DUST and no NIGHT, and a contract that holds
no NIGHT.

## Is there NIGHT on Midnight Mainnet?

The docs say "Today most NIGHT is held on Cardano as cNIGHT" ([Networks and environments, Funding and
transaction cost](https://docs.midnight.network/guides/networks-and-environments#funding-and-transaction-cost),
midnight-docs at `f19a76d`, 2026-10-18).

Other docs pages don't agree on where NIGHT is. The unshielded tokens page (`docs/tokens/unshielded-token.mdx`)
says that "on mainnet it reaches Midnight from Cardano over the one-way cNIGHT-to-mNIGHT bridge", and
the tokens overview (`docs/tokens/overview.mdx`) says a delay "goes away once native mNIGHT launches".

To check the chain itself, Mainnet blocks were read with batched `chain_getBlock` calls from
`https://rpc.mainnet.midnight.network`. That is the Midnight-hosted RPC the docs list as retired on
2026-09-30 ("it can stop at any time"). It still answered on 2026-10-19, with `system_version`
`1.0.400-c338b9ac`. To repeat the scan, use Blockfrost's Mainnet RPC. Each Midnight transaction was
decoded with `Transaction.deserialize('signature', 'proof', 'binding', …)` from
`@midnight-ntwrk/ledger-v8` 8.1.3, and the inputs and outputs of its unshielded offers were counted by
token type. NIGHT is the token type of 32 zero bytes.

What this does and doesn't cover:

- **Only user transactions were decoded.** Inherents and system transactions, such as
  `DistributeNight` (block rewards, the Cardano bridge), weren't counted. Ledger 8.1.x has those
  paths (`semantics.rs`).
- **No ledger state was read.** That includes contract balances.
- **It's a sample.** 1,644 of about 421,500 blocks, about 0.4%.

So it shows that no NIGHT moved in the sampled user transactions. It doesn't show that none exists on
Midnight.

| Sample | Blocks | Midnight txs | NIGHT inputs / outputs | Other unshielded inputs / outputs | DUST spends | DUST registrations |
|---|---|---|---|---|---|---|
| 2026-09-20 to 10-12, every 400th block | 2,657,212 to 2,973,829 (792 blocks) | 514 (5 deploys, 509 calls) | 0 / 0 | 0 / 0 | 514 | 0 |
| 2026-10-16 08:00 to 10-19 07:00 UTC, every 50th block | 3,036,167 to 3,078,743 (852 blocks) | 2,312 (2,302 calls, 10 with no contract action) | 0 / 0 | 79 / 104 (in 56 txs) | 2,312 | 0 |

- None of the 2,826 transactions spent or created NIGHT on Midnight, and none was a block reward claim.
- Every transaction paid its fee with DUST.
- The ten with no contract action were a single DUST spend each.
- The other unshielded inputs and outputs are tokens that contracts minted themselves: those do move
  on Mainnet.

## The experiment

`no-night.test.ts`, a vitest file added to a scratch copy of `examples/token-transfers`, using the
example's own wallet and provider helpers:

1. Alice is the local network's genesis wallet, with NIGHT and DUST.
2. Dave (the `LOCAL_SEEDS.DAVE` seed) gets DUST but no NIGHT. A third wallet receives 100,000 NIGHT
   from Alice and registers it for DUST generation with Dave's DUST address as the receiver, the way
   the repo's `yarn fund:wallet` does. Dave started each run with 0 NIGHT and a DUST balance.
3. Alice deploys `token-transfers` (compiled with 0.31.1). The contract holds no NIGHT.
4. Five calls are made through `submitCallTx`. For each one the test records the result or error, the
   time it took (this includes an 8-second wait for the wallet to see the result), and both wallets'
   NIGHT and DUST balances before and after.

The two NIGHT circuits in `token-transfers.compact`:

```compact
export circuit receiveNightTokens(amount: Uint<128>): [] {
   receiveUnshielded(default<Bytes<32>>, disclose(amount));
}

export circuit sendNightTokensToUser(amount: Uint<64>, user_addr: UserAddress): [] {
    sendUnshielded(
        default<Bytes<32>>, disclose(amount), right<ContractAddress, UserAddress>(disclose(user_addr))
    );
}
```

### Results

The outcomes were the same on node 1.0.0 and node 1.0.400.

| Call | Who | Outcome | Time (1.0.0 / 1.0.400) |
|---|---|---|---|
| `receiveNightTokens(5000)` | Dave (DUST, no NIGHT) | `Unexpected error submitting scoped transaction '<unnamed>': (FiberFailure) Wallet.InsufficientFunds: Insufficient funds` | 20.6 s / 18.9 s |
| `sendNightTokensToUser(2000, Dave)`, contract holds no NIGHT | Dave | `Unexpected error submitting scoped transaction '<unnamed>': (FiberFailure) SubmissionError: Transaction submission error`; the console shows `RPC-CORE: submitAndWatchExtrinsic(extrinsic: Extrinsic): ExtrinsicStatus:: 1010: Invalid Transaction: Custom error: 194` | 53.3 s / 40.0 s |
| `sendNightTokensToUser(2000, Alice)`, contract holds no NIGHT | Alice (has NIGHT) | the same `SubmissionError` and `Custom error: 194` | 41.7 s / 32.5 s |
| `receiveNightTokens(5000)` (control) | Alice | `SucceedEntirely`; Alice's NIGHT went down by 5,000 STAR | 66.8 s / 64.6 s |
| `sendNightTokensToUser(2000, Dave)` (control), contract now holds 5,000 STAR | Dave | `SucceedEntirely`; Dave's NIGHT went from 0 to 2,000 STAR | 59.8 s / 52.8 s |

What this shows:

- **Receiving NIGHT** fails in Dave's wallet, whatever his DUST balance. midnight-js proves the call
  first and then asks the wallet to balance it (`submitTxCore` in midnight-js-contracts 4.1.1: `proveTx`,
  then `balanceTx`, then `submitTx`). The unshielded wallet can't find 5,000 STAR of NIGHT to pay in and throws
  `InsufficientFundsError` (`wallet-sdk-unshielded-wallet` 3.1.0, `dist/v1/Transacting.js`). Nothing
  reaches the node.
- **Sending NIGHT** from a contract that holds none is proven and balanced, and then rejected by the
  node with 194. In the node 1.0.x table that is `Invalid.BalanceCheckOutOfBounds`
  ([decode-1010.mjs](../../node-1010-custom-error-runbook/scripts/decode-1010.mjs)): the transaction
  takes more NIGHT out of the contract than it has. It doesn't matter who calls it: Alice, who has
  NIGHT, gets the same rejection, because the contract has none.
- **Both work** once the NIGHT is there, so the circuits and the setup are fine. What makes them fail
  is the missing NIGHT.
- **Nothing is charged.** The receive never left the wallet, and the node rejected the send before
  it was included in a block, and only included transactions pay fees. The balances agree:
  - Dave's DUST rose by round amounts across both of his failures, which is generation from the
    registration with nothing taken off: +34,721,400,000,000,000 and +87,630,200,000,000,000 SPECK on
    node 1.0.0, and +15,707,300,000,000,000 and +33,068,000,000,000,000 on 1.0.400.
  - Over his successful control call, the change wasn't round (+99,203,979,263,883,006 SPECK): generation
    less the fee.
  - Dave's NIGHT stayed at 0.
  - Alice's DUST can't show a fee either way: it also decays from the NIGHT she sent the sponsor. Over
    her failed send on node 1.0.400 it fell by 27,281,100,000,000,000 SPECK, about that decay. On node
    1.0.0 it fell by 103,200,267,415,014,929,636 SPECK (about 103,200 DUST), 7.5 times the drop over her
    successful call. That wasn't explained. The transaction wasn't in any block, so it wasn't a fee.
- **The errors are loud but misleading.** Neither message mentions NIGHT, and neither first line has the
  reason. midnight-js builds `err.message` from `String(err)` of the wallet's error, and Effect prints
  the whole cause chain there, so for the send `err.message` does contain
  `RpcError: 1010: Invalid Transaction: Custom error: 194`, a few lines down, as does the `RPC-CORE`
  console line. A developer who sees `Insufficient funds` while the wallet shows plenty of DUST will
  look at fees first.

### What the wallet's error carries

A second test (`no-night-error.test.ts`) repeated Dave's `receiveNightTokens(5000)` against the
same contract on node 1.0.400 and walked the thrown error:

- `err.message`: `Unexpected error submitting scoped transaction '<unnamed>': (FiberFailure) Wallet.InsufficientFunds: Insufficient funds`.
- `err.cause`: an Effect `FiberFailure`. Its cause is an `InsufficientFundsError` with `_tag`
  `Wallet.InsufficientFunds`, `tokenType` `0000…0000` (64 zeros) and `amount` `-5000n`.
- `JSON.stringify(err.cause)` prints all of it, but only with a bigint replacer. `amount` is a bigint,
  and plain `JSON.stringify` throws `TypeError: Do not know how to serialize a BigInt`. That was
  checked with the wallet SDK's `InsufficientFundsError` and Effect 3.22.1. In the test above it
  worked only because `@midnight-ntwrk/testkit-js` sets `BigInt.prototype.toJSON` globally. With
  `JSON.stringify(err.cause, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))`:

```json
{"_id":"FiberFailure","cause":{"_id":"Cause","_tag":"Fail","failure":{"message":"Insufficient funds","tokenType":"0000000000000000000000000000000000000000000000000000000000000000","amount":"-5000","_tag":"Wallet.InsufficientFunds"}}}
```

So a DApp that prints the cause that way can tell a missing NIGHT payment (64 zeros, from the unshielded
wallet) from a missing custom token (any other token type). `String(err)` and `err.message` don't show
the token type. `amount` is what the transaction needs from the wallet
(`imbalances.get(tokenType)`), not the difference from what the wallet holds. The two are equal here
only because Dave held none.

The same `_tag` comes from the other two wallets, so the message alone is ambiguous. The source of
each, in the 1.2.0 wallet SDK:

| Wallet | Message | `tokenType` |
|---|---|---|
| unshielded (`wallet-sdk-unshielded-wallet` 3.1.0, `dist/v1/Transacting.js`) | `Insufficient funds` | the unshielded token type; NIGHT is 64 zeros |
| shielded (`wallet-sdk-shielded`, `dist/v1/Transacting.js`) | `Insufficient funds`, or `Insufficient funds for fallible segment N` | the shielded token type |
| DUST (`wallet-sdk-dust-wallet`, `dist/v1/Transacting.js`) | `Insufficient Funds: could not balance dust` (from `wallet-sdk-capabilities`' balancer); no `amount` | `dust` |

The ledger SDK's `shieldedToken().raw` is also 64 zeros, so the token type alone doesn't say which
wallet failed. A stack in the message (`wallet-sdk-shielded/` or `wallet-sdk-unshielded-wallet/`) does.

### Not run

- **A balance check alone.** `unshieldedBalance(nativeToken())` on a contract that holds no NIGHT
  wasn't called. It reads the contract's NIGHT balance, which can only be 0, so the runbook treats it
  as reading 0.
- **private-party and silent-auction.** Neither was deployed and called. Their NIGHT steps use the same
  two standard-library calls, so their errors are expected to match.
- **Other wallets.** Browser wallets, through the DApp connector, weren't tried. Their wording may
  differ.
- **A zero amount** (for example `receiveUnshielded(nativeToken(), 0)`) wasn't tried.

## The examples that use NIGHT

`check-night-usage.mjs` on every `.compact` file under midnight-examples `examples/` (15 files, main
at `7c8c0a0`) flags three contracts. These are also the only three a plain `grep` for
`receiveUnshielded`, `sendUnshielded` or `unshieldedBalance` finds.

| Contract | Circuits that move NIGHT | What fails on Mainnet |
|---|---|---|
| `token-transfers` | `receiveNightTokens` (receive), `sendNightTokensToUser` (send) | both, as in the experiment. The other seven use the contract's own unshielded token or shielded coins. |
| `private-party` | `checkIn` (receive the entry fee), `claimFees` (balance check, then send) | `checkIn` always fails, so no guest can check in. `claimFees` then stops at its earlier `assert(checkedInParty.size() > 0, "No fees to claim")`, or before that at `The doors are not yet closed` if the organizer hasn't called `closeEntry`. |
| `silent-auction` | `receiveTokens` (receive the organizer's deposit), `revealWin` (send, only when the highest bid is under the reserve price), `claimWin` (receive the winning bid, then send) | `receiveTokens` is what moves the auction from `RECEIVE` to `OPEN`, so on Mainnet the auction never opens. |

The docs teach the same pattern: the private-party tutorial
([docs/tutorials/private-party/smart-contract.mdx](https://github.com/midnightntwrk/midnight-docs/blob/main/docs/tutorials/private-party/smart-contract.mdx))
and the private guest list example ([docs/examples/contracts/private-guest-list.mdx](https://github.com/midnightntwrk/midnight-docs/blob/main/docs/examples/contracts/private-guest-list.mdx))
both take the entry fee with `receiveUnshielded(nativeToken(), …)`. The token-transfers example page
(`docs/examples/contracts/token-transfers.mdx`) shows the two NIGHT circuits with `default<Bytes<32>>`.

The docs' "Preparing a DApp for mainnet" procedure says to validate on Preprod first, because "anything
that fails there will fail in production". It doesn't warn about the reverse case: a NIGHT circuit that
works on Preprod fails on Mainnet.

## The checker's tests

`test-check-night-usage.mjs`, 77 cases, offline, passing on Node 18.20.5, 20.19.1 and 24.20.0. The
fixtures are:

- the NIGHT parts of `token-transfers.compact` and `private-party.compact`;
- a file of simple shapes: NIGHT calls in comments and a string (ignored), `const night = nativeToken()`,
  a parameter with and without `disclose`, NIGHT through a helper circuit, `unshieldedBalance`, and a
  custom `tokenType(…)`;
- a vault contract with the shapes from the operator review (see Reviews): a helper that returns
  `nativeToken()`, one that returns `tokenType(…)`, `nativeToken()` and a parameter passed into a
  helper's parameter, a send inside a helper, a ledger field set by the constructor, a witness,
  `const NIGHT = default<Bytes<32>>`, `pad(32, "")`, a balance check on a helper's NIGHT, and
  `const c = disclose(color)`;
- modules: `import "Pay"` from a separate file, the same with `prefix P_`, a module in the same file,
  a module file scanned alone, and an import that isn't there;
- from the fact-check (see Reviews): a module circuit with the same name as a top-level one, imported
  with a prefix (source, and compiled, where `circuits.pay` calls `_pay_1` while the module's is
  `_pay_0`), an `export { pay };` list, `include "file"`, NIGHT in a struct field, a `pure` helper,
  and a typed `const`;
- two trimmed 0.31.1 `contract/index.js` files: one with `this._nativeToken_0()` and
  `new Uint8Array(32)`, directly and through a helper, and the vault as the compiler emits it (ledger
  read, witness method, `const NIGHT_0`, a 32-zero array, the standard library's balance helpers);
- the error texts from the runs above, the cause as JSON with NIGHT's token type and with another
  token's, a stack from the shielded wallet, the DUST wallet's message, 194, another code, unrelated
  text, `--network preprod`, and the text on stdin.

They also cover exit codes 0, 1, 2 and 3 in text and JSON output, a directory scan (which reads only
`.compact` files), a project whose `contract/index.js` is a wrapper that re-exports the compiled
contract (scanned as source, not taken for compiled output with no circuits), and bad arguments.

**Mutation pass.** 43 deliberate bugs were made in the final checker, one at a time, and the test was run
on each. 42 make it fail. The one that survives has the compiled scan read the standard library's own
method bodies, which it skips. In 0.31.1 output those bodies make no unshielded calls into the
contract (checked in `token-transfers`' `_mintUnshieldedToken_0`), so the result doesn't change.
Earlier passes, on the first versions of the checker, found the gaps that the wrapper, comment and
exit-code tests now cover.

The checker was also run on the real compiled output (`compact compile +0.31.1`) of `token-transfers`
and `private-party`, where it finds the same circuits as in their sources. Run again on all 15
midnight-examples contracts after the rework below, it flags the same three, and nothing in the other
twelve, not even as possible.

## Reviews

**Operator walk-through.** A fresh agent worked six tickets from the README lookup and this runbook,
and wrote contracts to break the checker, compiled with `compact compile +0.31.1 --skip-zk`. It found:

- **False all-clears in the checker.** A source scan said "no NIGHT use found" (exit 0) for:
  - a helper circuit that returns `nativeToken()`;
  - a token type set by the constructor and stored in a ledger field;
  - a witness;
  - `disclose(color)` with `color` a parameter (bare `color` doesn't compile on 0.31.1);
  - `pad(32, "")`;
  - a circuit from an imported module.

  A compiled scan missed `const NIGHT_0 = new Uint8Array(32)`. `take(nativeToken(), …)` into a
  helper's parameter was reported as only possible.

  The checker was reworked: every unshielded call's token type is now sorted into NIGHT, another token,
  a parameter (decided by each caller's argument) or unknown, and anything not provably another token
  is reported, as certain or possible. Imports next to the file are followed, and exit 3 means
  "possible only".
- **The page was wrong about 194.** It said the code isn't in `err.message`. In the runs above, midnight-js
  prints the whole cause chain into `err.message`, and the code is there, below the first line; the
  node rejection codes runbook says the same. Fixed on the page and in the checker.
- **`--error` overclaimed.** A bare `Insufficient funds`, a bare `Transaction submission error` or a
  194 alone returned "Matches" with exit 2. They now return "could be" with exit 3 and the detail that
  decides. "Not this runbook" now points where to go instead. `--network` was added, so Preprod
  cases aren't sent here.
- **Commands.** `--error '<text>'` breaks in zsh on the error's own `'<unnamed>'`, so the page now
  pipes the text on stdin (`--error -`). The hand-run `grep … *.compact` missed subdirectories and
  multi-line calls; it's now `grep -rnE -A2 --include='*.compact'`.
- **Gaps on the page.** These were added:
  - the faucet URLs and the unshielded address;
  - a network check for the DApp;
  - the servicedesk#257 caveat ahead of "deploy without them";
  - how to get a wallet with DUST and no NIGHT. The experiment's test now ships as
    [`no-night.test.ts`](no-night.test.ts), with a guard added after these runs that stops it on any
    network but the local one;
  - definitions for DUST, tNIGHT, `color` and `(FiberFailure)`;
  - a README lookup row for the DUST message;
  - a 194 row and decoder hint in the node rejection codes runbook.
- **Wording.** "Yet", "until", "once" and "today" read as a promise that NIGHT will arrive. They were
  replaced with what was observed and when.

**Fact-check.** An independent agent checked every claim against the source, the result files, the docs
clone and the lockfile, and wrote contracts compiled with 0.31.1 to break the checker. It confirmed:

- the standard library and ledger line references;
- the prove, balance and submit order, and the three wallets' messages;
- all five outcomes and ten timings in both result files;
- the Mainnet sample counts;
- the docs quotes, slugs and anchors;
- the examples' circuits;
- every link and ref.

It found, and these are fixed:

- **`JSON.stringify(err.cause)` throws in a normal DApp**, because `amount` is a bigint. It only worked in
  the test because testkit-js patches `BigInt.prototype.toJSON`. The page now gives the replacer.
- **194 is in `err.message`**, the same as the operator found.
- **"No NIGHT on Midnight Mainnet" said more than the evidence.** The docs say "most" NIGHT is on Cardano,
  describe a cNIGHT-to-mNIGHT bridge, and speak of "once native mNIGHT launches"; the sample decoded only
  user transactions. The page now says what was observed, and lists the docs' disagreement as a
  follow-up.
- **Amounts are STAR, not NIGHT.** 5,000 is 0.005 NIGHT. And `amount` is what the transaction needs, not
  the shortfall.
- **"Nothing is charged" needed its evidence:** Dave's round DUST increases, and Alice's unexplained
  1.0.0 figure. Both are above.
- **Three checker holes in the reworked version:**
  - compiled entry points were matched by name, not by the method each `circuits` entry calls, so a
    top-level `pay` was blamed for its module namesake's NIGHT receive;
  - inline modules lost their import prefix and could be overwritten by a top-level circuit of the same
    name, giving exit 0 with an unresolved import;
  - `export { pay };` lists were ignored.

  The source scan now keeps each module's circuits apart and maps prefixed imports onto them. An
  unresolved import gives exit 3, never 0.
- **Smaller fixes:**
  - the retired RPC and the sample's limits are now stated;
  - `ledger-8.1.3` is cited, the version node 1.0.400 pins; the lines are the same in 8.1.0 and 8.1.2;
  - the shielded wallet's 64 zeros;
  - the DUST error's missing `amount`;
  - private-party's `The doors are not yet closed`;
  - a deploy caveat on the minted-token option;
  - the token-transfers docs page added to the follow-ups.


## Updates

- **2026-10-21: Mainnet deploys land again.** [midnightntwrk/servicedesk#257](https://github.com/midnightntwrk/servicedesk/issues/257) was fixed on
  2026-10-20: a leftover deploy filter was removed from the affected nodes, and a test deploy was
  included in block 3,097,000. The deploy caveat came off the page (option 3, option 4 and the
  "Other errors" list) and off the checker's `Fix:` line. The NIGHT findings are unchanged.

## Ledger 9 upgrade re-check (2026-11-07)

- midnight-docs `docs/relnotes/ledger-9.mdx`: "The upgrade doesn't turn on the cNIGHT to mNIGHT
  protocol token bridge on Mainnet. Turning it on is a separate governance action". Mainnet runs node
  2.1.101 (`system_version` `2.1.101-913ec011`).
- `decode-1010.mjs 194 --node 2.x`: `Invalid.BalanceCheckOutOfBounds`, the same as on 1.0.x.
- The checker on midnight-examples PR #88's 0.36.0 `token-transfers.compact` (`pragma
  language_version 0.28`): 9 exported circuits, `receiveNightTokens` (receive, line 37) and
  `sendNightTokensToUser` (send, line 41), as on the 0.31.1 source.
- Not run again on ledger 9: the receive and send failures themselves, so the midnight-js 5.0.0 and
  wallet SDK 2.0.0 messages aren't checked. `test-check-night-usage.mjs`: 77 of 77.

## midnight-js 5.0.0 error shapes (review on #291, 2026-11-07)

midnight-js 5.0.0's `atProviderMethod` (`packages/contracts/src/internal/submit-payload.ts`, bundled
into `midnight-js-contracts` 5.0.0's `dist/index.js`, not exported) was run from a scratch copy of the
bundle on two errors shaped like the wallet SDK's: an `InsufficientFundsError` with message
`Wallet.InsufficientFunds: Insufficient funds` and a NIGHT `tokenType`, and the
`SubmissionError` → `SubmissionError` → `RpcError: 1010: Invalid Transaction: Custom error: 194` chain.

- `err.name` `ProviderFailedError`; `err.message` `balanceTx rejected the transaction (circuit
  'receiveNightTokens'). The provider's own failure is on \`cause\`, …` (and `submitTx … 'sendNightTokensToUser'`).
- `err.cause.message` `InsufficientFundsError: Wallet.InsufficientFunds: Insufficient funds`; for
  the send, three causes: `SubmissionError: Transaction submission error`, `SubmissionError:
  Transaction submission failed`, `RpcError: 1010: Invalid Transaction: Custom error: 194`.
- No own properties on any cause, so `JSON.stringify(err.cause)` is `{}` and `tokenType` is gone.

The checker now matches `(balanceTx|submitTx|proveTx) rejected the transaction (circuit '…')` and
decides by the circuit name. `test-check-night-usage.mjs`: 85 of 85 (8 new cases).
