#!/usr/bin/env node
/**
 * check-test-funds.mjs: did the faucet's tNIGHT reach this address, and is it registered for DUST?
 *
 * It answers, for one unshielded address on Preview or Preprod:
 *   1. Is the address one the faucet for that network accepts (prefix, type, checksum)? Offline.
 *   2. With --drip: what does the faucet say about that request (PENDING, CONFIRMED, FAILED)?
 *   3. With --tx, or a CONFIRMED drip: is the faucet's transaction on chain, and did it succeed?
 *   4. Which tNIGHT has reached the address, what is still unspent, and which of it is registered
 *      for DUST generation?
 *
 * It reads only: one GET to the faucet, one GraphQL query and one GraphQL subscription to the
 * network's indexer. It needs the public address, never a seed, and signs nothing.
 *
 * Requirements: Node >= 22 (global fetch and WebSocket). No npm install.
 *
 * Usage:
 *   node check-test-funds.mjs <mn_addr_...> --offline     # the address check only, no request
 *   node check-test-funds.mjs <mn_addr_...>
 *   node check-test-funds.mjs <mn_addr_...> --drip <dripId> --faucet <faucet page URL>
 *   node check-test-funds.mjs <mn_addr_...> --tx <transaction ID the faucet page showed>
 *
 * Preprod reads Blockfrost, so set BLOCKFROST_PROJECT_ID to a Midnight Preprod project id in your
 * environment first. Never pass it as an argument. It is sent only to Blockfrost and removed from
 * everything this script prints.
 *
 * Exit code: 0 = unspent tNIGHT is at the address and all of it is registered for DUST,
 *            2 = a finding (bad address, a request not sent or failed, nothing arrived, unregistered
 *            tNIGHT), 1 = it could not run (bad arguments, missing token, endpoint unreachable).
 */

// Endpoints from the docs' Environment reference (guides/networks-and-environments).
const INDEXERS = {
  preview: {
    http: 'https://indexer.preview.midnight.network/api/v4/graphql',
    ws: 'wss://indexer.preview.midnight.network/api/v4/graphql/ws',
    token: false,
  },
  preprod: {
    http: 'https://midnight-preprod.blockfrost.io/api/v0',
    ws: 'wss://midnight-preprod.blockfrost.io/api/v0/ws',
    token: true,
  },
};
// Address prefixes (Bech32m human-readable parts) from the same page.
const UNSHIELDED_HRP = { mn_addr_preview: 'preview', mn_addr_preprod: 'preprod', mn_addr: 'mainnet' };
const OTHER_TYPES = [['mn_shield-addr', 'a shielded address'], ['mn_dust', 'a DUST address']];
// The faucet's request-status path. Never call the bare API root: see servicedesk#193.
const DRIP_PATH = '/api/drips/';
// The unshielded NIGHT token type, nativeToken() in the ledger.
const NIGHT = '0'.repeat(64);
const STAR_PER_NIGHT = 1_000_000n;
const TIMEOUT_MS = 60_000;

const TOKEN = process.env.BLOCKFROST_PROJECT_ID?.trim() ?? '';
const redact = (s) => (TOKEN ? String(s).split(TOKEN).join('<token>') : String(s));
const say = (s = '') => console.log(redact(s));
const fail = (s) => { console.error(redact(s)); process.exit(1); };

