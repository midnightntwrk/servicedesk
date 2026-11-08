#!/usr/bin/env node
/**
 * check-night-usage.mjs: finds the circuits in a Compact contract that move NIGHT, the native
 * token, and explains the errors they give on Mainnet.
 *
 * On Mainnet, NIGHT is held on Cardano as cNIGHT, which generates DUST on Midnight. As of 2026-10-19 a
 * Mainnet wallet funded that way has DUST and no NIGHT on Midnight, the docs say native mNIGHT hasn't
 * launched, and no NIGHT moved in the Mainnet transactions sampled for the runbook. So a circuit that
 * takes NIGHT from the caller fails in the wallet, one that pays NIGHT out of a contract that was never
 * paid any is rejected by the node, and one that checks such a contract's NIGHT balance sees 0. On
 * Preview, Preprod and a local network, which have tNIGHT, the same circuits work.
 *
 *   node check-night-usage.mjs contract/managed/my-contract      # the compiler's output (contract/index.js)
 *   node check-night-usage.mjs contract/my-contract.compact     # source; follows imports next to it
 *   node check-night-usage.mjs contracts/                        # every .compact file under it
 *   pbpaste | node check-night-usage.mjs --error - --network mainnet    # an error, on stdin
 *
 * Node >= 18, no install. It reads only. --json prints the result as JSON.
 *
 * Exit code: 0 = no NIGHT use found, or the error isn't this one; 2 = a circuit certainly moves NIGHT,
 * or the error is this one; 3 = a circuit may move NIGHT (its token type comes from a parameter, the
 * ledger, a witness or another value), an import couldn't be followed, or the error could be this one
 * and needs one more detail; 1 = could not run.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RUNBOOK = 'https://github.com/midnightntwrk/servicedesk/blob/main/runbooks/contract-native-night-mainnet-runbook/contract-native-night-mainnet-runbook.md';
const DUST_RUNBOOK = 'https://github.com/midnightntwrk/servicedesk/blob/main/runbooks/cnight-dust-duplicate-registration-runbook/cnight-dust-duplicate-registration-runbook.md';
const LOOKUP = 'https://github.com/midnightntwrk/servicedesk/blob/main/runbooks/README.md#error-string-lookup';
// Re-checked after the ledger 9 upgrade, which didn't turn on the cNIGHT-to-mNIGHT bridge
// (midnight-docs relnotes/ledger-9.mdx).
const AS_OF = '2026-11-07, after the ledger 9 upgrade, which left the bridge off';

const USAGE = `usage: node check-night-usage.mjs <file.compact | directory | compiled contract dir | contract/index.js>... [--json]
       node check-night-usage.mjs --error '<error text>' | --error - [--network mainnet|preprod|preview|local] [--json]`;

// ---------- facts this check relies on (the runbook's Key identifiers) ----------
// The standard library's unshielded-token circuits (compiler/standard-library.compact at
// compactc-v0.31.1). The first argument of each is the token type; NIGHT's is 32 zero bytes, which
// nativeToken() returns and default<Bytes<32>> and pad(32, "") also are.
const OPS = {
  receiveUnshielded: 'receive',
  sendUnshielded: 'send',
  unshieldedBalance: 'balance',
  unshieldedBalanceLt: 'balance',
  unshieldedBalanceGte: 'balance',
  unshieldedBalanceGt: 'balance',
  unshieldedBalanceLte: 'balance',
};
// What each kind of use does on Mainnet. receive and send were run on 2026-10-19 on a local network
// (node 1.0.0 and 1.0.400, wallet SDK 1.2.0, midnight-js 4.1.1) with a wallet that had DUST and no
// NIGHT, and a contract that held none; balance follows from the contract holding none.
const ON_MAINNET = {
  receive: 'fails in the wallet after proving, before anything is submitted: Wallet.InsufficientFunds: Insufficient funds. A wallet funded through cNIGHT has DUST but no NIGHT on Midnight to pay with.',
  send: 'is rejected by the node after proving: 1010: Invalid Transaction: Custom error: 194 (BalanceCheckOutOfBounds), shown as SubmissionError: Transaction submission error. The contract holds no NIGHT.',
  balance: 'reads 0, because the contract holds none, so a check on it takes its "no NIGHT" branch.',
};
// NIGHT's token type as the unshielded wallet reports it in InsufficientFundsError.tokenType.
const NIGHT_HEX = '0'.repeat(64);

// ---------- arguments ----------
function parseArgs(argv) {
  const opts = { json: false, paths: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a === '--error' || a === '--network') {
      const v = argv[++i];
      if (v === undefined) fail(`${a} needs a value\n${USAGE}`);
      opts[a.slice(2)] = v;
    } else if (a === '-h' || a === '--help') { console.log(USAGE); process.exit(0); }
    else if (a.startsWith('--')) fail(`unknown argument ${a}\n${USAGE}`);
    else opts.paths.push(a);
  }
  if (opts.error === undefined && !opts.paths.length) fail(USAGE);
  if (opts.error !== undefined && opts.paths.length) fail(`use either paths or --error\n${USAGE}`);
  if (opts.network !== undefined && !['mainnet', 'preprod', 'preview', 'local', 'undeployed'].includes(opts.network)) fail(`--network: mainnet, preprod, preview or local\n${USAGE}`);
  if (opts.network !== undefined && opts.error === undefined) fail(`--network goes with --error\n${USAGE}`);
  return opts;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

// ---------- text helpers ----------
// Blank out comments and string contents, keeping offsets, so the scan sees code only.
export function stripCode(src, quotes = '"') {
  let out = '';
  for (let i = 0; i < src.length; ) {
    if (src.startsWith('//', i)) { const j = src.indexOf('\n', i); const end = j < 0 ? src.length : j; out += ' '.repeat(end - i); i = end; }
    else if (src.startsWith('/*', i)) { const j = src.indexOf('*/', i + 2); const end = j < 0 ? src.length : j + 2; out += src.slice(i, end).replace(/[^\n]/g, ' '); i = end; }
    else if (quotes.includes(src[i])) {
      const q = src[i];
      let j = i + 1;
      while (j < src.length && src[j] !== q) j += src[j] === '\\' ? 2 : 1;
      out += q + src.slice(i + 1, Math.min(j, src.length)).replace(/[^\n]/g, ' ') + (j < src.length ? q : '');
      i = j + 1;
    } else { out += src[i]; i++; }
  }
  return out;
}

