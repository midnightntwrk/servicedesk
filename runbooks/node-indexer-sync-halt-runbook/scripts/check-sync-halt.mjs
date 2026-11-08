#!/usr/bin/env node
/**
 * check-sync-halt.mjs: read-only check for a self-hosted Midnight node or indexer that stopped
 * syncing on a block the chain accepted, with "Intent TTL has expired" or "dust is outside of its
 * validity window".
 *
 * It reads the halt error, finds the transaction's block, and works out which time the transaction
 * is valid at: its block's own time, or the parent block's time + 12 s (the time a block author on a
 * runtime before 1.0.300 could have checked a block's first transaction at). Then it says which time
 * the halted software checked at, names the fix, and asks GitHub and Docker Hub which published
 * versions contain it.
 *
 * Node >= 20, no install. It reads public data only and writes nothing.
 *
 *   node check-sync-halt.mjs --network mainnet --rpc http://<your node>:9944 --log indexer.log
 *   docker logs indexer 2>&1 | node check-sync-halt.mjs --network preview
 *   node check-sync-halt.mjs --network preprod --error 'cannot apply regular transaction …'
 *   node check-sync-halt.mjs --versions          # only the release check
 *
 * Block data comes from the first source that has it:
 *   1. a node at http://127.0.0.1:9944, if it answers for the same network;
 *   2. --rpc <url> (a node's JSON-RPC; WebSocket URLs, scheme ws or wss, are read as http or https) and
 *      --indexer <url> (a GraphQL indexer), repeatable;
 *   3. the network's public indexer and RPC. Preprod and Mainnet ones are Blockfrost's and need
 *      BLOCKFROST_PROJECT_ID in the environment.
 * A stopped node doesn't have the block it stopped on: give it another source with --rpc.
 *
 * Other options: --offline (skip the GitHub and Docker Hub check), --json, --timeout <seconds>.
 * GITHUB_TOKEN, if set, raises GitHub's rate limit. Neither token is ever printed.
 *
 * Exit code: 0 = the halt matches a known pattern (the output names the fix); 2 = it doesn't, or the
 * input has no halt error; 3 = the block couldn't be found or confirmed (add a source); 1 = could not
 * run. With --versions alone: 0, or 1 if a check failed.
 */

import fs from 'node:fs';

if (Number(process.versions.node.split('.')[0]) < 20) {
  console.error(`Node >= 20 is required (this is ${process.version})`);
  process.exit(1);
}

const USAGE = `usage: node check-sync-halt.mjs [--network mainnet|preprod|preview] [--log <file> | --error '<text>' | stdin]
                           [--rpc <url>]… [--indexer <url>]… [--offline] [--json] [--timeout <seconds>]
       node check-sync-halt.mjs --versions [--json]`;