function parseArgs(argv) {
  const out = { address: undefined, drip: undefined, faucet: undefined, tx: undefined, offline: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--offline') out.offline = true;
    else if (a === '--drip' || a === '--faucet' || a === '--tx') {
      const v = argv[++i];
      if (!v || v.startsWith('--')) fail(`${a} needs a value`);
      out[a.slice(2)] = v.trim();
    } else if (!a.startsWith('--') && !out.address) out.address = a.trim();
    else if (!a.startsWith('--') && out.address) fail(`a second address part "${a}": the address has a space in it. Paste it again without spaces, in quotes.`);
    else fail(`unknown argument ${a}\nusage: node check-test-funds.mjs <mn_addr_...> [--offline] [--drip <id> --faucet <url>] [--tx <id>]`);
  }
  if (!out.address) fail('usage: node check-test-funds.mjs <mn_addr_...> [--drip <id> --faucet <url>] [--tx <id>]');
  if (out.drip && !out.faucet) fail('--drip needs --faucet <the faucet page URL you used>');
  if (out.drip && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(out.drip)) fail('--drip is the dripId from the faucet response, like a539eb57-6ef7-4343-9762-49e6bf02c37f');
  if (out.tx && !/^(0x)?[0-9a-f]{64,}$/i.test(out.tx)) fail('--tx is the hex transaction ID the faucet page showed');
  return out;
}

// Bech32m (BIP-350) checksum, so a mistyped or truncated address is caught before any request.
const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
function bech32mValid(addr) {
  const s = addr.toLowerCase();
  if (addr !== s && addr !== addr.toUpperCase()) return false;
  const sep = s.lastIndexOf('1');
  if (sep < 1 || s.length - sep < 7) return false;
  const hrp = s.slice(0, sep);
  const data = [...s.slice(sep + 1)].map((c) => CHARSET.indexOf(c));
  if (data.includes(-1)) return false;
  const values = [...[...hrp].map((c) => c.charCodeAt(0) >> 5), 0, ...[...hrp].map((c) => c.charCodeAt(0) & 31), ...data];
  const G = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >> i) & 1) chk ^= G[i];
  }
  return chk === 0x2bc830a3;
}

function classifyAddress(addr) {
  if (/\s/.test(addr)) return { error: 'the address contains whitespace' };
  for (const [prefix, what] of OTHER_TYPES) {
    if (addr.startsWith(prefix)) return { error: `this is ${what}; the faucet needs the unshielded address, which starts with mn_addr_` };
  }
  const sep = addr.lastIndexOf('1');
  const hrp = sep > 0 ? addr.slice(0, sep).toLowerCase() : '';
  const network = UNSHIELDED_HRP[hrp];
  if (!network) return { error: `the prefix "${hrp || addr.slice(0, 12)}" is not a Midnight unshielded address prefix` };
  if (!bech32mValid(addr)) return { error: 'the checksum is wrong, so the address was mistyped or cut short' };
  // A 32-byte key is 52 five-bit characters, plus 6 checksum characters.
  if (addr.length - sep - 1 !== 52 + 6) return { error: 'the address is the wrong length for an unshielded address, so it was cut short or altered' };
  return { network };
}

function withToken(url, net) {
  if (!INDEXERS[net].token) return url;
  return `${url}${url.includes('?') ? '&' : '?'}project_id=${encodeURIComponent(TOKEN)}`;
}

async function getJson(url, init) {
  const ctl = AbortSignal.timeout(TIMEOUT_MS);
  const r = await fetch(url, { ...init, signal: ctl });
  const text = await r.text();
  let body;
  try { body = JSON.parse(text); } catch { body = undefined; }
  return { status: r.status, body, text };
}

async function dripStatus(faucet, id) {
  let origin;
  try { origin = new URL(faucet).origin; } catch { fail(`--faucet is not a URL: ${faucet}`); }
  const r = await getJson(`${origin}${DRIP_PATH}${id}`);
  if (r.status !== 200 || !r.body?.status) fail(`${origin} answered HTTP ${r.status} with no drip status: is --faucet the faucet page that made the request?`);
  return r.body;
}

async function findTransaction(net, identifier) {
  const id = identifier.replace(/^0x/i, '').toLowerCase();
  // The faucet returns the transaction's identifier; a reader may paste its hash from an explorer.
  for (const kind of ['identifier', 'hash']) {
    const query = `query($i: HexEncoded!) { transactions(offset: { ${kind}: $i }) { id hash block { height timestamp } unshieldedCreatedOutputs { owner tokenType value } ... on RegularTransaction { transactionResult { status } } } }`;
    const r = await getJson(withToken(INDEXERS[net].http, net), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables: { i: id } }),
    });
    if (r.status !== 200 || r.body?.errors) fail(`the indexer answered HTTP ${r.status}: ${(r.body?.errors?.[0]?.message ?? r.text).slice(0, 200)}`);
    const tx = r.body.data?.transactions?.[0];
    if (tx) return tx;
  }
  return undefined;
}

