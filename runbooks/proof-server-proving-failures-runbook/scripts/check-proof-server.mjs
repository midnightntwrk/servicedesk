#!/usr/bin/env node
/**
 * check-proof-server.mjs: read-only diagnostic. Can this Midnight proof server be reached, is it
 * the version the network is tested with, and can it actually prove? When it runs in local
 * Docker, is the container set up so that it starts, keeps its keys and logs its errors?
 *
 * It sends GET /health, /version, /proof-versions and /ready, then one test /check and /prove
 * for a known-good circuit: `increment` of a one-line Counter contract compiled with Compact
 * 0.31.1, as midnight-js 4.1.1 sends it (no witnesses, no wallet data). With Docker available it
 * reads `docker ps`, `docker inspect` and `docker logs` for proof-server containers. Nothing is
 * started, stopped, signed or submitted.
 *
 * Requirements: Node >= 20. No npm install.
 *
 * Usage:
 *   node check-proof-server.mjs [url] [--network preprod] [--no-prove] [--no-docker]
 *
 *   url          proof server base URL, exactly as the app passes it to httpClientProofProvider
 *                or the wallet (default http://127.0.0.1:6300)
 *   --network    preview | preprod | mainnet: the matrix version to compare with (default preprod)
 *   --no-prove   skip the test proof (a fresh server may download a small key for it)
 *   --no-docker  skip the container checks
 *   --timeout    seconds to wait for the test proof (default 300, midnight-js's default)
 *   --matrix     support-matrix.json path or URL (default: midnight-docs main, because the
 *                matrix changes with every release)
 *
 * Status words: OK; FAIL (proving can't work like this); WARN (works now, will bite); INFO; SKIP.
 *
 * Exit code: 0 = no FAIL, 2 = at least one FAIL, 1 = could not run (bad arguments or a crash).
 * 1 is never a verdict.
 */

import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';

const MATRIX_URL =
  'https://raw.githubusercontent.com/midnightntwrk/midnight-docs/main/docs/relnotes/support-matrix.json';
// Used only when the matrix can't be read. Point-in-time: midnight-docs main, 2026-10-09.
const MATRIX_FALLBACK = '8.1.3';
const NETWORKS = ['preview', 'preprod', 'mainnet'];
const USAGE =
  'usage: node check-proof-server.mjs [url] [--network <preview|preprod|mainnet>] [--no-prove] [--no-docker] [--timeout <s>] [--matrix <file|url>]';
// The keys and parameters a proof server downloads on first start, about 34 MB.
const CACHE_DIRS = ['/.cache/midnight', '/.cache/midnight/zk-params', '/.cache', '/'];

const fail = (msg) => {
  console.error(msg);
  process.exit(1);
};

// ---------- arguments ----------
const opts = { url: 'http://127.0.0.1:6300', network: 'preprod', prove: true, docker: true, timeout: 300, matrix: MATRIX_URL };
{
  const argv = process.argv.slice(2);
  let positional = 0;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) fail(`${a} needs a value\n${USAGE}`);
      return v;
    };
    if (a === '--help' || a === '-h') {
      console.log(USAGE);
      process.exit(0);
    } else if (a === '--network') opts.network = val();
    else if (a === '--no-prove') opts.prove = false;
    else if (a === '--no-docker') opts.docker = false;
    else if (a === '--timeout') opts.timeout = Number(val());
    else if (a === '--matrix') opts.matrix = val();
    else if (a.startsWith('--')) fail(`unknown option ${a}\n${USAGE}`);
    else if (positional++ === 0) opts.url = a;
    else fail(`unexpected argument ${a}\n${USAGE}`);
  }
  if (!NETWORKS.includes(opts.network)) fail(`--network must be one of ${NETWORKS.join(', ')}\n${USAGE}`);
  if (!(opts.timeout > 0)) fail(`--timeout must be a positive number of seconds\n${USAGE}`);
}

