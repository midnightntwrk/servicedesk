// batch-deploy.ts — deploy a Compact contract whose verifier keys don't fit in one block.
//
// Strategy (see ../contract-batched-deploy-runbook.md):
//   1. Deploy the contract with only as many circuits' verifier keys as fit in a block budget.
//   2. Insert each remaining verifier key with a maintenance update (submitInsertVerifierKeyTx),
//      one tx at a time, signed by the contract maintenance authority (CMA) key.
//   3. Resumable: re-run with `contractAddress` and it inserts only the keys still missing on chain.
//
// WHERE THIS FILE GOES: copy it into the DApp repo that already builds `ContractProviders` for the
// contract (e.g. next to the code that calls `deployContract`). It only imports published
// @midnight-ntwrk packages, so no relative imports need fixing. Written against midnight-js 4.1.1
// (@midnight-ntwrk/midnight-js-contracts / -types / -protocol / -network-id / -utils @ 4.1.1).
//
// SAFETY: defaults to a dry run (prints the plan, submits nothing). Pass `execute: true` to submit.
// Keys are read only through YOUR local providers; nothing private is logged. The CMA signing key
// is persisted to your private state provider BEFORE the deploy is submitted — back it up: without
// it the remaining circuits can never be added.

import {
  type ContractProviders,
  createUnprovenDeployTx,
  DeployTxFailedError,
  type DeployTxOptionsBase,
  type DeployTxOptionsWithPrivateState,
  submitInsertVerifierKeyTx,
  submitTx
} from '@midnight-ntwrk/midnight-js-contracts';
import { type CompiledContract, ContractExecutable } from '@midnight-ntwrk/midnight-js-protocol/compact-js';
import type { Contract } from '@midnight-ntwrk/midnight-js-protocol/compact-js/effect/Contract';
import { sampleSigningKey, type SigningKey } from '@midnight-ntwrk/midnight-js-protocol/compact-runtime';
import {
  type ContractAddress,
  ContractDeploy,
  ContractState as LedgerContractState,
  LedgerParameters,
  type SyntheticCost,
  type UnprovenTransaction
} from '@midnight-ntwrk/midnight-js-protocol/ledger';
import { type PrivateStateId, SucceedEntirely, type VerifierKey } from '@midnight-ntwrk/midnight-js-types';

/** Network limits the plan is checked against. Defaults: mainnet, midnight-node res/mainnet/ledger-parameters-config.json (2026-09-29). */
export type BlockBudget = {
  readonly transactionByteLimit: bigint;
  readonly block: SyntheticCost;
  /**
   * Fraction of each block limit a single (unbalanced) tx may use. Default 0.6. A tx is weighted by its
   * largest normalized cost dimension, and normal txs only get 75% of block weight (midnight-node
   * NORMAL_DISPATCH_RATIO), minus on-initialize/inherent weight. Measured on node 0.22.1: 62.6% of
   * bytesWritten was included, 68.1% was rejected with 1010 "Transaction would exhaust the block limits".
   */
  readonly headroom: number;
};

export const MAINNET_BUDGET: BlockBudget = {
  transactionByteLimit: 1_048_576n,
  block: {
    readTime: 2_000_000_000_000n,
    computeTime: 2_000_000_000_000n,
    blockUsage: 1_000_000n,
    bytesWritten: 50_000n,
    bytesChurned: 50_000_000n
  },
  headroom: 0.6
};

export type BatchDeployOptions<C extends Contract.Any> = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly compiledContract: CompiledContract.CompiledContract<C, any>;
  /** Constructor arguments, exactly as you would pass them to deployContract. */
  readonly args?: Contract.InitializeParameters<C>;
  /** For contracts with private state: stored under `privateStateId` after the deploy succeeds. */
  readonly privateStateId?: PrivateStateId;
  readonly initialPrivateState?: Contract.PrivateState<C>;
  /** CMA signing key. If omitted a fresh one is sampled (as deployContract does). */
  readonly signingKey?: SigningKey;
  /** Circuits to put in the initial deploy first (e.g. admin/pause circuits). Others follow in compiled order. */
  readonly priorityCircuits?: readonly string[];
  /** Resume: address of a contract already deployed by a previous run. Skips the deploy step. */
  readonly contractAddress?: ContractAddress;
  readonly budget?: BlockBudget;
  /** false (default) = dry run: build and price the txs, print the plan, submit nothing. */
  readonly execute?: boolean;
  readonly log?: (line: string) => void;
};