// ---------- facts this check relies on (the runbook's Key identifiers) ----------
const BUMP_S = 12; // runtimes before 1.0.300 could check a block's first transaction at parent time + 12 s
// Ledger 8 parameters on Preview, Preprod and Mainnet (2026-10-15). 3600 s is only the ledger's
// initial default for global_ttl; the chains run 14 days. Used only for "TTL is too far in the future".
const GLOBAL_TTL_S = 1209600;
const DUST_GRACE_S = 10800; // the DUST validity window, if the error doesn't give it
const RUNTIME_1_0_300 = 1000300; // from this spec version on, every transaction is checked at block time
// Timestamp::Now in storage: twox128("Timestamp") ++ twox128("Now"), a u64 of milliseconds.
const TIMESTAMP_NOW_KEY = '0xf0c365c3cf59d671eb72da0e7a4113c49f1f0515f462cdcf84e0f1d6045dfcbb'; // gitleaks:allow - a public storage key, not a secret
const NETWORKS = {
  preview: { chain: 'Midnight Preview', indexer: 'https://indexer.preview.midnight.network/api/v4/graphql', rpc: 'https://rpc.preview.midnight.network' },
  preprod: { chain: 'Midnight Preprod', indexer: 'https://midnight-preprod.blockfrost.io/api/v0', rpc: 'https://rpc.midnight-preprod.blockfrost.io', blockfrost: true },
  mainnet: { chain: 'Midnight Mainnet', indexer: 'https://midnight-mainnet.blockfrost.io/api/v0', rpc: 'https://rpc.midnight-mainnet.blockfrost.io', blockfrost: true },
};
// The fix in each repo. A tag has it when one of its commits since the fix was merged carries the
// fix's title: that also finds it after a cherry-pick to a release line, where the hash differs.
// midnight-indexer: #1610 on main (3e9f6374), #1612 on release/4.3 (8cb252e3, in v4.3.800-rc.2),
// #1613 on release/4.4 (7fd4ecba). midnight-node: #2216 on main (1ec1c61e), #2218 on
// release/node-2.1.0 (7955f18e, in node-2.1.0-rc.4), #2238 on release/node-1.0.400 (5defaf5d).
const FIXES = {
  indexer: {
    repo: 'midnightntwrk/midnight-indexer',
    images: ['midnightntwrk/indexer-standalone', 'midnightntwrk/chain-indexer'],
    tag: /^v(\d+)\.(\d+)\.(\d+)(?:-rc\.\d+)?$/,
    from: [4, 3, 4], // earlier tags check only at block time and predate the fix
    title: 'accept the first regular transaction at either tblock',
    since: '2026-09-29T00:00:00Z',
  },
  node: {
    repo: 'midnightntwrk/midnight-node',
    images: ['midnightntwrk/midnight-node'],
    tag: /^node-(\d+)\.(\d+)\.(\d+)(?:-rc\.\d+)?$/,
    from: [1, 0, 300],
    title: "retry tblock-corrected first tx at the block's own tblock",
    since: '2026-09-29T00:00:00Z',
  },
};
// Overridable so the test can point the script at a local mock.
const GITHUB_API = process.env.CHECK_SYNC_HALT_GITHUB_API ?? 'https://api.github.com';
const DOCKER_HUB = process.env.CHECK_SYNC_HALT_DOCKER_HUB ?? 'https://hub.docker.com';
const LOCAL_RPC = process.env.CHECK_SYNC_HALT_LOCAL_RPC ?? 'http://127.0.0.1:9944';
const PUBLIC = process.env.CHECK_SYNC_HALT_PUBLIC ? JSON.parse(process.env.CHECK_SYNC_HALT_PUBLIC) : undefined;
const RETRY_MS = Number(process.env.CHECK_SYNC_HALT_RETRY_MS ?? 1000);

// ---------- arguments ----------
const argv = process.argv.slice(2);
const opts = { rpc: [], indexer: [], offline: false, json: false, versions: false, timeout: 20 };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const value = () => {
    const v = argv[++i];
    if (v === undefined || v.startsWith('--')) fail(`${a} needs a value\n${USAGE}`);
    return v;
  };
  if (a === '--network') opts.network = value();
  else if (a === '--log') opts.log = value();
  else if (a === '--error') opts.error = value();
  else if (a === '--rpc') opts.rpc.push(value());
  else if (a === '--indexer') opts.indexer.push(value());
  else if (a === '--timeout') opts.timeout = Number(value());
  else if (a === '--offline') opts.offline = true;
  else if (a === '--json') opts.json = true;
  else if (a === '--versions') opts.versions = true;
  else if (a === '-h' || a === '--help') { console.log(USAGE); process.exit(0); }
  else fail(`unknown argument ${a}\n${USAGE}`);
}
if (opts.network !== undefined && !Object.hasOwn(NETWORKS, opts.network)) fail(`--network must be mainnet, preprod or preview\n${USAGE}`);
if (!(opts.timeout > 0)) fail('--timeout takes a number of seconds');

const TOKEN = process.env.BLOCKFROST_PROJECT_ID?.trim() || undefined;
const GH_TOKEN = process.env.GITHUB_TOKEN?.trim() || undefined;
// Everything this script prints goes through redact().
function redact(s) {
  let out = String(s);
  for (const t of [TOKEN, GH_TOKEN]) if (t) out = out.split(t).join('<token>');
  return out;
}
function fail(message) {
  console.error(redact(message));
  process.exit(1);
}
// fetch() reports "fetch failed" and keeps the reason in `cause`.
const why = (e) => `${e.message}${e.cause?.code ? ` (${e.cause.code})` : e.cause?.message ? ` (${e.cause.message})` : ''}`;

