// no-night.test.ts: what token-transfers' NIGHT circuits do for a wallet that has DUST but no NIGHT,
// the position of a Mainnet wallet funded through cNIGHT. It's the experiment behind the
// contract-native-night-mainnet runbook (results in check-night-usage.NOTES.md).
//
// Where it goes: midnight-examples, examples/token-transfers/src/test/no-night.test.ts (its imports are
// relative to that folder). It runs on the example's local network only, never on a public one.
//
//   cd examples/token-transfers
//   compact compile +0.31.1 contract/token-transfers.compact contract/managed/token-transfers
//   npm run env:up
//   NODE_OPTIONS='--experimental-vm-modules' MIDNIGHT_NETWORK=local npx vitest run src/test/no-night.test.ts
//
// Alice (a genesis seed) has NIGHT and deploys. Dave (a non-genesis seed) gets DUST without NIGHT: a
// sponsor wallet receives NIGHT from Alice and registers it for DUST generation with Dave's DUST
// address as the receiver. Every outcome is written to NO_NIGHT_RESULTS (a JSON file, default
// no-night-results.json).

import { describe, it, beforeAll, afterAll } from 'vitest';
import { WebSocket } from 'ws';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { deployContract, submitCallTx, type DeployedContract } from '@midnight-ntwrk/midnight-js-contracts';
import { type ContractAddress, encodeUserAddress } from '@midnight-ntwrk/midnight-js-protocol/compact-runtime';
import { nativeToken } from '@midnight-ntwrk/midnight-js-protocol/ledger';
import { type EnvironmentConfiguration } from '@midnight-ntwrk/testkit-js';
import { firstValueFrom } from 'rxjs';
import * as Rx from 'rxjs';
import pino from 'pino';
import { getConfig } from '../config.js';
import { MidnightWalletProvider, syncWallet } from '../wallet.js';
import { LOCAL_SEEDS, assembleWallet, registerNightForDust, transferNight } from '@midnight-ntwrk/example-fast-sync';
import { buildProviders, type TokenTransfersProviders } from '../providers.js';
import { CompiledTokenTransfersContract, Contract, zkConfigPath } from '../../contract/index.js';

// @ts-expect-error WebSocket global assignment for apollo
globalThis.WebSocket = WebSocket;

const logger = pino({ level: process.env['LOG_LEVEL'] ?? 'info', transport: { target: 'pino-pretty' } });
const STAR = 1_000_000n;
const NIGHT = nativeToken().raw;
const STATE_ID = 'NoNightState';
const results: Record<string, unknown> = { startedAt: new Date().toISOString() };
const out = process.env['NO_NIGHT_RESULTS'] ?? 'no-night-results.json';
const save = () => writeFileSync(out, JSON.stringify(results, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));

function describeError(e: unknown) {
  const err = e as { name?: string; message?: string; cause?: unknown; constructor?: { name?: string } };
  const cause = err?.cause as { name?: string; message?: string } | undefined;
  return {
    class: err?.constructor?.name,
    name: err?.name,
    message: err?.message,
    string: String(e),
    cause: cause ? { name: cause.name, message: cause.message, string: String(cause) } : undefined,
  };
}