export type BatchDeployResult = {
  readonly contractAddress: ContractAddress | undefined;
  /** Circuits carried by the initial deploy (empty when resuming). */
  readonly deployed: readonly string[];
  /** Circuits inserted by this run (or that would be, in a dry run). */
  readonly inserted: readonly string[];
  /** Circuits already on chain when this run started (resume). */
  readonly alreadyOnChain: readonly string[];
  readonly executed: boolean;
};

const overBudget = (tx: UnprovenTransaction, budget: BlockBudget): string[] => {
  const factor = BigInt(Math.round(budget.headroom * 1000));
  const scaled = (v: bigint) => (v * factor) / 1000n;
  const bad: string[] = [];
  const bytes = BigInt(tx.serialize().length);
  if (bytes > scaled(budget.transactionByteLimit)) bad.push(`txBytes ${bytes} > ${scaled(budget.transactionByteLimit)}`);
  const cost = tx.cost(LedgerParameters.initialParameters());
  for (const k of Object.keys(budget.block) as (keyof SyntheticCost)[]) {
    if (cost[k] > scaled(budget.block[k])) bad.push(`${k} ${cost[k]} > ${scaled(budget.block[k])}`);
  }
  return bad;
};

/**
 * Rewrites the (unproven, unbound) deploy tx in place so its ContractDeploy carries only the `keep`
 * operations of `original` (the full constructor state). Everything else — ledger data from the constructor, maintenance authority, balance,
 * Zswap offers — is preserved. Returns the new contract address (the deploy nonce is re-sampled).
 */
export const deployIn = (tx: UnprovenTransaction) => {
  const intents = tx.intents;
  if (!intents || intents.size !== 1) throw new Error('expected exactly one intent in the deploy tx');
  const [[segment, intent]] = [...intents.entries()];
  const idx = intent.actions.findIndex((a) => a instanceof ContractDeploy);
  if (idx < 0) throw new Error('no ContractDeploy action in the deploy tx');
  return { segment, intent, idx, state: (intent.actions[idx] as ContractDeploy).initialState };
};

export const restrictDeployTo = (
  tx: UnprovenTransaction,
  original: LedgerContractState,
  keep: readonly string[]
): ContractAddress => {
  const { segment, intent, idx } = deployIn(tx);

  const trimmed = new LedgerContractState();
  trimmed.data = original.data;
  trimmed.maintenanceAuthority = original.maintenanceAuthority;
  trimmed.balance = original.balance;
  for (const id of keep) {
    const op = original.operation(id);
    if (!op) throw new Error(`circuit '${id}' missing from constructor state`);
    trimmed.setOperation(id, op);
  }
  const deploy = new ContractDeploy(trimmed);
  const actions = [...intent.actions];
  actions[idx] = deploy;
  intent.actions = actions;
  tx.intents = new Map([[segment, intent]]); // re-computes binding: tx is unproven and unbound
  return deploy.address;
};

