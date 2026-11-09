# Runbook: Contract circuits that move NIGHT fail on Mainnet (`Wallet.InsufficientFunds`, `Custom error: 194`)

A contract that works on Preview, Preprod or a local network fails on Mainnet in the circuits that move
NIGHT, the native token:

- **Taking NIGHT from the caller** (`receiveUnshielded(nativeToken(), …)`) fails in the wallet with
  `Wallet.InsufficientFunds: Insufficient funds`, although the wallet has DUST for the fee.
- **Paying NIGHT out of the contract** (`sendUnshielded(nativeToken(), …)`) is rejected by the node
  with `1010: Invalid Transaction: Custom error: 194`, which midnight-js shows as
  `Transaction submission error`.

The contract isn't wrong. DUST is what pays transaction fees, and NIGHT generates it. On Mainnet,
NIGHT is held on Cardano as cNIGHT, and registering cNIGHT generates DUST on Midnight. A wallet funded
that way has DUST but no NIGHT on Midnight to pay into a contract, and a contract no one has paid NIGHT
holds none. As of 2026-10-19 the docs say native mNIGHT hasn't launched, and no NIGHT moved in the
Mainnet transactions sampled for this page. The ledger 9 upgrade on 6 November 2026 didn't change
this: the docs say it doesn't turn on the cNIGHT-to-mNIGHT bridge on Mainnet, which is a separate
governance action. The checker below lists the circuits in a contract that
move NIGHT, and tells whether an error a user pasted is this one.