// ---------- reading the halt ----------
// These are the texts the ledger, the indexer and the node print (runbook, Symptom).
function parseHalt(text) {
  const last = (re) => { let m; for (const x of text.matchAll(re)) m = x; return m; };
  const errors = [];
  const expired = last(/Intent TTL has expired\. TTL: Timestamp\((\d+)\), Current block: Timestamp\((\d+)\)/g);
  if (expired) errors.push({ at: expired.index, kind: 'ttl-expired', value: Number(expired[1]), used: Number(expired[2]) });
  const far = last(/Intent TTL is too far in the future\. TTL: Timestamp\((\d+)\), Maximum allowed: Timestamp\((\d+)\)/g);
  if (far) errors.push({ at: far.index, kind: 'ttl-too-far', value: Number(far[1]), max: Number(far[2]), used: Number(far[2]) - GLOBAL_TTL_S });
  const dust = last(/dust is outside of its validity window \(declared time: Timestamp\((\d+)\), window: \[Timestamp\((\d+)\), Timestamp\((\d+)\)\]\)/g);
  if (dust) errors.push({ at: dust.index, kind: 'dust-window', value: Number(dust[1]), used: Number(dust[3]), grace: Number(dust[3]) - Number(dust[2]) });
  const dustWarn = last(/dust actions out of TTL range ctime=Timestamp\((\d+)\) tblock=Timestamp\((\d+)\) grace_period=Duration\((\d+)\)/g);
  if (dustWarn && !dust) errors.push({ at: dustWarn.index, kind: 'dust-window', value: Number(dustWarn[1]), used: Number(dustWarn[2]), grace: Number(dustWarn[3]) });
  if (!errors.length) return undefined;
  // A crash-looping process logs the same error again and again; the last one is the one it stopped on.
  const { at, ...halt } = errors.sort((a, b) => a.at - b.at).at(-1);
  const tx = last(/cannot apply regular transaction (?:0x)?([0-9a-f]{64})/g);
  if (tx) halt.txHash = tx[1];
  const block = last(/apply transactions of block (?:0x)?([0-9a-f]{64}) at height (\d+)/g);
  if (block) { halt.blockHash = block[1]; halt.height = Number(block[2]); }
  if (/index_blocks_task failed|chain-indexer exited|cannot apply regular transaction/.test(text)) halt.software = 'indexer';
  else if (/Transaction malformed:|Invalid\(Custom\(\d+\)\)|Aborting the rest of the block execution/.test(text)) halt.software = 'node';
  else halt.software = 'unknown';
  const imported = [...text.matchAll(/Imported #(\d+)/g)].map((m) => Number(m[1]));
  if (imported.length) halt.lastImported = Math.max(...imported);
  return halt;
}

// ---------- which time the transaction is valid at ----------
// tb and tp: the block's and its parent's time in whole seconds, as the ledger uses them.
function classify(halt, tb, tp) {
  const bump = tp + BUMP_S;
  const grace = halt.grace ?? DUST_GRACE_S;
  const valid = (t) => (halt.kind === 'ttl-expired' ? halt.value >= t
    : halt.kind === 'ttl-too-far' ? halt.value <= t + GLOBAL_TTL_S
      : t - grace <= halt.value && halt.value <= t);
  // block+12 is indexer v4.3.4's time: it added the 12 s to the block's own time instead of the parent's.
  const checkedAt = halt.used === tb ? 'block' : halt.used === bump ? 'bump' : halt.used === tb + BUMP_S ? 'block+12' : 'other';
  const validAtBlock = valid(tb), validAtBump = valid(bump);
  const pattern = (checkedAt === 'bump' || checkedAt === 'block+12') && validAtBlock ? 'A'
    : checkedAt === 'block' && validAtBump ? 'B'
      : checkedAt === 'other' && (validAtBlock || validAtBump) ? 'C'
        : 'none';
  return { tb, tp, bump, used: halt.used, checkedAt, validAtBlock, validAtBump, pattern };
}

// ---------- block sources ----------
function withToken(url) {
  if (!TOKEN) return url;
  const u = new URL(url);
  u.searchParams.set('project_id', TOKEN);
  return u.toString();
}
async function post(url, body) {
  let res;
  // One retry on a network error: public endpoints drop connections now and then.
  for (let attempt = 1; !res; attempt++) {
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(opts.timeout * 1000),
      });
    } catch (e) {
      if (attempt >= 2) throw new Error(why(e));
      await new Promise((r) => setTimeout(r, RETRY_MS));
    }
  }
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { throw new Error(`HTTP ${res.status}: ${text.slice(0, 160)}`); }
  if (!res.ok && json.data === undefined && json.result === undefined) throw new Error(`HTTP ${res.status}: ${String(json.message ?? json.error?.message ?? text).slice(0, 160)}`);
  return json;
}
const secs = (ms) => Math.floor(Number(ms) / 1000);
const u32le = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };

function rpcSource(url, label) {
  const call = async (method, params = []) => {
    const r = await post(url, { jsonrpc: '2.0', id: 1, method, params });
    if (r.error) throw new Error(`${method}: ${r.error.message ?? JSON.stringify(r.error)}`);
    return r.result;
  };
  const hashAt = (h) => call('chain_getBlockHash', [h]);
  return {
    label,
    chain: () => call('system_chain'),
    tip: async () => parseInt((await call('chain_getHeader')).number, 16),
    timeAt: async (h) => {
      const hash = await hashAt(h);
      if (!hash) return undefined;
      const raw = await call('state_getStorage', [TIMESTAMP_NOW_KEY, hash]);
      if (typeof raw !== 'string' || !/^0x[0-9a-f]{16}$/i.test(raw)) return undefined;
      return { time: secs(Buffer.from(raw.slice(2), 'hex').readBigUInt64LE()), hash };
    },
    runtimeAt: async (h) => {
      const hash = await hashAt(h);
      return hash ? (await call('state_getRuntimeVersion', [hash]))?.specVersion : undefined;
    },
    // Whether the block's extrinsics hold the value as a 4-byte little-endian number: a transaction's
    // TTL and DUST time are stored that way, so this confirms which block holds the transaction.
    holds: async (h, value) => {
      const hash = await hashAt(h);
      if (!hash) return undefined;
      const block = (await call('chain_getBlock', [hash]))?.block;
      if (!block) return undefined;
      const needle = u32le(value);
      return block.extrinsics.some((x) => Buffer.from(x.slice(2), 'hex').includes(needle));
    },
    findTx: async () => undefined,
  };
}

function indexerSource(url, label) {
  const query = async (q) => {
    const r = await post(url, { query: q });
    if (r.errors?.length) throw new Error(r.errors.map((e) => e.message).join('; ').slice(0, 200));
    return r.data;
  };
  const block = async (h, fields) => (await query(`{ block(offset: { height: ${Number(h)} }) { ${fields} } }`)).block;
  return {
    label,
    tip: async () => (await query('{ block { height } }')).block?.height,
    timeAt: async (h) => { const b = await block(h, 'hash timestamp'); return b ? { time: secs(b.timestamp), hash: b.hash } : undefined; },
    runtimeAt: async (h) => (await block(h, 'protocolVersion'))?.protocolVersion,
    holds: async () => undefined,
    findTx: async (hash) => {
      const t = (await query(`{ transactions(offset: { hash: "${hash}" }) { block { height hash timestamp } } }`)).transactions?.[0];
      return t?.block ? { height: t.block.height } : undefined;
    },
  };
}

async function sourcesFor(network) {
  const sources = [], notes = [];
  const local = rpcSource(LOCAL_RPC, `the node at ${LOCAL_RPC}`);
  try {
    const chain = await local.chain();
    const localNetwork = Object.keys(NETWORKS).find((n) => NETWORKS[n].chain === chain);
    network ??= localNetwork;
    if (network && localNetwork === network) sources.push(local);
    else notes.push(`${LOCAL_RPC} answers for "${chain}", so it isn't used`);
  } catch { /* no node on this machine: fine */ }
  for (const given of opts.rpc) {
    // A node serves JSON-RPC over HTTP on the same port as its WebSocket; indexer configs hold WebSocket (ws) URLs.
    const u = given.replace(/^ws(s?):\/\//, 'http$1://');
    if (u !== given) notes.push(`read ${redact(given)} as ${redact(u)}`);
    const s = rpcSource(u, redact(u));
    if (!network) {
      try { const chain = await s.chain(); network = Object.keys(NETWORKS).find((n) => NETWORKS[n].chain === chain); } catch { /* the lookups say so */ }
    }
    sources.push(s);
  }
  for (const u of opts.indexer) sources.push(indexerSource(u, redact(u)));
  if (network) {
    const n = { ...NETWORKS[network], ...PUBLIC?.[network] };
    if (!n.blockfrost || TOKEN) {
      sources.push(indexerSource(n.blockfrost ? withToken(n.indexer) : n.indexer, `the public ${network} indexer (${n.indexer})`));
      sources.push(rpcSource(n.blockfrost ? withToken(n.rpc) : n.rpc, `the public ${network} RPC (${n.rpc})`));
    } else notes.push(`the public ${network} indexer and RPC are Blockfrost's, so they need BLOCKFROST_PROJECT_ID`);
  }
  return { sources, notes, network };
}

// The first source that answers. Errors are kept for the report if none does.
async function first(sources, fn) {
  const errors = [];
  for (const s of sources) {
    try {
      const value = await fn(s);
      if (value !== undefined && value !== null) return { value, from: s.label };
    } catch (e) { errors.push(`${s.label}: ${e.message}`); }
  }
  return { errors };
}

// Lowest height in [1, tip] whose block time is >= t (the tip if none is). Failures go to `tried`.
async function heightAtOrAfter(sources, tip, t, tried) {
  let lo = 1, hi = tip;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const r = await first(sources, (s) => s.timeAt(mid));
    const b = r.value;
    if (!b) { tried.push(...(r.errors?.length ? r.errors : [`no source has block ${mid}`])); return undefined; }
    if (b.time < t) lo = mid + 1; else hi = mid;
  }
  return lo;
}