const lineOf = (src, at) => src.slice(0, at).split('\n').length;

// The index of the bracket that closes the one at `open`.
function closing(src, open) {
  const o = src[open], c = { '{': '}', '(': ')', '[': ']' }[o];
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === o) depth++;
    else if (src[i] === c && --depth === 0) return i;
  }
  return src.length;
}

// Split the text between brackets at its top-level commas. `angle` counts <> as brackets (Compact's
// generic types); JavaScript has none.
function splitTop(text, angle) {
  const parts = [];
  let depth = 0, from = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if ('([{'.includes(ch) || (angle && ch === '<')) depth++;
    else if ((')]}'.includes(ch) || (angle && ch === '>')) && depth > 0) depth--;
    else if (ch === ',' && depth === 0) { parts.push(text.slice(from, i).trim()); from = i + 1; }
  }
  const last = text.slice(from).trim();
  if (last || parts.length) parts.push(last);
  return parts;
}

// `name(...)` taking up the whole expression: its argument text, else undefined.
function callArgs(expr, name) {
  const m = new RegExp(`^${name}\\s*\\(`).exec(expr);
  if (!m) return undefined;
  const open = m[0].length - 1;
  return closing(expr, open) === expr.length - 1 ? expr.slice(open + 1, -1) : undefined;
}

// ---------- the analysis, shared by source and compiled code ----------
// Each circuit has params, aliases (const name = expr), uses (unshielded calls, with the token type
// expression) and calls (to other circuits, with argument expressions). A token type is classified as:
//   night   certainly NIGHT's
//   other   certainly another token (tokenType(...), mintUnshieldedToken(...))
//   param   a parameter of the circuit: decided by what each caller passes
//   unknown anything else: a ledger field, a witness, another value
// Several possible token types for one name (const bound in different branches): NIGHT if any is.
function combine(results) {
  if (results.some((r) => r.status === 'night')) return { status: 'night' };
  return results.find((r) => r.status !== 'other') ?? { status: 'other' };
}

