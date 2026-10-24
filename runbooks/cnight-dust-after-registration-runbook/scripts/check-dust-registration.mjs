#!/usr/bin/env node
/**
 * check-dust-registration.mjs: has this cNIGHT registration reached Midnight, and is it generating DUST?
 *
 * It answers, for one Cardano stake key on Mainnet, Preprod or Preview:
 *   1. How many registrations does the key have live at the mapping validator on Cardano, and when
 *      was each made? (Koios, no key needed.)
 *   2. Were any made or removed recently, in the transactions that touch the key?
 *   3. How much cNIGHT does the key hold on Cardano?
 *   4. Has Midnight picked the registration up, which DUST address does it generate for, and how
 *      much NIGHT does it count? (The network's Midnight indexer.)
 *
 * It needs the public stake address (stake1..., stake_test1...) or a Cardano address that carries the
 * stake key (addr1q..., addr_test1q...). It never needs a seed, and it signs nothing.
 *
 * Requirements: Node >= 18 (global fetch). No npm install.
 *
 * Usage:
 *   node check-dust-registration.mjs <stake1... | addr1...>
 *   node check-dust-registration.mjs <stake_test1... | addr_test1...> --network preprod|preview
 *   add --dust <mn_dust...>   to check that DUST goes to this DUST address (the wallet's)
 *   add --cardano-only        to skip the Midnight indexer (no Blockfrost project id needed)
 *
 * Mainnet and Preprod read the Midnight indexer on Blockfrost, so set BLOCKFROST_PROJECT_ID to a
 * Midnight project id for that network in your environment first. Never pass it as an argument. It is
 * sent only to Blockfrost and removed from everything this script prints.
 *
 * Exit code: 0 = registered once and generating DUST for the expected address (with --cardano-only:
 *                registered once, and the key holds cNIGHT),
 *            2 = a finding (each FINDING line names the runbook step),
 *            1 = it could not run (bad arguments, missing project id, an endpoint unreachable).
 */

import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// The cNIGHT -> DUST mapping validator and the cNIGHT token for each Cardano network, from the node's
// res/<network>/cnight-config.json (midnightntwrk/midnight-node). Preview and Preprod share the
// validator, each on its own Cardano network. waitHours is how long the cNgD DApp tells users to wait
// before DUST starts (its IndexerSyncBanner).
const TESTNET_VALIDATOR = 'addr_test1wplxjzranravtp574s2wz00md7vz9rzpucu252je68u9a8qzjheng';
const NETWORKS = {
  mainnet: {
    koios: 'https://api.koios.rest/api/v1',
    validator: 'addr1w9e7ft4rrdd4rkdseguxr9hudfxyytm5ckh2qy0yhz7lfeg9lvhq7',
    cnight: { policy: '0691b2fecca1ac4f53cb6dfb00b7013e561d1f34403b957cbb5af1fa', name: '4e49474854' },
    indexer: 'https://midnight-mainnet.blockfrost.io/api/v0',
    token: true,
    stakeHrp: 'stake',
    dustHrp: 'mn_dust',
    waitHours: 12,
  },
  preprod: {
    koios: 'https://preprod.koios.rest/api/v1',
    validator: TESTNET_VALIDATOR,
    cnight: { policy: 'd2dbff622e509dda256fedbd31ef6e9fd98ed49ad91d5c0e07f68af1', name: '' },
    indexer: 'https://midnight-preprod.blockfrost.io/api/v0',
    token: true,
    stakeHrp: 'stake_test',
    dustHrp: 'mn_dust_preprod',
    waitHours: 12,
  },
  preview: {
    koios: 'https://preview.koios.rest/api/v1',
    validator: TESTNET_VALIDATOR,
    cnight: { policy: 'd2dbff622e509dda256fedbd31ef6e9fd98ed49ad91d5c0e07f68af1', name: '' },
    indexer: 'https://indexer.preview.midnight.network/api/v4/graphql',
    token: false,
    stakeHrp: 'stake_test',
    dustHrp: 'mn_dust_preview',
    waitHours: 2.5,
  },
};
// The registration datum: Constr0[ Constr0[ bytes28 stake key hash ], bytes dust_address ].
const DATUM_PREFIX = 'd8799fd8799f581c';
// Past 24 hours with no sign on Midnight, escalate.
const ESCALATE_HOURS = 24;
// The newest transactions read for the history; a busy key has thousands.
const HISTORY_TXS = 100;
const SHOWN = 10;
const STAR_PER_NIGHT = 1_000_000n;
const SPECK_PER_DUST = 1_000_000_000_000_000n;
const TIMEOUT_MS = 60_000;