// Find the block, its time and its parent's time. Returns one entry per block that fits.
async function locate(halt, sources) {
  const tried = [];
  const timesAt = async (h) => {
    const [b, p] = [await first(sources, (s) => s.timeAt(h)), await first(sources, (s) => s.timeAt(h - 1))];
    if (!b.value || !p.value) { tried.push(...(b.errors ?? []), ...(p.errors ?? [])); return undefined; }
    return { height: h, hash: b.value.hash, tb: b.value.time, tp: p.value.time };
  };
  if (halt.height) {
    const r = await timesAt(halt.height);
    if (r) return [{ ...r, by: 'the height in the halt line', sure: true }];
  }
  if (halt.txHash) {
    const t = await first(sources, (s) => s.findTx(halt.txHash));
    if (t.value) {
      const r = await timesAt(t.value.height);
      if (r) return [{ ...r, by: `the transaction hash, from ${t.from}`, sure: true }];
    } else tried.push(...t.errors);
  }
  // No height or hash, or nothing has them: try each time the halting software could have checked at,
  // up to the highest tip (a stopped node is behind the other sources).
  const tips = [];
  for (const s of sources) { try { const t = await s.tip(); if (t) tips.push(t); } catch (e) { tried.push(`${s.label}: ${e.message}`); } }
  if (!tips.length) return [{ notFound: true, tried }];
  const tip = Math.max(...tips);
  const candidates = [];
  // The block 12 s before the error's time: the parent (most versions), or the block itself (v4.3.4).
  const earlyAt = await heightAtOrAfter(sources, tip, halt.used - BUMP_S, tried);
  const early = earlyAt && (await first(sources, (s) => s.timeAt(earlyAt))).value;
  if (early && early.time === halt.used - BUMP_S) {
    const r = await timesAt(earlyAt + 1);
    if (r) candidates.push({ ...r, by: `time: its parent is the block at ${early.time}` });
    else if (earlyAt === tip || halt.lastImported === earlyAt) candidates.push({ height: earlyAt + 1, tp: early.time, missingBlock: true });
    const self = earlyAt > 1 ? await timesAt(earlyAt) : undefined;
    if (self) candidates.push({ ...self, by: `time: the block at ${self.tb}, checked at its own time + ${BUMP_S} s` });
  }
  const atAt = await heightAtOrAfter(sources, tip, halt.used, tried);
  const at = atAt && atAt > 1 ? await timesAt(atAt) : undefined;
  if (at && at.tb === halt.used) candidates.push({ ...at, by: `time: the block at ${at.tb}` });
  // Keep the ones that fit a known pattern; then ask a node which of them holds the transaction.
  const fitting = candidates.filter((c) => c.missingBlock || classify(halt, c.tb, c.tp).pattern !== 'none');
  for (const c of fitting) {
    if (c.missingBlock) continue;
    const held = (await first(sources, (s) => s.holds(c.height, halt.value))).value;
    if (held !== undefined) c.holds = held;
  }
  const confirmed = fitting.filter((c) => c.holds === true).map((c) => ({ ...c, by: `${c.by}; it holds the transaction's ${halt.kind === 'dust-window' ? 'DUST time' : 'TTL'}`, sure: true }));
  if (confirmed.length) return confirmed;
  const open = fitting.filter((c) => c.holds !== false);
  if (open.length) return open;
  // Blocks fit the time but no known pattern: report them, so the verdict says so.
  const found = candidates.filter((c) => !c.missingBlock);
  return found.length ? found : [{ notFound: true, tried }];
}

