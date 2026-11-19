#!/usr/bin/env node
/**
 * check-wallet-sync.mjs: read-only diagnostic for a wallet SDK 2.x wallet that syncs slowly, starts
 * over on every restart, or seems stuck. No wallet keys are needed and nothing is sent but indexer
 * queries.
 *
 * It asks the indexer for the chain tip and for the newest DUST and shielded (zswap) ledger event.
 * On a chain that crossed into ledger 9 (Preprod and Mainnet; Preview restarted on ledger 9), it
 * finds where the ledger 9 DUST events start, by the same binary search wallet SDK 2.x runs for
 * `skipLedgerV8DustHistory`, but on a fresh socket per lookup with retries. That gives the
 * `dustTimelineStartProbe` answer a fresh wallet can start from (runbook, Remediation 1), and how
 * many DUST events a fresh wallet replays with and without it. Given the files a wallet saved with
 * `serializeState()`, it reads the position each one was saved at and compares it with the indexer:
 * how far behind it is, whether it was saved against another indexer, and whether a DUST state is
 * still replaying ledger 8.
 *
 * Requirements: Node >= 22 (it uses the built-in WebSocket). No npm install.
 *
 * Usage:
 *   node check-wallet-sync.mjs [--network preprod] [--state <file> ...] [--no-search]
 *                              [--indexer <http url> --indexer-ws <ws url>]
 *
 *   --network     preview | preprod | mainnet (default preprod). Preprod and mainnet go through
 *                 Blockfrost and read the project id from BLOCKFROST_PROJECT_ID; it is never printed.
 *   --state       a saved sub-wallet state file (shielded, unshielded or DUST), the string
 *                 serializeState() returned. Repeat for each.
 *   --no-search   skip the ledger 9 DUST start search (about 25 lookups, 20 to 40 s)
 *   --fork-v9     the wallet configuration's forks.v9, if it isn't the default 2000000; the
 *                 search and the ledger 8 check use it as the boundary
 *   --indexer, --indexer-ws
 *                 your own indexer instead (for example a local one), HTTP and WebSocket URLs of its
 *                 GraphQL API
 *
 * Status words: OK; FAIL (this will not sync like this); WARN (works, but costs time); INFO.
 * Exit code: 0 = no FAIL, 2 = at least one FAIL, 1 = could not run. 1 is never a verdict.
 */

import fs from 'node:fs';

const USAGE =
  'usage: node check-wallet-sync.mjs [--network <preview|preprod|mainnet>] [--state <file> ...] [--no-search] [--fork-v9 <version>] [--indexer <http url> --indexer-ws <ws url>]';
// Where each network's indexer is, at compile date (2026-10-13). Preprod and mainnet moved to
// Blockfrost on 2026-10-09; see the indexer migration runbook.
const ENDPOINTS = {
  preview: {
    http: 'https://indexer.preview.midnight.network/api/v4/graphql',
    ws: 'wss://indexer.preview.midnight.network/api/v4/graphql/ws',
  },
  preprod: { http: 'https://midnight-preprod.blockfrost.io/api/v0', ws: 'wss://midnight-preprod.blockfrost.io/api/v0/ws', blockfrost: true },
  mainnet: { http: 'https://midnight-mainnet.blockfrost.io/api/v0', ws: 'wss://midnight-mainnet.blockfrost.io/api/v0/ws', blockfrost: true },
};
// The first ledger 9 protocol version: wallet SDK 2.x's DefaultForkSchedule `forks.v9`, unless --fork-v9 names the
// wallet's own. DUST events from here on are what a wallet started at the ledger 9 boundary replays.
let V9 = 2000000n;
// DUST events a fresh wallet SDK 2.x wallet applied per minute on preprod through Blockfrost (servicedesk#319). Default
// start with the default batches of 10: about 300 to 400 (2.0.0, 2026-11-13, a poor connection) and about 3,400 (2.0.1,
// 2026-11-18, the first 3 minutes). Ledger 9 start with batchUpdates.size 500: about 530 (2.0.0, 2026-11-14, a
// connection that dropped several times) and about 35,000 (2.0.1, 2026-11-18: 130,000 events in 3.7 min). Each batch
// waits on indexer round trips, so the connection sets the rate more than the machine does (inferred).
const REPLAY_RATE = { default: { low: 300, high: 3400 }, batched: { low: 530, high: 35000 } };
const duration = (events, perMinute) => {
  const min = events / perMinute;
  return min < 90 ? `${Math.max(1, Math.round(min))} min` : min < 48 * 60 ? `${Math.round(min / 60)} h` : `${Math.round(min / 60 / 24)} days`;
};
const span = (events, r) => {
  const slow = duration(events, r.low);
  const fast = duration(events, r.high);
  return slow === fast ? `about ${slow}` : `about ${fast} to ${slow}`;
};