const TOKEN = process.env.BLOCKFROST_PROJECT_ID?.trim() ?? '';
const redact = (s) => (TOKEN ? String(s).split(TOKEN).join('<token>') : String(s));
const say = (s = '') => console.log(redact(s));
const fail = (s) => { console.error(redact(s)); process.exit(1); };
const USAGE = 'usage: node check-dust-registration.mjs <stake1... | addr1...> [--network preprod|preview] [--dust <mn_dust...>] [--cardano-only]';

function parseArgs(argv) {
  const out = { address: undefined, network: undefined, dust: undefined, cardanoOnly: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--cardano-only') out.cardanoOnly = true;
    else if (a === '--network' || a === '--dust') {
      const v = argv[++i];
      if (!v || v.startsWith('--')) fail(`${a} needs a value`);
      out[a.slice(2)] = v.trim();
    } else if (!a.startsWith('--') && !out.address) out.address = a.trim();
    else if (!a.startsWith('--')) fail(`a second address part "${a}": the address has a space in it. Paste it again without spaces, in quotes.`);
    else fail(`unknown argument ${a}\n${USAGE}`);
  }
  if (!out.address) fail(USAGE);
  if (out.network && !NETWORKS[out.network]) fail(`--network is mainnet, preprod or preview, not "${out.network}"`);
  return out;
}

// Bech32 (BIP-173, Cardano addresses) and Bech32m (BIP-350, Midnight addresses).
const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const BECH32 = 1, BECH32M = 0x2bc830a3;
function polymod(values) {
  const G = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >> i) & 1) chk ^= G[i];
  }
  return chk;
}
const hrpExpand = (hrp) => [...[...hrp].map((c) => c.charCodeAt(0) >> 5), 0, ...[...hrp].map((c) => c.charCodeAt(0) & 31)];
function convertBits(data, from, to, pad) {
  let acc = 0, bits = 0;
  const out = [], max = (1 << to) - 1;
  for (const v of data) {
    acc = (acc << from) | v;
    bits += from;
    while (bits >= to) { bits -= to; out.push((acc >> bits) & max); }
  }
  if (pad && bits) out.push((acc << (to - bits)) & max);
  // Unpadding: five or more leftover bits, or any of them set, is not a valid encoding.
  else if (!pad && (bits >= from || ((acc << (to - bits)) & max))) return undefined;
  return out;
}
// Returns { hrp, bytes, encoding } or undefined for anything that is not a well-formed address.
export function bech32Decode(addr) {
  if (addr !== addr.toLowerCase() && addr !== addr.toUpperCase()) return undefined;
  const s = addr.toLowerCase();
  const sep = s.lastIndexOf('1');
  if (sep < 1 || s.length - sep < 7) return undefined;
  const hrp = s.slice(0, sep);
  const data = [...s.slice(sep + 1)].map((c) => CHARSET.indexOf(c));
  if (data.includes(-1)) return undefined;
  const chk = polymod([...hrpExpand(hrp), ...data]);
  const encoding = chk === BECH32 ? 'bech32' : chk === BECH32M ? 'bech32m' : undefined;
  if (!encoding) return undefined;
  const bytes = convertBits(data.slice(0, -6), 5, 8, false);
  if (!bytes) return undefined;
  return { hrp, bytes: Uint8Array.from(bytes), encoding };
}
export function bech32Encode(hrp, bytes, encoding = 'bech32') {
  const data = convertBits([...bytes], 8, 5, true);
  const mod = polymod([...hrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0]) ^ (encoding === 'bech32m' ? BECH32M : BECH32);
  const chk = [0, 1, 2, 3, 4, 5].map((i) => (mod >> (5 * (5 - i))) & 31);
  return `${hrp}1${[...data, ...chk].map((d) => CHARSET[d]).join('')}`;
}
const hex = (bytes) => Buffer.from(bytes).toString('hex');