// ---------- releases ----------
async function getJson(url, headers = {}) {
  // One retry: GitHub and Docker Hub reset connections now and then.
  for (let attempt = 1; ; attempt++) {
    try {
      let res;
      try {
        res = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'check-sync-halt', ...headers }, signal: AbortSignal.timeout(opts.timeout * 1000) });
      } catch (e) { throw new Error(`${why(e)} from ${new URL(url).host}`); }
      if (res.status === 403 || res.status === 429) throw Object.assign(new Error(`HTTP ${res.status} from ${new URL(url).host} (rate limit? set GITHUB_TOKEN)`), { final: true });
      if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status} from ${new URL(url).host}`), { final: res.status < 500 });
      return await res.json();
    } catch (e) {
      if (e.final || attempt >= 2) throw e;
      await new Promise((r) => setTimeout(r, RETRY_MS));
    }
  }
}
const ghHeaders = GH_TOKEN ? { authorization: `Bearer ${GH_TOKEN}` } : {};
const atLeast = (v, min) => (v[0] !== min[0] ? v[0] > min[0] : v[1] !== min[1] ? v[1] > min[1] : v[2] >= min[2]);

async function releaseStatus(kind) {
  const f = FIXES[kind];
  const names = [];
  for (let page = 1; page <= 3; page++) {
    const batch = await getJson(`${GITHUB_API}/repos/${f.repo}/tags?per_page=100&page=${page}`, ghHeaders);
    names.push(...batch.map((t) => t.name));
    if (batch.length < 100) break;
  }
  const fixed = [], unfixed = [];
  for (const name of names) {
    const m = name.match(f.tag);
    if (!m || !atLeast([+m[1], +m[2], +m[3]], f.from)) continue;
    let has = false;
    for (let page = 1; page <= 3 && !has; page++) {
      const commits = await getJson(`${GITHUB_API}/repos/${f.repo}/commits?sha=${encodeURIComponent(name)}&since=${f.since}&per_page=100&page=${page}`, ghHeaders);
      has = commits.some((c) => c.commit?.message?.split('\n')[0].includes(f.title));
      if (commits.length < 100) break;
    }
    (has ? fixed : unfixed).push(name);
  }
  const imageTag = (tag) => tag.replace(/^v|^node-/, '');
  const images = {};
  for (const image of f.images) {
    try {
      // `latest` and the fixed tags are fetched by name; the recent-tags list only names what `latest` is.
      const digest = async (t) => getJson(`${DOCKER_HUB}/v2/repositories/${image}/tags/${encodeURIComponent(t)}`)
        .then((x) => x.digest, (e) => (/HTTP 404/.test(e.message) ? undefined : Promise.reject(e)));
      const latest = await digest('latest');
      const fixedHere = [];
      for (const t of fixed.map(imageTag)) if (await digest(t)) fixedHere.push(t);
      const recent = await getJson(`${DOCKER_HUB}/v2/repositories/${image}/tags?page_size=100&ordering=last_updated`);
      const latestIs = latest ? recent.results.filter((t) => t.name !== 'latest' && t.digest === latest && !/-(arm64|amd64)$/.test(t.name)).map((t) => t.name) : [];
      images[image] = { fixed: fixedHere, latest: latest ? { is: latestIs, fixed: latestIs.some((t) => fixedHere.includes(t)) } : null };
    } catch (e) { images[image] = { error: e.message }; }
  }
  return { fixed, unfixed, images };
}

function printReleases(kind, s) {
  const repo = FIXES[kind].repo.split('/')[1];
  if (s.error) { console.log(`  ${repo}: could not check (${redact(s.error)}). The runbook's Key identifiers list them as of its date.`); return; }
  console.log(`  ${repo} tags with the fix: ${s.fixed.length ? s.fixed.join(', ') : 'none yet'}`);
  for (const [image, i] of Object.entries(s.images)) {
    if (i.error) { console.log(`    ${image}: could not check (${i.error})`); continue; }
    const latest = i.latest === null ? 'there is no `latest` tag'
      : `\`latest\` is ${i.latest.is.join(', ') || 'an untagged build'}${i.latest.fixed ? ', with the fix' : ', without the fix'}`;
    console.log(`    ${image}: ${i.fixed.length ? `images with the fix: ${i.fixed.join(', ')}` : 'no image with the fix'}; ${latest}`);
  }
}

