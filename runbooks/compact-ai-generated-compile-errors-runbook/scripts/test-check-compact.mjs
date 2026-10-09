#!/usr/bin/env node
/**
 * test-check-compact.mjs: re-run the reproduction corpus (cases.json) against check-compact.mjs and,
 * optionally, against the compilers you have installed.
 *
 * Static (default): writes every case's contracts into a temporary directory and runs the static
 * scan on each. A `right*` file with an error-level finding is a false positive; a `wrong*` file that
 * the compiler rejects and the scan doesn't flag is left to --compile (reported, not a failure).
 *
 * --compile: also compiles every contract with each compiler recorded in the corpus that is installed
 * (`compact compile +<v> --skip-zk`) and reports any result that differs from the recorded one
 * (compiler drift: a new message, or code that now compiles or no longer does), plus any compiler
 * message `check-compact.mjs --explain` has no explanation for.
 *
 * Node >= 20, no install. Nothing outside the temporary directory is written.
 *
 *   node test-check-compact.mjs
 *   node test-check-compact.mjs --compile
 *   node test-check-compact.mjs --compile --only map-get,disclose-conditional
 *
 * Disclosure errors are all printed in one run; only the first error of a run is compared.
 *
 * Always: a fixed set of compiler messages whose explanation was once wrong (similar wording, a
 * different fix) is run through --explain, and each answer must contain the expected fix.
 *
 * Exit code: 0 = no false positives, every expected explanation (and, with --compile, no drift and
 *            every message explained), 2 = at least one of those failed, 1 = could not run.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHECK = path.join(HERE, 'check-compact.mjs');
const argv = process.argv.slice(2);
const compile = argv.includes('--compile');
const onlyAt = argv.indexOf('--only');
const only = onlyAt >= 0 ? new Set((argv[onlyAt + 1] ?? '').split(',').filter(Boolean)) : undefined;
const unknown = argv.filter((a, i) => a !== '--compile' && a !== '--only' && !(onlyAt >= 0 && i === onlyAt + 1));
if (unknown.length || (only && !only.size)) {
  console.error(`unknown argument ${unknown[0] ?? '--only (needs slugs)'}\nusage: node test-check-compact.mjs [--compile] [--only slug,slug]`);
  process.exit(1);
}

const corpus = JSON.parse(fs.readFileSync(path.join(HERE, 'cases.json'), 'utf8'));
if (only) {
  const missing = [...only].filter((s) => !corpus.cases.some((c) => c.slug === s));
  if (missing.length) { console.error(`no such case: ${missing.join(', ')}`); process.exit(1); }
  corpus.cases = corpus.cases.filter((c) => only.has(c.slug));
}
// The first error of a run: a later "potential witness-value disclosure" starts a second error.
const firstError = (m) => { const s = norm(m), k = 'potential witness-value disclosure must be declared', i = s.indexOf(k, 1); return (i > 0 ? s.slice(0, i) : s).trim(); };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'check-compact-corpus-'));
const norm = (s) => String(s ?? '').replace(/\/(?:private\/)?(?:var|tmp)\/\S*?\/(?=[\w.-]+\/compiler\/|[\w.-]+\.compact)/g, '<dir>/');

function run(args, cwd) {
  return spawnSync(process.execPath, [CHECK, ...args], { encoding: 'utf8', cwd, timeout: 600_000 });
}
function compileOne(file, version) {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-out-'));
  try {
    const r = spawnSync('compact', ['compile', `+${version}`, '--skip-zk', path.basename(file), out], { encoding: 'utf8', cwd: path.dirname(file), timeout: 600_000 });
    const lines = `${r.stdout}${r.stderr}`.split('\n').filter((l) => l.trim() && !l.startsWith('Compiling'));
    const i = lines.findIndex((l) => l.startsWith('Exception:'));
    const message = i < 0 ? '' : [lines[i].replace(/^Exception: \S+ line \d+ char \d+:\s*/, ''), ...lines.slice(i + 1).filter((l) => /^\s/.test(l)).map((l) => l.trim())].join(' ').trim();
    return { exit: r.status, message, missing: r.status !== 0 && /not installed|no such version|couldn't find compiler|directory does not exist/i.test(lines.join(' ')) };
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
}