// Streams the address's unshielded transactions until the indexer says there are no more.
function unshieldedHistory(net, address) {
  const query = `subscription($a: UnshieldedAddress!) { unshieldedTransactions(address: $a) {
    __typename
    ... on UnshieldedTransaction { transaction { id block { timestamp } }
      createdUtxos { owner tokenType value intentHash outputIndex registeredForDustGeneration }
      spentUtxos { owner tokenType intentHash outputIndex } }
    ... on UnshieldedTransactionsProgress { highestTransactionId } } }`;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(withToken(INDEXERS[net].ws, net), 'graphql-transport-ws');
    const txs = [];
    let highest = null, last = null, settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch {}
      if (err) reject(err); else resolve(txs);
    };
    const timer = setTimeout(() => finish(new Error(`no complete answer from the indexer in ${TIMEOUT_MS / 1000} s`)), TIMEOUT_MS);
    ws.onopen = () => ws.send(JSON.stringify({ type: 'connection_init' }));
    ws.onerror = () => finish(new Error('could not connect to the indexer WebSocket (check the network and, on Preprod, the project id)'));
    ws.onclose = (e) => finish(new Error(`the indexer closed the connection (${e.code}${e.reason ? `: ${e.reason}` : ''})`));
    ws.onmessage = (m) => {
      let msg;
      try { msg = JSON.parse(m.data); } catch { return finish(new Error('the indexer sent a message that is not JSON')); }
      if (msg.type === 'connection_ack') {
        ws.send(JSON.stringify({ id: '1', type: 'subscribe', payload: { query, variables: { a: address } } }));
        return;
      }
      if (msg.type === 'error') return finish(new Error(msg.payload?.[0]?.message ?? 'subscription error'));
      if (msg.type !== 'next') return;
      if (msg.payload.errors) return finish(new Error(msg.payload.errors[0].message));
      const ev = msg.payload.data?.unshieldedTransactions;
      if (!ev) return finish(new Error('the indexer answered without unshieldedTransactions'));
      if (ev.__typename === 'UnshieldedTransactionsProgress') highest = ev.highestTransactionId;
      else { txs.push(ev); last = ev.transaction.id; }
      if (highest === 0 || (highest !== null && last !== null && last >= highest)) finish();
    };
  });
}

const night = (stars) => {
  const s = BigInt(stars);
  const frac = (s % STAR_PER_NIGHT).toString().padStart(6, '0').replace(/0+$/, '');
  return `${s / STAR_PER_NIGHT}${frac ? `.${frac}` : ''} tNIGHT`;
};
const when = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