const rows = [];
const fixes = [];
const add = (check, found, expected, status, note = '') => rows.push({ check, found, expected, status, note });
const fix = (s) => fixes.includes(s) || fixes.push(s);

// ---------- HTTP without fetch, so connection errors keep their codes ----------
const request = (url, { method = 'GET', body, timeoutMs = 10_000 } = {}) =>
  new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http;
    const t0 = Date.now();
    const req = lib.request(
      url,
      { method, headers: body ? { 'content-type': 'application/octet-stream', 'content-length': body.length } : {} },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks), ms: Date.now() - t0 }));
        res.on('error', reject);
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(Object.assign(new Error(`no answer within ${timeoutMs / 1000} s`), { code: 'TIMEOUT' })));
    req.on('error', (e) => reject(Object.assign(e, { ms: Date.now() - t0 })));
    if (body) req.write(body);
    req.end();
  });

// What midnight-js / the wallet print for each connection error, and what it means.
const explainConnError = (e, where) => {
  const code = e.code ?? '';
  const msg = String(e.message ?? e);
  if (code === 'ECONNREFUSED')
    return [`connect ECONNREFUSED ${where}`, 'Nothing is listening there: the proof server is not running, has exited, or is published on another port.'];
  if (code === 'ECONNRESET' || code === 'EPIPE' || /socket hang up/.test(msg))
    return [
      `read ECONNRESET / socket hang up (${where})`,
      'Something accepted the connection and closed it without answering. With Docker Desktop that is the port forwarder: the container is up but the server is not listening yet (on first start it downloads about 34 MB of keys before it listens) or it has just died.',
    ];
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return [`getaddrinfo ${code} ${where}`, 'The host name does not resolve.'];
  if (code === 'EPROTO' || /wrong version number|SSL/i.test(msg))
    return [`EPROTO … wrong version number (${where})`, 'This is https:// to a server that speaks plain HTTP. A local proof server is http://.'];
  if (code === 'TIMEOUT' || code === 'ETIMEDOUT')
    return [`no answer (${where})`, 'Nothing answered in time: a firewall, a wrong host, or a server too busy to reply.'];
  return [`${code || 'error'}: ${msg}`, ''];
};

// ---------- the version the network is tested with ----------
const expectedVersion = async () => {
  try {
    const text = /^https?:/.test(opts.matrix)
      ? await (await fetch(opts.matrix, { signal: AbortSignal.timeout(10_000) })).text()
      : fs.readFileSync(opts.matrix, 'utf8');
    const m = JSON.parse(text);
    const row = (m.components ?? []).find((c) => /proof server/i.test(c.component ?? ''));
    const v = row?.versions?.[opts.network]?.containerTag;
    if (v) return { version: v, source: opts.matrix === MATRIX_URL ? 'midnight-docs main' : opts.matrix };
  } catch {
    // fall through
  }
  return { version: MATRIX_FALLBACK, source: `built-in ${MATRIX_FALLBACK} (matrix unreadable)` };
};

const sh = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 20_000, maxBuffer: 32 * 1024 * 1024 });
  if (r.error) return { ok: false, missing: r.error.code === 'ENOENT', out: '', err: String(r.error.message) };
  return { ok: r.status === 0, out: r.stdout ?? '', err: r.stderr ?? '' };
};
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

