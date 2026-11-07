#!/usr/bin/env node
/**
 * test-check-night-usage.mjs: runs check-night-usage.mjs on Compact source, compiled contracts and
 * pasted errors, and checks what it reports and its exit code. No network, no compiler.
 *
 * The example sources are from midnight-examples (main at 7c8c0a0, 2026-10-16). The vault, module and
 * variant shapes are contracts written for the runbook's review and compiled with 0.31.1; the compiled
 * fixtures keep the shape that compiler emits (`this.circuits = { name: ... }`, `_name_0(...)`
 * methods, `this._nativeToken_0()`, `new Uint8Array(32)` and a 32-zero array as token types). The error
 * texts are from the 2026-10-19 local-network runs recorded in check-night-usage.NOTES.md.
 *
 *   node test-check-night-usage.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const CHECK = path.join(path.dirname(fileURLToPath(import.meta.url)), 'check-night-usage.mjs');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'test-check-night-'));
const write = (rel, text) => { const f = path.join(TMP, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); return f; };
const ZEROS = '0'.repeat(64);
const ZERO_ARRAY = `new Uint8Array([${Array(32).fill(0).join(', ')}])`;

// midnight-examples examples/token-transfers/contract/token-transfers.compact (circuits that matter here)
const TOKEN_TRANSFERS = `pragma language_version 0.23;
import CompactStandardLibrary;

// Mint using mintUnshieldedToken() + receiveUnshielded()
export circuit mintAndReceive(amount: Uint<64>): Bytes<32> {
    const domain = pad(32, "simple:receive");
    const color = mintUnshieldedToken(disclose(domain), disclose(amount), left<ContractAddress, UserAddress>(kernel.self()));
    return color;
}

// Send to user address
export circuit sendToUser(amount: Uint<64>, user_addr: UserAddress): [] {
    const domain = pad(32, "simple:receive");
    const color = tokenType(domain, kernel.self());
    sendUnshielded(
        color, disclose(amount), right<ContractAddress, UserAddress>(disclose(user_addr))
    );
}

export circuit receiveTokens(amount: Uint<128>): [] {
    const domain = pad(32, "simple:receive");
    const color = tokenType(domain, kernel.self());
    receiveUnshielded(color, disclose(amount));
}

export circuit receiveNightTokens(amount: Uint<128>): [] {
   receiveUnshielded(default<Bytes<32>>, disclose(amount));
}

export circuit sendNightTokensToUser(amount: Uint<64>, user_addr: UserAddress): [] {
    sendUnshielded(
        default<Bytes<32>>, disclose(amount), right<ContractAddress, UserAddress>(disclose(user_addr))
    );
}
`;

// midnight-examples examples/private-party/contract/private-party.compact (checkIn, claimFees and helpers)
const PRIVATE_PARTY = `pragma language_version 0.23;
import CompactStandardLibrary;
export ledger checkedInParty: Set<UserAddress>;
export sealed ledger entryFee: Uint<16>;

export circuit checkIn(address: UserAddress, _secret: Bytes<32>): [] {
    const commitHash = commitAddress(_secret, address.bytes);
    // take in unshielded payment, party goers are now public
    receiveUnshielded(nativeToken(), entryFee as Uint<128>);
    checkedInParty.insert(disclose(address));
}

export circuit claimFees(address: UserAddress, _secret: Bytes<32>): [] {
    const pubKey = getDappPublicKey(_secret);
    assert(checkedInParty.size() > 0, "No fees to claim");
    const totalCollected = checkedInParty.size() * entryFee;
    assert(unshieldedBalanceGte(nativeToken(), totalCollected), "Contract balance wrong");
    sendUnshielded(
        nativeToken(),
        disclose(totalCollected) as Uint<128>,
        right<ContractAddress, UserAddress>(disclose(address))
    );
}

circuit commitAddress(_address: Bytes<32>, _secret: Bytes<32>): Bytes<32> {
    return persistentCommit<Bytes<32>>(_address, _secret);
}

circuit getDappPublicKey(_secret: Bytes<32>): Bytes<32> {
    return persistentHash<Vector<2, Bytes<32>>>([pad(32, "private-party:pk:"), _secret]);
}
`;

// Shapes a real contract might use.
const SHAPES = `pragma language_version 0.23;
import CompactStandardLibrary;

// receiveUnshielded(nativeToken(), 1) in a comment is not code
export circuit noted(): [] {
    // receiveUnshielded(nativeToken(), 2);
    /* sendUnshielded(nativeToken(), 3, right<ContractAddress, UserAddress>(x)); */
    assert(true, "receiveUnshielded(nativeToken(), 5)");
}

export circuit aliased(amount: Uint<128>): [] {
    const night = nativeToken();
    receiveUnshielded(night, disclose(amount));
}

export circuit anyToken(color: Bytes<32>, amount: Uint<128>): [] {
    receiveUnshielded(disclose(color), disclose(amount));
}

export circuit anyToken2(color: Bytes<32>, amount: Uint<128>): [] {
    receiveUnshielded(color, disclose(amount));
}

circuit takeNight(amount: Uint<128>): [] {
    receiveUnshielded(nativeToken(), amount);
}

export circuit deposit(amount: Uint<128>): [] {
    takeNight(disclose(amount));
}

export circuit hasNight(): Boolean {
    return unshieldedBalance(nativeToken()) > 0;
}

export circuit custom(amount: Uint<128>): [] {
    receiveUnshielded(tokenType(pad(32, "mine"), kernel.self()), disclose(amount));
}
`;

// Token types that reach the call some other way (from the runbook's operator review).
const VAULT = `pragma language_version 0.23;
import CompactStandardLibrary;