export async function batchDeploy<C extends Contract.Any>(
  providers: ContractProviders<C>,
  options: BatchDeployOptions<C>
): Promise<BatchDeployResult> {
  const log = options.log ?? ((l: string) => console.log(l));
  const budget = options.budget ?? MAINNET_BUDGET;
  const execute = options.execute ?? false;
  const mode = execute ? 'EXECUTE' : 'DRY RUN';

  const circuitIds = ContractExecutable.make(options.compiledContract).getProvableCircuitIds() as string[];
  const vkEntries = await providers.zkConfigProvider.getVerifierKeys(circuitIds as Contract.ProvableCircuitId<C>[]);
  const vks = new Map<string, VerifierKey>(vkEntries.map(([id, vk]) => [id as string, vk]));
  const priority = (options.priorityCircuits ?? []).filter((id) => {
    if (!vks.has(id)) throw new Error(`priorityCircuits: '${id}' is not a provable circuit of this contract`);
    return true;
  });
  const ordered = [...priority, ...circuitIds.filter((id) => !priority.includes(id))];
  log(`[${mode}] ${ordered.length} provable circuits, ${[...vks.values()].reduce((a, v) => a + v.length, 0)} verifier-key bytes`);

  let contractAddress = options.contractAddress;
  let deployed: string[] = [];

  if (contractAddress === undefined) {
    const signingKey = options.signingKey ?? sampleSigningKey();
    const deployOptions =
      options.initialPrivateState !== undefined
        ? ({ compiledContract: options.compiledContract, args: options.args, signingKey, initialPrivateState: options.initialPrivateState } as unknown as DeployTxOptionsWithPrivateState<C>)
        : ({ compiledContract: options.compiledContract, args: options.args, signingKey } as unknown as DeployTxOptionsBase<C>);
    // Runs the constructor locally and builds the full deploy tx (every verifier key) — not submitted.
    const unsubmitted = await createUnprovenDeployTx(providers, deployOptions);
    const tx = unsubmitted.private.unprovenTx;
    const fullState = deployIn(tx).state;

    // Greedy: add circuits in order while the deploy stays within budget.
    let fit = 0;
    let lastBad: string[] = [];
    while (fit < ordered.length) {
      restrictDeployTo(tx, fullState, ordered.slice(0, fit + 1));
      lastBad = overBudget(tx, budget);
      if (lastBad.length > 0) break;
      fit++;
    }
    if (fit === 0) throw new Error(`even a deploy with one circuit exceeds the budget: ${lastBad.join('; ')}`);
    deployed = ordered.slice(0, fit);
    contractAddress = restrictDeployTo(tx, fullState, deployed);
    log(`[${mode}] batch 1 (deploy): ${deployed.length} circuits: ${deployed.join(', ')}`);
    if (fit < ordered.length) log(`[${mode}]   stopped at '${ordered[fit]}': would exceed ${lastBad.join('; ')}`);

    if (execute) {
      const pds = providers.privateStateProvider;
      // Persist the CMA key under the (already known) address BEFORE submitting, so a crash after
      // the deploy lands cannot orphan the contract. Harmless if the deploy then fails.
      pds.setContractAddress(contractAddress);
      await pds.setSigningKey(contractAddress, unsubmitted.private.signingKey);
      log(`[${mode}] contract address: ${contractAddress}  (CMA key stored; re-run with contractAddress to resume)`);
      const finalized = await submitTx(providers, { unprovenTx: tx });
      if (finalized.status !== SucceedEntirely) throw new DeployTxFailedError(finalized);
      if (options.privateStateId !== undefined) {
        await pds.set(options.privateStateId, unsubmitted.private.initialPrivateState);
      }
      log(`[${mode}] batch 1 finalized in block ${finalized.blockHeight} (tx ${finalized.txId})`);
    } else {
      log(`[${mode}] contract address would be ${contractAddress} (re-sampled on a real run)`);
    }
  }

  // Resume / insert phase: diff compiled circuits against what is on chain.
  let alreadyOnChain: string[] = [];
  if (options.contractAddress !== undefined) {
    const state = await providers.publicDataProvider.queryContractState(options.contractAddress);
    if (!state) throw new Error(`no contract state on chain at ${options.contractAddress}`);
    const onChain = new Set(state.operations().map(String));
    for (const id of onChain) {
      const local = vks.get(id);
      const remote = state.operation(id)?.verifierKey;
      if (local && remote && Buffer.compare(Buffer.from(local), Buffer.from(remote)) !== 0) {
        throw new Error(`circuit '${id}' is on chain with a DIFFERENT verifier key — recompiled? Stop and see the runbook.`);
      }
    }
    alreadyOnChain = ordered.filter((id) => onChain.has(id));
    providers.privateStateProvider.setContractAddress(options.contractAddress);
    const sk = await providers.privateStateProvider.getSigningKey(options.contractAddress);
    if (!sk) throw new Error(`no CMA signing key stored locally for ${options.contractAddress} — cannot insert keys`);
    log(`[${mode}] resuming ${options.contractAddress}: ${alreadyOnChain.length}/${ordered.length} circuits already on chain`);
  }
  const done = new Set([...deployed, ...alreadyOnChain]);
  const toInsert = ordered.filter((id) => !done.has(id));
  log(`[${mode}] batches 2..${toInsert.length + 1}: ${toInsert.length} verifier-key insert txs (one circuit each, sequential)`);

  const inserted: string[] = [];
  if (execute) {
    for (const id of toInsert) {
      // Re-check on chain before each insert so an interrupted run can simply be re-run.
      const state = await providers.publicDataProvider.queryContractState(contractAddress);
      if (state?.operation(id)) {
        log(`  = ${id} already on chain, skipping`);
        continue;
      }
      const res = await submitInsertVerifierKeyTx(
        providers,
        options.compiledContract,
        contractAddress,
        id as Contract.ProvableCircuitId<C>,
        vks.get(id)!
      );
      inserted.push(id);
      log(`  + ${id} inserted (block ${res.blockHeight}) [${inserted.length}/${toInsert.length}]`);
    }
    log(`[${mode}] done. All ${ordered.length} circuits have verifier keys; findDeployedContract() will now succeed.`);
  } else {
    for (const id of toInsert) log(`  would insert ${id}`);
    inserted.push(...toInsert);
  }

  return { contractAddress, deployed, inserted, alreadyOnChain, executed: execute };
}