async function main() {
  const { version: expected, source: matrixSrc } = await expectedVersion();

  // 1. The URL, read the way midnight-js 4.1.1 reads it (new URL, then <path>/check and /prove).
  let base;
  try {
    base = new URL(opts.url);
  } catch {
    add('URL', opts.url, 'http://host:port', 'FAIL', 'not a URL');
    fix(`midnight-js throws \`TypeError: Invalid URL\` for "${opts.url}". Write the scheme: http://${opts.url}`);
  }
  if (base && base.protocol !== 'http:' && base.protocol !== 'https:') {
    add('URL', opts.url, 'http://host:port', 'FAIL', `scheme read as ${base.protocol}`);
    fix(`midnight-js throws \`Invalid protocol scheme: '${base.protocol}'. Allowable schemes are one of: http:,https:\`. Write http://${opts.url}`);
    base = undefined;
  }
  if (!base) return report(expected, matrixSrc);
  const prefix = base.pathname.replace(/\/$/, '');
  const at = (p) => new URL(`${base.protocol}//${base.host}${prefix}${p}`);
  if (prefix) {
    add('URL path', prefix, '(none)', 'WARN', `requests go to ${prefix}/check and ${prefix}/prove`);
    fix(`The URL has a path (${prefix}). midnight-js sends ${prefix}/check and ${prefix}/prove, which a proof server answers with 404 (\`Failed Proof Server response: … code="404"\`) unless a proxy maps them. Use the bare http://host:port.`);
  } else add('URL', base.href, '', 'OK');
  const local = ['127.0.0.1', 'localhost', '[::1]', '0.0.0.0'].includes(base.hostname);

  // 2. Reachability and the read-only endpoints.
  let reachable = false;
  let served;
  try {
    const r = await request(at('/health'));
    if (r.status === 200) {
      reachable = true;
      add('GET /health', `200 in ${r.ms} ms`, '200', 'OK');
    } else {
      add('GET /health', `HTTP ${r.status}`, '200', 'FAIL', prefix && r.status === 404 ? `the path ${prefix} isn't served` : r.body.toString().slice(0, 80));
      if (!(prefix && r.status === 404)) fix(`Something answers at ${base.host} but not as a proof server (/health gave ${r.status}). Check the host and port.`);
    }
  } catch (e) {
    const [seen, meaning] = explainConnError(e, base.host);
    add('GET /health', seen, '200', 'FAIL', meaning);
    fix(meaning + (local && opts.docker ? ' The container checks below say which.' : ''));
  }
  if (reachable) {
    const v = await request(at('/version')).catch(() => undefined);
    served = v?.status === 200 ? v.body.toString().trim() : undefined;
    if (!served) add('GET /version', v ? `HTTP ${v.status}` : 'no answer', expected, 'WARN', 'not a proof server version');
    else if (served === expected) add('Version', served, expected, 'OK');
    else {
      const major = (s) => s.split('.')[0];
      add('Version', served, expected, major(served) === major(expected) ? 'WARN' : 'FAIL', `${opts.network} is tested with ${expected}`);
      fix(
        major(served) === major(expected)
          ? `This is proof server ${served}; ${opts.network} is tested with ${expected}. Same major version, so it should read the same requests (the test proof shows whether it does). Move to midnightntwrk/proof-server:${expected}.`
          : `This is proof server ${served}, a different major version from the ${expected} that ${opts.network} is tested with. Its request format differs from what midnight-js 4.x sends. Run midnightntwrk/proof-server:${expected}.`,
      );
    }
    const pv = await request(at('/proof-versions')).catch(() => undefined);
    if (pv?.status === 200) add('GET /proof-versions', pv.body.toString().trim(), '', 'INFO');
    const ready = await request(at('/ready')).catch(() => undefined);
    if (ready) {
      let j = {};
      try {
        j = JSON.parse(ready.body.toString());
      } catch {
        // older servers
      }
      const detail = `processing ${j.jobsProcessing ?? '?'}, pending ${j.jobsPending ?? '?'}, capacity ${j.jobCapacity === 0 ? 'unlimited' : (j.jobCapacity ?? '?')}`;
      if (ready.status === 200) add('GET /ready', detail, '', 'OK');
      else {
        add('GET /ready', `HTTP ${ready.status}: ${detail}`, '200', 'WARN', 'busy');
        fix('The proof server reports itself busy. New requests may get 429 `Job Queue full`. Wait, lower the load, or raise MIDNIGHT_PROOF_SERVER_JOB_CAPACITY / MIDNIGHT_PROOF_SERVER_NUM_WORKERS.');
      }
      if (j.jobCapacity > 0) add('Job capacity', String(j.jobCapacity), 'unlimited (0)', 'INFO', 'requests beyond it get 429 Job Queue full');
    }
  }

  // 3. A real proof of a known-good circuit.
  if (!opts.prove) add('Test proof', 'not run', '', 'SKIP', '--no-prove');
  else if (!reachable) add('Test proof', 'not run', '', 'SKIP', 'server unreachable');
  else await testProof(at);

  // 4. Docker.
  if (!opts.docker) add('Docker', 'not checked', '', 'SKIP', '--no-docker');
  else if (!local) add('Docker', 'not checked', '', 'SKIP', `${base.hostname} is not this machine`);
  else dockerChecks(base, expected, reachable);

  return report(expected, matrixSrc);
}