export ledger feeToken: Bytes<32>;
witness payToken(): Bytes<32>;

constructor(t: Bytes<32>) {
  feeToken = disclose(t);
}

circuit night(): Bytes<32> {
  return nativeToken();
}

circuit myToken(): Bytes<32> {
  return tokenType(pad(32, "vault:own"), kernel.self());
}

circuit take(c: Bytes<32>, a: Uint<128>): [] {
  receiveUnshielded(c, a);
}

circuit payOutNight(a: Uint<128>, to: Either<ContractAddress, UserAddress>): [] {
  sendUnshielded(nativeToken(), a, to);
}

export circuit depositViaHelper(amount: Uint<128>): [] {
  receiveUnshielded(night(), disclose(amount));
}

export circuit depositNightViaTake(amount: Uint<128>): [] {
  take(nativeToken(), disclose(amount));
}

export circuit depositOwnViaTake(amount: Uint<128>): [] {
  take(myToken(), disclose(amount));
}

export circuit depositAnyViaTake(color: Bytes<32>, amount: Uint<128>): [] {
  take(disclose(color), disclose(amount));
}

export circuit withdraw(amount: Uint<128>, to: UserAddress): [] {
  payOutNight(disclose(amount), right<ContractAddress, UserAddress>(disclose(to)));
}

export circuit payFee(amount: Uint<128>): [] {
  receiveUnshielded(feeToken, disclose(amount));
}

export circuit depositWitness(amount: Uint<128>): [] {
  receiveUnshielded(disclose(payToken()), disclose(amount));
}

export circuit depositConst(amount: Uint<128>): [] {
  const NIGHT = default<Bytes<32>>;
  receiveUnshielded(NIGHT, disclose(amount));
}

export circuit depositPad(amount: Uint<128>): [] {
  receiveUnshielded(pad(32, ""), disclose(amount));
}

export circuit hasNight(n: Uint<128>): Boolean {
  return unshieldedBalanceGte(night(), disclose(n));
}

export circuit discloseAlias(color: Bytes<32>, amount: Uint<128>): [] {
  const c = disclose(color);
  receiveUnshielded(c, disclose(amount));
}
`;

// A module in its own file, imported with and without a prefix, and a module in the same file.
const PAY_MODULE = `module Pay {
  import CompactStandardLibrary;
  export circuit takeNight(a: Uint<128>): [] {
    receiveUnshielded(nativeToken(), a);
  }
}
`;
const SHOP = `pragma language_version 0.23;
import CompactStandardLibrary;
import "Pay";

export circuit buy(amount: Uint<128>): [] {
  takeNight(disclose(amount));
}
`;
const SHOP_PREFIX = `pragma language_version 0.23;
import CompactStandardLibrary;
import "Pay" prefix P_;

export circuit buy(amount: Uint<128>): [] {
  P_takeNight(disclose(amount));
}
`;
const SHOP_INLINE = `pragma language_version 0.23;
import CompactStandardLibrary;
module Inner {
  import CompactStandardLibrary;
  export circuit takeNight(a: Uint<128>): [] {
    receiveUnshielded(nativeToken(), a);
  }
}
import Inner;

export circuit buy(amount: Uint<128>): [] {
  takeNight(disclose(amount));
}
`;
const SHOP_MISSING = `pragma language_version 0.23;
import CompactStandardLibrary;
import "lib/Missing";

export circuit buy(amount: Uint<128>): [] {
  takeNight(disclose(amount));
}
`;

// From the runbook's fact-check: a module circuit with the same name as a top-level one, imported with
// a prefix; an export list; NIGHT in a struct field, from a pure helper and through a typed const.
const CLASH = `pragma language_version 0.23;
import CompactStandardLibrary;

module Fees {
  import CompactStandardLibrary;
  export circuit pay(amount: Uint<128>): [] {
    receiveUnshielded(nativeToken(), amount);
  }
}
import Fees prefix Fees_;

export ledger n: Counter;

export circuit pay(): [] {
  n.increment(1);
}

export circuit deposit(amount: Uint<128>): [] {
  Fees_pay(disclose(amount));
}
`;
const EXPORT_LIST = `pragma language_version 0.23;
import CompactStandardLibrary;

circuit pay(amount: Uint<128>): [] {
  receiveUnshielded(nativeToken(), disclose(amount));
}

circuit helper(): [] {
}

export { pay };
`;
const MORE_SHAPES = `pragma language_version 0.23;
import CompactStandardLibrary;

struct Payment { color: Bytes<32>; amount: Uint<128>; }

pure circuit night(): Bytes<32> {
  return nativeToken();
}

export circuit viaStruct(amount: Uint<128>): [] {
  const p = Payment { color: nativeToken(), amount: disclose(amount) };
  receiveUnshielded(p.color, p.amount);
}

export circuit viaPureHelper(amount: Uint<128>): [] {
  receiveUnshielded(night(), disclose(amount));
}