const fail = (msg) => {
  console.error(msg);
  process.exit(1);
};

// ---------- arguments ----------
const opts = { network: 'preprod', states: [], search: true, http: undefined, ws: undefined };
{
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i] ?? fail(`${a} needs a value\n${USAGE}`);
    if (a === '--help' || a === '-h') {
      console.log(USAGE);
      process.exit(0);
    } else if (a === '--network') opts.network = next();
    else if (a === '--state') opts.states.push(next());
    else if (a === '--no-search') opts.search = false;
    else if (a === '--fork-v9') {
      const v = next();
      if (!/^\d+$/.test(v)) fail(`--fork-v9 must be a protocol version number\n${USAGE}`);
      V9 = BigInt(v);
    }
    else if (a === '--indexer') opts.http = next();
    else if (a === '--indexer-ws') opts.ws = next();
    else fail(`unknown argument ${a}\n${USAGE}`);
  }
  if (!ENDPOINTS[opts.network]) fail(`--network must be preview, preprod or mainnet\n${USAGE}`);
  if (Boolean(opts.http) !== Boolean(opts.ws)) fail(`--indexer and --indexer-ws go together\n${USAGE}`);
}
if (typeof WebSocket !== 'function') fail(`This needs Node 22 or later (built-in WebSocket); this is Node ${process.versions.node}.`);

const endpoint = opts.http ? { http: opts.http, ws: opts.ws } : ENDPOINTS[opts.network];
const projectId = process.env.BLOCKFROST_PROJECT_ID?.trim();
if (endpoint.blockfrost && !projectId) {
  fail(
    `${opts.network} goes through Blockfrost, which needs a project id. Set BLOCKFROST_PROJECT_ID to a ` +
      `Midnight ${opts.network} project id (the token is per network) and run again. It is read from ` +
      'the environment and never printed.',
  );
}
const withKey = (u) => (endpoint.blockfrost ? `${u}?project_id=${encodeURIComponent(projectId)}` : u);
const redact = (s) => (projectId ? String(s).replaceAll(projectId, '<project_id>').replaceAll(encodeURIComponent(projectId), '<project_id>') : String(s));
const shown = (u) => u.replace(/\?.*$/, '');

// ---------- report ----------
const rows = [];
const add = (check, found, status, note = '') => rows.push({ check, found: redact(found), status, note: redact(note) });
const fmt = (n) => Number(n).toLocaleString('en-US');

// ---------- indexer queries ----------
async function httpQuery(query) {
  const res = await fetch(withKey(endpoint.http), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text.slice(0, 200) };
  }
  return { status: res.status, body };
}

// Open a graphql-transport-ws subscription and hand each event to onEvent until it returns true or time runs out.
function subscribe(query, variables, onEvent, seconds) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(withKey(endpoint.ws), 'graphql-transport-ws');
    let settled = false;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {}
      err ? reject(err) : resolve(value);
    };
    const timer = setTimeout(() => finish(null, 'timeout'), seconds * 1000);
    ws.onopen = () => ws.send(JSON.stringify({ type: 'connection_init' }));
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.type === 'connection_ack') ws.send(JSON.stringify({ id: '1', type: 'subscribe', payload: { query, variables } }));
      else if (msg.type === 'next') {
        if (msg.payload?.errors) finish(new Error(JSON.stringify(msg.payload.errors).slice(0, 200)));
        else if (onEvent(Object.values(msg.payload.data)[0])) finish(null, 'done');
      } else if (msg.type === 'error') finish(new Error(JSON.stringify(msg.payload).slice(0, 200)));
    };
    ws.onerror = () => finish(new Error('the WebSocket connection failed'));
    ws.onclose = (e) => finish(e.code === 1000 ? null : new Error(`the WebSocket closed with code ${e.code}`), 'closed');
  });
}