async function testProof(at) {
  const check = zlib.gunzipSync(Buffer.from(CHECK_GZ, 'base64'));
  const prove = zlib.gunzipSync(Buffer.from(PROVE_GZ, 'base64'));
  const verdict = (step, r, okPrefix) => {
    const text = r.body.subarray(0, 300).toString('latin1');
    if (r.status === 200 && text.startsWith(okPrefix)) return true;
    const shown = text.replace(/[^\x20-\x7e]/g, '.').slice(0, 160);
    if (r.status === 400 && /expected header tag|discriminant|Unsupported|version/i.test(text)) {
      add(`Test ${step}`, `400: ${shown}`, `200 ${okPrefix}`, 'FAIL', 'request format not understood');
      fix(`The server can't read the ledger-8 request format midnight-js 4.x sends ("${shown}"). Run midnightntwrk/proof-server at the matrix version.`);
    } else if (r.status === 400) {
      add(`Test ${step}`, `400: ${shown}`, `200 ${okPrefix}`, 'FAIL', 'rejected a known-good circuit');
      fix('The server rejected a circuit that proves on a healthy 8.1.x server. On 8.x the reason is only in its log, and only with MIDNIGHT_PROOF_SERVER_VERBOSE=true.');
    } else if (r.status === 429) {
      add(`Test ${step}`, `429: ${shown}`, `200 ${okPrefix}`, 'FAIL', 'queue full');
      fix('`Job Queue full`: more requests are waiting than MIDNIGHT_PROOF_SERVER_JOB_CAPACITY allows. midnight-js does not retry 429. Raise the capacity (0 = unlimited) or send fewer proofs at once.');
    } else if (r.status === 500) {
      add(`Test ${step}`, `500: ${shown}`, `200 ${okPrefix}`, 'FAIL', 'internal error');
      fix('`internal error` (500). On 8.x a proof that runs past --job-timeout (MIDNIGHT_PROOF_SERVER_JOB_TIMEOUT, default 600 s) ends like this, and the log says only `failed to complete job`. midnight-js retries a 500 three times, so a slow proof is done four times before it fails.');
    } else {
      add(`Test ${step}`, `HTTP ${r.status}: ${shown}`, `200 ${okPrefix}`, 'FAIL');
      if (r.status === 404) fix('404 on /check or /prove: the URL points at something other than the proof server root.');
    }
    return false;
  };
  try {
    const c = await request(at('/check'), { method: 'POST', body: check, timeoutMs: 60_000 });
    if (!verdict('/check', c, 'midnight:vec(option(u64))')) return;
    add('Test /check', `200 in ${c.ms} ms`, '200', 'OK');
    const p = await request(at('/prove'), { method: 'POST', body: prove, timeoutMs: opts.timeout * 1000 });
    if (!verdict('/prove', p, 'midnight:proof-versioned')) return;
    add('Test /prove', `200 in ${(p.ms / 1000).toFixed(1)} s`, '200', 'OK', p.ms > 30_000 ? 'slow: first use downloads a key, or the machine is short of CPU' : '');
  } catch (e) {
    const [seen] = explainConnError(e, 'during the test proof');
    add('Test proof', seen, 'a proof', 'FAIL', e.code === 'TIMEOUT' ? 'too slow' : 'connection closed while proving');
    fix(
      e.code === 'TIMEOUT'
        ? `No proof within ${opts.timeout} s. midnight-js gives up at 300 s by default with \`AbortError: The user aborted a request.\` Give the machine more CPU, or pass a larger timeout to httpClientProofProvider(url, zkConfigProvider, { timeout }).`
        : 'The connection closed while proving. The process probably died: look for OOMKilled in the container checks below, or give Docker more memory.',
    );
  }
}