export circuit viaTypedAlias(amount: Uint<128>): [] {
  const t: Bytes<32> = nativeToken();
  sendUnshielded(t, disclose(amount), left<ContractAddress, UserAddress>(kernel.self()));
}
`;
const INCLUDED = `export circuit tip(amount: Uint<128>): [] {
  receiveUnshielded(nativeToken(), disclose(amount));
}
`;
const INCLUDER = `pragma language_version 0.23;
import CompactStandardLibrary;
include "tips";
`;
// CLASH as 0.31.1 compiles it (trimmed): circuits.pay calls _pay_1; the module's pay is _pay_0.
const COMPILED_CLASH = `class Contract {
  constructor(...args_0) {
    this.circuits = {
      pay: (...args_1) => {
        const result_0 = this._pay_1(context, partialProofData);
        return result_0;
      },
      deposit: (...args_1) => {
        const result_0 = this._deposit_0(context, partialProofData, amount_0);
        return result_0;
      }
    };
  }
  _nativeToken_0() {
    return ${ZERO_ARRAY};
  }
  _receiveUnshielded_0(context, partialProofData, color_0, amount_0) {
    return [];
  }
  _pay_0(context, partialProofData, amount_0) {
    this._receiveUnshielded_0(context, partialProofData, this._nativeToken_0(), amount_0);
    return [];
  }
  _pay_1(context, partialProofData) {
    return [];
  }
  _deposit_0(context, partialProofData, amount_0) {
    this._pay_0(context, partialProofData, amount_0); return [];
  }
}
`;

const PAY_GENERIC = `module Pay<T> {
  import CompactStandardLibrary;
  export circuit takeNight(a: Uint<128>): [] {
    receiveUnshielded(nativeToken(), a);
  }
}
`;
const SHOP_GENERIC = `pragma language_version 0.23;
import CompactStandardLibrary;
import "Pay"<Field>;

export circuit buy(amount: Uint<128>): [] {
  takeNight(disclose(amount));
}
`;
const BRANCHES = `pragma language_version 0.23;
import CompactStandardLibrary;