async function newestEvent(field) {
  let found;
  const outcome = await subscribe(`subscription($id: Int) { ${field}(id: $id) { id maxId } }`, { id: 1 }, (e) => {
    found = e;
    return true;
  }, 60);
  if (!found) throw new Error(`no event within 60 s (${outcome})`);
  return BigInt(found.maxId);
}

// The first DUST event at or after `id` (null: the first one), on its own socket, 15 s, three tries. The SDK's own
// search waits 10 s per lookup on one shared connection; on Blockfrost preprod that timed out every time (runbook).
async function dustEventAt(id) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
    let found;
    try {
      await subscribe('subscription($id: Int) { dustLedgerEvents(id: $id) { id maxId protocolVersion } }', { id }, (e) => {
        found = e;
        return true;
      }, 15);
      if (found?.protocolVersion === undefined || found?.protocolVersion === null) {
        if (found) throw Object.assign(new Error(`the DUST event at ${id ?? 'the start'} has no protocolVersion`), { final: true });
      } else return { id: Number(found.id), maxId: Number(found.maxId), version: BigInt(found.protocolVersion) };
      lastError = new Error(`no DUST event at ${id ?? 'the start'} within 15 s`);
    } catch (e) {
      if (e.final || /^\[\{|"message"/.test(e.message)) throw e; // a GraphQL error answers the same every time
      lastError = e;
    }
  }
  throw lastError;
}

// Where the DUST timeline reaches V9: the id of the last event below it (the cursor a start at the boundary resumes
// from) and the version of the first event at or above it. The same search as wallet-sdk-dust-wallet's
// findDustTimelineStart. undefined when the chain never crossed (all one side of the boundary).
async function findV9Start() {
  const first = await dustEventAt(null);
  const last = await dustEventAt(first.maxId);
  if (first.version >= V9 || last.version < V9) return undefined;
  let low = first.id + 1;
  let high = last.id;
  let atHigh = last;
  let lookups = 2;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    const probed = await dustEventAt(mid);
    lookups++;
    if (probed.version >= V9) {
      high = mid;
      atHigh = probed;
    } else low = probed.id + 1;
  }
  return { cursor: low - 1, version: atHigh.version, newest: last.maxId, lookups };
}

// ---------- checks ----------
let tips = {};
{
  try {
    const { status, body } = await httpQuery('{ block { height } }');
    const height = body?.data?.block?.height;
    if (status === 200 && height !== undefined) add('Indexer', `${shown(endpoint.http)}: block ${fmt(height)}`, 'OK');
    else {
      const message = body?.message ?? body?.errors?.[0]?.message ?? body?.raw ?? JSON.stringify(body).slice(0, 160);
      const hint =
        status === 403 && /Missing project token/i.test(message)
          ? 'no project id reached Blockfrost'
          : status === 403 && /Network token mismatch/i.test(message)
            ? 'the project id is for another network: Blockfrost tokens are per network'
            : status === 403 && /Invalid project token/i.test(message)
              ? 'the project id is wrong'
            : status === 410
              ? 'this indexer is shut down; preprod and mainnet moved to Blockfrost (indexer migration runbook)'
              : '';
      add('Indexer', `${shown(endpoint.http)}: HTTP ${status} ${message}`, 'FAIL', hint);
    }
  } catch (e) {
    add('Indexer', `${shown(endpoint.http)}: ${e.message}`, 'FAIL', 'unreachable: check the URL and the network connection');
  }
}