async function main() {
  if (typeof WebSocket !== 'function') fail(`Node >= 22 is required (this is ${process.version}, which has no global WebSocket).`);
  const args = parseArgs(process.argv.slice(2));
  const addr = classifyAddress(args.address);
  if (addr.error) {
    say(`ADDRESS FINDING: ${addr.error}. Diagnose 1.`);
    process.exit(2);
  }
  const net = addr.network;
  // Bech32m allows an all-uppercase address; the indexer and the faucet match the lowercase form.
  args.address = args.address.toLowerCase();
  if (net === 'mainnet') {
    say('ADDRESS FINDING: this is a mainnet address. Mainnet has no faucet; use a Preview or Preprod address. Diagnose 1.');
    process.exit(2);
  }
  say(`ADDRESS ok: an unshielded ${net} address`);
  if (args.offline) process.exit(0);
  if (INDEXERS[net].token && !TOKEN) fail(`${net} reads the Blockfrost indexer: set BLOCKFROST_PROJECT_ID to a Midnight ${net} project id first.`);

  let finding = false;
  let identifier = args.tx;
  if (args.drip) {
    const d = await dripStatus(args.faucet, args.drip);
    if (d.status === 'CONFIRMED') {
      say(`REQUEST ok: CONFIRMED, transaction ID ${d.transactionHash}`);
      identifier ??= d.transactionHash ?? undefined;
    } else if (d.status === 'PENDING') {
      say(`REQUEST FINDING: PENDING (taskStatus ${d.taskStatus}): the faucet has not sent it yet. Diagnose 2.`);
      finding = true;
    } else {
      say(`REQUEST FINDING: ${d.status}: ${d.error ?? 'no reason given'}. Diagnose 2.`);
      finding = true;
    }
  }

  if (identifier) {
    const tx = await findTransaction(net, identifier);
    if (!tx) {
      say(`ON CHAIN FINDING: the ${net} indexer has no transaction with ID ${identifier}. Diagnose 2.`);
      finding = true;
    } else {
      const status = tx.transactionResult?.status ?? 'unknown';
      const paid = tx.unshieldedCreatedOutputs.filter((u) => u.owner === args.address && u.tokenType === NIGHT).reduce((n, u) => n + BigInt(u.value), 0n);
      say(`ON CHAIN ${status === 'SUCCESS' ? 'ok' : 'FINDING'}: ${status} in block ${tx.block.height} at ${when(tx.block.timestamp)} (indexer tx ${tx.id})${status === 'SUCCESS' ? '' : '. Stop and escalate.'}`);
      if (status !== 'SUCCESS') finding = true;
      else if (paid === 0n) {
        say('ON CHAIN FINDING: this transaction paid no tNIGHT to this address, so the faucet was given another address. Remediation 1.');
        finding = true;
      } else say(`ON CHAIN ok: it paid ${night(paid)} to this address`);
    }
  }

  const history = await unshieldedHistory(net, args.address);
  const key = (u) => `${u.intentHash}:${u.outputIndex}`;
  const spent = new Set(history.flatMap((t) => t.spentUtxos.filter((u) => u.owner === args.address).map(key)));
  const deposits = history.flatMap((t) => t.createdUtxos
    .filter((u) => u.owner === args.address && u.tokenType === NIGHT)
    .map((u) => ({ ...u, at: t.transaction.block.timestamp, spent: spent.has(key(u)) })));
  const unspent = deposits.filter((u) => !u.spent);
  const registered = unspent.filter((u) => u.registeredForDustGeneration);
  const sum = (us) => us.reduce((n, u) => n + BigInt(u.value), 0n);

  if (deposits.length === 0) {
    say(`TNIGHT FINDING: no tNIGHT has ever reached this address on ${net}. Diagnose 2.`);
    process.exit(2);
  }
  for (const u of deposits) say(`TNIGHT ${when(u.at)}  ${night(u.value).padStart(16)}  ${u.spent ? 'spent' : u.registeredForDustGeneration ? 'unspent, registered for DUST' : 'unspent, NOT registered for DUST'}`);
  say(`TNIGHT unspent: ${night(sum(unspent))} in ${unspent.length} UTXO(s), ${registered.length} registered for DUST`);
  if (unspent.length === 0) {
    say('DUST FINDING: every tNIGHT UTXO here has been spent, so nothing here generates DUST. Diagnose 3.');
    process.exit(2);
  }
  if (registered.length < unspent.length) {
    say(`DUST FINDING: ${unspent.length - registered.length} unspent UTXO(s), ${night(sum(unspent) - sum(registered))}, are not registered, so they generate no DUST. Remediation 3.`);
    process.exit(2);
  }
  say('DUST ok: all unspent tNIGHT is registered, so DUST is accruing to the DUST address it was registered to. If the wallet still shows none, Diagnose 3.');
  process.exit(finding ? 2 : 0);
}

main().catch((e) => fail(`could not run: ${e.message}`));