export circuit pay(useNight: Boolean, amount: Uint<64>, to: UserAddress): [] {
  if (disclose(useNight)) {
    const color = nativeToken();
    sendUnshielded(color, disclose(amount), right<ContractAddress, UserAddress>(disclose(to)));
  } else {
    const color = tokenType(pad(32, "own"), kernel.self());
    sendUnshielded(color, disclose(amount), right<ContractAddress, UserAddress>(disclose(to)));
  }
}
`;
const COMMENTED_IMPORT = `pragma language_version 0.23;
import CompactStandardLibrary;
/*
      import "Missing";
*/
export ledger n: Counter;
export circuit inc(): [] { n.increment(1); }
`;
// 0.34.0 and 0.35.0 output (trimmed from 0.35.0): async circuits, awaited calls.
const COMPILED_ASYNC = `class Contract {
  constructor(...args_0) {
    this.circuits = {
      take: async (...args_1) => {
        const result_0 = await this._take_0(context, partialProofData, amount_0);
        return result_0;
      },
      viaHelper: async (...args_1) => {
        const result_0 = await this._viaHelper_0(context, partialProofData, amount_0);
        return result_0;
      },
      custom: async (...args_1) => {
        const result_0 = await this._custom_0(context, partialProofData, amount_0);
        return result_0;
      }
    };
  }
  _nativeToken_0() {
    return ${ZERO_ARRAY};
  }
  _tokenType_0(domain_sep_0, contractAddress_0) {
    return x;
  }
  async _receiveUnshielded_0(context, partialProofData, color_0, amount_0) {
    return [];
  }
  _night_0() { return this._nativeToken_0(); }
  async _take_0(context, partialProofData, amount_0) {
    await this._receiveUnshielded_0(context,
                                    partialProofData,
                                    this._nativeToken_0(),
                                    amount_0);
    return [];
  }
  async _viaHelper_0(context, partialProofData, amount_0) {
    await this._receiveUnshielded_0(context,
                                    partialProofData,
                                    this._night_0(),
                                    amount_0);
    return [];
  }
  async _custom_0(context, partialProofData, amount_0) {
    await this._receiveUnshielded_0(context,
                                    partialProofData,
                                    this._tokenType_0(own_0, this._ownAddress_0()),
                                    amount_0);
    return [];
  }
}
`;
// A circuits entry this checker can't read: must not come out as an all-clear.
const COMPILED_UNKNOWN = `class Contract {
  constructor(...args_0) {
    this.circuits = {
      take: function (...args_1) {
        return this.run('take', args_1);
      }
    };
  }
}
`;

// The shape of a 0.31.1 contract/index.js (trimmed): exported names, then the methods.
const COMPILED = `class Contract {
  constructor(...args_0) {
    this.circuits = {
      checkIn: (...args_1) => {
        return this._checkIn_0(context, partialProofData, address_0, _secret_0);
      },
      rsvp: (...args_1) => {
        return this._rsvp_0(context, partialProofData);
      },
      payOut: (...args_1) => {
        return this._payOut_0(context, partialProofData, amount_0);
      },
      anyToken: (...args_1) => {
        return this._anyToken_0(context, partialProofData, color_0, amount_0);
      }
    };
  }
  _nativeToken_0() {
    return ${ZERO_ARRAY};
  }
  _sendUnshielded_0(context, partialProofData, color_0, amount_0, recipient_0) {
    const tmp_0 = this._left_0(color_0);
  }
  _receiveUnshielded_0(context, partialProofData, color_0, amount_0) {
    return [];
  }
  _helper_0(context, partialProofData, amount_0) {
    this._sendUnshielded_0(context,
                           partialProofData,
                           new Uint8Array(32),
                           amount_0,
                           this._right_0(x));
    return [];
  }
  _checkIn_0(context, partialProofData, address_0, _secret_0) {
    this._receiveUnshielded_0(context,
                              partialProofData,
                              this._nativeToken_0(),
                              1n);
    return [];
  }
  _rsvp_0(context, partialProofData) {
    return [];
  }
  _payOut_0(context, partialProofData, amount_0) {
    this._helper_0(context, partialProofData, amount_0);
    return [];
  }
  _anyToken_0(context, partialProofData, color_0, amount_0) {
    this._receiveUnshielded_0(context, partialProofData, color_0, amount_0);
    return [];
  }
}
`;

// VAULT as 0.31.1 compiles it (trimmed to the methods that matter).
const COMPILED_VAULT = `class Contract {
  constructor(...args_0) {
    this.circuits = {
      depositViaHelper: (...args_1) => {
        return this._depositViaHelper_0(context, partialProofData, amount_0);
      },
      depositNightViaTake: (...args_1) => {
        return this._depositNightViaTake_0(context, partialProofData, amount_0);
      },
      payFee: (...args_1) => {
        return this._payFee_0(context, partialProofData, amount_0);
      },
      depositWitness: (...args_1) => {
        return this._depositWitness_0(context, partialProofData, amount_0);
      },
      depositConst: (...args_1) => {
        return this._depositConst_0(context, partialProofData, amount_0);
      },
      depositPad: (...args_1) => {
        return this._depositPad_0(context, partialProofData, amount_0);
      },
      hasNight: (...args_1) => {
        return this._hasNight_0(context, partialProofData, n_0);
      }
    };
  }
  _nativeToken_0() {
    return ${ZERO_ARRAY};
  }
  _receiveUnshielded_0(context, partialProofData, color_0, amount_0) {
    return [];
  }
  _unshieldedBalanceLt_0(context, partialProofData, color_0, amount_0) {
    return false;
  }
  _unshieldedBalanceGte_0(context, partialProofData, color_0, amount_0) {
    return !this._unshieldedBalanceLt_0(context,
                                        partialProofData,
                                        color_0,
                                        amount_0);
  }
  _payToken_0(context, partialProofData) {
    const witnessContext_0 = __compactRuntime.createWitnessContext(ledger(context.currentQueryContext.state), context.currentPrivateState, context.currentQueryContext.address);
    const [nextPrivateState_0, result_0] = this.witnesses.payToken(witnessContext_0);
    context.currentPrivateState = nextPrivateState_0;
    return result_0;
  }
  _night_0() { return this._nativeToken_0(); }
  _take_0(context, partialProofData, c_0, a_0) {
    this._receiveUnshielded_0(context, partialProofData, c_0, a_0); return [];
  }
  _depositViaHelper_0(context, partialProofData, amount_0) {
    this._receiveUnshielded_0(context,
                              partialProofData,
                              this._night_0(),
                              amount_0);
    return [];
  }
  _depositNightViaTake_0(context, partialProofData, amount_0) {
    this._take_0(context, partialProofData, this._nativeToken_0(), amount_0);
    return [];
  }
  _payFee_0(context, partialProofData, amount_0) {
    this._receiveUnshielded_0(context,
                              partialProofData,
                              _descriptor_2.fromValue(__compactRuntime.queryLedgerState(context,
                                                                                        partialProofData,
                                                                                        [
                                                                                         { dup: { n: 0 } },
                                                                                         { idx: { cached: false,
                                                                                                  pushPath: false,
                                                                                                  path: [
                                                                                                         { tag: 'value',
                                                                                                           value: { value: _descriptor_8.toValue(0n),
                                                                                                                    alignment: _descriptor_8.alignment() } }] } },
                                                                                         { popeq: { cached: false,
                                                                                                    result: undefined } }]).value),
                              amount_0);
    return [];
  }
  _depositWitness_0(context, partialProofData, amount_0) {
    this._receiveUnshielded_0(context,
                              partialProofData,
                              this._payToken_0(context, partialProofData),
                              amount_0);
    return [];
  }
  _depositConst_0(context, partialProofData, amount_0) {
    const NIGHT_0 = new Uint8Array(32);
    this._receiveUnshielded_0(context, partialProofData, NIGHT_0, amount_0);
    return [];
  }
  _depositPad_0(context, partialProofData, amount_0) {
    this._receiveUnshielded_0(context,
                              partialProofData,
                              ${ZERO_ARRAY},
                              amount_0);
    return [];
  }
  _hasNight_0(context, partialProofData, n_0) {
    return this._unshieldedBalanceGte_0(context,
                                        partialProofData,
                                        this._night_0(),
                                        n_0);
  }
}
`;

const ERR_RECEIVE = "Unexpected error submitting scoped transaction '<unnamed>': (FiberFailure) Wallet.InsufficientFunds: Insufficient funds";
// JSON.stringify(err.cause) of the receive failure (midnight-js 4.1.1, wallet SDK 1.2.0).
const ERR_RECEIVE_JSON = `{"_id":"FiberFailure","cause":{"_id":"Cause","_tag":"Fail","failure":{"message":"Insufficient funds","tokenType":"${ZEROS}","amount":"-5000","_tag":"Wallet.InsufficientFunds"}}}`;
const ERR_OTHER_TOKEN_JSON = ERR_RECEIVE_JSON.replace(ZEROS, 'ab'.repeat(32));
const ERR_SEND_RPC = '2026-10-19 11:21:54        RPC-CORE: submitAndWatchExtrinsic(extrinsic: Extrinsic): ExtrinsicStatus:: 1010: Invalid Transaction: Custom error: 194';
const ERR_SEND_JS = "Unexpected error submitting scoped transaction '<unnamed>': (FiberFailure) SubmissionError: Transaction submission error";
const ERR_DUST = '(FiberFailure) Wallet.InsufficientFunds: Insufficient Funds: could not balance dust';
// midnight-js 5.0.0's ProviderFailedError (atProviderMethod), with the causes it rebuilds.
const MJS5_TAIL = ". The provider's own failure is on `cause`, with its message redacted of anything that could carry transaction or witness material; read the provider's own logs for the unredacted detail.";
const ERR5_RECEIVE = `balanceTx rejected the transaction (circuit 'receiveNightTokens')${MJS5_TAIL}`;
const ERR5_SEND = `submitTx rejected the transaction (circuit 'sendNightTokensToUser')${MJS5_TAIL}`;
const ERR5_RECEIVE_CAUSE = `${ERR5_RECEIVE}\nInsufficientFundsError: Wallet.InsufficientFunds: Insufficient funds`;
const ERR5_SEND_CAUSE = `${ERR5_SEND}\nSubmissionError: Transaction submission error\nSubmissionError: Transaction submission failed\nRpcError: 1010: Invalid Transaction: Custom error: 194`;
const ERR_SHIELDED = `Unexpected error submitting scoped transaction '<unnamed>': (FiberFailure) Wallet.InsufficientFunds: Insufficient funds
    at Object.catch (file:///app/node_modules/@midnight-ntwrk/wallet-sdk-shielded/dist/v1/Transacting.js:180:32)`;

const tt = write('tt/token-transfers.compact', TOKEN_TRANSFERS);
const pp = write('pp/private-party.compact', PRIVATE_PARTY);
const shapes = write('shapes/shapes.compact', SHAPES);
const vault = write('vault/vault.compact', VAULT);
write('mod/Pay.compact', PAY_MODULE);
const shop = write('mod/shop.compact', SHOP);
const shopPrefix = write('mod/shop-prefix.compact', SHOP_PREFIX);
const shopInline = write('inline/shop.compact', SHOP_INLINE);
const shopMissing = write('missing/shop.compact', SHOP_MISSING);
write('generic/Pay.compact', PAY_GENERIC);
const shopGeneric = write('generic/shop.compact', SHOP_GENERIC);
const branches = write('branches/b.compact', BRANCHES);
const commentedImport = write('commented/c.compact', COMMENTED_IMPORT);
write('compiled/managed/async/contract/index.js', COMPILED_ASYNC);
write('compiled/managed/unknown/contract/index.js', COMPILED_UNKNOWN);
const clash = write('clash/clash.compact', CLASH);
const exportList = write('exportlist/reexport.compact', EXPORT_LIST);
const moreShapes = write('more/shapes.compact', MORE_SHAPES);
write('include/tips.compact', INCLUDED);
const includer = write('include/main.compact', INCLUDER);
write('compiled/managed/clash/contract/index.js', COMPILED_CLASH);
const compiled = write('compiled/managed/party/contract/index.js', COMPILED);
const compiledVault = write('compiled/managed/vault/contract/index.js', COMPILED_VAULT);
const clean = write('dir/clean.compact', 'pragma language_version 0.23;\nexport ledger n: Counter;\nexport circuit inc(): [] { n.increment(1); }\n');
write('dir/sub/night.compact', 'pragma language_version 0.23;\nimport CompactStandardLibrary;\nexport circuit pay(a: Uint<128>): [] { receiveUnshielded(nativeToken(), disclose(a)); }\n');
write('dir/managed/x/contract/index.js', COMPILED); // compiled output under a source directory isn't scanned again
const feeOnly = write('fee/fee.compact', 'pragma language_version 0.23;\nimport CompactStandardLibrary;\nexport ledger feeToken: Bytes<32>;\nexport circuit payFee(a: Uint<128>): [] { receiveUnshielded(feeToken, disclose(a)); }\n');
// A project whose contract/index.js is a TypeScript build of a wrapper, not the compiler's output.
write('wrapped/contract/index.js', "export * from './managed/party/contract/index.js';\nexport const zkConfigPath = 'managed/party';\n");
write('wrapped/contract/party.compact', 'pragma language_version 0.23;\nimport CompactStandardLibrary;\nexport circuit pay(a: Uint<128>): [] { receiveUnshielded(nativeToken(), disclose(a)); }\n');

const run = (args, input) => spawnSync(process.execPath, [CHECK, ...args], { encoding: 'utf8', input });
const json = (args, input) => { const r = run([...args, '--json'], input); return { code: r.status, j: r.stdout ? JSON.parse(r.stdout) : undefined, err: r.stderr }; };
const text = (args, input) => { const r = run(args, input); return { code: r.status, out: r.stdout, err: r.stderr }; };
// circuit -> { kinds, certain, why, files } for the first result of a scan
const found = (j, i = 0) => Object.fromEntries((j.results[i]?.found ?? []).map((f) => [f.circuit, {
  kinds: [...new Set(f.uses.map((u) => u.kind))].sort().join(','),
  certain: f.certain,
  why: f.uses.map((u) => u.why ?? '').join(' | '),
  files: f.uses.map((u) => (u.file ? path.basename(u.file) : '')).join(','),
}]));
const vaultSource = found(json([vault]).j);
const vaultCompiled = found(json([path.join(TMP, 'compiled', 'managed', 'vault')]).j);

const cases = [
  // Compact source: the examples
  ['token-transfers: the two NIGHT circuits, not the custom-token ones', () => {
    const { code, j } = json([tt]);
    const f = found(j);
    return code === 2 && JSON.stringify(Object.keys(f).sort()) === '["receiveNightTokens","sendNightTokensToUser"]' && f.receiveNightTokens.kinds === 'receive' && f.sendNightTokensToUser.kinds === 'send' && f.receiveNightTokens.certain && j.results[0].circuits === 5;
  }],
  ['private-party: checkIn receives, claimFees checks and sends', () => {
    const { code, j } = json([pp]);
    const f = found(j);
    return code === 2 && f.checkIn?.kinds === 'receive' && f.claimFees?.kinds === 'balance,send' && f.claimFees.certain && !f.commitAddress && j.results[0].circuits === 2;
  }],
  // Compact source: shapes
  ['comments and strings are ignored', () => !found(json([shapes]).j).noted],
  ['a const bound to nativeToken() counts', () => found(json([shapes]).j).aliased?.certain === true],
  ['a token type from a parameter is possible', () => { const f = found(json([shapes]).j).anyToken2; return f?.certain === false && f.why.includes('parameter color'); }],
  ['disclose(param) is possible too', () => { const f = found(json([shapes]).j).anyToken; return f?.certain === false && f.why.includes('parameter color'); }],
  ['const c = disclose(param) is possible', () => vaultSource.discloseAlias?.certain === false && vaultSource.discloseAlias.why.includes('parameter color')],
  ['NIGHT reached through a helper circuit', () => found(json([shapes]).j).deposit?.kinds === 'receive'],
  ['a helper that is not exported is not listed', () => found(json([shapes]).j).takeNight === undefined],
  ['unshieldedBalance(nativeToken()) is a balance use', () => found(json([shapes]).j).hasNight?.kinds === 'balance'],
  ['a custom token from tokenType() is not NIGHT', () => found(json([shapes]).j).custom === undefined],
  ['a helper that returns nativeToken() is NIGHT', () => vaultSource.depositViaHelper?.certain === true],
  ['a helper that returns tokenType() is not NIGHT', () => vaultSource.depositOwnViaTake === undefined],
  ['nativeToken() passed into a helper\'s parameter is NIGHT', () => vaultSource.depositNightViaTake?.certain === true && vaultSource.depositNightViaTake.kinds === 'receive'],
  ['a parameter passed on into a helper stays possible', () => vaultSource.depositAnyViaTake?.certain === false && vaultSource.depositAnyViaTake.why.includes('parameter color')],
  ['a send inside a helper', () => vaultSource.withdraw?.certain === true && vaultSource.withdraw.kinds === 'send'],
  ['a ledger field is possible, and named', () => vaultSource.payFee?.certain === false && vaultSource.payFee.why.includes('ledger field feeToken')],
  ['a witness is possible, and named', () => vaultSource.depositWitness?.certain === false && vaultSource.depositWitness.why.includes('witness payToken()')],
  ['const NIGHT = default<Bytes<32>> is NIGHT', () => vaultSource.depositConst?.certain === true],
  ['pad(32, "") is NIGHT', () => vaultSource.depositPad?.certain === true],
  ['a balance check on a helper\'s NIGHT', () => vaultSource.hasNight?.certain === true && vaultSource.hasNight.kinds === 'balance'],
  // Compact source: modules and imports
  ['import "Pay" is followed into Pay.compact', () => { const { code, j } = json([shop]); const f = found(j); return code === 2 && f.buy?.certain === true && f.buy.files === 'Pay.compact'; }],
  ['import with a prefix', () => found(json([shopPrefix]).j).buy?.certain === true],
  ['a module in the same file', () => { const { j } = json([shopInline]); const f = found(j); return f.buy?.certain === true && !f.takeNight && j.results[0].circuits === 1 && !j.results[0].unresolvedImports; }],
  ['a module file alone has no entry points', () => { const { code, j } = json([path.join(TMP, 'mod', 'Pay.compact')]); return code === 0 && j.results[0].circuits === 0; }],
  ['an import that isn\'t found is reported', () => { const { j } = json([shopMissing]); const r = text([shopMissing]); return JSON.stringify(j.results[0].unresolvedImports) === '["lib/Missing"]' && r.out.includes('not followed') && r.code === 3 && r.out.includes("isn't an all-clear"); }],
  ['a module circuit named like a top-level one, imported with a prefix', () => { const { code, j } = json([clash]); const f = found(j); return code === 2 && f.deposit?.certain === true && f.pay === undefined && j.results[0].circuits === 2 && !j.results[0].unresolvedImports; }],
  ['a generic module import, import "Pay"<Field>', () => { const { code, j } = json([shopGeneric]); return code === 2 && found(j).buy?.certain === true && !j.results[0].unresolvedImports; }],
  ['a name bound to NIGHT in one branch and a minted token in the other', () => { const { code, j } = json([branches]); return code === 2 && found(j).pay?.certain === true && found(j).pay.kinds === 'send'; }],
  ['an indented import inside a block comment is ignored', () => { const { code, j } = json([commentedImport]); return code === 0 && !j.results[0].unresolvedImports; }],
  ['an export list makes a circuit an entry point', () => { const { code, j } = json([exportList]); const f = found(j); return code === 2 && f.pay?.certain === true && j.results[0].circuits === 1; }],
  ['NIGHT in a struct field', () => found(json([moreShapes]).j).viaStruct?.certain === true],
  ['a pure helper that returns nativeToken()', () => found(json([moreShapes]).j).viaPureHelper?.certain === true],
  ['a typed const alias', () => found(json([moreShapes]).j).viaTypedAlias?.certain === true],
  ['include "file" adds its circuits as entry points', () => { const { j } = json([includer]); return found(j).tip?.certain === true && j.results[0].circuits === 1; }],
  // Compiled
  ['compiled: this._nativeToken_0() and new Uint8Array(32), directly and via a helper', () => {
    const { code, j } = json([path.join(TMP, 'compiled', 'managed', 'party')]);
    const f = found(j);
    return code === 2 && j.results[0].kind === 'compiled' && f.checkIn?.kinds === 'receive' && f.checkIn.certain && f.payOut?.kinds === 'send' && f.payOut.certain && !f.rsvp && f.anyToken?.certain === false && j.results[0].circuits === 4;
  }],
  ['compiled: index.js passed directly', () => json([compiled]).j.results[0].kind === 'compiled'],
  ['compiled: a helper that returns NIGHT, and NIGHT passed into a helper', () => vaultCompiled.depositViaHelper?.certain === true && vaultCompiled.depositNightViaTake?.certain === true],
  ['compiled: a const alias and a 32-zero array', () => vaultCompiled.depositConst?.certain === true && vaultCompiled.depositPad?.certain === true],
  ['compiled: a ledger read and a witness are possible', () => vaultCompiled.payFee?.certain === false && vaultCompiled.payFee.why.includes('a ledger field') && vaultCompiled.depositWitness?.certain === false && vaultCompiled.depositWitness.why.includes('witness payToken()')],
  ['compiled: a balance check through the standard library\'s helpers', () => vaultCompiled.hasNight?.certain === true && vaultCompiled.hasNight.kinds === 'balance'],
  ['compiled: each entry point is the method its circuits entry calls', () => { const { code, j } = json([path.join(TMP, 'compiled', 'managed', 'clash')]); const f = found(j); return code === 2 && f.deposit?.certain === true && f.pay === undefined; }],
  ['compiled: 0.34.0 and 0.35.0 output (async circuits, awaited calls)', () => { const { code, j } = json([path.join(TMP, 'compiled', 'managed', 'async')]); const f = found(j); return code === 2 && j.results[0].circuits === 3 && f.take?.certain === true && f.viaHelper?.certain === true && f.custom === undefined; }],
  ['compiled: circuits it can\'t read give exit 1, not an all-clear', () => { const r = text([path.join(TMP, 'compiled', 'managed', 'unknown')]); return r.code === 1 && r.err.includes("couldn't read the circuits"); }],
  ['compiled: names are the circuit names', () => json([compiledVault]).j.results[0].found.every((f) => !/_\d+$/.test(f.circuit))],
  // Files and directories
  ['a directory: finds the NIGHT file, not the compiled copy', () => {
    const { code, j } = json([path.join(TMP, 'dir')]);
    const files = j.results.map((r) => path.basename(r.file)).sort();
    return code === 2 && JSON.stringify(files) === '["clean.compact","night.compact"]' && j.results.find((r) => r.file.endsWith('night.compact')).found[0].circuit === 'pay';
  }],
  ['a project with a wrapper contract/index.js is scanned as source', () => {
    const { code, j } = json([path.join(TMP, 'wrapped')]);
    return code === 2 && j.results.length === 1 && j.results[0].kind === 'source' && j.results[0].found[0]?.circuit === 'pay';
  }],
  ['a .js file that is not compiled output: exit 1', () => {
    const r = text([path.join(TMP, 'wrapped', 'contract', 'index.js')]);
    return r.code === 1 && r.err.includes('not a compiled Compact contract');
  }],
  // Exit codes and text output
  ['text output exits 2 when NIGHT is certain', () => text([tt]).code === 2],
  ['only possible uses: exit 3, and the text says so', () => { const r = text([feeOnly]); return r.code === 3 && r.out.includes('1 may') && r.out.includes('only if its token type is NIGHT'); }],
  ['a contract with no NIGHT: exit 0', () => {
    const { code, out } = text([clean]);
    return code === 0 && out.includes('no NIGHT use found') && !out.includes('On Mainnet');
  }],
  ['text output names the Mainnet behaviour for each kind', () => {
    const { out } = text([pp]);
    return out.includes('Wallet.InsufficientFunds: Insufficient funds') && out.includes('Custom error: 194') && out.includes('reads 0, because the contract holds none') && out.includes('checkIn: receive') && out.includes('2 move NIGHT');
  }],
  ['text output links the runbook', () => text([tt]).out.includes('https://github.com/midnightntwrk/servicedesk/blob/main/runbooks/contract-native-night-mainnet-runbook/')],
  ['text output names the file of a use in an imported module', () => text([shop]).out.includes('line 4 of Pay.compact in Pay.takeNight')],
  // Errors
  ['error: JSON of err.cause with NIGHT\'s token type', () => { const { code, j } = json(['--error', ERR_RECEIVE_JSON]); return code === 2 && j.verdict === 'night' && j.tokenType === ZEROS; }],
  ['error: the same on preprod is not this runbook', () => { const { code, j } = json(['--error', ERR_RECEIVE_JSON, '--network', 'preprod']); return code === 0 && j.verdict === null && j.summary.includes('tNIGHT'); }],
  ['error: Insufficient funds of another token is not this runbook', () => { const { code, j } = json(['--error', ERR_OTHER_TOKEN_JSON]); return code === 0 && j.verdict === null && j.summary.includes('not NIGHT'); }],
  ['error: plain Insufficient funds could be, and asks for err.cause', () => { const { code, j } = json(['--error', ERR_RECEIVE]); return code === 3 && j.verdict === 'maybe' && j.summary.includes('JSON.stringify(err.cause'); }],
  ['error: plain Insufficient funds on preprod is not this runbook', () => { const { code, j } = json(['--error', ERR_RECEIVE, '--network', 'preprod']); return code === 0 && j.verdict === null; }],
  ['error: the shielded wallet\'s Insufficient funds is not this runbook', () => { const { code, j } = json(['--error', ERR_SHIELDED]); return code === 0 && j.verdict === null && j.summary.includes('shielded'); }],
  ['error: the advice for err.cause uses a bigint replacer', () => json(['--error', ERR_RECEIVE]).j.summary.includes("typeof v === 'bigint'")],
  ['error: the shielded wallet\'s fallible-segment message with 64 zeros is not NIGHT', () => { const { code, j } = json(['--error', ERR_RECEIVE_JSON.replace('"Insufficient funds"', '"Insufficient funds for fallible segment 1"')]); return code === 0 && j.verdict === null; }],
  ['error: 194 on preprod is not this runbook', () => { const { code, j } = json(['--error', ERR_SEND_RPC, '--network', 'preprod']); return code === 0 && j.verdict === null && j.summary.includes('preprod'); }],
  ['error: the decoder\'s 183 (Malformed.BalanceCheckOutOfBounds) is not 194', () => { const { code, j } = json(['--error', 'Custom error: 183 → Malformed.BalanceCheckOutOfBounds']); return code === 0 && j.verdict === null; }],
  ['error: the decoder\'s 194 line could be', () => json(['--error', 'Custom error: 194 → Invalid.BalanceCheckOutOfBounds']).code === 3],
  ['error: a DUST shortage is not this runbook', () => { const { code, j } = json(['--error', ERR_DUST]); return code === 0 && j.verdict === null && j.tokenType === 'dust' && j.next.includes('cnight-dust-duplicate'); }],
  ['error: the RPC-CORE line with 194 could be', () => { const { code, j } = json(['--error', ERR_SEND_RPC]); return code === 3 && j.verdict === 'maybe' && j.summary.includes('sends NIGHT'); }],
  ['error: SubmissionError without the code says where the code is', () => { const { code, j } = json(['--error', ERR_SEND_JS]); return code === 3 && j.summary.includes('RPC-CORE') && j.summary.includes('err.message'); }],
  ['error: another code is not this runbook', () => { const { code, j } = json(['--error', '1010: Invalid Transaction: Custom error: 182']); return code === 0 && j.verdict === null; }],
  ['error: unrelated text points to the lookup', () => { const r = text(['--error', 'ECONNREFUSED 127.0.0.1:6300']); return r.code === 0 && r.out.startsWith('Not this runbook') && r.out.includes('README.md#error-string-lookup') && !r.out.includes('Runbook:'); }],
  ['error: midnight-js 5 balanceTx message alone could be, names the circuit and asks for err.cause.message', () => { const { code, j } = json(['--error', ERR5_RECEIVE]); return code === 3 && j.circuit === 'receiveNightTokens' && j.summary.includes('err.cause.message') && j.summary.includes('NIGHT receive'); }],
  ['error: midnight-js 5 submitTx message alone could be, as a send', () => { const { code, j } = json(['--error', ERR5_SEND]); return code === 3 && j.circuit === 'sendNightTokensToUser' && j.summary.includes('Custom error: 194') && j.summary.includes('NIGHT send'); }],
  ['error: midnight-js 5 balanceTx with its cause is decided by the circuit', () => { const { code, j } = json(['--error', ERR5_RECEIVE_CAUSE]); return code === 3 && j.summary.includes("circuit decides") && !j.summary.includes('JSON.stringify'); }],
  ['error: midnight-js 5 submitTx with 194 in its causes is decided by the circuit', () => { const { code, j } = json(['--error', ERR5_SEND_CAUSE]); return code === 3 && j.summary.includes('194') && j.summary.includes("'sendNightTokensToUser'"); }],
  ['error: midnight-js 5 on preprod is not this runbook', () => { const { code, j } = json(['--error', ERR5_RECEIVE_CAUSE, '--network', 'preprod']); return code === 0 && j.verdict === null && j.summary.includes('tNIGHT'); }],
  ['error: midnight-js 5 proveTx is not this runbook', () => { const { code, j } = json(['--error', ERR5_RECEIVE.replace('balanceTx', 'proveTx')]); return code === 0 && j.verdict === null && j.summary.includes('Proving failed'); }],
  ['error: midnight-js 5 DUST shortage is still not this runbook', () => { const { code, j } = json(['--error', `${ERR5_RECEIVE}\nInsufficientFundsError: Wallet.InsufficientFunds: Insufficient Funds: could not balance dust`]); return code === 0 && j.tokenType === 'dust'; }],
  ['error: the err.cause advice says it prints {} on midnight-js 5', () => json(['--error', ERR_RECEIVE]).j.summary.includes('prints {}')],
  ['error: --error - reads stdin', () => { const { code, j } = json(['--error', '-'], ERR_RECEIVE_JSON); return code === 2 && j.verdict === 'night'; }],
  // As a module
  ['importing it doesn\'t run the command', () => { const r = spawnSync(process.execPath, ['--input-type=module', '-e', `import(${JSON.stringify(pathToFileURL(CHECK).href)}).then((m) => console.log(Object.keys(m).sort().join(',')))`], { encoding: 'utf8' }); return r.status === 0 && r.stdout.trim() === 'explainError,scanCompiled,scanSource,stripCode'; }],
  // Arguments
  ['no arguments: usage, exit 1', () => text([]).code === 1],
  ['unknown argument: exit 1', () => { const r = text(['--nope']); return r.code === 1 && r.err.includes('unknown argument'); }],
  ['missing path: exit 1', () => { const r = text([path.join(TMP, 'nope.compact')]); return r.code === 1 && r.err.includes('no such file'); }],
  ['paths and --error together: exit 1', () => text([tt, '--error', 'x']).code === 1],
  ['--network without --error, or a bad value: exit 1', () => text([tt, '--network', 'mainnet']).code === 1 && text(['--error', 'x', '--network', 'moon']).code === 1],
];

let failed = 0;
for (const [name, fn] of cases) {
  let ok = false;
  try { ok = fn(); } catch (e) { console.log(`  ${e.message}`); }
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`);
}
fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${cases.length - failed} of ${cases.length} passed`);
process.exit(failed ? 1 : 0);