_Compiled 2026-10-19. Both failures were reproduced that day on a local network, on node 1.0.0 and on
node 1.0.400 (the version Preview, Preprod and Mainnet ran then), with a wallet that had DUST and no NIGHT.
Re-checked 2026-11-07 after the ledger 9 upgrade (Mainnet on node 2.1.101): the
[ledger 9 upgrade notes](https://docs.midnight.network/relnotes/ledger-9) say the bridge stays off, 194
is still `Invalid.BalanceCheckOutOfBounds` in the node 2.x code table, and the checker finds both NIGHT
circuits in midnight-examples' 0.36.0 `token-transfers`. The failures weren't run again on ledger 9,
so the midnight-js 5 and wallet SDK 2 messages weren't checked.
Control calls on the same contract succeeded once NIGHT was there. Two windows of Mainnet blocks between
2026-09-20 and 2026-10-19 were sampled for NIGHT. The checker was run on midnight-examples' contracts, source and
compiled, and on contracts written to break it. The page was reviewed by an independent fact-check and by
a fresh agent working through it as an operator. Method and results are in
[`scripts/check-night-usage.NOTES.md`](scripts/check-night-usage.NOTES.md). Sources, pinned:_

- _[LFDT-Minokawa/compact](https://github.com/LFDT-Minokawa/compact) tag `compactc-v0.31.1`,
  `compiler/standard-library.compact` lines 116 (`nativeToken`) and 314 to 350 (`sendUnshielded`,
  `receiveUnshielded`, `unshieldedBalance` and its comparisons)_
- _[midnightntwrk/midnight-ledger](https://github.com/midnightntwrk/midnight-ledger) tag `ledger-8.1.3`
  (the version node 1.0.400 pins), `ledger/src/semantics.rs` lines 1310 to 1338 (the contract balance
  check behind 194; the same lines in 8.1.0, which node 1.0.0 pins)_
- _`@midnight-ntwrk/midnight-js-contracts` 4.1.1 (`submitTxCore`) and wallet SDK 1.2.0
  (`wallet-sdk-unshielded-wallet` 3.1.0, `dist/v1/Transacting.js`, where `InsufficientFundsError` is
  thrown)_
- _[midnight-docs](https://github.com/midnightntwrk/midnight-docs) at `f19a76d`: [Networks and
  environments](https://docs.midnight.network/guides/networks-and-environments), the
  [tokens overview](https://docs.midnight.network/tokens/overview) and
  [unshielded tokens](https://docs.midnight.network/tokens/unshielded-token)_
- _[midnight-examples](https://github.com/midnightntwrk/midnight-examples) main at `7c8c0a0`_

_Re-check before quoting. The docs describe NIGHT reaching Midnight from Cardano over a one-way
cNIGHT-to-mNIGHT bridge, and the tokens overview speaks of the time "once native mNIGHT launches". If
NIGHT can now be spent on Midnight Mainnet, this page no longer applies: the docs'
[Funding and transaction cost](https://docs.midnight.network/guides/networks-and-environments#funding-and-transaction-cost)
section and the release notes would say so._

---

## Symptom

It happens on Mainnet only. The same call works on Preview, Preprod and a local network, where wallets
have tNIGHT (test NIGHT).

| The circuit | What the developer sees | Where it stops |
|---|---|---|
| takes NIGHT from the caller: `receiveUnshielded(nativeToken(), amount)` | `Unexpected error submitting scoped transaction '<unnamed>': (FiberFailure) Wallet.InsufficientFunds: Insufficient funds` | in the wallet, after proving (11 to 13 s in, on the test machine); nothing is submitted |
| pays NIGHT out of the contract: `sendUnshielded(nativeToken(), amount, recipient)` | `Unexpected error submitting scoped transaction '<unnamed>': (FiberFailure) SubmissionError: Transaction submission error`. The code is further down: on the console, `RPC-CORE: submitAndWatchExtrinsic(extrinsic: Extrinsic): ExtrinsicStatus:: 1010: Invalid Transaction: Custom error: 194`, and in the cause chain midnight-js prints into `err.message`, `[cause]: RpcError: 1010: Invalid Transaction: Custom error: 194` | at the node, after proving and balancing (25 to 45 s in) |
| checks the contract's NIGHT: `unshieldedBalance(nativeToken())`, `unshieldedBalanceGte(nativeToken(), n)` and the other comparisons | no error from the check itself. The balance is 0 (inferred, not run), so the circuit takes its "no NIGHT" branch, often an `assert` with the contract's own message | in the circuit |

These messages are from midnight-js 4.1.1 and wallet SDK 1.2.0, with `submitCallTx`. On midnight-js
5.0.0, which Mainnet runs now, both arrive as `ProviderFailedError`: `balanceTx rejected the transaction
(circuit '<name>')…` for a receive and `submitTx rejected the transaction (circuit '<name>')…` for a
send. The reason is on `err.cause.message`: `InsufficientFundsError: Wallet.InsufficientFunds:
Insufficient funds`, or two causes down, `RpcError: 1010: Invalid Transaction: Custom error: 194`
(midnight-js 5.0.0's own wrapper, `atProviderMethod`, run on errors shaped like the wallet SDK's).
`deployed.callTx.<circuit>()` goes through the same wrapper (see the
[Node rejection codes](../node-1010-custom-error-runbook/node-1010-custom-error-runbook.md) runbook).
`(FiberFailure)` is how the wallet SDK labels a failure. With a browser wallet such as Lace or 1AM, the
wording may differ (not tried): ask for the DApp's browser console output.

`default<Bytes<32>>` and `pad(32, "")` as the token type are NIGHT too: both are 32 zero bytes, the same
value `nativeToken()` returns. midnight-examples' `token-transfers` uses `default<Bytes<32>>`.

What gives it away:

- **The wallet has DUST.** The user can pay fees and other calls work, but this one reports
  `Insufficient funds`. A NIGHT balance the wallet shows for Cardano (cNIGHT) can't be paid into a
  Midnight contract.
- **The token type is NIGHT's** (midnight-js 4.1.1; on 5.0.0 the cause stringifies to `{}`, so the
  circuit name in `err.message` decides instead). In the DApp's `catch`, print the error's cause. `amount` is a bigint,
  so plain `JSON.stringify` throws (`Do not know how to serialize a BigInt`); use a replacer:

  ```ts
  console.log(JSON.stringify(err.cause, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
  ```

  It shows the token the wallet couldn't find, and `amount`, how much of it the transaction needs
  (negative, in the token's smallest unit: STAR for NIGHT, 1 NIGHT = 1,000,000 STAR). From the
  unshielded wallet, a token type of 64 zeros is NIGHT. Here the call asked for 5,000 STAR (0.005 NIGHT):

  ```json
  {"_id":"FiberFailure","cause":{"_id":"Cause","_tag":"Fail","failure":{"message":"Insufficient funds","tokenType":"0000000000000000000000000000000000000000000000000000000000000000","amount":"-5000","_tag":"Wallet.InsufficientFunds"}}}
  ```

  `err.message` and `String(err)` don't include the token type.
- **194 isn't on the first line.** It's in the cause chain lower down in `err.message` and `String(err)`,
  and on the `RPC-CORE` console line.
- **Nothing is charged.** The receive never leaves the wallet, and the node rejects the send before
  it reaches a block, so neither pays a fee.

When a NIGHT step comes first, everything after it is blocked too. From the contracts' code (these two
weren't run):

- In midnight-examples' `private-party`, no guest can `checkIn`, so the organizer has no fees: `claimFees`
  stops at `No fees to claim`, or earlier at `The doors are not yet closed` if entry wasn't closed.
- In `silent-auction`, `receiveTokens` takes the organizer's NIGHT deposit and is the step that opens
  the auction, so the auction never opens.

**Not this runbook:**

- `Wallet.InsufficientFunds: Insufficient Funds: could not balance dust` (capital F): the wallet is
  short of DUST for the fee. Wait for DUST to generate. If it stopped generating, see
  [cNIGHT→DUST duplicate registrations](../cnight-dust-duplicate-registration-runbook/cnight-dust-duplicate-registration-runbook.md).
- `Insufficient funds` whose `tokenType` isn't 64 zeros: the wallet is short of that token, which is a
  contract's own token or a shielded token. The shielded wallet uses the same words.
- `Custom error: 194` from a circuit that sends a contract's own token: the contract holds too little
  of that token. It's the same check, on any network.
- Any other `Custom error: N`: see [Node rejection codes](../node-1010-custom-error-runbook/node-1010-custom-error-runbook.md).
- A Mainnet deploy that sits pending until its TTL and is never included: a leftover deploy filter on
  a node caused this until it was removed on 2026-10-20 ([midnightntwrk/servicedesk#257](https://github.com/midnightntwrk/servicedesk/issues/257)). If it
  happens again, open a servicedesk issue with the transaction hash.

## Root cause

NIGHT is Midnight's unshielded native token. Its token type is 32 zero bytes, which the standard
library's `nativeToken()` returns. A contract moves unshielded tokens with these standard-library
circuits, each taking the token type first; the standard library calls it `color`
(`compiler/standard-library.compact`, `compactc-v0.31.1`):

- `receiveUnshielded(color, amount)`: the transaction brings `amount` of the token into the contract.
  The caller's wallet pays it from its own coins when it balances the transaction.
- `sendUnshielded(color, amount, recipient)`: the contract pays `amount` out of what it holds.
- `unshieldedBalance(color)`, and `unshieldedBalanceLt`, `Gte`, `Gt` and `Lte`: read what the contract
  holds.

On Preview, Preprod and a local network, wallets get tNIGHT from a faucet or from the local network's
prefunded wallets, so these work. Mainnet is different:

- **NIGHT lives on Cardano.** The docs: "Today most NIGHT is held on Cardano as cNIGHT"
  ([Funding and transaction cost](https://docs.midnight.network/guides/networks-and-environments#funding-and-transaction-cost)).
  Registering cNIGHT generates DUST on Midnight, which pays fees. It doesn't put NIGHT in the wallet on
  Midnight. The docs describe a one-way cNIGHT-to-mNIGHT bridge, and the
  [tokens overview](https://docs.midnight.network/tokens/overview) speaks of the time "once native
  mNIGHT launches".
- **No NIGHT moved in the Mainnet sample.** Two windows of Mainnet blocks were read: every 400th block
  from 2026-09-20 to 10-12, and every 50th from 10-16 to 10-19. None of the 2,826 user transactions in
  them spent or created NIGHT, none claimed block rewards, and every fee was paid in DUST. Bridge and
  system transactions weren't counted. Tokens that contracts mint themselves do move: 56 of the
  transactions carried them.

So, on Mainnet:

1. **A NIGHT receive fails in the wallet.** midnight-js proves the call, then has the wallet balance
   it, then submits it (`submitTxCore`: `proveTx`, `balanceTx`, `submitTx`). The unshielded wallet has
   no NIGHT coins to pay in, so it throws `InsufficientFundsError` with `tokenType` 64 zeros and
   `amount`, what the transaction needs. Nothing is submitted.
2. **A NIGHT send is rejected by the node.** When the node applies the contract call, it subtracts
   each token the call pays out from the contract's balance, and fails if that goes below zero
   (`ledger/src/semantics.rs`, `ledger-8.1.3`, lines 1310 to 1338). The contract holds no NIGHT, so it
   fails with `Invalid.BalanceCheckOutOfBounds`, code 194 on node 1.0.x and 2.x. It doesn't matter who calls:
   it was reproduced with a caller who had NIGHT, because the contract's balance is what's checked.
3. **A NIGHT balance check reads 0.** It reads the contract's NIGHT balance, and the compiled
   `unshieldedBalanceLt` treats a token the contract doesn't hold as 0. This one wasn't run: it follows
   from the contract holding none.

Both failures go away once the NIGHT is there. On the same local network, the same circuits succeeded
for a wallet that had NIGHT, and for a contract that held it.

## Key identifiers

- **NIGHT's token type:** 32 zero bytes, written as:
  - `nativeToken()`, `default<Bytes<32>>` or `pad(32, "")` in Compact;
  - `this._nativeToken_0()`, `new Uint8Array(32)` or a 32-zero `Uint8Array` in a compiled `contract/index.js`;
  - `ledger.nativeToken().raw` (64 hex zeros) in the SDK and in the unshielded wallet's error. The SDK's
    `shieldedToken().raw` is also 64 zeros, so check which wallet the error came from.
- **Amounts:** STAR, 1 NIGHT = 1,000,000 STAR.
- **Standard-library circuits:** `receiveUnshielded`, `sendUnshielded`, `unshieldedBalance`,
  `unshieldedBalanceLt`, `unshieldedBalanceGte`, `unshieldedBalanceGt`, `unshieldedBalanceLte`.
- **Wallet error:** `_tag` `Wallet.InsufficientFunds`, with `tokenType`, and `amount` from the unshielded
  and shielded wallets (a bigint, in the token's smallest unit). The three wallets word it differently:
  - unshielded: `Insufficient funds`;
  - shielded: `Insufficient funds`, or `Insufficient funds for fallible segment N`;
  - DUST: `Insufficient Funds: could not balance dust`.
- **Node code:** `Custom error: 194`, `Invalid.BalanceCheckOutOfBounds` on node 1.0.x and 2.x (decoded by
  [`decode-1010.mjs`](../node-1010-custom-error-runbook/scripts/decode-1010.mjs), which needs Node 20).
- **Network ID:** `mainnet`: the `networkId` the DApp passes in `providers.config` (midnight-js
  5.0.0, which removed `@midnight-ntwrk/midnight-js-network-id`), or `getNetworkId()` from that
  package on midnight-js 4.1.1.
- **Examples that move NIGHT** (midnight-examples at `7c8c0a0`):
  - `token-transfers`: `receiveNightTokens`, `sendNightTokensToUser`;
  - `private-party`: `checkIn`, `claimFees`;
  - `silent-auction`: `receiveTokens`, `revealWin` (sends only when the highest bid is under the reserve
    price), `claimWin`.

  The docs' [private-party tutorial](https://docs.midnight.network/tutorials/private-party/smart-contract)
  and private guest list example take the entry fee in NIGHT the same way.

## Diagnose

1. **Check the network.** If the failure is on Preview or Preprod, the wallet really has too little
   tNIGHT: send tNIGHT to the wallet's unshielded address from the
   [Preprod faucet](https://midnight-tmnight-preprod.nethermind.dev/) or the
   [Preview faucet](https://midnight-tmnight-preview.nethermind.dev/), let it sync and try again.
   This runbook is about Mainnet.
2. **Run the checker on the contract.** It reads only, needs Node >= 18 and no install. Give it the
   compiled contract (the directory holding `contract/index.js`) when you have it: that's what is
   deployed, and it includes imported modules. It also takes a `.compact` file, whose imports it follows
   when they sit next to it, or a directory of them:

   ```sh
   mkdir -p /tmp/check-night-usage
   curl -fsSL -o /tmp/check-night-usage/check-night-usage.mjs \
     https://raw.githubusercontent.com/midnightntwrk/servicedesk/main/runbooks/contract-native-night-mainnet-runbook/scripts/check-night-usage.mjs
   node /tmp/check-night-usage/check-night-usage.mjs contract/managed/my-contract     # compiled
   node /tmp/check-night-usage/check-night-usage.mjs contract/my-contract.compact     # source
   ```

   It sorts each unshielded call by where its token type comes from:
   - **Certain:** `nativeToken()`, `default<Bytes<32>>` or `pad(32, "")`, directly, through a `const`, a
     helper circuit that returns one, or a helper's parameter that a caller fills with one.
   - **Possible:** a parameter of an exported circuit, a ledger field (often set at deploy), a witness, or
     any other value. It's NIGHT only if that value is NIGHT's token type. Check what the contract is
     deployed or called with.
   - **Not NIGHT:** `tokenType(…)` or `mintUnshieldedToken(…)`, a token the contract mints itself.

   Exit code: 2 = a circuit certainly moves NIGHT; 3 = only possible uses, or an import it couldn't
   follow (listed as "not followed": scan the compiled contract instead); 0 = every unshielded call
   uses a token the contract mints, or there are none; 1 = it could not run. `--json` prints the
   result as JSON, with `certain` on each use. A source scan follows modules, prefixes, `include` and
   `export { … }` lists. On midnight-examples' `token-transfers` (exit 2):

   ```text
   contract/token-transfers.compact (source, 9 exported circuits): 2 move NIGHT
     receiveNightTokens: receive
       receiveUnshielded(default<Bytes<32>>) at line 37
     sendNightTokensToUser: send
       sendUnshielded(default<Bytes<32>>) at line 41

   On Mainnet (as of 2026-11-07, after the ledger 9 upgrade, which left the bridge off), a wallet funded through cNIGHT has DUST but no NIGHT on Midnight, and a contract no one has paid NIGHT holds none, so a circuit that moves NIGHT fails there. It works on Preview, Preprod and a local network:
     - a NIGHT receive fails in the wallet after proving, before anything is submitted: Wallet.InsufficientFunds: Insufficient funds. A wallet funded through cNIGHT has DUST but no NIGHT on Midnight to pay with.
     - a NIGHT send is rejected by the node after proving: 1010: Invalid Transaction: Custom error: 194 (BalanceCheckOutOfBounds), shown as SubmissionError: Transaction submission error. The contract holds no NIGHT.
   Fix: hide these circuits on Mainnet in the DApp, or leave them out of the Mainnet build. If a circuit only needs some token to move, a token the contract mints itself (mintUnshieldedToken) does move on Mainnet.
   Runbook: https://github.com/midnightntwrk/servicedesk/blob/main/runbooks/contract-native-night-mainnet-runbook/contract-native-night-mainnet-runbook.md
   ```

3. **Confirm from the error.** In the DApp's `catch`, print the message and its causes, which works
   on both midnight-js versions:

   ```ts
   for (let e: unknown = err; e instanceof Error; e = e.cause) console.log(e.message);
   ```

   On midnight-js 4.1.1, also print the cause with the bigint replacer above. Pass that, or the error text, to `--error`, on stdin so the shell doesn't trip on its quotes, and
   say the network:

   ```sh
   pbpaste | node /tmp/check-night-usage/check-night-usage.mjs --error - --network mainnet    # macOS clipboard
   node /tmp/check-night-usage/check-night-usage.mjs --error - --network mainnet < error.txt
   ```

   Exit code: 2 = this runbook (a `tokenType` of 64 zeros on Mainnet, not from the shielded wallet); 3 = could be, and the output
   says the one detail that decides it (the `tokenType`, or whether the circuit sends NIGHT); 0 = not
   this runbook, with where to go instead. For a send, the decider is `Custom error: 194` in the
   `RPC-CORE` console line or lower down in `err.message`, plus the checker finding a NIGHT send. On
   midnight-js 5.0.0 the output names the circuit from `err.message`, and the decider is whether step 2
   lists that circuit as a NIGHT receive or send.
4. **By hand, without the script:**

   ```sh
   grep -rnE -A2 --include='*.compact' 'receiveUnshielded|sendUnshielded|unshieldedBalance' .
   ```

   Then check each call's first argument: `nativeToken()`, `default<Bytes<32>>`, `pad(32, "")`, or a
   constant, helper, parameter, ledger field or witness that can hold one of them.

## Remediation

1. **For a DApp's user: nothing to fix on their side.** The DApp's NIGHT feature can't work on Mainnet
   now, and the failed call cost nothing. More DUST won't help.
2. **Hide the NIGHT circuits on Mainnet in the DApp.** Disable those actions on Mainnet, with a message
   that says why, and keep them on Preview and Preprod:

   ```ts
   // midnight-js 5.0.0: the same networkId the DApp passes in providers.config
   const nightPaymentsWork = config.networkId !== 'mainnet';
   ```

   On midnight-js 4.1.1 (the ledger 8 set), read it with `getNetworkId()` from
   `@midnight-ntwrk/midnight-js-network-id` instead; midnight-js 5.0.0 removed that package.

   - Pro: no contract change.
   - Con: the feature is missing on Mainnet. Nothing published says whether a contract deployed now
     will work unchanged once NIGHT can be spent on Midnight Mainnet.
3. **Leave them out of the Mainnet build.** Deploy a contract without the NIGHT circuits, and run the
   checker on its compiled output first. Exit 0 means every unshielded call uses the contract's own token; review any
   "possible" line before deploying.
   - Pro: users can't reach a call that can only fail.
   - Con: it's a second contract to maintain.
4. **Use a token the contract mints itself, where the circuit only needs some token to move** (a
   ticket, a receipt, a marker). `mintUnshieldedToken` and `tokenType(domain, kernel.self())`, the
   token type for a 32-byte name the contract picks, work on Mainnet. `token-transfers`'
   `mintAndReceive` and `receiveTokens` show the pattern (not `silent-auction`'s `receiveTokens`, which
   takes NIGHT).
   - Con: it isn't NIGHT and carries none of its value, so it can't replace a real payment. Switching an
     existing contract to it means a new deploy.
5. **Before any Mainnet launch,** run the checker on every contract. Then call each NIGHT circuit once
   on a local network from a wallet that has DUST but no NIGHT, which is the Mainnet position. To get
   such a wallet, a funded wallet sends NIGHT to a third wallet, and that wallet registers it for DUST
   generation with the test wallet's DUST address as the receiver.
   [`scripts/no-night.test.ts`](scripts/no-night.test.ts) does this for `token-transfers` and makes the
   five calls in the NOTES. It runs inside midnight-examples, and its header says where it goes and
   how to run it.

## Upstream follow-ups

- **midnight-docs** (to report):
  - "Preparing a DApp for mainnet" says to validate on Preprod because "anything that fails there will
    fail in production". It doesn't warn about the reverse: a NIGHT circuit that works on Preprod fails
    on Mainnet.
  - The private-party tutorial, the private guest list example and the token-transfers example page
    (`docs/examples/contracts/token-transfers.mdx`) move NIGHT without a Mainnet note.
  - The docs disagree on where Mainnet NIGHT is: the unshielded tokens page says it "reaches Midnight
    from Cardano over the one-way cNIGHT-to-mNIGHT bridge", and the tokens overview speaks of the time
    "once native mNIGHT launches".
- **midnight-examples** (to report): `token-transfers`, `private-party` and `silent-auction` have NIGHT
  circuits with no Mainnet note.
- **Wallet SDK and midnight-js** (to report): `Insufficient funds` doesn't name the token, and
  midnight-js's message drops the `tokenType`. A message naming NIGHT would make this a one-line answer.

## Reference material

- **Scripts:**
  - [`scripts/check-night-usage.mjs`](scripts/check-night-usage.mjs), the checker, and
    [`scripts/test-check-night-usage.mjs`](scripts/test-check-night-usage.mjs), its offline test;
  - [`scripts/no-night.test.ts`](scripts/no-night.test.ts), the local-network reproduction.

  The experiment, the Mainnet sample and the test fixtures are in
  [`scripts/check-night-usage.NOTES.md`](scripts/check-night-usage.NOTES.md).
- **Source:**
  - [`compiler/standard-library.compact`](https://github.com/LFDT-Minokawa/compact/blob/compactc-v0.31.1/compiler/standard-library.compact)
    at `compactc-v0.31.1`;
  - [`ledger/src/semantics.rs`](https://github.com/midnightntwrk/midnight-ledger/blob/ledger-8.1.3/ledger/src/semantics.rs#L1310-L1338)
    at `ledger-8.1.3`.
- **Docs:** [Networks and environments](https://docs.midnight.network/guides/networks-and-environments),
  sections "Funding and transaction cost" and "Preparing a DApp for mainnet"; the
  [tokens overview](https://docs.midnight.network/tokens/overview) and
  [unshielded tokens](https://docs.midnight.network/tokens/unshielded-token).
- **Examples:** [midnight-examples](https://github.com/midnightntwrk/midnight-examples) `examples/token-transfers`,
  `examples/private-party` and `examples/silent-auction`.
- **Related runbooks:**
  - [Node rejection codes](../node-1010-custom-error-runbook/node-1010-custom-error-runbook.md): other
    `Custom error: N`, and where the code sits in an error;
  - [cNIGHT→DUST duplicate registrations](../cnight-dust-duplicate-registration-runbook/cnight-dust-duplicate-registration-runbook.md):
    DUST that stopped generating.