function dockerChecks(base, expected, reachable) {
  const ps = sh('docker', ['ps', '-a', '--no-trunc', '--format', '{{json .}}']);
  if (ps.missing) return add('Docker', 'docker CLI not found', '', 'SKIP', 'not using Docker, or not on PATH');
  if (!ps.ok) {
    const down = /Cannot connect to the Docker daemon|daemon running|error during connect/i.test(ps.err);
    add('Docker', down ? 'daemon not running' : 'docker ps failed', '', down ? 'FAIL' : 'WARN', ps.err.trim().split('\n')[0].slice(0, 100));
    if (down) fix('Docker is not running, so no proof server container is either. Start Docker Desktop (or the docker service), then the proof server.');
    return;
  }
  const containers = ps.out
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((c) => /proof-server/.test(c.Image ?? ''));
  if (!containers.length) {
    add('Docker', 'no proof-server container', '', 'INFO', 'running it another way, or not at all');
    return;
  }
  const port = base.port || (base.protocol === 'https:' ? '443' : '80');
  const infos = [];
  for (const c of containers) {
    const ins = sh('docker', ['inspect', c.ID]);
    if (!ins.ok) {
      add(`Container ${c.Names}`, 'inspect failed', '', 'WARN', ins.err.trim().slice(0, 80));
      continue;
    }
    const d = JSON.parse(ins.out)[0];
    const env = Object.fromEntries((d.Config?.Env ?? []).map((e) => [e.split('=')[0], e.slice(e.indexOf('=') + 1)]));
    const bindings = Object.entries(d.HostConfig?.PortBindings ?? {}).flatMap(([cp, list]) =>
      (list ?? []).filter((b) => b.HostPort).map((b) => ({ host: b.HostPort, inner: cp.split('/')[0] })),
    );
    const hostPorts = bindings.map((b) => b.host);
    infos.push({ c, d, env, bindings, hostPorts, name: (d.Name ?? c.Names).replace(/^\//, ''), serves: hostPorts.includes(port) });
  }
  // Check in full the container that publishes the URL's port. If none does and the URL didn't
  // answer, every proof-server container is a suspect (it exited, or publishes another port).
  const serving = infos.filter((i) => i.serves);
  const focus = serving.length ? serving : reachable ? [] : infos;
  for (const i of infos.filter((x) => !focus.includes(x)))
    add(`Container ${i.name}`, `${i.c.Image}, ${i.d.State?.Running ? 'running' : `exited ${i.d.State?.ExitCode}`}`, '', 'INFO', i.hostPorts.length ? `publishes ${i.hostPorts.join(', ')}` : 'no port published');
  if (!serving.length && reachable) add('Docker', `no container publishes :${port}`, '', 'INFO', 'the server at the URL runs outside Docker');
  if (!serving.length && !reachable) {
    const published = infos.filter((i) => i.d.State?.Running && i.hostPorts.length).flatMap((i) => i.hostPorts.map((p) => `${i.name} on :${p}`));
    add('Docker', `no container publishes :${port}`, `:${port}`, 'FAIL', published.length ? `running: ${published.join(', ')}` : 'none running with a port');
    fix(
      published.length
        ? `No proof-server container publishes port ${port}. Running ones publish ${published.join(', ')}: point the app there, or start the container with -p ${port}:6300.`
        : `No running proof-server container publishes port ${port}. Start one (see Remediation 1 in the runbook), or read why it stopped below.`,
    );
  }
  for (const { c, d, env, bindings, hostPorts, name, serves } of focus) {
    const tag = c.Image.split(':')[1] ?? 'latest';
    const label = `Container ${name}`;
    const logs = sh('docker', ['logs', '--tail', '400', c.ID]);
    const log = stripAnsi(`${logs.out}\n${logs.err}`);

    // Image.
    if (/^midnightnetwork\//.test(c.Image)) {
      add(`${label} image`, c.Image, `midnightntwrk/proof-server:${expected}`, 'FAIL', 'old repository');
      fix(`${name} uses the old midnightnetwork/proof-server repository (its latest is a 7.0.0 release candidate). Use midnightntwrk/proof-server:${expected}.`);
    } else if (tag === 'latest') {
      add(`${label} image`, c.Image, expected, 'WARN', 'latest moves; check /version');
      fix(`${name} runs the latest tag, which moves between releases. Pin midnightntwrk/proof-server:${expected}.`);
    } else add(`${label} image`, c.Image, expected, tag === expected ? 'OK' : 'WARN', serves ? `publishes :${port}` : '');

    // State.
    const st = d.State ?? {};
    if (!st.Running) {
      if (st.OOMKilled) {
        add(`${label} state`, `exited ${st.ExitCode}, OOMKilled`, 'running', 'FAIL', 'killed for memory');
        fix(`${name} was killed for memory while proving. Clients saw \`socket hang up\` / \`ECONNRESET\` (midnight-js) or \`Transport error\` (wallet), then \`ECONNREFUSED\`. Give Docker more memory (Docker Desktop: Settings → Resources) and remove any --memory limit; large circuits need GBs.`);
      } else if (/Giving up/.test(log)) {
        const line = log.split('\n').reverse().find((l) => /Failed to fetch data from|Giving up/.test(l)) ?? '';
        add(`${label} state`, `exited ${st.ExitCode}`, 'running', 'FAIL', 'key download failed');
        fix(`${name} gave up downloading its keys and exited: ${line.trim().slice(0, 160)}. Keep the keys in a volume (-v midnight-zk-params:/.cache/midnight) and start it again: completed files are kept, so each restart only fetches what's missing. Behind a firewall, allow srs.midnight.network or set MIDNIGHT_PARAM_SOURCE to a mirror.`);
      } else if (/invalid option|command not found/.test(log)) {
        add(`${label} state`, `exited ${st.ExitCode}`, 'running', 'FAIL', 'bad command');
        fix(`${name} exited at once: ${log.trim().split('\n').find((l) => /invalid option|command not found/.test(l))?.trim().slice(0, 120)}. Arguments given after the image name go to the image's \`bash -c\`; pass no command, and set options with environment variables.`);
      } else {
        add(`${label} state`, `exited ${st.ExitCode}`, 'running', serves ? 'FAIL' : 'INFO', st.FinishedAt?.slice(0, 19) ?? '');
        if (serves) fix(`${name} is not running (exit ${st.ExitCode}). Read \`docker logs ${name}\`, then start it again.`);
      }
    } else {
      const listening = /listening on/.test(log);
      const fetching = [...log.matchAll(/Fetching '([^']+)' - (\d+) \/ (\d+) bytes downloaded/g)];
      if (!listening && fetching.length) {
        const last = fetching[fetching.length - 1];
        add(`${label} state`, `running, downloading keys (${last[1]} ${last[2]}/${last[3]} bytes)`, 'listening', 'FAIL', 'not listening yet');
        fix(`${name} is still downloading its keys and won't listen until it has them all (about 34 MB from srs.midnight.network). Until then clients get \`read ECONNRESET\`. Wait, and keep the keys in a volume so the next container starts in seconds.`);
      } else add(`${label} state`, listening ? 'running, listening' : 'running', 'running', 'OK', st.RestartCount ? `${st.RestartCount} restarts` : '');
    }

    // Ports: what is published, and the port the server really listens on inside the container
    // (PORT with the image's own command; MIDNIGHT_PROOF_SERVER_PORT when the command is replaced).
    const listen = [...log.matchAll(/listening on: [^\s]*:(\d+)/g)].pop()?.[1];
    const inner = listen ?? env.PORT ?? '6300';
    const shown = bindings.map((b) => `${b.host}->${b.inner}`).join(', ');
    const urlBinding = bindings.find((b) => b.host === port);
    if (!bindings.length) {
      add(`${label} ports`, 'none published', `${port}->${inner}`, st.Running ? 'WARN' : 'INFO', 'unreachable from the host');
      if (st.Running) fix(`${name} publishes no port, so nothing outside Docker reaches it. Run it with -p ${port}:${inner}.`);
    } else if (st.Running && listen && urlBinding && urlBinding.inner !== listen) {
      add(`${label} ports`, `${shown}; listens on ${listen}`, `${port}->${listen}`, 'FAIL', 'forwarded to a port nothing listens on');
      fix(`${name} forwards ${port} to container port ${urlBinding.inner}, but the server listens on ${listen} inside the container, so clients get \`read ECONNRESET\`. Publish -p ${port}:${listen}, or remove the PORT / MIDNIGHT_PROOF_SERVER_PORT setting.`);
    } else add(`${label} ports`, shown + (listen ? `; listens on ${listen}` : ''), '', serves ? 'OK' : 'INFO', serves ? '' : `not the URL's port ${port}`);

    // Command and environment.
    const cmd = d.Config?.Cmd ?? [];
    const bashC = (d.Config?.Entrypoint ?? []).slice(-1)[0] === '-c';
    if (bashC && cmd.length > 1) {
      add(`${label} command`, JSON.stringify(cmd), 'no command', 'WARN', `${cmd.slice(1).join(' ')} ignored`);
      fix(`${name}'s command ${JSON.stringify(cmd)} loses everything after the first word: the image runs \`bash -c\`, which takes only one string. Drop the command and use environment variables (MIDNIGHT_PROOF_SERVER_VERBOSE=true, PORT, MIDNIGHT_PROOF_SERVER_NUM_WORKERS …).`);
    }
    const verbose = env.MIDNIGHT_PROOF_SERVER_VERBOSE || (bashC && cmd.length === 1 && /\s(-v|--verbose)\b/.test(cmd[0]));
    if (!verbose) {
      add(`${label} logging`, 'not verbose', 'verbose', 'WARN', 'rejection reasons not logged');
      fix(`${name} doesn't log why it rejects a request (a 400 \`bad input\` shows only the request line). Set -e MIDNIGHT_PROOF_SERVER_VERBOSE=true.`);
    } else add(`${label} logging`, 'verbose', '', 'OK');

    // Key cache.
    const mounts = (d.Mounts ?? []).map((m) => m.Destination);
    const cached = mounts.some((m) => CACHE_DIRS.includes(m)) || (env.MIDNIGHT_PP && mounts.some((m) => env.MIDNIGHT_PP.startsWith(m)));
    if (!cached) {
      add(`${label} key cache`, 'inside the container', 'a volume', 'WARN', 're-downloaded by every new container');
      fix(`${name} keeps its keys inside the container, so every new container downloads about 34 MB before it listens, and on a slow link it can give up and exit. Mount a volume: -v midnight-zk-params:/.cache/midnight.`);
    } else add(`${label} key cache`, mounts.find((m) => CACHE_DIRS.includes(m)) ?? env.MIDNIGHT_PP, '', 'OK');

    // What the log says about recent requests.
    const count = (re) => (log.match(re) ?? []).length;
    const full = count(/JobQueueFull|Job Queue full/g);
    const timedOut = count(/failed to complete job/g);
    const bad = [...log.matchAll(/Error in response: (BadInput\([^\n]*?\)|[^\n]*Invalid input data[^\n]*)/g)].map((m) => m[1]);
    if (full) add(`${label} log`, `${full}× Job Queue full`, '', 'WARN', 'requests refused with 429');
    if (timedOut) {
      add(`${label} log`, `${timedOut}× failed to complete job`, '', 'WARN', 'jobs past --job-timeout, answered 500');
      fix(`${name} answered "internal error" (500) to proofs that ran past its job timeout. Raise MIDNIGHT_PROOF_SERVER_JOB_TIMEOUT or give it more CPU.`);
    }
    if (bad.length) {
      add(`${label} log`, `${bad.length}× rejected: ${bad[bad.length - 1].slice(0, 70)}`, '', 'WARN', 'see the runbook');
      if (bad.some((b) => /couldn't find built-in key/.test(b)))
        fix(`${name} logged \`couldn't find built-in key <circuit>\`: the app sent /check without the circuit's ZKIR. midnight-js 4.x swallows the zk-config error, so the app's zkConfigProvider can't read <compiled>/zkir/<circuit>.bzkir (wrong path, file not served or not copied).`);
    }
  }
}

function report(expected, matrixSrc) {
  const cols = ['check', 'found', 'expected', 'status'];
  const width = Object.fromEntries(cols.map((k) => [k, Math.min(Math.max(k.length, ...rows.map((r) => String(r[k]).length)), k === 'found' ? 52 : k === 'check' ? 44 : 34)]));
  const cell = (s, n) => {
    const t = String(s ?? '');
    return t.length > n ? `${t.slice(0, n - 1)}…` : t.padEnd(n);
  };
  console.log(`check-proof-server: ${opts.url}, network ${opts.network} (proof server ${expected}, from ${matrixSrc})\n`);
  console.log(`${cell('check', width.check)}  ${cell('found', width.found)}  ${cell('expected', width.expected)}  ${cell('status', width.status)}  note`);
  for (const r of rows) console.log(`${cell(r.check, width.check)}  ${cell(r.found, width.found)}  ${cell(r.expected, width.expected)}  ${cell(r.status, width.status)}  ${r.note}`);
  const fails = rows.filter((r) => r.status === 'FAIL').length;
  if (fixes.length) {
    console.log('\nWhat to do:');
    for (const f of fixes) console.log(`  - ${f}`);
  }
  console.log(
    fails
      ? `\nRESULT: ${fails} problem(s) that stop proving. The runbook maps each error text to its cause.`
      : '\nRESULT: this proof server can prove. If the app still fails, the cause is on the client side (URL, zk config files, timeout, wallet); see the runbook.',
  );
  return fails;
}

// Test payloads, captured from midnight-js 4.1.1 (ledger-v8 8.1.0) calling `increment` on
// `export ledger round: Counter; export circuit increment(): [] { round.increment(1); }`,
// compiled with Compact 0.31.1. /check: the proof preimage and the circuit's ZKIR. /prove: the
// preimage with the circuit's prover key, verifier key and ZKIR. No witness or wallet data.
// gzip + base64. SHA-256 of the raw bytes: check 216c1ab1…3868, prove 83f9014a…eb57.
const CHECK_GZ =
  'H4sIAAAAAAACE8vNTMnLTM8osdIoKMrPT9MtKErNzE1MT9UtSy0qzszPS03RyS8oyczP0ygvSiwoSE3RzSzS1LRiZGCQOcjI' +
  'wsJgwdLKxMDAmN/cOFGibMPJ1Ry6tXJRm1e7PXddttWkdVFy+KIZgZrK64vF1lslR1n6GP+ekf3u1WNjiaSq86xCNY0+7WuV' +
  'Hb4yFWmqZOYlF6XmpuaVMDIy5sIclVmkW5xfWpScGl1mFGvFwGjDw8JzkJGHgY2FjYGNgY2DnZFBgMeCjYeNgZ2RgYOnlYlN' +
  'gJ2RgQUASmlitdUAAAA=';
const PROVE_GZ =
  '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' +
  'bB5WGkk9AAA=';

try {
  const fails = await main();
  process.exit(fails ? 2 : 0);
} catch (e) {
  fail(`check-proof-server failed: ${e?.stack ?? e}`);
}
