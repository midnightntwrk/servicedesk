#!/usr/bin/env node
/**
 * test-check-wallet-sync.mjs: runs check-wallet-sync.mjs against a mock indexer on 127.0.0.1, so it
 * needs no network, no project id and no install (Node >= 22).
 *
 *   node test-check-wallet-sync.mjs
 *
 * The mock answers `{ block { height } }` over HTTP and the `dustLedgerEvents` / `zswapLedgerEvents`
 * subscriptions over graphql-transport-ws, with fixed newest ids. Its DUST events carry a
 * `protocolVersion` that crosses into ledger 9 at a fixed id, so the checker's boundary search has
 * something to find. The state files are written to a temporary directory in the shape wallet SDK
 * 2.x's serializeState() writes, with dummy values.
 * Exit code 0 when every case passes.
 */
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const CHECKER = path.join(import.meta.dirname, 'check-wallet-sync.mjs');
const DUST_TIP = 50_000;
const ZSWAP_TIP = 60_000;
// The first ledger 9 DUST event id. Only even ids exist, as on a real chain where zswap events sit in the gaps of the
// shared id counter, so the last ledger 8 event, the cursor the search should answer, is V9_FROM - 2.
const V9_FROM = 30_000;
const CURSOR = V9_FROM - 2;
const V8 = 1000300;
const V9 = 2001100;

// ---------- mock indexer ----------
// HTTP: `mode` picks the answer. WebSocket: just enough of RFC 6455 and graphql-transport-ws.
let mode = 'ok';
let chain = 'crossed'; // crossed: ledger 8 then ledger 9; v9only: born on ledger 9; mute: version lookups never answer
const HTTP_ANSWERS = {
  ok: [200, { data: { block: { height: 123_456 } } }],
  mismatch: [403, { status_code: 403, error: 'Forbidden', message: 'Network token mismatch' }],
  missing: [403, { status_code: 403, error: 'Forbidden', message: 'Missing project token. Please include project_id in your request.' }],
  gone: [410, { message: 'This endpoint has been shut down.' }],
};

const frame = (text) => {
  const payload = Buffer.from(text);
  const n = payload.length;
  const head = n < 126 ? Buffer.from([0x81, n]) : n < 65536 ? Buffer.from([0x81, 126, n >> 8, n & 255]) : null;
  if (!head) throw new Error('mock frames stay under 64 KB');
  return Buffer.concat([head, payload]);
};

// Client frames are masked; returns [opcode, text, bytes used] or undefined if incomplete.
const unframe = (buf) => {
  if (buf.length < 2) return undefined;
  let len = buf[1] & 0x7f;
  let at = 2;
  if (len === 126) {
    if (buf.length < 4) return undefined;
    len = buf.readUInt16BE(2);
    at = 4;
  } else if (len === 127) {
    if (buf.length < 10) return undefined;
    len = Number(buf.readBigUInt64BE(2));
    at = 10;
  }
  if (buf.length < at + 4 + len) return undefined;
  const mask = buf.subarray(at, at + 4);
  const data = Buffer.from(buf.subarray(at + 4, at + 4 + len));
  for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
  return [buf[0] & 0x0f, data.toString(), at + 4 + len];
};

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    const [status, json] = HTTP_ANSWERS[mode];
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(json));
  });
});