// ---------- report ----------
const iso = (t) => new Date(t * 1000).toISOString().replace('T', ' ').replace('.000Z', ' UTC');
const SOFTWARE = { indexer: 'indexer', node: 'node', unknown: 'node or indexer' };
const KIND_TEXT = {
  'ttl-expired': (h) => `"Intent TTL has expired" (TTL ${h.value}, checked at ${h.used})`,
  'ttl-too-far': (h) => `"Intent TTL is too far in the future" (TTL ${h.value}, latest allowed ${h.max})`,
  'dust-window': (h) => `"dust is outside of its validity window" (DUST time ${h.value}, checked at ${h.used})`,
};
function patternText(v, sw, runtime) {
  if (v.pattern === 'A') {
    const who = v.checkedAt === 'block+12'
      ? (sw === 'indexer' ? ' Only indexer v4.3.4 does that: it adds the 12 s to the block\'s own time.' : '')
      : sw === 'indexer' ? ' Indexer v4.3.5 to v4.3.800-rc.1, and v4.4.0-rc.2 to rc.5, do that.'
        : sw === 'node' ? ' Node 1.0.300 (and 2.1.0-rc.3) does that for blocks from runtimes before 1.0.300.' : '';
    const when = v.checkedAt === 'block+12' ? `its own time + ${BUMP_S} s` : `parent + ${BUMP_S} s`;
    let text = `Known pattern A. The chain accepted this transaction at its block's own time, and your ${sw} checks a block's first transaction at ${when}.${who}`;
    if (runtime >= RUNTIME_1_0_300 && sw !== 'node') {
      text += ` This block was built by runtime 1.0.300 or later, which checks every transaction at block time, so the same version will stop again on later blocks like it: keeping a database past this one doesn't help.`;
    }
    return text;
  }
  if (v.pattern === 'B') {
    return `Known pattern B. The transaction is valid only at parent + ${BUMP_S} s, the time its block's author checked it at, and your ${sw} checks only at the block's own time.`
      + (sw === 'indexer' ? ' Indexer v4.3.3 and earlier, and v4.4.0-rc.1, do that.' : '');
  }
  return `A time mismatch of the same kind. The transaction is valid at ${v.validAtBlock ? "its block's own time" : `parent + ${BUMP_S} s`}, but your ${sw} checked it at a time that is neither.`;
}
const FIX_TEXT = {
  indexer: 'Fix: an indexer release that checks both times (midnight-indexer#1610 and #1537). Restarting the same version stops on the same block every time, because the block is permanent.',
  node: 'Fix: a node release that checks both times (midnight-node#2216). Restarting the same version stops on the same block every time, because the block is permanent.',
  unknown: 'Fix: node and indexer releases that check both times (midnight-node#2216, midnight-indexer#1610).',
};