function makeClassifier(lang, table) {
  const returns = new Map();
  function returnOf(key, local, depth) {
    if (returns.has(key)) return returns.get(key);
    const unknown = { status: 'unknown', what: lang.describeCall(local) };
    returns.set(key, unknown); // a recursive helper stays unknown
    const c = table.get(key);
    const results = c.returns.map((r) => classify(r, c, depth + 1));
    let r = unknown;
    if (results.length && results.every((x) => x.status === 'night')) r = { status: 'night' };
    else if (results.length && results.every((x) => x.status === 'other')) r = { status: 'other' };
    returns.set(key, r);
    return r;
  }
  function classify(raw, c, depth = 0) {
    let e = raw.trim().replace(/\s+/g, ' ');
    if (depth > 20) return { status: 'unknown', what: e };
    for (let inner = lang.unwrap(e); inner !== undefined; inner = lang.unwrap(e)) e = inner.trim();
    if (lang.night.test(e)) return { status: 'night' };
    if (lang.other.test(e)) return { status: 'other' };
    if (/^[A-Za-z_]\w*$/.test(e)) {
      if (c.aliases.has(e)) return combine(c.aliases.get(e).map((x) => classify(x, c, depth + 1)));
      const i = c.params.indexOf(e);
      if (i >= 0) return { status: 'param', index: i, what: `parameter ${lang.label(e)}` };
      return { status: 'unknown', what: lang.describeName(e) };
    }
    // A field of a struct built in this circuit: const p = Payment { color: nativeToken(), ... }; p.color
    const field = /^([A-Za-z_]\w*)\.([A-Za-z_]\w*)$/.exec(e);
    if (field && c.aliases.has(field[1])) {
      const results = c.aliases.get(field[1]).map((x) => {
        const lit = /^[A-Za-z_]\w*\s*(?:<[^>{]*>)?\s*\{(.*)\}$/.exec(x.replace(/\s+/g, ' '));
        const part = lit && splitTop(lit[1], true).find((p) => new RegExp(`^${field[2]}\\s*:`).test(p));
        return part && classify(part.slice(part.indexOf(':') + 1), c, depth + 1);
      });
      if (results.every(Boolean)) return combine(results);
    }
    const call = lang.call(e);
    if (call) {
      const key = lang.resolve(c, call.name);
      return key !== undefined && table.has(key) ? returnOf(key, call.name, depth) : { status: 'unknown', what: lang.describeCall(call.name) };
    }
    return { status: 'unknown', what: lang.describeExpr(e) };
  }
  return classify;
}

// Every unshielded use reachable from a circuit. A token type that is one of the circuit's own
// parameters stays 'param' until a caller's argument decides it.
function analyse(table, classify) {
  const memo = new Map();
  function usesOf(key, stack = []) {
    if (memo.has(key)) return memo.get(key);
    if (stack.includes(key)) return [];
    const c = table.get(key);
    if (!c) return [];
    const out = [];
    for (const u of c.uses) {
      const k = classify(u.arg, c);
      if (k.status !== 'other') out.push({ ...u, ...k, via: key });
    }
    for (const call of c.calls) {
      for (const u of usesOf(call.key, [...stack, key])) {
        if (u.status !== 'param') { out.push(u); continue; }
        const arg = call.args[u.index];
        const k = arg === undefined ? { status: 'unknown', what: u.what } : classify(arg, c);
        if (k.status !== 'other') out.push({ ...u, ...k });
      }
    }
    memo.set(key, out);
    return out;
  }
  return usesOf;
}

// entries: [{ key, name }], the contract's exported circuits.
function report(usesOf, file, kind, entries, label) {
  const found = [];
  for (const { key, name } of entries) {
    const uses = usesOf(key).map((u) => ({
      op: u.op,
      kind: u.kind,
      certain: u.status === 'night',
      arg: u.arg.replace(/\s+/g, ' '),
      line: u.line,
      ...(u.file && u.file !== file ? { file: u.file } : {}),
      via: u.via === key ? name : label(u.via),
      why: u.status === 'night' ? undefined : u.status === 'param' ? `only if the caller passes NIGHT's token type (${u.what})` : `NIGHT if ${u.what} holds NIGHT's token type`,
    }));
    if (uses.length) found.push({ circuit: name, certain: uses.some((u) => u.certain), uses });
  }
  return { file, kind, circuits: entries.length, found };
}

// ---------- Compact source ----------
const SOURCE = {
  night: /^(?:nativeToken\s*\(\s*\)|default\s*<\s*Bytes\s*<\s*32\s*>\s*>|pad\s*\(\s*32\s*,\s*""\s*\))$/,
  other: /^(?:tokenType|mintUnshieldedToken)\s*\(/,
  // disclose(x) and `x as T` have x's token type.
  unwrap: (e) => {
    const d = callArgs(e, 'disclose');
    if (d !== undefined) return d;
    const cast = /^(.*\S)\s+as\s+[A-Za-z_][\w<>, ]*$/.exec(e);
    return cast ? cast[1] : undefined;
  },
  call: (e) => {
    const m = /^([A-Za-z_]\w*)\s*(?:<[^>(]*>)?\s*\(/.exec(e);
    return m && closing(e, m[0].length - 1) === e.length - 1 ? { name: m[1] } : undefined;
  },
  label: (n) => n,
};

// The modules, circuits, export lists, imports, witnesses and ledger fields of one Compact file. Each
// circuit, export list and import records the module it sits in ('' for the top level).
function parseCompact(raw) {
  const src = stripCode(raw);
  const modules = [];
  for (const m of src.matchAll(/\bmodule\s+([A-Za-z_]\w*)\s*(?:<[^>{]*>)?\s*\{/g)) {
    const open = m.index + m[0].length - 1;
    modules.push({ name: m[1], open, end: closing(src, open) });
  }
  // The innermost module around a position.
  const moduleAt = (at) => modules.filter((x) => at > x.open && at < x.end).sort((a, b) => b.open - a.open)[0]?.name ?? '';
  const circuits = [];
  const re = /\b(export\s+)?(?:pure\s+)?circuit\s+([A-Za-z_]\w*)\s*(?:<[^>(]*>)?\s*\(/g;
  let m;
  while ((m = re.exec(src))) {
    const paren = re.lastIndex - 1;
    const close = closing(src, paren);
    const params = splitTop(src.slice(paren + 1, close), true).map((p) => p.split(/\s*:/)[0].trim());
    const open = src.indexOf('{', close);
    const semi = src.indexOf(';', close);
    if (open < 0 || (semi >= 0 && semi < open)) continue; // a declaration without a body
    const end = closing(src, open);
    circuits.push({ name: m[2], module: moduleAt(m.index), exported: Boolean(m[1]), params, open, end });
    re.lastIndex = end;
  }
  const exportLists = [...src.matchAll(/\bexport\s*\{([^}]*)\}/g)].map((x) => ({ module: moduleAt(x.index), names: x[1].split(',').map((n) => n.trim()).filter(Boolean) }));
  const witnesses = new Set([...src.matchAll(/\bwitness\s+([A-Za-z_]\w*)\s*\(/g)].map((x) => x[1]));
  const ledger = new Set([...src.matchAll(/\bledger\s+([A-Za-z_]\w*)\s*:/g)].map((x) => x[1]));
  // import "file"; import Name; include "file"; with an optional prefix. Read from the raw text, since
  // stripping blanks the quoted path.
  const imports = [];
  for (const x of raw.matchAll(/^[ \t]*(import|include)\s+(?:"([^"]+)"|([A-Za-z_]\w*))\s*(?:<[^;]*>)?\s*(?:prefix\s+([A-Za-z_]\w*))?\s*;/gm)) {
    const at = x.index + x[0].indexOf(x[1]);
    if (src.slice(at, at + x[1].length) !== x[1]) continue; // inside a comment
    imports.push({ kind: x[1], spec: x[2] ?? x[3], quoted: x[2] !== undefined, prefix: x[4] ?? '', module: moduleAt(x.index) });
  }
  return { src, modules, circuits, exportLists, witnesses, ledger, imports };
}

// The file an import or include names, looked for next to the importing file.
function resolveFile(spec, dir) {
  for (const f of [spec, `${spec}.compact`]) {
    const p = path.resolve(dir, f);
    if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
  }
  return undefined;
}

export function scanSource(raw, file = '<source>') {
  // Circuits are keyed by module: `name` at the top level, `Module::name` inside a module.
  const table = new Map();
  const scopes = new Map([['', new Map()]]); // scope -> local name -> key
  const moduleExports = new Map(); // module -> names
  const witnesses = new Set(), ledger = new Set(), unresolved = [], entryKeys = [], entryLists = [];
  const pending = []; // imports to bind once every file is loaded
  const loaded = new Set();
  const scope = (s) => { if (!scopes.has(s)) scopes.set(s, new Map()); return scopes.get(s); };
  const exportsOf = (mod) => { if (!moduleExports.has(mod)) moduleExports.set(mod, new Set()); return moduleExports.get(mod); };
  function load(text, f, top) {
    if (loaded.has(f)) return;
    loaded.add(f);
    const p = parseCompact(text);
    p.witnesses.forEach((w) => witnesses.add(w));
    p.ledger.forEach((l) => ledger.add(l));
    for (const c of p.circuits) {
      const key = c.module ? `${c.module}::${c.name}` : c.name;
      const body = p.src.slice(c.open, c.end);
      const entry = { key, scope: c.module, params: c.params, aliases: new Map(), uses: [], calls: [], returns: [] };
      for (const a of body.matchAll(/\bconst\s+([A-Za-z_]\w*)\s*(?::[^=;]+)?=\s*([^;]+);/g)) entry.aliases.set(a[1], [...(entry.aliases.get(a[1]) ?? []), a[2].trim()]);
      for (const r of body.matchAll(/\breturn\s+([^;]+);/g)) entry.returns.push(r[1].trim());
      for (const call of body.matchAll(/\b([A-Za-z_]\w*)\s*(?:<[^>(]*>)?\s*\(/g)) {
        const at = c.open + call.index + call[0].length - 1;
        const args = splitTop(p.src.slice(at + 1, closing(p.src, at)), true);
        if (Object.hasOwn(OPS, call[1])) entry.uses.push({ op: call[1], kind: OPS[call[1]], arg: args[0] ?? '', line: lineOf(p.src, at), file: f });
        else entry.calls.push({ name: call[1], args });
      }
      table.set(key, entry);
      scope(c.module).set(c.name, key);
      if (c.module && c.exported) exportsOf(c.module).add(c.name);
      // The contract's entry points: exported top-level circuits of the scanned file and of what it includes.
      if (!c.module && c.exported && top) entryKeys.push(key);
    }
    for (const x of p.exportLists) {
      if (x.module) x.names.forEach((n) => exportsOf(x.module).add(n));
      else if (top) entryLists.push(...x.names);
    }
    for (const imp of p.imports) {
      if (imp.spec === 'CompactStandardLibrary') continue;
      const target = f === '<source>' ? undefined : resolveFile(imp.spec, path.dirname(f));
      if (imp.kind === 'include') {
        if (target) load(fs.readFileSync(target, 'utf8'), target, top && !imp.module);
        else unresolved.push(imp.spec);
        continue;
      }
      // import "path/Name" brings in module Name from that file; import Name, a module already in scope
      // or in Name.compact next to this file.
      const mod = imp.quoted ? path.basename(imp.spec).replace(/\.compact$/, '') : imp.spec;
      if (!p.modules.some((x) => x.name === mod) && target) load(fs.readFileSync(target, 'utf8'), target, false);
      pending.push({ ...imp, mod, scope: imp.module });
    }
  }
  load(raw, file, true);
  for (const imp of pending) {
    if (!moduleExports.has(imp.mod) && ![...table.keys()].some((k) => k.startsWith(`${imp.mod}::`))) { unresolved.push(imp.spec); continue; }
    for (const n of exportsOf(imp.mod)) scope(imp.scope).set(imp.prefix + n, `${imp.mod}::${n}`);
  }
  // A name in a module resolves in that module, then at the top level.
  const resolve = (c, name) => scope(c.scope).get(name) ?? scopes.get('').get(name);
  for (const c of table.values()) {
    c.calls = c.calls.map((x) => ({ key: resolve(c, x.name), args: x.args })).filter((x) => x.key !== undefined && x.key !== c.key && table.has(x.key));
  }
  const entries = entryKeys.map((key) => ({ key, name: key }));
  for (const n of entryLists) {
    const key = scopes.get('').get(n);
    if (key !== undefined && !entries.some((e) => e.key === key && e.name === n)) entries.push({ key, name: n });
  }
  const lang = {
    ...SOURCE,
    resolve,
    describeName: (n) => (ledger.has(n) ? `ledger field ${n}` : n),
    describeCall: (n) => (witnesses.has(n) ? `witness ${n}()` : `the result of ${n}()`),
    describeExpr: (e) => e,
  };
  const result = report(analyse(table, makeClassifier(lang, table)), file, 'source', entries, (k) => k.replace('::', '.'));
  if (unresolved.length) result.unresolvedImports = [...new Set(unresolved)];
  return result;
}

// ---------- compiled contract (contract/index.js) ----------
const COMPILED = {
  night: /^(?:this\._nativeToken_\d+\(\)|new Uint8Array\(32\)|new Uint8Array\(\[\s*0(?:\s*,\s*0){31}\s*\]\))$/,
  other: /^this\._(?:tokenType|mintUnshieldedToken)_\d+\(/,
  // 0.34.0 and later compile circuits as async methods and await the calls.
  unwrap: (e) => (/^await\s/.test(e) ? e.replace(/^await\s+/, '') : undefined),
  call: (e) => {
    const m = /^this\.(_[A-Za-z_]\w*?_\d+)\(/.exec(e);
    return m && closing(e, m[0].length - 1) === e.length - 1 ? { name: m[1] } : undefined;
  },
  resolve: (_c, name) => name,
  label: (n) => n.replace(/^_/, '').replace(/_\d+$/, ''),
};
const OP_JS = /^_(receiveUnshielded|sendUnshielded|unshieldedBalance(?:Lt|Gte|Gt|Lte)?)_\d+$/;
// The standard library's own methods: their bodies aren't the contract's uses.
const STDLIB_JS = /^_(?:receiveUnshielded|sendUnshielded|unshieldedBalance(?:Lt|Gte|Gt|Lte)?|nativeToken|tokenType|mintUnshieldedToken)_\d+$/;

export function scanCompiled(raw, file = '<index.js>') {
  const src = stripCode(raw, '"\'`');
  // Exported circuits are the keys of `this.circuits = { name: (...args) => { ... this._name_N(...` .
  // Each entry calls its own method; a module circuit of the same name gets another N.
  const exported = [];
  const start = src.search(/this\.circuits\s*=\s*\{/);
  if (start >= 0) {
    const open = src.indexOf('{', start);
    const block = src.slice(open, closing(src, open));
    const keys = [...block.matchAll(/^\s{6}([A-Za-z_]\w*):\s*(?:async\s*)?\(/gm)];
    // Entries there but none read: a compiler output shape this script doesn't know. Never an all-clear.
    if (!keys.length && /^\s{6}[A-Za-z_]\w*\s*:/m.test(block)) fail(`${file}: couldn't read the circuits in this compiled output (a compiler version this checker doesn't know). Scan the .compact source instead.`);
    keys.forEach((k, i) => {
      const body = block.slice(k.index, i + 1 < keys.length ? keys[i + 1].index : block.length);
      const method = new RegExp(`this\\.(_${k[1]}_\\d+)\\(`).exec(body)?.[1];
      if (method) exported.push({ key: method, name: k[1] });
    });
  }
  const table = new Map();
  const witnessMethods = new Set();
  const re = /^ {2}(?:async\s+)?(_[A-Za-z_]\w*?_\d+)\(([^)]*)\)\s*\{/gm;
  let m;
  while ((m = re.exec(src))) {
    const open = re.lastIndex - 1;
    const end = closing(src, open);
    const body = src.slice(open, end);
    if (/this\.witnesses\./.test(body)) witnessMethods.add(m[1]);
    const entry = { key: m[1], params: m[2].split(',').map((p) => p.trim()).filter(Boolean), aliases: new Map(), uses: [], calls: [], returns: [] };
    for (const r of body.matchAll(/\breturn\s+([^;]+);/g)) entry.returns.push(r[1].trim());
    if (!STDLIB_JS.test(m[1])) {
      for (const a of body.matchAll(/\bconst\s+([A-Za-z_]\w*)\s*=\s*([^;]+);/g)) entry.aliases.set(a[1], [...(entry.aliases.get(a[1]) ?? []), a[2].trim()]);
      for (const call of body.matchAll(/this\.(_[A-Za-z_]\w*?_\d+)\(/g)) {
        const at = open + call.index + call[0].length - 1;
        const args = splitTop(src.slice(at + 1, closing(src, at)), false);
        const op = OP_JS.exec(call[1]);
        // args[0] and args[1] are context and partialProofData; the token type is next.
        if (op) entry.uses.push({ op: op[1], kind: OPS[op[1]], arg: args[2] ?? '', line: lineOf(src, at) });
        else if (call[1] !== m[1]) entry.calls.push({ key: call[1], args });
      }
    }
    table.set(m[1], entry);
  }
  for (const c of table.values()) c.calls = c.calls.filter((x) => table.has(x.key));
  const lang = {
    ...COMPILED,
    describeName: (n) => `local ${n}`,
    describeCall: (n) => (witnessMethods.has(n) ? `witness ${COMPILED.label(n)}()` : `the result of ${COMPILED.label(n)}()`),
    describeExpr: (e) => (/queryLedgerState/.test(e) ? 'a ledger field' : e.length > 60 ? `${e.slice(0, 57)}...` : e),
  };
  return report(analyse(table, makeClassifier(lang, table)), file, 'compiled', exported.filter((e) => table.has(e.key)), COMPILED.label);
}

// ---------- files ----------
function compactFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...compactFiles(p));
    else if (e.name.endsWith('.compact')) out.push(p);
  }
  return out;
}

// The compiler's contract/index.js, not a wrapper that re-exports it: it builds `this.circuits = {`.
function isCompiled(file) {
  try { return /this\.circuits\s*=\s*\{/.test(fs.readFileSync(file, 'utf8')); } catch { return false; }
}

function targets(p) {
  let st;
  try { st = fs.statSync(p); } catch { fail(`${p}: no such file or directory`); }
  if (st.isFile()) {
    if (!/\.(c|m)?js$/.test(p)) return [{ file: p, kind: 'source' }];
    if (!isCompiled(p)) fail(`${p}: not a compiled Compact contract (no "this.circuits = {"). Pass the .compact source, or the directory the compiler wrote (it holds contract/index.js).`);
    return [{ file: p, kind: 'compiled' }];
  }
  for (const js of [path.join(p, 'contract', 'index.js'), path.join(p, 'index.js')]) if (isCompiled(js)) return [{ file: js, kind: 'compiled' }];
  const files = compactFiles(p);
  if (!files.length) fail(`${p}: no .compact files and no compiled contract/index.js under it`);
  return files.map((f) => ({ file: f, kind: 'source' }));
}

// ---------- errors ----------
// verdict: 'night' = this runbook; 'maybe' = could be, one more detail decides; null = not this one.
export function explainError(text, network) {
  const t = String(text);
  const testnet = network !== undefined && network !== 'mainnet';
  // The DUST wallet's message: Wallet.InsufficientFunds: Insufficient Funds: could not balance dust.
  if (/could not balance dust|"?tokenType"?\s*[:=]\s*"?dust\b/.test(t)) {
    return { verdict: null, tokenType: 'dust', summary: 'The wallet is short of DUST to pay the fee, not of NIGHT, so this isn\'t the NIGHT problem. Wait for its DUST to grow; if the DUST balance stopped growing, see the cNIGHT to DUST duplicate registrations runbook.', next: DUST_RUNBOOK };
  }
  const insufficient = /InsufficientFunds|Insufficient funds/.test(t);
  // midnight-js 5.0.0 wraps a provider's failure as ProviderFailedError, "<method> rejected the
  // transaction (circuit '<name>')", and rebuilds the cause as a plain Error with only its class name
  // and message (packages/contracts/src/errors.ts, internal/submit-payload.ts). err.cause then
  // stringifies to {}, so the token type is gone and the circuit name is what decides.
  const provider = /\b(balanceTx|submitTx|proveTx) rejected the transaction \(circuit '([^']+)'\)/.exec(t);
  if (provider) {
    const [, method, circuit] = provider;
    const has194 = /Custom error:\s*194\b|Invalid\.BalanceCheckOutOfBounds/.test(t);
    const scan = `run this checker on the contract: if it lists '${circuit}' as a NIGHT ${method === 'balanceTx' ? 'receive' : 'send'}, this is the runbook.`;
    if (method === 'proveTx') return { verdict: null, circuit, summary: `Proving failed for circuit '${circuit}', before the wallet or the node saw the transaction, so this isn't the NIGHT problem. See the proof server runbook.`, next: LOOKUP };
    if (testnet) return { verdict: null, circuit, summary: `On ${network} this isn't the Mainnet problem. If circuit '${circuit}' moves NIGHT, the wallet or the contract has too little tNIGHT: send tNIGHT to the paying wallet's unshielded address (the faucet does this).` };
    if ((method === 'balanceTx' && insufficient) || (method === 'submitTx' && has194)) {
      return { verdict: 'maybe', circuit, summary: `midnight-js 5 reports ${method === 'balanceTx' ? 'the wallet short of a token' : 'the node rejecting the call with 194 (Invalid.BalanceCheckOutOfBounds)'} for circuit '${circuit}'. Its error no longer carries the token type, so the circuit decides: ${scan}` };
    }
    if (method === 'balanceTx' || method === 'submitTx') {
      return { verdict: 'maybe', circuit, summary: `midnight-js 5 wraps the ${method === 'balanceTx' ? 'wallet' : 'node'}'s failure for circuit '${circuit}', and the reason is on err.cause. Print err.cause.message and its own causes (for (let e = err.cause; e; e = e.cause) console.log(e.message)) and pass that here too. ${method === 'balanceTx' ? 'Wallet.InsufficientFunds' : 'Custom error: 194'} there, on Mainnet, with '${circuit}' moving NIGHT, is this runbook: ${scan}` };
    }
  }
  // A stack from the shielded wallet (wallet-sdk-shielded/...): a shielded token, whatever its type.
  if (insufficient && /wallet-sdk-shielded\/|Insufficient funds for fallible segment/.test(t)) {
    return { verdict: null, summary: 'The shielded wallet is short of a shielded token, so this isn\'t the NIGHT problem (NIGHT is unshielded): the paying wallet needs more of that shielded token.' };
  }
  // JSON of err.cause carries the token type the wallet couldn't balance.
  const tokenType = /"?tokenType"?\s*[:=]\s*"?([0-9a-fA-F]{64})"?/.exec(t)?.[1];
  if (tokenType && insufficient) {
    if (tokenType !== NIGHT_HEX) return { verdict: null, tokenType, summary: `The wallet is short of token type ${tokenType}, not NIGHT, so this isn't the NIGHT problem. It's a token a contract minted, or a shielded token: the paying wallet needs more of it. "amount" is how much of it the transaction needs (negative).` };
    if (testnet) return { verdict: null, tokenType, summary: `On ${network} this is a wallet with too little tNIGHT, not the Mainnet problem: send tNIGHT to its unshielded address (the faucet does this), let it sync, and try again.` };
    return { verdict: 'night', tokenType, summary: 'The wallet couldn\'t find enough NIGHT (token type 00…00) to pay into the contract. On Mainnet that is this runbook: a wallet funded through cNIGHT has DUST but no NIGHT on Midnight to pay with, whatever its DUST balance. Nothing was charged. (On Preview or Preprod it would mean too little tNIGHT.)' };
  }
  if (insufficient) {
    if (testnet) return { verdict: null, summary: `On ${network} this isn't the Mainnet problem: a wallet is short of some token. If the circuit takes NIGHT, send tNIGHT to the paying wallet's unshielded address (the faucet does this). The tokenType in err.cause shows which token.` };
    return { verdict: 'maybe', summary: 'A wallet couldn\'t find enough of some token: NIGHT, a contract\'s own unshielded token, or a shielded token (the shielded wallet uses the same words). It is this runbook if the circuit takes NIGHT and this is Mainnet. To be sure, on midnight-js 4.1.1 log JSON.stringify(err.cause, (_k, v) => typeof v === \'bigint\' ? v.toString() : v) and pass that to --error: a tokenType of 64 zeros is NIGHT. On midnight-js 5 that prints {}; pass err.message instead, which names the circuit.' };
  }
  if (/Custom error:\s*194\b|Invalid\.BalanceCheckOutOfBounds/.test(t)) {
    if (testnet) return { verdict: null, summary: `On ${network} this isn't the Mainnet problem: 194 (Invalid.BalanceCheckOutOfBounds) means the contract holds too little of the token the circuit sends, tNIGHT or its own. Nothing was charged.` };
    return { verdict: 'maybe', summary: 'The node rejected the transaction with 194 (Invalid.BalanceCheckOutOfBounds): a contract call pays out more of a token than the contract holds. Nothing was charged. It is this runbook if the circuit sends NIGHT (sendUnshielded with nativeToken()) and this is Mainnet: run this checker on the contract. If it sends a token the contract minted, the contract holds too little of that token.' };
  }
  if (/Custom error:\s*\d+/.test(t)) {
    return { verdict: null, summary: 'A node rejection with a code other than 194, so not this runbook: decode it with the node rejection codes runbook.', next: LOOKUP };
  }
  if (/Transaction submission error/.test(t)) {
    return { verdict: 'maybe', summary: 'The node rejected the transaction, but this text doesn\'t say why. The code is further down: in the cause chain that midnight-js prints into err.message, in String(err), and in the RPC-CORE console line (1010: Invalid Transaction: Custom error: N). 194 from a circuit that sends NIGHT is this runbook; any other code is the node rejection codes runbook.' };
  }
  return { verdict: null, summary: 'Not one of the errors a NIGHT circuit gives on Mainnet (Wallet.InsufficientFunds with NIGHT\'s token type, Custom error 194). Search the runbooks\' error-string lookup.', next: LOOKUP };
}

// ---------- main ----------
function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.error !== undefined) {
    const text = opts.error === '-' ? fs.readFileSync(0, 'utf8') : opts.error;
    const r = explainError(text, opts.network);
    const code = r.verdict === 'night' ? 2 : r.verdict === 'maybe' ? 3 : 0;
    if (opts.json) console.log(JSON.stringify({ ...r, exit: code }, null, 2));
    else {
      const head = { night: 'This runbook', maybe: 'Could be this runbook' }[r.verdict] ?? 'Not this runbook';
      const next = r.verdict ? `Runbook: ${RUNBOOK}` : r.next ? `See: ${r.next}` : '';
      console.log(`${head}: ${r.summary}${next ? `\n${next}` : ''}`);
    }
    process.exit(code);
  }
  const results = [];
  for (const p of opts.paths) for (const t of targets(p)) {
    const raw = fs.readFileSync(t.file, 'utf8');
    results.push(t.kind === 'compiled' ? scanCompiled(raw, t.file) : scanSource(raw, t.file));
  }
  const certain = results.some((r) => r.found.some((f) => f.certain));
  const possible = results.some((r) => r.found.length);
  const unfollowed = results.some((r) => r.unresolvedImports);
  const code = certain ? 2 : possible || unfollowed ? 3 : 0;
  if (opts.json) {
    console.log(JSON.stringify({ results, onMainnet: ON_MAINNET, exit: code }, null, 2));
    process.exit(code);
  }
  const lines = [];
  for (const r of results) {
    const n = r.found.length;
    const sure = r.found.filter((f) => f.certain).length;
    const counts = [sure && `${sure} move${sure === 1 ? 's' : ''} NIGHT`, n - sure && `${n - sure} may`].filter(Boolean).join(', ');
    lines.push(`${r.file} (${r.kind}, ${r.circuits} exported circuit${r.circuits === 1 ? '' : 's'}): ${n ? counts : 'no NIGHT use found'}`);
    if (r.unresolvedImports) lines.push(`  not followed (no such file next to it): ${r.unresolvedImports.join(', ')}. Scan the compiled contract, which includes them.`);
    for (const f of r.found) {
      lines.push(`  ${f.circuit}: ${[...new Set(f.uses.map((u) => u.kind))].join(', ')}${f.certain ? '' : ' (possible)'}`);
      for (const u of f.uses) {
        const arg = u.arg.length > 60 ? `${u.arg.slice(0, 57)}...` : u.arg;
        const where = `line ${u.line}${u.file ? ` of ${path.basename(u.file)}` : ''}${u.via !== f.circuit ? ` in ${u.via}` : ''}`;
        lines.push(`    ${u.op}(${arg}) at ${where}${u.certain ? '' : `: ${u.why}`}`);
      }
    }
  }
  if (possible) {
    const kinds = [...new Set(results.flatMap((r) => r.found.flatMap((f) => f.uses.map((u) => u.kind))))];
    lines.push('', `On Mainnet (as of ${AS_OF}), a wallet funded through cNIGHT has DUST but no NIGHT on Midnight, and a contract no one has paid NIGHT holds none, so a circuit that moves NIGHT fails there. It works on Preview, Preprod and a local network:`);
    for (const k of kinds) lines.push(`  - a NIGHT ${k} ${ON_MAINNET[k]}`);
    if (!certain) lines.push('Each use above is NIGHT only if its token type is NIGHT\'s (32 zero bytes, what nativeToken() returns): check what the contract is deployed or called with.');
    lines.push(`Fix: hide these circuits on Mainnet in the DApp, or leave them out of the Mainnet build. If a circuit only needs some token to move, a token the contract mints itself (mintUnshieldedToken) does move on Mainnet.`);
    lines.push(`Runbook: ${RUNBOOK}`);
  } else if (unfollowed) lines.push('', 'Exit 3: an import wasn\'t followed, so this isn\'t an all-clear.');
  console.log(lines.join('\n'));
  process.exit(code);
}

// Run only as a command, so the exported functions can be imported.
const invoked = (() => {
  try { return fs.realpathSync(process.argv[1] ?? '') === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (invoked) main();