// The stake key in a Cardano address: { mainnet, credential } or { error }.
export function stakeKeyOf(addr) {
  if (/\s/.test(addr)) return { error: 'the address contains whitespace' };
  if (/^(mn_|midnight)/i.test(addr)) return { error: 'this is a Midnight address; give the Cardano wallet\'s stake address (stake1...) or its address (addr1...)' };
  if (/^(Ae2|DdzFF)/.test(addr)) return { error: 'this is a Byron address, which has no stake key, so it cannot register for DUST' };
  const d = bech32Decode(addr);
  if (!d || d.encoding !== 'bech32') return { error: 'the checksum is wrong or it is not a Cardano address, so it was mistyped or cut short' };
  const header = d.bytes[0], type = header >> 4, net = header & 0x0f;
  const mainnet = net === 1;
  if (net > 1) return { error: `the network id ${net} in this address is not Mainnet or a testnet` };
  const expectHrp = (kind) => `${kind}${mainnet ? '' : '_test'}`;
  if (type === 0x0e || type === 0x0f) {
    if (d.hrp !== expectHrp('stake') || d.bytes.length !== 29) return { error: 'this stake address is malformed' };
    if (type === 0x0f) return { error: 'this stake address is a script, and a DUST registration names a key-based stake key' };
    return { mainnet, credential: hex(d.bytes.slice(1)) };
  }
  if (type <= 3) {
    if (d.hrp !== expectHrp('addr') || d.bytes.length !== 57) return { error: 'this address is malformed' };
    if (type >= 2) return { error: 'this address\'s stake part is a script, and a DUST registration names a key-based stake key' };
    return { mainnet, credential: hex(d.bytes.slice(29)) };
  }
  if (type === 6 || type === 7) return { error: 'this is an enterprise address, which has no stake key; give the wallet\'s stake address (stake1...) or an address starting addr1q' };
  return { error: 'this kind of address carries no stake key; give the wallet\'s stake address (stake1...)' };
}

// The DUST address the user expects: { payload } or { error }.
export function dustAddressOf(addr, net) {
  const want = NETWORKS[net].dustHrp;
  if (/^mn_addr|^mn_shield/i.test(addr)) return { error: `the --dust address is not a DUST address; the wallet's DUST address starts with ${want}1` };
  const d = bech32Decode(addr);
  if (!d || d.encoding !== 'bech32m') return { error: 'the --dust address checksum is wrong, so it was mistyped or cut short' };
  if (d.hrp !== want) return { error: `the --dust address is for ${d.hrp.replace(/^mn_dust_?/, '') || 'mainnet'}, not ${net}` };
  return { payload: hex(d.bytes) };
}