describe('NIGHT circuits with DUST but no NIGHT', () => {
  const config = getConfig();
  let alice: MidnightWalletProvider;
  let dave: MidnightWalletProvider;
  let aliceP: TokenTransfersProviders;
  let daveP: TokenTransfersProviders;
  let contractAddress: ContractAddress;

  const env: EnvironmentConfiguration = {
    walletNetworkId: config.networkId,
    networkId: config.networkId,
    indexer: config.indexer,
    indexerWS: config.indexerWS,
    node: config.node,
    nodeWS: config.nodeWS,
    faucet: config.faucet,
    proofServer: config.proofServer,
  };

  async function balances(w: MidnightWalletProvider) {
    const s = await firstValueFrom(w.wallet.state());
    const night = BigInt(((s.unshielded.balances ?? {}) as Record<string, bigint>)[NIGHT] ?? 0n);
    const dust = BigInt(s.dust.balance(new Date()) as unknown as bigint);
    return { night, dust };
  }

  async function attempt(label: string, who: MidnightWalletProvider, p: TokenTransfersProviders, circuitId: string, args: unknown[]) {
    const before = await balances(who);
    const t0 = Date.now();
    let outcome: Record<string, unknown>;
    try {
      const res = await (submitCallTx as any)(p, { compiledContract: CompiledTokenTransfersContract, contractAddress, privateStateId: STATE_ID, circuitId, args });
      outcome = { ok: true, status: res.public?.status, txId: res.public?.txId, txHash: res.public?.txHash, blockHeight: res.public?.blockHeight };
    } catch (e) {
      outcome = { ok: false, error: describeError(e) };
    }
    await new Promise((r) => setTimeout(r, 8000)); // let the wallet see the result
    const after = await balances(who);
    results[label] = { circuitId, args, ms: Date.now() - t0, before, after, ...outcome };
    logger.info(`${label}: ${JSON.stringify(results[label], (_k, v) => (typeof v === 'bigint' ? v.toString() : v))}`);
    save();
  }

  beforeAll(async () => {
    if (config.networkId !== 'undeployed') throw new Error('no-night.test.ts runs only on the local network (MIDNIGHT_NETWORK=local)');
    setNetworkId(config.networkId);

    // 1. Give Dave DUST without NIGHT, the way `yarn fund:wallet` does.
    const strictlyComplete = (p: unknown) => typeof (p as any)?.isStrictlyComplete === 'function' && (p as any).isStrictlyComplete();
    const open = async (seed: string) => {
      const w = await assembleWallet(logger, env, { kind: 'seed', value: seed });
      await w.facade.start(w.zswapSecretKeys, w.dustSecretKey);
      await firstValueFrom(w.facade.state().pipe(Rx.filter((s: any) => strictlyComplete(s.shielded.state.progress) && strictlyComplete(s.unshielded.progress) && strictlyComplete(s.dust.state.progress)), Rx.take(1)));
      return w;
    };
    const genesis = await open(LOCAL_SEEDS.ALICE);
    const sponsor = await open(createHash('sha256').update('no-night experiment sponsor').digest('hex'));
    const daveW = await open(LOCAL_SEEDS.DAVE);
    const daveDust = await daveW.facade.dust.getAddress();
    const sponsorAddr = await sponsor.facade.unshielded.getAddress();
    results.fundNightToSponsor = await transferNight(genesis, sponsorAddr, 100_000n * STAR);
    await firstValueFrom(sponsor.facade.state().pipe(Rx.filter((s: any) => s.unshielded.availableCoins.some((c: any) => c.utxo.type === NIGHT)), Rx.take(1)));
    results.registerSponsorNightForDave = await registerNightForDust(sponsor, daveDust);
    for (const w of [genesis, sponsor, daveW]) await w.facade.stop().catch(() => undefined);
    save();

    // 2. The two wallets the calls use.
    alice = await MidnightWalletProvider.build(logger, env, { kind: 'seed', value: LOCAL_SEEDS.ALICE }, {});
    dave = await MidnightWalletProvider.build(logger, env, { kind: 'seed', value: LOCAL_SEEDS.DAVE }, {});
    await alice.start();
    await dave.start();
    await syncWallet(logger, alice.wallet, 10 * 60_000);
    await syncWallet(logger, dave.wallet, 10 * 60_000);

    // Wait until Dave has some DUST to pay fees with.
    const t0 = Date.now();
    while ((await balances(dave)).dust === 0n && Date.now() - t0 < 10 * 60_000) await new Promise((r) => setTimeout(r, 5000));
    results.daveAtStart = await balances(dave);
    results.aliceAtStart = await balances(alice);
    save();

    aliceP = buildProviders(alice, zkConfigPath, config);
    daveP = buildProviders(dave, zkConfigPath, config);
  });

  afterAll(async () => {
    results.finishedAt = new Date().toISOString();
    save();
    await alice?.stop().catch(() => undefined);
    await dave?.stop().catch(() => undefined);
  });

  it('deploys token-transfers as Alice', async () => {
    const deployed: DeployedContract<Contract> = await (deployContract<Contract>)(aliceP, {
      compiledContract: CompiledTokenTransfersContract,
      privateStateId: STATE_ID,
      initialPrivateState: {},
    });
    contractAddress = deployed.deployTxData.public.contractAddress;
    results.contractAddress = contractAddress;
    save();
    // Dave calls a contract Alice deployed: give Dave's private-state store the (empty) state.
    (daveP.privateStateProvider as any).setContractAddress(contractAddress);
    await daveP.privateStateProvider.set(STATE_ID, {} as never);
  });

  const userAddr = (w: MidnightWalletProvider) => ({ bytes: encodeUserAddress(w.unshieldedKeystore.getAddress()) });

  it('Dave (DUST, no NIGHT) calls receiveNightTokens', async () => {
    await attempt('daveReceiveNight', dave, daveP, 'receiveNightTokens', [5_000n]);
  });

  it('Dave calls sendNightTokensToUser on a contract that holds no NIGHT', async () => {
    await attempt('daveSendNightFromEmptyContract', dave, daveP, 'sendNightTokensToUser', [2_000n, userAddr(dave)]);
  });

  it('Alice (has NIGHT) calls sendNightTokensToUser on a contract that holds no NIGHT', async () => {
    await attempt('aliceSendNightFromEmptyContract', alice, aliceP, 'sendNightTokensToUser', [2_000n, userAddr(alice)]);
  });

  it('control: Alice calls receiveNightTokens', async () => {
    await attempt('aliceReceiveNight', alice, aliceP, 'receiveNightTokens', [5_000n]);
  });

  it('control: Dave calls sendNightTokensToUser once the contract holds NIGHT', async () => {
    await attempt('daveSendNightFromFundedContract', dave, daveP, 'sendNightTokensToUser', [2_000n, userAddr(dave)]);
  });
});