async function main() {
  if (opts.versions && opts.log === undefined && opts.error === undefined) {
    const out = {};
    for (const kind of ['indexer', 'node']) out[kind] = await releaseStatus(kind).catch((e) => ({ error: e.message }));
    if (opts.json) console.log(redact(JSON.stringify(out, null, 2)));
    else {
      console.log(`Releases with the fix (GitHub tags and Docker Hub, checked ${new Date().toISOString().slice(0, 10)}):`);
      for (const kind of ['indexer', 'node']) printReleases(kind, out[kind]);
    }
    return Object.values(out).some((s) => s.error) ? 1 : 0;
  }

  let text;
  if (opts.error !== undefined) text = opts.error;
  else if (opts.log !== undefined) {
    try { text = fs.readFileSync(opts.log, 'utf8'); } catch (e) { fail(`cannot read ${opts.log}: ${e.code ?? e.message}`); }
  } else if (!process.stdin.isTTY) text = fs.readFileSync(0, 'utf8');
  else fail(`give the halt error with --log, --error or stdin\n${USAGE}`);

  const halt = parseHalt(text);
  if (!halt) {
    const message = 'No halt error found: the input has no "Intent TTL has expired" or "dust is outside of its validity window". This runbook may not apply; see its Symptom section.';
    console.log(opts.json ? JSON.stringify({ halt: null, message }) : message);
    return 2;
  }

  const { sources, notes, network } = await sourcesFor(opts.network);
  if (!network) fail('pass --network: no node at 127.0.0.1:9944 or --rpc URL answered to tell which network this is');
  if (!sources.length) fail(`no source of ${network} block data: ${notes.join('; ')}. Pass --rpc with a node's URL (your own node, if it is past the block) or set BLOCKFROST_PROJECT_ID.`);

  const results = [];
  for (const loc of await locate(halt, sources)) {
    if (loc.notFound || loc.missingBlock) { results.push({ loc }); continue; }
    const runtime = (await first(sources, (s) => s.runtimeAt(loc.height))).value;
    results.push({ loc, runtime, verdict: classify(halt, loc.tb, loc.tp) });
  }
  const known = results.filter((r) => r.verdict && r.verdict.pattern !== 'none');
  const code = known.length ? 0 : results.some((r) => r.loc.notFound || r.loc.missingBlock) ? 3 : 2;

  let releases;
  if (!opts.offline && known.length) {
    releases = {};
    for (const kind of halt.software === 'unknown' ? ['indexer', 'node'] : [halt.software]) releases[kind] = await releaseStatus(kind).catch((e) => ({ error: e.message }));
  }

  if (opts.json) {
    console.log(redact(JSON.stringify({ network, halt, results, releases, notes, exit: code }, null, 2)));
    return code;
  }

  const sw = SOFTWARE[halt.software];
  console.log(`Halt: ${sw} on ${network}, ${KIND_TEXT[halt.kind](halt)}${halt.txHash ? `, transaction ${halt.txHash}` : ''}`);
  for (const n of notes.filter((n) => !/Blockfrost/.test(n) || !known.length)) console.log(`  note: ${redact(n)}`);
  const shown = known.length ? known : [results.find((r) => r.verdict) ?? results[0]];
  if (known.length > 1) console.log(`${known.length} blocks fit the time in the error (${known.map((r) => r.loc.height).join(', ')}), and no source could say which holds the transaction. A log line with its hash, or --rpc with a node, settles it.`);
  for (const { loc, runtime, verdict: v } of shown) {
    if (loc.notFound) {
      console.log('Block: not found. No source had the transaction, and no block fits the time in the error.');
      for (const e of loc.tried ?? []) console.log(`  ${redact(e)}`);
      console.log('Pass --rpc with a node that has the block (a stopped node doesn\'t have the block it stopped on), or set BLOCKFROST_PROJECT_ID, and run it again.');
      continue;
    }
    if (loc.missingBlock) {
      console.log(`Block: probably ${loc.height}, after the last block your sources have (time ${loc.tp}). The error's time is that block's time + ${BUMP_S} s, as in pattern A.`);
      console.log(`A stopped node doesn't have the block it stopped on. To confirm, pass --rpc with another node that is past block ${loc.height}, or set BLOCKFROST_PROJECT_ID.`);
      continue;
    }
    console.log(`Block: ${loc.height}${loc.hash ? ` (${loc.hash.startsWith('0x') ? loc.hash : `0x${loc.hash}`})` : ''}, time ${v.tb} (${iso(v.tb)}); parent time ${v.tp}; parent + ${BUMP_S} s = ${v.bump}${runtime ? `; runtime spec ${runtime}` : ''}`);
    console.log(`  found by ${redact(loc.by)}${loc.sure ? '' : ' (not confirmed: no node could be asked whether it holds the transaction)'}`);
    const at = { block: `the block's own time (${v.used})`, bump: `parent + ${BUMP_S} s (${v.used})`, 'block+12': `the block's own time + ${BUMP_S} s (${v.used})` }[v.checkedAt] ?? `${v.used}, neither the block's own time nor parent + ${BUMP_S} s`;
    console.log(`  your ${sw} checked it at ${at}`);
    console.log(`  valid at the block's own time: ${v.validAtBlock ? 'yes' : 'no'}; valid at parent + ${BUMP_S} s: ${v.validAtBump ? 'yes' : 'no'}`);
    if (v.pattern === 'none') {
      console.log('Not a known pattern: the transaction is invalid at both times a block author could have used. File an issue with this output (runbook, Remediation 5).');
    } else {
      console.log(patternText(v, sw, runtime));
      console.log(FIX_TEXT[halt.software]);
    }
  }
  if (releases) {
    const all = Object.values(releases);
    console.log(all.every((s) => s.error) ? 'Releases with the fix: could not check.' : `Releases with the fix (GitHub tags and Docker Hub, checked ${new Date().toISOString().slice(0, 10)}):`);
    for (const [kind, s] of Object.entries(releases)) printReleases(kind, s);
  }
  console.log('Runbook: node-indexer-sync-halt-runbook.md');
  return code;
}

main().then((code) => { process.exitCode = code; }, (e) => fail(`could not run: ${e.message}`));