if (!rows.some((r) => r.status === 'FAIL')) {
  for (const [name, field] of [
    ['DUST events', 'dustLedgerEvents'],
    ['Shielded events', 'zswapLedgerEvents'],
  ]) {
    try {
      tips[field] = await newestEvent(field);
      add(name, `newest id ${fmt(tips[field])}`, 'INFO', name === 'DUST events' ? 'a fresh wallet with the default start replays all of these, from every owner' : '');
    } catch (e) {
      add(name, e.message, 'FAIL', 'the WebSocket API did not answer');
    }
  }
}

let v9;
if (tips.dustLedgerEvents !== undefined && opts.search) {
  const t0 = Date.now();
  try {
    v9 = await findV9Start();
    const secs = Math.round((Date.now() - t0) / 1000);
    if (v9) {
      add(
        'Ledger 9 DUST start',
        `cursor ${v9.cursor}, version ${v9.version} (${v9.lookups} lookups, ${secs} s)`,
        'INFO',
        `a fresh wallet can start here: dustTimelineStartProbe: async () => Option.some({ cursor: ${v9.cursor}n, version: ProtocolVersion.ProtocolVersion(${v9.version}n) }) (runbook, Remediation 1)`,
      );
    } else {
      add('Ledger 9 DUST start', `none (${secs} s)`, 'INFO', 'every DUST event on this chain is on one side of ledger 9, so there is no ledger 8 history to skip');
    }
  } catch (e) {
    add('Ledger 9 DUST start', e.message, 'WARN', 'the search did not finish; run again, or from another connection');
  }
}

if (tips.dustLedgerEvents !== undefined) {
  const events = Number(tips.dustLedgerEvents);
  if (v9) {
    const since = Math.max(0, events - v9.cursor);
    add(
      'Fresh wallet, default start',
      `replays ${fmt(events)} DUST event ids, ledger 8 included`,
      opts.network === 'preprod' && !opts.http && opts.states.length === 0 ? 'WARN' : 'INFO',
      `${span(events, REPLAY_RATE.default)} at the rates measured on preprod with the default batches of 10, depending on the connection; skipLedgerV8DustHistory: true did not change this on Blockfrost (runbook, Root cause 2)`,
    );
    add(
      'Fresh wallet, ledger 9 start',
      `replays ${fmt(since)} DUST event ids`,
      'INFO',
      `${span(since, REPLAY_RATE.batched)} with batchUpdates.size 500, depending on the connection; ${span(since, REPLAY_RATE.default)} with the default batches (runbook, Remediation 1)`,
    );
  } else {
    add('Fresh wallet', `replays ${fmt(events)} DUST event ids`, 'INFO', `${span(events, REPLAY_RATE.default)} at the rates measured on preprod; a short history goes much faster`);
  }
}