server.on('upgrade', (req, socket) => {
  const accept = crypto.createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: graphql-transport-ws\r\n\r\n`,
  );
  let buf = Buffer.alloc(0);
  let open = true;
  socket.on('error', () => {});
  socket.on('close', () => (open = false));
  socket.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    for (let f = unframe(buf); f; f = unframe(buf)) {
      const [opcode, text, used] = f;
      buf = buf.subarray(used);
      if (opcode === 8) {
        socket.end(Buffer.from([0x88, 0]));
        return;
      }
      if (opcode !== 1) continue;
      const msg = JSON.parse(text);
      if (msg.type === 'connection_init') socket.write(frame(JSON.stringify({ type: 'connection_ack' })));
      if (msg.type !== 'subscribe') continue;
      const field = /\{\s*(\w+)\s*\(/.exec(msg.payload.query)[1];
      const tip = field === 'dustLedgerEvents' ? DUST_TIP : ZSWAP_TIP;
      if (!msg.payload.query.includes('protocolVersion')) {
        socket.write(frame(JSON.stringify({ id: msg.id, type: 'next', payload: { data: { [field]: { id: 2, maxId: tip } } } })));
        continue;
      }
      if (chain === 'mute') continue;
      // The first even id at or after the one asked for (null: the first event).
      const asked = msg.payload.variables?.id ?? 0;
      const id = Math.min(tip, Math.max(2, asked + (asked % 2)));
      const protocolVersion = chain === 'v9only' || id >= V9_FROM ? V9 : V8;
      socket.write(frame(JSON.stringify({ id: msg.id, type: 'next', payload: { data: { [field]: { id, maxId: tip, protocolVersion } } } })));
    }
  });
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `127.0.0.1:${server.address().port}`;

// ---------- state files, in serializeState()'s shape ----------
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-wallet-sync-'));
const hex = (bytes) => '00'.repeat(bytes);
const write = (name, value) => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
  return file;
};
const shielded = (offset, networkId = 'preprod') => ({
  version: 'v2',
  writtenBy: 'v2',
  publicKeys: { coinPublicKey: hex(32), encryptionPublicKey: hex(32) },
  state: hex(1900),
  protocolVersion: String(V9),
  offset: String(offset),
  networkId,
  coinHashes: {},
});
const dust = (offset, { networkId = 'preprod', stateBytes = 27_000, version = V9, syncKind = 'events' } = {}) => ({
  version: 'v2',
  writtenBy: 'v2',
  publicKey: { publicKey: hex(37) },
  state: hex(stateBytes),
  protocolVersion: String(version),
  networkId,
  offset: String(offset),
  syncKind,
  pendingDust: [],
});
const unshielded = (appliedId, networkId = 'preprod') => ({
  version: 'v2',
  writtenBy: 'v2',
  publicKey: { publicKey: hex(32), addressHex: hex(32), address: 'mn_addr_preprod1dummy' },
  state: { availableUtxos: [], pendingUtxos: [] },
  protocolVersion: String(V9),
  appliedId: String(appliedId),
  networkId,
});

// ---------- cases ----------
// The checker runs as a child process; execFile, not spawnSync, so the mock server keeps answering.
const run = ({ args, env = {} }) =>
  new Promise((resolve) =>
    execFile(process.execPath, [CHECKER, ...args], { encoding: 'utf8', env: { ...process.env, ...env }, timeout: 90_000 }, (err, stdout, stderr) =>
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: `${stdout}${stderr}` }),
    ),
  );
const local = ['--indexer', `http://${base}/api/v0`, '--indexer-ws', `ws://${base}/api/v0/ws`];
// Each expectation is [regex over the output]; `code` is the exit code.
const CASES = [
  {
    name: 'healthy indexer on a crossed chain, states of every kind',
    http: 'ok',
    args: [
      ...local,
      '--state', write('dust-behind.json', dust(40_000)),
      '--state', write('shielded-behind.json', shielded(59_000)),
      '--state', write('unshielded.json', unshielded(7)),
      // serializeState() returns a string; a file holding it JSON-encoded once more reads the same
      '--state', write('dust-as-string.json', JSON.stringify(JSON.stringify(dust(41_000)))),
    ],
    code: 0,
    expect: [
      /^Indexer +http:\/\/127\.0\.0\.1:\d+\/api\/v0: block 123,456 +OK/m,
      /^DUST events +newest id 50,000 +INFO/m,
      /^Shielded events +newest id 60,000 +INFO/m,
      new RegExp(`^Ledger 9 DUST start +cursor ${CURSOR}, version ${V9} \\(\\d+ lookups, \\d+ s\\) +INFO +a fresh wallet can start here: dustTimelineStartProbe: async \\(\\) => Option\\.some\\(\\{ cursor: ${CURSOR}n, version: ProtocolVersion\\.ProtocolVersion\\(${V9}n\\) \\}\\)`, 'm'),
      /^Fresh wallet, default start +replays 50,000 DUST event ids, ledger 8 included +INFO/m,
      new RegExp(`^Fresh wallet, ledger 9 start +replays ${(DUST_TIP - CURSOR).toLocaleString('en-US')} DUST event ids +INFO`, 'm'),
      /^State dust \(dust-behind\.json\) +offset 40,000, 10,000 events behind, 54 KB +OK +plausible: within this indexer's range/m,
      /^State dust \(dust-as-string\.json\) +offset 41,000, 9,000 events behind/m,
      /^State shielded \(shielded-behind\.json\) +offset 59,000, 1,000 events behind, 4 KB +OK +plausible/m,
      /^State unshielded \(unshielded\.json\) +appliedId 7, 1 KB +INFO/m,
      /^RESULT: nothing here stops a sync/m,
    ],
  },
  {
    name: 'states that will not resume, or still replay ledger 8',
    http: 'ok',
    args: [
      ...local,
      '--state', write('dust-zero.json', dust(0)),
      '--state', write('dust-past-tip.json', dust(DUST_TIP + 1)),
      '--state', write('shielded-past-tip.json', shielded(ZSWAP_TIP + 5)),
      '--state', write('dust-ledger8.json', dust(10_000, { version: V8 })),
      '--state', write('dust-eventless.json', dust(3_400_000, { syncKind: 'projections' })),
      '--state', write('big-dust.json', dust(49_000, { stateBytes: 6_000_000 })),
      '--state', write('not-json.json', 'not json'),
      '--state', write('null.json', 'null'),
      '--state', write('number.json', '42'),
      '--state', write('other-shape.json', { hello: 'world' }),
      '--state', path.join(dir, 'missing.json'),
    ],
    code: 2,
    expect: [
      /^State dust \(dust-zero\.json\) +offset 0, \d+ KB +WARN +saved before any event was applied/m,
      /^State dust \(dust-past-tip\.json\) +offset 50,001 is past this indexer's newest event 50,000 +FAIL +saved against a different indexer/m,
      /^State shielded \(shielded-past-tip\.json\) +offset 60,005 is past this indexer's newest event 60,000 +FAIL/m,
      new RegExp(`^State dust \\(dust-ledger8\\.json\\) +offset 10,000, still on ledger 8 \\(version ${V8}\\), \\d+ KB +WARN +restoring it replays the rest of the ledger 8 DUST history first, 40,000 events in all\\. Starting fresh at the ledger 9 start replays ${(DUST_TIP - CURSOR).toLocaleString('en-US')} \\(runbook, Remediation 4\\)\\. Move the file aside`, 'm'),
      /^State dust \(dust-eventless\.json\) +eventless \(projections\) state at block 3,400,000, \d+ KB +WARN +saved by the eventless DUST sync/m,
      /^State dust \(big-dust\.json\) +offset 49,000, 1,000 events behind, 12\.0 MB +OK/m,
      /^State \S+not-json\.json +.+ +FAIL +not a readable serializeState\(\) file/m,
      /^State \S+other-shape\.json +unrecognised shape +WARN/m,
      /^State \S+null\.json +not a JSON object +WARN/m,
      /^State \S+number\.json +not a JSON object +WARN/m,
      /^State \S+missing\.json +ENOENT.+ +FAIL/m,
      /^RESULT: at least one FAIL above/m,
    ],
  },
  {
    name: 'a chain born on ledger 9: nothing to skip',
    http: 'ok',
    chain: 'v9only',
    args: [...local],
    code: 0,
    expect: [/^Ledger 9 DUST start +none \(\d+ s\) +INFO +every DUST event on this chain is on one side of ledger 9/m, /^Fresh wallet +replays 50,000 DUST event ids +INFO/m],
    absent: [/Fresh wallet, ledger 9 start/],
  },
  {
    name: '--no-search skips the boundary search',
    http: 'ok',
    args: [...local, '--no-search', '--state', write('dust-ledger8-nosearch.json', dust(10_000, { version: V8 }))],
    code: 0,
    expect: [/^Fresh wallet +replays 50,000 DUST event ids/m, /^State dust \(dust-ledger8-nosearch\.json\) +offset 10,000, still on ledger 8 \(version 1000300\), \d+ KB +WARN +restoring it replays the rest of the ledger 8 DUST history first, 40,000 events in all\. \(runbook, Remediation 4\)\. Move the file aside/m],
    absent: [/Ledger 9 DUST start/],
  },
  {
    name: 'version lookups that never answer (about 45 s)',
    http: 'ok',
    chain: 'mute',
    args: [...local],
    code: 0,
    expect: [/^Ledger 9 DUST start +no DUST event at the start within 15 s +WARN +the search did not finish/m, /^RESULT: nothing here stops a sync, but the WARN rows above/m],
  },
  {
    name: 'project id for another network (403)',
    http: 'mismatch',
    args: [...local],
    code: 2,
    expect: [/^Indexer +.+HTTP 403 Network token mismatch +FAIL +the project id is for another network/m],
    absent: [/DUST events/],
  },
  {
    name: 'no project id reached the indexer (403)',
    http: 'missing',
    args: [...local],
    code: 2,
    expect: [/HTTP 403 Missing project token.+FAIL +no project id reached Blockfrost/],
  },
  {
    name: 'shut-down indexer (410)',
    http: 'gone',
    args: [...local],
    code: 2,
    expect: [/HTTP 410 .+FAIL +this indexer is shut down/],
  },
  {
    name: 'nothing listening',
    args: ['--indexer', 'http://127.0.0.1:9/api/v0', '--indexer-ws', 'ws://127.0.0.1:9/api/v0/ws'],
    code: 2,
    expect: [/^Indexer +http:\/\/127\.0\.0\.1:9\/api\/v0: .+ +FAIL +unreachable/m],
  },
  { name: 'preprod without a project id', args: ['--network', 'preprod'], env: { BLOCKFROST_PROJECT_ID: '' }, code: 1, expect: [/needs a project id\. Set BLOCKFROST_PROJECT_ID/] },
  { name: 'unknown network', args: ['--network', 'devnet'], code: 1, expect: [/--network must be preview, preprod or mainnet/] },
  { name: '--indexer without --indexer-ws', args: ['--indexer', `http://${base}/api/v0`], code: 1, expect: [/--indexer and --indexer-ws go together/] },
  { name: 'unknown argument', args: ['--states', 'x'], code: 1, expect: [/unknown argument --states/] },
  { name: 'bad --fork-v9', args: [...local, '--fork-v9', 'v9'], code: 1, expect: [/--fork-v9 must be a protocol version number/] },
  {
    name: '--fork-v9 moves the boundary',
    http: 'ok',
    args: [...local, '--fork-v9', String(V9 + 1)],
    code: 0,
    expect: [/^Ledger 9 DUST start +none/m],
  },
];

let failed = 0;
for (const c of CASES) {
  mode = c.http ?? 'ok';
  chain = c.chain ?? 'crossed';
  const { code, out } = await run(c);
  const problems = [];
  if (code !== c.code) problems.push(`exit ${code}, expected ${c.code}`);
  for (const re of c.expect) if (!re.test(out)) problems.push(`missing ${re}`);
  for (const re of c.absent ?? []) if (re.test(out)) problems.push(`unexpected ${re}`);
  if (problems.length) {
    failed++;
    console.log(`FAIL  ${c.name}\n      ${problems.join('\n      ')}\n${out.replace(/^/gm, '      | ')}`);
  } else console.log(`ok    ${c.name}`);
}


server.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log(failed ? `\n${failed} of ${CASES.length} cases failed` : `\nall ${CASES.length} cases passed`);
process.exit(failed ? 1 : 0);