async function getJson(url, init) {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const text = await r.text();
  let body;
  try { body = JSON.parse(text); } catch { body = undefined; }
  if (r.status !== 200) throw new Error(`${new URL(url).host} answered HTTP ${r.status}: ${(body?.message ?? body?.errors?.[0]?.message ?? text).toString().slice(0, 200)}`);
  return body;
}
const koiosPost = (net, path, body) => getJson(`${NETWORKS[net].koios}${path}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
  body: JSON.stringify(body),
});

function parseDatum(bytes) {
  if (!bytes?.startsWith(DATUM_PREFIX)) return undefined;
  const credential = bytes.slice(DATUM_PREFIX.length, DATUM_PREFIX.length + 56);
  let rest = bytes.slice(DATUM_PREFIX.length + 56);
  if (rest.startsWith('ff')) rest = rest.slice(2);
  // A CBOR byte string: 0x40-0x57 carry the length in the head, 0x58 in the next byte.
  const head = parseInt(rest.slice(0, 2), 16);
  let dust;
  if (head === 0x58) dust = rest.slice(4, 4 + 2 * parseInt(rest.slice(2, 4), 16));
  else if (head >= 0x40 && head < 0x58) dust = rest.slice(2, 2 + 2 * (head - 0x40));
  return { credential, dust };
}

// The live registrations for the key at the validator, filtered by the datum's stake key.
async function liveRegistrations(net, credential) {
  const filter = encodeURIComponent('inline_datum->>bytes').replace(/%2D/g, '-') + `=like.${DATUM_PREFIX}${credential}%2A`;
  const rows = await koiosPost(net, `/address_utxos?${filter}`, { _addresses: [NETWORKS[net].validator], _extended: true });
  return rows.map((u) => ({ u, d: parseDatum(u.inline_datum?.bytes) }))
    .filter(({ d }) => d?.credential === credential)
    .map(({ u, d }) => ({ tx: u.tx_hash, ix: u.tx_index, time: u.block_time, dust: d.dust }))
    .sort((a, b) => a.time - b.time);
}

// The cNIGHT at addresses with this stake key: all of it, and the part that arrived in the last
// waitHours, which Midnight does not count yet.
async function cnightHeld(net, stake, now) {
  const rows = await koiosPost(net, '/account_utxos', { _stake_addresses: [stake], _extended: true });
  const { policy, name } = NETWORKS[net].cnight;
  let total = 0n, recent = 0n;
  for (const u of rows) {
    const q = (u.asset_list ?? []).filter((a) => a.policy_id === policy && (a.asset_name ?? '') === name).reduce((n, a) => n + BigInt(a.quantity), 0n);
    total += q;
    if (now - u.block_time < NETWORKS[net].waitHours * 3600) recent += q;
  }
  return { total, recent };
}

// Registrations made and removed in the key's newest transactions.
async function history(net, stake, credential) {
  const newest = await getJson(`${NETWORKS[net].koios}/account_txs?_stake_address=${stake}&order=block_height.desc&limit=${HISTORY_TXS}`, { headers: { Accept: 'application/json' } });
  const validator = NETWORKS[net].validator;
  const candidates = [];
  for (let i = 0; i < newest.length; i += 50) {
    const info = await koiosPost(net, '/tx_info', { _tx_hashes: newest.slice(i, i + 50).map((t) => t.tx_hash), _inputs: true, _assets: false, _withdrawals: false, _certs: false, _scripts: false, _bytecode: false });
    for (const t of info) {
      for (const o of t.outputs) if (o.payment_addr?.bech32 === validator) candidates.push({ type: 'registered', ref: `${t.tx_hash}#${o.tx_index}`, tx: t.tx_hash, time: t.tx_timestamp });
      for (const o of t.inputs ?? []) if (o.payment_addr?.bech32 === validator) candidates.push({ type: 'removed', ref: `${o.tx_hash}#${o.tx_index}`, tx: t.tx_hash, time: t.tx_timestamp });
    }
  }
  const datums = new Map();
  const refs = [...new Set(candidates.map((c) => c.ref))];
  for (let i = 0; i < refs.length; i += 50) {
    for (const u of await koiosPost(net, '/utxo_info', { _utxo_refs: refs.slice(i, i + 50), _extended: true })) {
      datums.set(`${u.tx_hash}#${u.tx_index}`, parseDatum(u.inline_datum?.bytes));
    }
  }
  const events = candidates.filter((c) => datums.get(c.ref)?.credential === credential)
    .map((c) => ({ ...c, dust: datums.get(c.ref).dust }))
    // A transaction that replaces a registration removes the old one before the new one counts.
    .sort((a, b) => a.time - b.time || (a.type === 'removed' ? -1 : 1));
  return { events, read: newest.length };
}

