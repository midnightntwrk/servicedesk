#!/usr/bin/env node
/**
 * test-watch-sync.mjs: runs watch-sync.ts against a fake wallet whose positions the test moves, so it
 * needs no network and no install. Node >= 22.18 (it imports the .ts file with Node's built-in type
 * stripping; watch-sync.ts only imports types from the wallet SDK).
 *
 *   node test-watch-sync.mjs
 *
 * Time is scaled down: a 40 ms tick stands for 30 s and a 200 ms stall threshold for 10 minutes.
 * Exit code 0 when every case passes.
 */
import { watchSync } from './watch-sync.ts';

const TICK = 40;
const STALL = 200;

// A sub-wallet's progress, as wallet SDK 2.x exposes it.
const progress = (applied, target, synced) => ({
  appliedIndex: applied,
  highestRelevantWalletIndex: target,
  isStrictlyComplete: () => synced,
});
const unshieldedProgress = (applied, target, synced) => ({
  appliedId: applied,
  highestTransactionId: target,
  isStrictlyComplete: () => synced,
});

// A wallet whose state() emits whatever the test last set.
function fakeWallet(initial) {
  let current = initial;
  const listeners = new Set();
  return {
    set(next) {
      current = next;
      for (const l of listeners) l(current);
    },
    state: () => ({
      subscribe(listener) {
        listeners.add(listener);
        listener(current);
        return { unsubscribe: () => listeners.delete(listener) };
      },
    }),
  };
}
const facadeState = ({ dust, shielded, unshielded = unshieldedProgress(0n, 0n, true), protocol = { _tag: 'Settled', version: 2001100n } }) => ({
  protocol,
  isSynced: dust.isStrictlyComplete() && shielded.isStrictlyComplete() && unshielded.isStrictlyComplete(),
  dust: { progress: dust },
  shielded: { progress: shielded },
  unshielded: { progress: unshielded },
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Blocks the event loop, as a suspended process (a laptop asleep) would.
const freeze = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

async function run(name, scenario, check) {
  const lines = [];
  const logger = { info: (m) => lines.push(`INFO ${m}`), warn: (m) => lines.push(`WARN ${m}`) };
  await scenario(logger);
  const problems = check(lines);
  if (problems.length) {
    console.log(`FAIL  ${name}\n      ${problems.join('\n      ')}\n${lines.map((l) => `      | ${l}`).join('\n')}`);
    return false;
  }
  console.log(`ok    ${name}`);
  return true;
}
const expectSome = (lines, re, label) => (lines.some((l) => re.test(l)) ? [] : [`no line matching ${label ?? re}`]);
const expectNone = (lines, re, label) => (lines.some((l) => re.test(l)) ? [`unexpected line matching ${label ?? re}`] : []);

const results = [];

// DUST stuck far behind while shielded keeps moving with new blocks: the case the first version missed.
results.push(
  await run(
    'DUST stuck while shielded keeps moving',
    async (logger) => {
      let shielded = 1_651_000n;
      const wallet = fakeWallet(facadeState({ dust: progress(57_212n, 1_651_660n, false), shielded: progress(shielded, shielded, true) }));
      const stop = watchSync(wallet, { everyMs: TICK, stallMs: STALL, logger });
      for (let i = 0; i < 10; i++) {
        await sleep(TICK);
        shielded += 8n;
        wallet.set(facadeState({ dust: progress(57_212n, 1_651_660n, false), shielded: progress(shielded, shielded, true) }));
      }
      stop();
    },
    (lines) => [
      ...expectSome(lines, /^WARN sync: dust has not moved for \d+ min \(at 57212 of 1651660\)\. This is a stall, not a slow sync/),
      ...expectNone(lines, /^WARN .*shielded has not moved/, 'a warning about shielded'),
    ],
  ),
);

// A slow sync that keeps moving never warns, and the line reports rate and time left.
results.push(
  await run(
    'slow but moving',
    async (logger) => {
      let dust = 45_693n;
      const wallet = fakeWallet(facadeState({ dust: progress(dust, 1_651_660n, false), shielded: progress(1_650_108n, 1_650_108n, true) }));
      const stop = watchSync(wallet, { everyMs: TICK, stallMs: STALL, logger });
      for (let i = 0; i < 10; i++) {
        await sleep(TICK);
        dust += 1_000n;
        wallet.set(facadeState({ dust: progress(dust, 1_651_660n, false), shielded: progress(1_650_108n, 1_650_108n, true) }));
      }
      stop();
    },
    (lines) => [
      ...expectNone(lines, /^WARN/, 'a warning'),
      ...expectSome(lines, /^INFO sync: dust \d+\/1651660 at \d+\/s, about \d+ min left \| shielded 1650108\/1650108 at 0\/s \| unshielded 0\/0 at 0\/s$/),
    ],
  ),
);

// Synced sub-wallets that don't move (no new events) are not a stall.
results.push(
  await run(
    'everything synced and idle',
    async (logger) => {
      const wallet = fakeWallet(facadeState({ dust: progress(1_651_660n, 1_651_660n, true), shielded: progress(1_651_659n, 1_651_659n, true) }));
      const stop = watchSync(wallet, { everyMs: TICK, stallMs: STALL, logger });
      await sleep(TICK * 8);
      stop();
    },
    (lines) => [...expectSome(lines, /^INFO sync: complete/), ...expectNone(lines, /^WARN/, 'a warning')],
  ),
);

// No event received yet: not complete, so 10 minutes of nothing is a stall too.
results.push(
  await run(
    'nothing received at all',
    async (logger) => {
      const wallet = fakeWallet(facadeState({ dust: progress(0n, 0n, false), shielded: progress(0n, 0n, false), unshielded: unshieldedProgress(0n, 0n, false) }));
      const stop = watchSync(wallet, { everyMs: TICK, stallMs: STALL, logger });
      await sleep(TICK * 8);
      stop();
    },
    (lines) => expectSome(lines, /^WARN sync: dust has not moved for \d+ min \(at 0 of 0\), shielded has not moved .*, unshielded has not moved/),
  ),
);

// A suspended process: the time asleep isn't counted, it says so, and the stall clock starts again.
results.push(
  await run(
    'process suspended (laptop asleep)',
    async (logger) => {
      const wallet = fakeWallet(facadeState({ dust: progress(57_212n, 1_651_660n, false), shielded: progress(1_651_000n, 1_651_000n, true) }));
      const stop = watchSync(wallet, { everyMs: TICK, stallMs: STALL, logger });
      await sleep(TICK * 2);
      freeze(STALL * 2); // asleep for longer than the stall threshold
      await sleep(TICK * 2); // the tick right after waking
      stop();
    },
    (lines) => [
      ...expectSome(lines, /^INFO sync: this process was paused for \d+ min \(asleep\?\); watching again from here$/),
      ...expectNone(lines, /^WARN/, 'a warning right after waking'),
    ],
  ),
);

// After waking, a sync that still doesn't move is reported once the threshold passes again.
results.push(
  await run(
    'still stuck after waking',
    async (logger) => {
      const wallet = fakeWallet(facadeState({ dust: progress(45_693n, 1_650_046n, false), shielded: progress(1_650_108n, 1_650_108n, true) }));
      const stop = watchSync(wallet, { everyMs: TICK, stallMs: STALL, logger });
      await sleep(TICK * 2);
      freeze(STALL * 2);
      await sleep(TICK + STALL + TICK * 2);
      stop();
    },
    (lines) => {
      const woke = lines.findIndex((l) => /paused for/.test(l));
      const warned = lines.findIndex((l) => /^WARN sync: dust has not moved/.test(l));
      return woke === -1 ? ['no wake-up line'] : warned > woke ? [] : ['no warning after the wake-up line'];
    },
  ),
);

// Stuck through repeated sleeps, each shorter awake stretch below the threshold: awake time adds up across
// the sleeps, so the stall is still reported (a reset on every wake-up would never warn here).
results.push(
  await run(
    'stuck through repeated sleeps',
    async (logger) => {
      const wallet = fakeWallet(facadeState({ dust: progress(45_693n, 1_650_046n, false), shielded: progress(1_650_108n, 1_650_108n, true) }));
      const stop = watchSync(wallet, { everyMs: TICK, stallMs: STALL, logger });
      for (let i = 0; i < 3; i++) {
        await sleep(TICK * 4); // awake for less than the stall threshold
        freeze(STALL); // asleep
      }
      await sleep(TICK * 3);
      stop();
    },
    (lines) => [
      ...expectSome(lines, /^INFO sync: this process was paused/),
      ...expectSome(lines, /^WARN sync: dust has not moved for \d+ min \(at 45693 of 1650046\)/),
    ],
  ),
);

// Complete, but the facade never settles: the eventless DUST sync on wallet SDK 2.0.0 reported protocol 0.
results.push(
  await run(
    'complete but still crossing',
    async (logger) => {
      const crossing = { _tag: 'Crossing', from: 0n, to: 2001100n, behind: ['dust'] };
      const wallet = fakeWallet(facadeState({ dust: progress(3_410_026n, 3_410_026n, true), shielded: progress(1_651_659n, 1_651_659n, true), protocol: crossing }));
      const stop = watchSync(wallet, { everyMs: TICK, stallMs: STALL, logger });
      await sleep(TICK * 4);
      stop();
    },
    (lines) => [
      ...expectSome(lines, /^WARN sync: all three sub-wallets are complete, but the facade is still crossing from protocol 0 to 2001100 \(behind: dust\)/),
      ...expectNone(lines, /^INFO sync: complete/, 'a "complete" line'),
    ],
  ),
);

// stop() ends the logging.
results.push(
  await run(
    'stop() ends the logging',
    async (logger) => {
      const wallet = fakeWallet(facadeState({ dust: progress(1n, 10n, false), shielded: progress(1n, 1n, true) }));
      const stop = watchSync(wallet, { everyMs: TICK, stallMs: STALL, logger });
      await sleep(TICK * 2.5);
      stop();
      logger.info('-- stopped --');
      await sleep(TICK * 4);
    },
    (lines) => (lines.at(-1) === 'INFO -- stopped --' ? [] : ['logged after stop()']),
  ),
);

const failed = results.filter((ok) => !ok).length;
console.log(failed ? `\n${failed} of ${results.length} cases failed` : `\nall ${results.length} cases passed`);
process.exit(failed ? 1 : 0);