// Saved state files: the JSON string serializeState() returns, in wallet SDK 2.x. Shielded and DUST record
// `offset`; unshielded records `appliedId`. A DUST state also records `syncKind`: `events` (offset is the last DUST
// event id applied) or `projections` (the eventless sync: offset is a block height). BigInts are written as strings.
for (const file of opts.states) {
  let snap;
  let bytes;
  try {
    const text = fs.readFileSync(file, 'utf8');
    bytes = Buffer.byteLength(text);
    snap = JSON.parse(text);
    if (typeof snap === 'string') {
      bytes = Buffer.byteLength(snap);
      snap = JSON.parse(snap);
    }
  } catch (e) {
    add(`State ${file}`, e.message, 'FAIL', 'not a readable serializeState() file');
    continue;
  }
  if (snap === null || typeof snap !== 'object' || Array.isArray(snap)) {
    add(`State ${file}`, 'not a JSON object', 'WARN', "expected one sub-wallet's serializeState() output (shielded, unshielded or DUST)");
    continue;
  }
  const kind = snap.publicKeys ? 'shielded' : 'appliedId' in snap || snap.state?.availableUtxos ? 'unshielded' : snap.publicKey ? 'dust' : undefined;
  if (!kind) {
    add(`State ${file}`, 'unrecognised shape', 'WARN', 'expected one sub-wallet\'s serializeState() output (shielded, unshielded or DUST)');
    continue;
  }
  const label = `State ${kind} (${file.split('/').pop()})`;
  const size = bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} KB`;
  if (snap.networkId && snap.networkId !== opts.network && !opts.http) {
    add(label, `saved on ${snap.networkId}`, 'FAIL', `this check is for ${opts.network}; restore it only against ${snap.networkId}`);
    continue;
  }
  if (kind === 'unshielded') {
    add(label, `appliedId ${fmt(snap.appliedId ?? 0)}, ${size}`, 'INFO', 'resumes from this transaction id');
    continue;
  }
  const offset = BigInt(snap.offset ?? 0);
  if (kind === 'dust' && snap.syncKind === 'projections') {
    add(
      label,
      `eventless (projections) state at block ${fmt(offset)}, ${size}`,
      'WARN',
      'saved by the eventless DUST sync: on wallet SDK 2.0.0 that wallet never settles its protocol version and cannot build transactions (runbook, Root cause 3)',
    );
    continue;
  }
  const tip = tips[kind === 'dust' ? 'dustLedgerEvents' : 'zswapLedgerEvents'];
  const version = snap.protocolVersion !== undefined ? BigInt(snap.protocolVersion) : undefined;
  if (offset === 0n) {
    add(label, `offset 0, ${size}`, 'WARN', 'saved before any event was applied: restoring it is the same as a fresh sync (0 means "stream from the start")');
  } else if (tip === undefined) {
    add(label, `offset ${fmt(offset)}, ${size}`, 'INFO', "indexer tip unknown, so how far behind it is can't be told");
  } else if (offset > tip) {
    add(
      label,
      `offset ${fmt(offset)} is past this indexer's newest event ${fmt(tip)}`,
      'FAIL',
      'saved against a different indexer, whose event ids differ: restoring it stalls with "values inserted non-linearly". Discard it and sync from the start (cursor runbook)',
    );
  } else if (kind === 'dust' && version !== undefined && version < V9 && (!v9 || Number(offset) < v9.cursor)) {
    const behind = Number(tip - offset);
    const fresh = v9 ? ` Starting fresh at the ledger 9 start replays ${fmt(Number(tip) - v9.cursor)}` : '';
    add(
      label,
      `offset ${fmt(offset)}, still on ledger 8 (version ${version}), ${size}`,
      'WARN',
      `restoring it replays the rest of the ledger 8 DUST history first, ${fmt(behind)} events in all.${fresh} (runbook, Remediation 4). Move the file aside rather than delete it: a fresh start for a wallet that held DUST before ledger 9 is not tested`,
    );
  } else {
    const behind = Number(tip - offset);
    // Within range is only plausible: state saved against another indexer whose ids differ by a little (the official
    // preprod indexer and Blockfrost were 22 apart) passes too, and stalls on restore all the same.
    add(
      label,
      `offset ${fmt(offset)}, ${fmt(behind)} events behind, ${size}`,
      'OK',
      "plausible: within this indexer's range, but a state saved against another indexer can be too (runbook, Remediation 2)",
    );
  }
}

// ---------- print ----------
const widths = ['check', 'found', 'status'].map((k) => Math.max(k.length, ...rows.map((r) => r[k].length)));
const line = (r) => [r.check.padEnd(widths[0]), r.found.padEnd(widths[1]), r.status.padEnd(Math.max(6, widths[2])), r.note].join('  ').trimEnd();
console.log(line({ check: 'check', found: 'found', status: 'status', note: 'note' }));
for (const r of rows) console.log(line(r));
const failed = rows.some((r) => r.status === 'FAIL');
const warned = rows.some((r) => r.status === 'WARN');
console.log(
  `\nRESULT: ${
    failed
      ? 'at least one FAIL above: fix it before waiting on a sync.'
      : warned
        ? 'nothing here stops a sync, but the WARN rows above will slow it or cost a full replay (runbook, Diagnose 1). If it still looks stuck, log its progress with scripts/watch-sync.ts (runbook, Diagnose 2).'
        : 'nothing here stops a sync. If it still looks stuck, log its progress with scripts/watch-sync.ts (runbook, Diagnose 2).'
  }`,
);
process.exit(failed ? 2 : 0);