// Messages that look alike but need different fixes: [message, text the explanation must contain].
const EXPLAIN_EXPECT = [
  ['parse error: found "<" looking for an expression4, a generic argument, or ">"', '`<<` and `>>`'],
  ['parse error: found "<" looking for an expression', 'Angle-bracket casts'],
  ['parse error: found "{" looking for ";"', 'A witness has no body'],
  ['parse error: found "{" looking for ";", ",", "||", "&&", "==", "!=", "as", "+", "-", "*", "[", ".", "?", "=", "+=", "-=", "<", "<=", ">=", or ">"', 'no match or switch'],
  ['parse error: found "Misc" looking for "("', 'emit X(…)'],
  ['no compatible function named left is in scope at this call one function is incompatible with the supplied generic values supplied generic values: <> declared generics for function at <standard library>: <type, type>', 'left<A, B>'],
  ['no compatible function named merkleTreePathRoot is in scope at this call one function is incompatible with the supplied generic values supplied generic values: <> declared generics for function at <standard library>: <size, type>', 'merkleTreePathRoot<N, T>'],
  ['no compatible function named persistentCommit is in scope at this call one function is incompatible with the supplied generic values supplied generic values: <> declared generics for function at <standard library>: <type>', 'persistentCommit<T>(value, rand)'],
  ['no compatible function named rootOf is in scope at this call one function is incompatible with the supplied generic values supplied generic values: <size 10> declared generics for function at line 3 char 1: <type>', '<#N>'],
  ['no compatible function named tokenType is in scope at this call one function is incompatible with the supplied argument types supplied argument types: (struct ContractAddress<bytes: Bytes<32>>, Bytes<32>) declared argument types for function at <standard library>: (Bytes<32>, struct ContractAddress<bytes: Bytes<32>>)', 'wrong order'],
  ['no compatible function named ecMulGenerator is in scope at this call one function is incompatible with the supplied argument types supplied argument types: (Field) declared argument types for function at <standard library>: (JubjubScalar)', 'JubjubScalar'],
  ['parse error: found keyword "void" (which is reserved for future use) looking for a type', '`: []`'],
  ['parse error: found keyword "throw" (which is reserved for future use) looking for a statement or "}"', 'assert('],
  ['parse error: found keyword "event" (which is reserved for future use) looking for a program element or end of file', 'Event declarations'],
  ['parse error: found keyword "event" (which is reserved for future use) looking for a const binding', 'rename it'],
  ['parse error: found keyword "export" looking for "ledger"', 'export sealed ledger'],
  ['expected first argument of persistentHash to have type Bytes<32> but received Field', 'must be Bytes<32>'],
  ['opaque type number is not supported', 'Opaque<"Uint8Array">'],
  ['mismatch between actual number 1 and declared number 2 of ADT parameters for Map', 'Map<K, V>'],
  ['mismatch between actual number 1 and declared number 2 of ADT parameters for HistoricMerkleTree', 'HistoricMerkleTree<depth, T>'],
  ['expected structure type, received JubjubPoint', 'jubjubPointX(p)'],
  ['expected equality-operator left operand type to be an ordinary Compact type but received ADT type Counter', 'ledger type'],
  ['parse error: found "Integer" looking for ",", ")", or a generic argument list', 'Uint<N>'],
  ['Uint width 0 is not between 1 and the maximum Uint width 248 (inclusive)', 'Uint<0>'],
  ['another binding found for send in the same scope at line 2 char 1', 'prefix'],
];
let wrongExplanations = 0;
for (const [msg, want] of EXPLAIN_EXPECT) {
  const e = run(['--explain', msg], HERE);
  if (e.status !== 0 || !e.stdout.includes(want)) {
    wrongExplanations++;
    console.log(`WRONG EXPLANATION for: ${msg}\n  expected it to contain: ${want}\n  got: ${e.stdout.trim()}`);
  }
}

const versions = Object.keys(corpus.compilers);
let falsePositives = 0, caught = 0, leftToCompile = 0, drift = 0, unexplained = 0;
const skippedVersions = new Set();
try {
  for (const c of corpus.cases) {
    const dir = path.join(tmp, c.slug);
    fs.mkdirSync(dir, { recursive: true });
    for (const [rel, src] of Object.entries(c.extra_files ?? {})) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), src);
    }
    for (const [name, f] of Object.entries(c.files)) {
      const file = path.join(dir, name);
      fs.writeFileSync(file, f.source);
      const r = run(['--json', file], dir);
      if (r.status === 1) throw new Error(`check-compact could not run on ${c.slug}/${name}: ${r.stderr}`);
      const errors = JSON.parse(r.stdout).files[0].findings.filter((x) => x.severity === 'error');
      const rejected = f.results['0.31.1']?.exit !== 0;
      if (name.startsWith('right') && errors.length) {
        falsePositives++;
        console.log(`FALSE POSITIVE ${c.slug}/${name}: ${errors.map((e) => `${e.rule} at ${e.line}:${e.col}`).join(', ')}`);
      } else if (name.startsWith('wrong') && rejected) {
        if (errors.length) caught++; else leftToCompile++;
      }
      if (!compile) continue;
      for (const v of versions) {
        if (skippedVersions.has(v)) continue;
        const now = compileOne(file, v);
        if (now.missing) { skippedVersions.add(v); console.log(`compiler ${v} isn't installed; skipping it`); continue; }
        const then = f.results[v];
        if (!then) continue;
        if ((now.exit === 0) !== (then.exit === 0) || firstError(now.message) !== firstError(then.message)) {
          drift++;
          console.log(`DRIFT ${c.slug}/${name} [${v}]\n  recorded: exit ${then.exit} ${then.message}\n  now:      exit ${now.exit} ${now.message}`);
        }
        if (now.exit !== 0 && now.message) {
          const e = run(['--explain', now.message], dir);
          if (e.status === 2) { unexplained++; console.log(`UNEXPLAINED [${v}] ${c.slug}/${name}: ${now.message}`); }
          else if (e.status !== 0) { unexplained++; console.log(`EXPLAIN FAILED [${v}] ${c.slug}/${name} (exit ${e.status}, signal ${e.signal}): ${String(e.stderr || e.error || '').trim().split('\n')[0]}`); }
        }
      }
    }
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

const files = corpus.cases.reduce((n, c) => n + Object.keys(c.files).length, 0);
console.log(`\n${corpus.cases.length} cases, ${files} files.`);
console.log(`Static scan: ${caught} rejected wrong files flagged, ${leftToCompile} left to --compile, ${falsePositives} false positive(s) on right files.`);
console.log(`Explanations: ${EXPLAIN_EXPECT.length - wrongExplanations} of ${EXPLAIN_EXPECT.length} look-alike messages get the expected fix.`);
if (compile) console.log(`Compilers: ${drift} result(s) differ from the corpus, ${unexplained} message(s) without an explanation.`);
process.exitCode = falsePositives || wrongExplanations || drift || unexplained ? 2 : 0;