async function midnightState(net, stake) {
  const n = NETWORKS[net];
  const query = `query($a: [CardanoRewardAddress!]!) {
    dustGenerationStatus(cardanoRewardAddresses: $a) { registered dustAddress nightBalance generationRate currentCapacity utxoTxHash utxoOutputIndex }
    dustGenerations(cardanoRewardAddresses: $a) { registrations { dustAddress valid nightBalance generationRate maxCapacity currentCapacity utxoTxHash utxoOutputIndex } } }`;
  const r = await fetch(n.indexer, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(n.token ? { project_id: TOKEN } : {}) },
    body: JSON.stringify({ query, variables: { a: [stake] } }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await r.text();
  let body;
  try { body = JSON.parse(text); } catch { body = undefined; }
  if (r.status === 403 || r.status === 401) throw new Error(`the ${net} indexer refused the project id (HTTP ${r.status}): is BLOCKFROST_PROJECT_ID a Midnight ${net} project?`);
  if (r.status !== 200 || !body) throw new Error(`the ${net} indexer answered HTTP ${r.status}: ${text.slice(0, 200)}`);
  if (body.errors) throw new Error(`the ${net} indexer answered: ${body.errors[0].message}`);
  return { status: body.data.dustGenerationStatus[0], registrations: body.data.dustGenerations[0]?.registrations ?? [] };
}

const night = (stars) => {
  const s = BigInt(stars);
  const frac = (s % STAR_PER_NIGHT).toString().padStart(6, '0').replace(/0+$/, '');
  return `${s / STAR_PER_NIGHT}${frac ? `.${frac}` : ''} NIGHT`;
};
const dust = (specks) => {
  const s = BigInt(specks);
  const milli = (s * 1000n) / SPECK_PER_DUST;
  const frac = (milli % 1000n).toString().padStart(3, '0').replace(/0+$/, '');
  return `${milli / 1000n}${frac ? `.${frac}` : ''} DUST`;
};
const when = (secs) => new Date(secs * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
const hours = (h) => (h < 48 ? `${h.toFixed(1)} h` : `${(h / 24).toFixed(1)} days`);

// The report for the facts gathered, and the exit code it gives. Exported so the test can feed it
// recorded answers. facts: { net, stake, now, live, history?, cnight?, others, midnight?, expectDust? }
export function report(facts) {
  const { net, now, live } = facts;
  const n = NETWORKS[net];
  const WAIT_HOURS = n.waitHours;
  const dustBech = (payload) => (payload ? bech32Encode(n.dustHrp, Buffer.from(payload, 'hex'), 'bech32m') : 'none');
  const lines = [];
  const ageH = (t) => (now - t) / 3600;

  lines.push(`CARDANO ${live.length} live registration(s) for this stake key at the ${net} mapping validator`);
  for (const r of live) lines.push(`CARDANO ${when(r.time)}  ${r.tx}#${r.ix}  ${hours(ageH(r.time))} ago  DUST address ${dustBech(r.dust)}`);
  if (facts.history) {
    const ev = facts.history.events;
    if (ev.length > SHOWN) lines.push(`HISTORY ${ev.length - SHOWN} earlier event(s) not shown`);
    for (const e of ev.slice(-SHOWN)) lines.push(`HISTORY ${when(e.time)}  ${e.type === 'registered' ? `registered  ${e.ref}` : `removed     ${e.ref}, in ${e.tx}`}`);
    if (ev.length === 0) lines.push(`HISTORY no registration made or removed in the ${facts.history.read} newest transaction(s) that touch this stake key`);
    if (facts.history.read >= HISTORY_TXS) lines.push(`HISTORY read only the ${HISTORY_TXS} newest transactions that touch this stake key`);
  }
  if (facts.cnight) lines.push(`NIGHT ${night(facts.cnight.total)} (cNIGHT) held by this stake key on Cardano${facts.cnight.recent ? `, ${night(facts.cnight.recent)} of it received in the last ${WAIT_HOURS} hours` : ''}`);
  for (const o of facts.others) lines.push(`OTHER NETWORK ${o.count} live registration(s) for the same key on Cardano ${o.net}`);

  const m = facts.midnight;
  if (m) {
    const valid = m.registrations.filter((r) => r.valid);
    lines.push(`MIDNIGHT ${m.status.registered ? 'registered' : 'not registered'}${m.status.utxoTxHash ? `, following ${m.status.utxoTxHash}#${m.status.utxoOutputIndex}` : ''}${m.status.dustAddress ? `, DUST address ${m.status.dustAddress}` : ''}`);
    for (const r of m.registrations) {
      lines.push(`MIDNIGHT ${r.valid ? 'valid' : 'NOT valid'}: ${night(r.nightBalance)} generating ${dust(BigInt(r.generationRate) * 3_600n)} per hour for ${r.dustAddress}; now ${dust(r.currentCapacity)} of a ${dust(r.maxCapacity)} cap (the indexer's estimate, before DUST spent on fees)`);
    }
    if (valid.length === 0 && m.registrations.length === 0 && !m.status.registered) lines.push('MIDNIGHT no registration for this stake key');
  } else if (facts.midnightSkipped) lines.push('MIDNIGHT not checked (--cardano-only)');

  const finding = (s) => { lines.push(s); return { lines, code: 2 }; };

  // No registration on Cardano.
  if (live.length === 0) {
    const last = facts.history?.events.at(-1);
    if (last?.type === 'removed') return finding(`REGISTRATION FINDING: nothing is registered now. The last registration, ${last.ref}, was removed on ${when(last.time)} in ${last.tx}, so no DUST is generated. A DApp page that still says "Registration Syncing" is showing the removed registration. Diagnose 2, then Remediation 1.`);
    if (facts.others.length) return finding(`REGISTRATION FINDING: this key has no registration on Cardano ${net}, only on ${facts.others.map((o) => o.net).join(' and ')}. A registration counts only on its own network, so register on ${net} too. Remediation 1.`);
    return finding(`REGISTRATION FINDING: this stake key has no registration on Cardano ${net}, so no DUST is generated. Remediation 1.`);
  }
  // Two or more: the chain treats the key as unregistered.
  if (live.length > 1) return finding(`REGISTRATION FINDING: ${live.length} live registrations for one stake key. Midnight treats the key as unregistered, so no DUST is generated. Follow the cNIGHT->DUST duplicate registrations runbook.`);

  const reg = live[0];
  const age = ageH(reg.time);
  if (!m) {
    if (facts.cnight?.total === 0n) return finding('NIGHT FINDING: registered once, but this stake key holds no cNIGHT on Cardano, so there is nothing to generate DUST from. Remediation 3.');
    lines.push(`REGISTRATION ok: registered once, ${hours(age)} ago. Run again without --cardano-only to check Midnight.`);
    return { lines, code: 0 };
  }

  const following = m.status.utxoTxHash === reg.tx && m.status.utxoOutputIndex === reg.ix;
  const pickedUp = m.status.registered && (following || !m.status.utxoTxHash);
  if (!pickedUp) {
    const what = m.status.registered ? `Midnight still follows an older registration, ${m.status.utxoTxHash}#${m.status.utxoOutputIndex}` : 'Midnight has not picked it up yet';
    if (age < WAIT_HOURS) return finding(`WAIT FINDING: registered ${hours(age)} ago and ${what}. It takes about ${WAIT_HOURS} hours, so expect it after ${when(reg.time + WAIT_HOURS * 3600)}. Do not register again. Diagnose 1.`);
    if (age < ESCALATE_HOURS) return finding(`WAIT FINDING: registered ${hours(age)} ago and ${what}, which is later than usual. Check again after ${when(reg.time + ESCALATE_HOURS * 3600)}. Do not register again. Diagnose 1.`);
    return finding(`ESCALATE FINDING: registered ${hours(age)} ago and ${what}. Open a servicedesk issue with this output. Diagnose 1.`);
  }

  if (reg.dust && m.status.dustAddress && dustBech(reg.dust) !== m.status.dustAddress) {
    return finding(`ESCALATE FINDING: the DUST address on Cardano (${dustBech(reg.dust)}) and on Midnight (${m.status.dustAddress}) differ. Open a servicedesk issue with this output.`);
  }
  if (facts.expectDust && facts.expectDust !== reg.dust) {
    return finding(`DUST ADDRESS FINDING: DUST is generated for ${dustBech(reg.dust)}, not for the DUST address given (${dustBech(facts.expectDust)}). The DUST is in the other address's wallet. Diagnose 3, then Remediation 2.`);
  }
  const generating = m.registrations.filter((r) => r.valid && r.dustAddress === m.status.dustAddress).reduce((s, r) => s + BigInt(r.nightBalance), 0n);
  const held = facts.cnight;
  if (held?.total === 0n) return finding('NIGHT FINDING: registered, but this stake key holds no cNIGHT on Cardano, so there is nothing to generate DUST from. Remediation 3.');
  if (generating === 0n) {
    if (held && held.recent === held.total) return finding(`WAIT FINDING: registered, but all ${night(held.total)} the key holds arrived in the last ${WAIT_HOURS} hours, and Midnight does not count it yet. Check again after ${WAIT_HOURS} hours. Diagnose 1.`);
    return finding(`ESCALATE FINDING: registered, but Midnight counts no NIGHT generating DUST for it${held ? `, although the key has held ${night(held.total - held.recent)} for more than ${WAIT_HOURS} hours` : ''}. Open a servicedesk issue with this output. Diagnose 1.`);
  }
  if (held && generating < held.total) {
    if (generating >= held.total - held.recent) lines.push(`NIGHT note: Midnight counts ${night(generating)} of the ${night(held.total)} the key holds. The ${night(held.recent)} received in the last ${WAIT_HOURS} hours is not counted yet.`);
    else lines.push(`NIGHT note: Midnight counts ${night(generating)}, less than the ${night(held.total - held.recent)} the key has held for more than ${WAIT_HOURS} hours. If it is still short tomorrow, open a servicedesk issue with this output.`);
  }
  // The DApp's Generation Rate, and its DUST Balance with no Midnight wallet connected, come from
  // dustGenerationStatus, which reads only the newest generating UTXO for the DUST address.
  if (m.status.nightBalance !== undefined && BigInt(m.status.nightBalance) < generating) {
    lines.push(`DAPP note: the DUST DApp's Generation Rate shows ${dust(BigInt(m.status.generationRate) * 3_600n)} per hour, and with no Midnight wallet connected its DUST Balance shows ${dust(m.status.currentCapacity)}. Those figures count only ${night(m.status.nightBalance)}, the newest of the UTXOs generating DUST, so they are lower than the totals above. Diagnose 4.`);
  }
  lines.push(`DUST ok: registered once and generating DUST for ${m.status.dustAddress}. If the wallet shows less or none, Diagnose 4.`);
  return { lines, code: 0 };
}

// Everything report() needs, read from Koios and the Midnight indexer. Exported so the test's
// recording can be refreshed with the same reads.
export async function gatherFacts({ net, credential, stake, expectDust, cardanoOnly }) {
  const now = Math.floor(Date.now() / 1000);
  const live = await liveRegistrations(net, credential);
  const others = [];
  for (const other of Object.keys(NETWORKS).filter((o) => o !== net)) {
    try {
      const found = await liveRegistrations(other, credential);
      if (found.length) others.push({ net: other, count: found.length });
    } catch { /* another network's answer is only a hint */ }
  }
  return {
    net, stake, now, live, others, expectDust,
    cnight: await cnightHeld(net, stake, now),
    history: await history(net, stake, credential),
    midnight: cardanoOnly ? undefined : await midnightState(net, stake),
    midnightSkipped: Boolean(cardanoOnly),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const key = stakeKeyOf(args.address);
  if (key.error) { say(`ADDRESS FINDING: ${key.error}.`); process.exit(2); }
  let net = args.network;
  if (key.mainnet && net && net !== 'mainnet') { say(`ADDRESS FINDING: this is a Mainnet address, not ${net}. Leave out --network.`); process.exit(2); }
  if (!key.mainnet && net === 'mainnet') { say('ADDRESS FINDING: this is a testnet address. Use --network preprod or --network preview.'); process.exit(2); }
  if (key.mainnet) net = 'mainnet';
  else if (!net) fail('a testnet address works on Preprod and Preview: add --network preprod or --network preview');
  const stake = bech32Encode(NETWORKS[net].stakeHrp, Buffer.from(`${key.mainnet ? 'e1' : 'e0'}${key.credential}`, 'hex'));
  say(`ADDRESS ok: stake key ${key.credential} on ${net} (${stake})`);
  let expectDust;
  if (args.dust) {
    const d = dustAddressOf(args.dust, net);
    if (d.error) { say(`ADDRESS FINDING: ${d.error}.`); process.exit(2); }
    expectDust = d.payload;
  }
  if (!args.cardanoOnly && NETWORKS[net].token && !TOKEN) fail(`${net} reads the Midnight indexer on Blockfrost: set BLOCKFROST_PROJECT_ID to a Midnight ${net} project id first, or add --cardano-only.`);

  const r = report(await gatherFacts({ net, credential: key.credential, stake, expectDust, cardanoOnly: args.cardanoOnly }));
  for (const line of r.lines) say(line);
  process.exit(r.code);
}

// Run only when called directly, not when the test imports report.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main().catch((e) => fail(`could not run: ${e.message}`));
}
