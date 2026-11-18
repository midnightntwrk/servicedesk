/**
 * watch-sync.ts: log a wallet's sync position while it syncs, so a slow sync can be told apart from a
 * stuck one. Copy it into your app and call it right after `wallet.start(...)`:
 *
 *   const stop = watchSync(wallet);
 *   const state = await wallet.waitForSyncedState();
 *   stop();
 *
 * Every 30 s it prints one line per sub-wallet: events applied out of the newest event the indexer
 * reported, the rate since the last line, and the time left at that rate. If a sub-wallet that isn't
 * synced yet doesn't move for 10 minutes, it prints a warning instead: that sync is stuck, not slow.
 * Each sub-wallet is watched on its own, because a shielded wallet at the tip keeps moving with every
 * new block while DUST can be stuck far behind. Time the process spends suspended (a laptop asleep)
 * isn't counted: after a wake-up it says so, and only awake time adds up towards the 10 minutes.
 *
 * When all three are complete but the facade's `protocol` is still `Crossing` (the wallets disagree on
 * the protocol version), it warns instead of reporting the sync complete: nothing can be built until
 * the facade settles, and a DUST wallet that never reports a version keeps it crossing for good.
 *
 * It only reads `progress` and `protocol`, which the wallet SDK 2.x facade state exposes. Nothing is
 * sent, signed or stored. Plain `console`; pass your own logger if you have one.
 */
import type { WalletFacade } from '@midnightntwrk/wallet-sdk';

type FacadeState = Awaited<ReturnType<WalletFacade['waitForSyncedState']>>;
type Logger = { info: (msg: string) => void; warn: (msg: string) => void };
type Position = { applied: bigint; target: bigint; synced: boolean };

const NAMES = ['dust', 'shielded', 'unshielded'] as const;
type Name = (typeof NAMES)[number];

const positions = (state: FacadeState): Record<Name, Position> => ({
  dust: {
    applied: state.dust.progress.appliedIndex,
    target: state.dust.progress.highestRelevantWalletIndex,
    synced: state.dust.progress.isStrictlyComplete(),
  },
  shielded: {
    applied: state.shielded.progress.appliedIndex,
    target: state.shielded.progress.highestRelevantWalletIndex,
    synced: state.shielded.progress.isStrictlyComplete(),
  },
  unshielded: {
    applied: state.unshielded.progress.appliedId,
    target: state.unshielded.progress.highestTransactionId,
    synced: state.unshielded.progress.isStrictlyComplete(),
  },
});

export function watchSync(
  wallet: WalletFacade,
  { everyMs = 30_000, stallMs = 10 * 60_000, logger = console as Logger } = {},
): () => void {
  let latest: FacadeState | undefined;
  const subscription = wallet.state().subscribe((state) => {
    latest = state;
  });

  let previous: { at: number; applied: Record<Name, bigint> } | undefined;
  const lastMove: Record<Name, number> = { dust: Date.now(), shielded: Date.now(), unshielded: Date.now() };

  const line = (name: Name, now: Position, seconds: number) => {
    const before = previous?.applied[name];
    const rate = before === undefined || seconds <= 0 ? undefined : Number(now.applied - before) / seconds;
    const left = Number(now.target - now.applied);
    const eta = rate && rate > 0 && left > 0 ? `, about ${Math.ceil(left / rate / 60)} min left` : '';
    return `${name} ${now.applied}/${now.target}${rate === undefined ? '' : ` at ${Math.round(rate)}/s`}${eta}`;
  };

  const timer = setInterval(() => {
    if (!latest) return;
    const now = Date.now();
    const current = positions(latest);
    const seconds = previous ? (now - previous.at) / 1000 : 0;
    // A timer this late means the process was suspended (a laptop asleep). The time asleep isn't a
    // stall, so it is added back to each stall clock; the awake time before and after keeps counting,
    // so a sync that stays stuck across repeated sleeps is still reported.
    const paused = previous !== undefined && seconds * 1000 > 3 * everyMs;
    const asleepMs = paused ? now - previous!.at - everyMs : 0;

    for (const name of NAMES) {
      if (current[name].applied !== previous?.applied[name]) lastMove[name] = now;
      else lastMove[name] += asleepMs;
    }
    const stuck = NAMES.filter((name) => !current[name].synced && now - lastMove[name] >= stallMs);

    if (paused) {
      logger.info(`sync: this process was paused for ${Math.round(seconds / 60)} min (asleep?); watching again from here`);
    } else if (latest.isSynced && latest.protocol?._tag === 'Crossing') {
      const p = latest.protocol;
      logger.warn(
        `sync: all three sub-wallets are complete, but the facade is still crossing from protocol ${p.from} to ${p.to} ` +
          `(behind: ${p.behind.join(', ')}). Nothing can be built until it settles; if it stays, see the runbook (eventless DUST sync).`,
      );
    } else if (latest.isSynced) {
      logger.info('sync: complete (all three sub-wallets strictly complete)');
    } else if (stuck.length > 0) {
      logger.warn(
        'sync: ' +
          stuck
            .map((name) => `${name} has not moved for ${Math.round((now - lastMove[name]) / 60_000)} min (at ${current[name].applied} of ${current[name].target})`)
            .join(', ') +
          '. This is a stall, not a slow sync: check the log for "values inserted non-linearly" and see the runbook.',
      );
    } else {
      logger.info('sync: ' + NAMES.map((name) => line(name, current[name], seconds)).join(' | '));
    }
    previous = { at: now, applied: { dust: current.dust.applied, shielded: current.shielded.applied, unshielded: current.unshielded.applied } };
  }, everyMs);

  return () => {
    clearInterval(timer);
    subscription.unsubscribe();
  };
}
