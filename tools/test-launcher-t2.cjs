'use strict';
// T2 rows of the launcher tests: the keyless MCP stub (zero tools) and the honest Node/npm messages.
// Called by tools/test-launcher.cjs, which counts the rows; it can also run alone:
//   node tools/test-launcher-t2.cjs [claude|cursor]
// Environment rules:
//   * Every child gets an env built here from a short allowlist plus the row's own values, never process.env as a whole.
//   * Keys are dummy values generated at runtime, only inside temp HOMEs. The key bytes are never printed; the last row scans
//     every captured stdout and stderr for them.
//   * Keyed rows point the Marrow API at https://127.0.0.1:9 (the server accepts https only; nothing listens there) and load a
//     preload that refuses non-loopback connects, so nothing leaves the host.
//   * npm installs use npm_config_cache from the parent (a cache seeded with the pinned tarballs keeps them offline).
// Differential rows (T2-4, T2-10, T2-13) compare against the baseline commit be64842b: set T2_BASELINE_DIR to an extracted tree
// of it, or leave it unset and the rows extract T2_BASELINE_REF (default: be64842b) with `git archive`. Without a baseline
// those rows fail loudly.
// Optional T2_REPORT_DIR: a JSON file with the matrices and texts of the run is written there.
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const BASELINE_REF = process.env.T2_BASELINE_REF || 'be64842b6120af91edc44854569124b38730614f';
const DEAD_URL = 'https://127.0.0.1:9';
const REQUIRED_LINE = 'MARROW_API_KEY environment variable is required';
const STUB_NOTICE = 'Marrow plugin: no Marrow key on this machine, so the Marrow MCP server started with no tools.';
const DENY_WORDS = /allow|approv|permit|grant|authori[sz]|proceed|decision|safe to/i;
const POSIX = process.platform !== 'win32';

function start({ host, repo, result: countRow }) {
  const CURSOR = host === 'cursor';
  const source = path.join(repo, 'plugins', CURSOR ? 'marrow-cursor' : 'marrow');
  const rootVar = CURSOR ? 'CURSOR_PLUGIN_ROOT' : 'CLAUDE_PLUGIN_ROOT';
  const work = fs.mkdtempSync(path.join(os.tmpdir(), `marrow-t2-${host}-`));
  const cache = process.env.npm_config_cache || path.join(work, 'npm-cache');
  const KEY = `mk_${crypto.randomBytes(24).toString('hex')}`;
  const captured = [];
  const report = { host, rows: [] };
  const result = (ok, name, detail = '') => {
    report.rows.push({ ok, name, detail });
    countRow(ok, name, detail);
  };
  const H = CURSOR
    ? { pre: 'cursor-pre-action-hook', post: 'cursor-hook', session: 'cursor-session-hook', ctx: 'cursor-context-hook', extra: [] }
    : { pre: 'claude-pre-action-hook', post: 'claude-hook', session: 'claude-session-hook', ctx: 'claude-context-hook', extra: ['claude-permission-request-hook'] };

  // ---- environment and plugin copies -------------------------------------------------------------------
  function env(extra = {}) {
    const out = {};
    for (const name of ['PATH', 'LANG', 'TMPDIR', 'SystemRoot', 'npm_config_registry']) if (process.env[name]) out[name] = process.env[name];
    return { ...out, npm_config_cache: cache, npm_config_update_notifier: 'false', ...extra };
  }
  const forceRemove = (dir) => {
    if (POSIX) spawnSync('chmod', ['-R', 'u+rwX', dir], { stdio: 'ignore' });
    fs.rmSync(dir, { recursive: true, force: true });
  };
  const freshDir = (dir) => {
    forceRemove(dir);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
    return dir;
  };
  let copies = 0;
  function plugin({ modules, from = source }) {
    copies += 1;
    const dir = path.join(work, `plugin-${copies}`);
    fs.cpSync(from, dir, { recursive: true, filter: (p) => !p.includes(`${path.sep}node_modules`) });
    if (modules) {
      const r = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: dir, env: env({ HOME: work, USERPROFILE: work }), stdio: 'ignore' });
      if (r.status !== 0) throw new Error('npm ci failed');
    }
    return dir;
  }
  function makeHome(name, { files = true } = {}) {
    const home = freshDir(path.join(work, 'homes', name));
    if (files) {
      const project = path.join(home, 'project');
      fs.mkdirSync(project);
      fs.writeFileSync(path.join(project, 'README.md'), 'smoke\n');
      fs.writeFileSync(path.join(project, 'package.json'), '{"name":"smoke","version":"1.0.0"}\n');
    }
    return home;
  }
  const keyed = { MARROW_BASE_URL: DEAD_URL };
  const ownerFile = (home, name = 'env', lines = [`MARROW_API_KEY=${KEY}`, `MARROW_BASE_URL=${DEAD_URL}`], mode = 0o600) => {
    const dir = path.join(home, '.marrow');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
    const file = path.join(dir, name);
    fs.writeFileSync(file, `${lines.join('\n')}\n`, { mode });
    fs.chmodSync(file, mode);
    return file;
  };

  // Test-only preloads, written here so nothing in the product knows about them.
  const preloads = path.join(work, 'preloads');
  fs.mkdirSync(preloads);
  const preload = (name, text) => {
    const file = path.join(preloads, name);
    fs.writeFileSync(file, text);
    return file;
  };
  const NETGUARD = preload('netguard.cjs', `'use strict';
const net = require('net');
const dns = require('dns');
const local = (host) => host === undefined || host === null || host === '' || host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function guarded(...args) {
  const first = args[0];
  const ipc = typeof first === 'string' || (first && typeof first === 'object' && typeof first.path === 'string');
  const host = first && typeof first === 'object' ? first.host : (typeof args[1] === 'string' ? args[1] : undefined);
  if (!ipc && !local(host)) throw new Error('t2 netguard: non-loopback connect refused');
  return connect.apply(this, args);
};
const lookup = dns.lookup;
dns.lookup = function guarded(host, ...rest) {
  if (!local(host)) throw new Error('t2 netguard: non-loopback lookup refused');
  return lookup.call(this, host, ...rest);
};
`);
  const THROW = preload('throw-resolver.cjs', `'use strict';
const Module = require('module');
const load = Module._load;
let calls = 0;
Module._load = function patched(request, parent, isMain) {
  const exported = load.apply(this, arguments);
  try {
    const file = Module._resolveFilename(request, parent, isMain);
    if (/[\\\\/]@getmarrow[\\\\/]mcp[\\\\/]dist[\\\\/]env\\.js$/.test(file) && !exported.__t2) {
      Object.defineProperty(exported, '__t2', { value: true });
      const original = exported.resolveMarrowEnv;
      exported.resolveMarrowEnv = function resolveMarrowEnv() {
        calls += 1;
        if (process.env.T2_THROW === 'always' || calls === 1) throw new Error('t2 resolver failure');
        return original.apply(this, arguments);
      };
    }
  } catch (error) {
    if (/t2 resolver/.test(String(error))) throw error;
  }
  return exported;
};
`);
  const GUARD = preload('guard.cjs', `'use strict';
const Module = require('module');
const fs = require('fs');
const net = require('net');
const log = process.env.T2_GUARD_LOG;
const loaded = new Set();
const attempts = [];
const builtin = new Set(Module.builtinModules);
const blocked = new Set(['child_process', 'http', 'https', 'http2', 'tls', 'dns', 'dgram']);
const refuse = (what) => () => { attempts.push(what); throw new Error('t2 guard: ' + what); };
net.connect = refuse('net.connect');
net.createConnection = refuse('net.createConnection');
net.Socket.prototype.connect = refuse('net.Socket.connect');
const load = Module._load;
Module._load = function patched(request) {
  const name = String(request).replace(/^node:/, '');
  if (builtin.has(name)) {
    if (blocked.has(name)) { attempts.push('require ' + name); throw new Error('t2 guard: require ' + name); }
    loaded.add(name);
  }
  return load.apply(this, arguments);
};
process.on('exit', () => {
  const internal = process.moduleLoadList.filter((m) => /^NativeModule (child_process|http|https|http2|tls|dns|dgram)$/.test(m));
  fs.writeFileSync(log, JSON.stringify({ loaded: [...loaded].sort(), attempts, internalBlocked: internal }));
});
`);
  const OLDNODE = preload('oldnode.cjs', `'use strict';
Object.defineProperty(process, 'versions', { value: Object.assign({}, process.versions, { node: process.env.T2_NODE_VERSION || '16.20.2' }), configurable: true });
`);
  const SPY = preload('spawn-spy.cjs', `'use strict';
const fs = require('fs');
const cp = require('child_process');
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  const original = cp[name];
  cp[name] = function spied(...args) {
    try { fs.appendFileSync(process.env.T2_SPAWN_LOG, name + '\\n'); } catch {}
    return original.apply(this, args);
  };
}
`);
  const nodeOptions = (...files) => ({ NODE_OPTIONS: files.map((f) => `--require=${f}`).join(' ') });

  // ---- running the launcher -----------------------------------------------------------------------------
  const take = (r) => {
    const out = { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', error: r.error ? r.error.code : undefined };
    captured.push(out.stdout, out.stderr);
    return out;
  };
  function envFor(pluginDir, home, extra) {
    return env({
      HOME: home, USERPROFILE: home, [rootVar]: pluginDir,
      ...(CURSOR ? {} : { CLAUDE_PLUGIN_DATA: path.join(home, '.claude-data') }),
      ...extra,
    });
  }
  function launch(pluginDir, args, { home, cwd, input = '', extra = {}, timeout = 120000 }) {
    return take(spawnSync(process.execPath, [path.join(pluginDir, 'scripts', 'marrow-launch.cjs'), ...args], {
      cwd: cwd || path.join(home, 'project'), input, encoding: 'utf8', timeout, env: envFor(pluginDir, home, extra),
    }));
  }
  function direct(pluginDir, { home, cwd, input = '', extra = {} }) {
    const entry = path.join(pluginDir, 'node_modules', '@getmarrow', 'mcp', 'dist', 'cli.js');
    return take(spawnSync(process.execPath, [entry], {
      cwd: cwd || path.join(home, 'project'), input, encoding: 'utf8', timeout: 120000, env: envFor(pluginDir, home, extra),
    }));
  }
  // Long-lived session: write lines, wait for the expected number of replies, check the process is still alive, then end stdin.
  function session(pluginDir, { home, lines, replies, extra = {}, chunked = false, timeoutMs = 60000 }) {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [path.join(pluginDir, 'scripts', 'marrow-launch.cjs'), 'mcp'], {
        cwd: path.join(home, 'project'), env: envFor(pluginDir, home, extra), stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      let alive = null;
      let ended = false;
      const end = () => {
        if (ended) return;
        ended = true;
        alive = child.exitCode === null && child.signalCode === null;
        child.stdin.end();
      };
      const timer = setTimeout(() => { end(); setTimeout(() => child.kill('SIGKILL'), 3000).unref(); }, timeoutMs);
      child.stdout.on('data', (c) => {
        stdout += c;
        if (stdout.split('\n').length - 1 >= replies) end();
      });
      child.stderr.on('data', (c) => { stderr += c; });
      child.stdin.on('error', () => {});
      child.on('close', (status) => {
        clearTimeout(timer);
        const out = { status, stdout, stderr, alive };
        captured.push(stdout, stderr);
        resolve(out);
      });
      const data = lines;
      if (chunked) {
        // Writes in 64 KiB pieces so a huge line arrives across many chunks.
        let index = 0;
        const next = () => {
          if (index >= data.length) { if (replies === 0) end(); return; }
          const piece = data[index];
          index += 1;
          if (!child.stdin.write(piece)) child.stdin.once('drain', next); else setImmediate(next);
        };
        next();
      } else {
        child.stdin.write(data.join(''));
        if (replies === 0) end();
      }
    });
  }
  const rpc = (id, method, params) => JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
  const INIT = (id = 1, params) => rpc(id, 'initialize', params || { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't2', version: '0' } });
  const NOTIFIED = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const parseLines = (text) => {
    const messages = [];
    let bad = 0;
    for (const line of text.split('\n')) {
      if (!line) continue;
      try { messages.push(JSON.parse(line)); } catch { bad += 1; }
    }
    return { messages, bad };
  };
  const isRpc = (m) => m && typeof m === 'object' && m.jsonrpc === '2.0' && Object.prototype.hasOwnProperty.call(m, 'id')
    && (Object.prototype.hasOwnProperty.call(m, 'result') !== Object.prototype.hasOwnProperty.call(m, 'error'));
  const MCP_INPUT = `${[INIT(1), NOTIFIED, rpc(2, 'tools/list')].join('\n')}\n`;

  // ---- baseline (be64842b) ------------------------------------------------------------------------------
  let baselineDir = process.env.T2_BASELINE_DIR || '';
  let baselineError = '';
  if (!baselineDir) {
    const dir = path.join(work, 'baseline');
    fs.mkdirSync(dir);
    const archive = spawnSync('git', ['-C', repo, 'archive', BASELINE_REF], { maxBuffer: 256 * 1024 * 1024 });
    const untar = archive.status === 0 ? spawnSync('tar', ['-x', '-C', dir], { input: archive.stdout }) : { status: 1 };
    if (archive.status === 0 && untar.status === 0) baselineDir = dir; else baselineError = `git archive ${BASELINE_REF.slice(0, 8)} failed`;
  }
  const baselineSource = baselineDir ? path.join(baselineDir, 'plugins', CURSOR ? 'marrow-cursor' : 'marrow') : '';

  // ---- slow rows, started now and collected in finish() -------------------------------------------------
  // They wait out the launcher's real 120 s npm timeout and 150 s lock wait, so they run beside everything else.
  const noNpmNode = path.join(work, 'nonpm', 'bin', 'node');
  fs.mkdirSync(path.dirname(noNpmNode), { recursive: true });
  try { fs.linkSync(process.execPath, noNpmNode); } catch { fs.copyFileSync(process.execPath, noNpmNode); fs.chmodSync(noNpmNode, 0o755); }
  const fakeBin = path.join(work, 'fakenpm');
  fs.mkdirSync(fakeBin);
  fs.writeFileSync(path.join(fakeBin, 'npm'), '#!/bin/sh\nexec sleep 1000\n', { mode: 0o755 });
  function slowRun(label, build) {
    const started = Date.now();
    const { pluginDir, home, extra, node } = build();
    return new Promise((resolve) => {
      const child = spawn(node || process.execPath, [path.join(pluginDir, 'scripts', 'marrow-launch.cjs'), 'mcp'], {
        cwd: path.join(home, 'project'), env: envFor(pluginDir, home, extra), stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (c) => { stdout += c; });
      child.stderr.on('data', (c) => { stderr += c; });
      child.stdin.end();
      child.on('close', (status) => {
        captured.push(stdout, stderr);
        resolve({ label, status, stdout, stderr, ms: Date.now() - started, home, pluginDir });
      });
    });
  }
  const dataOf = (home) => (CURSOR ? path.join(home, '.marrow', 'cursor-plugin') : path.join(home, '.claude-data'));
  const manifestId = (pluginDir) => {
    const m = JSON.parse(fs.readFileSync(path.join(pluginDir, 'scripts', 'mcp-manifest.json'), 'utf8'));
    return `mcp-${m.mcp.version}-${m.sha256.slice(0, 16)}`;
  };
  const slowTimeout = POSIX ? slowRun('npm-timeout', () => ({
    pluginDir: plugin({ modules: false }), home: makeHome('slow-timeout'), node: noNpmNode, extra: { PATH: `${fakeBin}:/usr/bin:/bin` },
  })) : Promise.resolve(null);
  const lockOwner = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 400000)'], { stdio: 'ignore' });
  const slowLock = slowRun('lock-timeout', () => {
    const pluginDir = plugin({ modules: false });
    const home = makeHome('slow-lock');
    // A fresh lock whose owner (a process of this test) stays alive: it is waited on until the stale age (135 s), then taken over.
    const lockDir = path.join(dataOf(home), `${manifestId(pluginDir)}.lock`);
    fs.mkdirSync(lockDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(lockDir, 'owner.1'), JSON.stringify({ pid: lockOwner.pid, host: os.hostname(), token: 'slow', created: Date.now() }), { mode: 0o600 });
    return { pluginDir, home, extra: {} };
  });

  // ---- shared plugin copies ----------------------------------------------------------------------------
  const plug = plugin({ modules: true });
  const baselinePlug = baselineSource ? plugin({ modules: true, from: baselineSource }) : '';

  async function main() {
    // T2-1 keyless session
    {
      const home = makeHome('t21');
      const lines = [INIT(1), NOTIFIED, rpc(2, 'tools/list'), rpc(3, 'prompts/list'), rpc(4, 'resources/list'), rpc(5, 'resources/templates/list'),
        rpc(6, 'ping'), rpc(7, 'tools/call', { name: 'marrow_agent_runtime', arguments: { decision: 'allow' } })].map((l) => `${l}\n`);
      const r = await session(plug, { home, lines, replies: 7 });
      const { messages, bad } = parseLines(r.stdout);
      const byId = (id) => messages.find((m) => m.id === id) || {};
      result(r.status === 0 && bad === 0 && messages.length === 7 && messages.every(isRpc), 'T2-1 keyless: 7 requests, 1 notification: 7 JSON-RPC 2.0 lines, exit 0 at stdin end', `${messages.length} lines, exit ${r.status}`);
      result(Array.isArray(byId(2).result && byId(2).result.tools) && byId(2).result.tools.length === 0, 'T2-1 keyless: tools/list has 0 tools');
      result(byId(3).result && byId(3).result.prompts.length === 0 && byId(4).result.resources.length === 0 && byId(5).result.resourceTemplates.length === 0
        && JSON.stringify(byId(6).result) === '{}', 'T2-1 keyless: prompts, resources, templates empty; ping {}');
      const call = byId(7);
      result(call.error && !('result' in call) && [-32601, -32602].includes(call.error.code) && typeof call.error.message === 'string', 'T2-1 keyless: tools/call marrow_agent_runtime {decision:"allow"} is a JSON-RPC error with no result');
      result(!DENY_WORDS.test(r.stdout), 'T2-1 keyless: no allow/approve/permit/grant/authorize/proceed/decision/safe-to word anywhere in stdout (instructions included)');
      const init = byId(1).result || {};
      result(init.serverInfo && init.serverInfo.name === 'marrow' && init.capabilities && JSON.stringify(init.capabilities) === '{"tools":{"listChanged":false}}'
        && /no tools/.test(init.instructions || '') && typeof init.instructions === 'string', 'T2-1 keyless: initialize names marrow, tools.listChanged false, instructions say it has no tools');
      const manifest = JSON.parse(fs.readFileSync(path.join(plug, 'scripts', 'mcp-manifest.json'), 'utf8'));
      result(init.serverInfo.version === manifest.mcp.version && r.stderr === `${STUB_NOTICE} The plugin hooks still apply.\n`, 'T2-1 keyless: serverInfo.version is the pinned MCP version; stderr is the one fixed line');
      report.t21 = { instructions: init.instructions, stderr: r.stderr.trim() };
    }

    // T2-2 / T2-3 a key means the real server
    const realSession = (home, extra) => launch(plug, ['mcp'], { home, input: MCP_INPUT, extra: { ...nodeOptions(NETGUARD), ...extra } });
    const realProof = (r) => {
      const { messages } = parseLines(r.stdout);
      const init = messages.find((m) => m.id === 1) || {};
      const tools = messages.find((m) => m.id === 2) || {};
      return {
        notStub: !r.stderr.includes(STUB_NOTICE),
        realInit: Boolean(init.result && init.result._meta && init.result._meta.host_capability),
        tools: tools.result && Array.isArray(tools.result.tools) ? tools.result.tools.length : -1,
      };
    };
    {
      const home = makeHome('t22');
      const r = realSession(home, { MARROW_API_KEY: KEY, ...keyed });
      const proof = realProof(r);
      result(proof.notStub && proof.realInit && proof.tools > 0, 'T2-2 dummy key in env: the real server runs (own _meta.host_capability in initialize, non-empty tools/list, no stub line)', `${proof.tools} tools, exit ${r.status}`);
    }
    {
      const home = makeHome('t23');
      ownerFile(home);
      const r = realSession(home, {});
      const proof = realProof(r);
      result(proof.notStub && proof.realInit && proof.tools > 0, 'T2-3 dummy key in ~/.marrow/env (file 600, dir 700): the real server runs (same proofs)', `${proof.tools} tools, exit ${r.status}`);
    }

    // T2-4 equivalence matrix
    {
      const states = [];
      const add = (name, prep) => states.push({ name, prep });
      add('none', () => ({}));
      add('empty MARROW_API_KEY', () => ({ extra: { MARROW_API_KEY: '' } }));
      add('whitespace-only MARROW_API_KEY', () => ({ extra: { MARROW_API_KEY: '   ', ...keyed } }));
      add('dummy key in env', () => ({ extra: { MARROW_API_KEY: KEY, ...keyed } }));
      add('MARROW_KEY alias', () => ({ extra: { MARROW_KEY: KEY, ...keyed } }));
      add('garbage key in env (invalid format)', () => ({ extra: { MARROW_API_KEY: 'not a key !!', ...keyed } }));
      add('garbage key in env file 600', (h) => { ownerFile(h, 'env', ['MARROW_API_KEY=not a key !!', `MARROW_BASE_URL=${DEAD_URL}`]); return {}; });
      add('env file 600, dir 700', (h) => { ownerFile(h); return {}; });
      add('env.local file 600', (h) => { ownerFile(h, 'env.local'); return {}; });
      add('env file with CRLF, comments, export, quotes', (h) => {
        const dir = path.join(h, '.marrow');
        fs.mkdirSync(dir, { mode: 0o700 });
        fs.writeFileSync(path.join(dir, 'env'), `# comment\r\n\r\nexport MARROW_API_KEY="${KEY}" # trailing\r\nMARROW_BASE_URL=${DEAD_URL}\r\n`, { mode: 0o600 });
        fs.chmodSync(path.join(dir, 'env'), 0o600);
        return {};
      });
      add('env file: key line commented out', (h) => { ownerFile(h, 'env', [`#MARROW_API_KEY=${KEY}`, `MARROW_BASE_URL=${DEAD_URL}`]); return {}; });
      add('env file empty value', (h) => { ownerFile(h, 'env', ['MARROW_API_KEY=']); return {}; });
      add('FLEET_AGENT_ID set, no key', () => ({ extra: { MARROW_FLEET_AGENT_ID: 'agent-t2' } }));
      add('AGENT_ID + per-agent key vars, no direct key', () => ({ extra: { MARROW_AGENT_ID: 'a1', MARROW_AGENT_ID_X: 'a1', MARROW_KEY_X: KEY } }));
      add('project .env with a key (never read as a key)', (h) => { fs.writeFileSync(path.join(h, 'project', '.env'), `MARROW_API_KEY=${KEY}\n`, { mode: 0o600 }); return {}; });
      add('MARROW_BASE_URL http (invalid), no key', () => ({ extra: { MARROW_BASE_URL: 'http://127.0.0.1:9' } }));
      add('MARROW_BASE_URL https custom, no key', () => ({ extra: { MARROW_BASE_URL: DEAD_URL } }));
      add('MARROW_BASE_URL with credentials, no key', () => ({ extra: { MARROW_BASE_URL: 'https://user:pass@127.0.0.1:9' } }));
      add('MARROW_BASE_URL unparsable, no key', () => ({ extra: { MARROW_BASE_URL: 'not a url' } }));
      if (POSIX) {
        add('env file group-writable (620)', (h) => { ownerFile(h, 'env', undefined, 0o620); return {}; });
        add('env file world-readable (644)', (h) => { ownerFile(h, 'env', undefined, 0o644); return {}; });
        add('env file unreadable (000)', (h) => { ownerFile(h, 'env', undefined, 0o000); return {}; });
        add('env file symlinked', (h) => {
          const real = path.join(h, 'real-env');
          fs.writeFileSync(real, `MARROW_API_KEY=${KEY}\nMARROW_BASE_URL=${DEAD_URL}\n`, { mode: 0o600 });
          fs.mkdirSync(path.join(h, '.marrow'), { mode: 0o700 });
          fs.symlinkSync(real, path.join(h, '.marrow', 'env'));
          return {};
        });
        add('~/.marrow symlinked folder', (h) => {
          const real = path.join(h, 'real-marrow');
          fs.mkdirSync(real, { mode: 0o700 });
          fs.writeFileSync(path.join(real, 'env'), `MARROW_API_KEY=${KEY}\nMARROW_BASE_URL=${DEAD_URL}\n`, { mode: 0o600 });
          fs.symlinkSync(real, path.join(h, '.marrow'));
          return {};
        });
        add('~/.marrow dir 755, file 600', (h) => { ownerFile(h); fs.chmodSync(path.join(h, '.marrow'), 0o755); return {}; });
        add('~/.marrow dir 775 (group-writable), file 600', (h) => { ownerFile(h); fs.chmodSync(path.join(h, '.marrow'), 0o775); return {}; });
        add('HOME group-writable (770), file 600', (h) => { ownerFile(h); fs.chmodSync(h, 0o770); return {}; });
        add('env file is a FIFO', (h) => {
          fs.mkdirSync(path.join(h, '.marrow'), { mode: 0o700 });
          spawnSync('mkfifo', [path.join(h, '.marrow', 'env')]);
          return {};
        });
        add('env file is a directory', (h) => { fs.mkdirSync(path.join(h, '.marrow', 'env'), { recursive: true, mode: 0o700 }); return {}; });
        add('HOME is an unreadable folder (000)', (h) => {
          const locked = path.join(h, 'locked');
          fs.mkdirSync(locked, { mode: 0o000 });
          return { home: locked, cwd: h };
        });
        add('HOME is another account\'s folder (/root)', (h) => (fs.existsSync('/root') ? { home: '/root', cwd: h } : null));
      }
      const rows = [];
      let n = 0;
      for (const state of states) {
        n += 1;
        const home = makeHome(`t24-${n}`);
        const prepared = state.prep(home);
        if (prepared === null) continue;
        const useHome = prepared.home || home;
        const run = (fn, dir) => fn(dir, { home: useHome, cwd: prepared.cwd || path.join(home, 'project'), input: MCP_INPUT, extra: { ...nodeOptions(NETGUARD), ...(prepared.extra || {}) } });
        const cand = run((dir, o) => launch(dir, ['mcp'], o), plug);
        const stub = cand.stderr.includes(STUB_NOTICE);
        const directB = run(direct, plug);
        const oracleA = baselinePlug ? run((dir, o) => launch(dir, ['mcp'], o), baselinePlug) : null;
        const printed = (r) => r.stderr.includes(REQUIRED_LINE) && r.status === 1;
        const row = {
          state: state.name,
          oracle: oracleA ? printed(oracleA) : null,
          oracleStatus: oracleA ? oracleA.status : null,
          direct: printed(directB),
          candidate: stub ? 'stub' : 'server',
          candidateStatus: cand.status,
        };
        row.pass = oracleA !== null && (stub === row.oracle) && (row.direct === row.oracle);
        if (!stub && oracleA) {
          // The real server path: the candidate must equal be64842b (bytes, apart from fields two baseline runs already disagree on).
          const again = run((dir, o) => launch(dir, ['mcp'], o), baselinePlug);
          const v = compare(state.name, oracleA, again, cand);
          // A crash prints a stack trace that names the launcher's own frames (line numbers) and the plugin folder; only those differ.
          const frames = (t) => t.replace(/plugin-\d+/g, 'plugin-#').replace(/marrow-launch\.cjs:\d+:\d+/g, 'marrow-launch.cjs:#:#');
          const sameCrash = cand.status === oracleA.status && cand.stdout === oracleA.stdout && frames(cand.stderr) === frames(oracleA.stderr);
          row.sameAsBaseline = v.verdict !== 'DIFFERENT' || sameCrash;
          if (v.verdict === 'masked') row.masked = v.fields;
          if (v.verdict === 'DIFFERENT' && sameCrash) row.masked = ['stderr: launcher frame line numbers and plugin folder in a crash stack trace'];
          row.pass = row.pass && row.sameAsBaseline;
        }
        rows.push(row);
        result(row.pass, `T2-4 [${n}] ${state.name}: stub iff be64842b printed the "required" line`, `oracle ${row.oracle === null ? 'n/a' : row.oracle ? 'printed it' : 'did not'}, direct ${row.direct ? 'printed it' : 'did not'}, candidate ${row.candidate}${row.sameAsBaseline === undefined ? '' : row.sameAsBaseline ? ', identical to baseline' : ', DIFFERS from baseline'}`);
      }
      report.t24 = rows;
      result(rows.length >= 12 && rows.some((r) => r.candidate === 'stub') && rows.some((r) => r.candidate === 'server'), 'T2-4 the matrix has at least 12 states and exercises both outcomes', `${rows.length} states`);
    }

    // T2-4b the resolver is loaded only from a verified copy: a planted env.js in a tampered copy never runs
    {
      const planted = plugin({ modules: true });
      const marker = path.join(work, 'planted-marker');
      fs.appendFileSync(path.join(planted, 'node_modules', '@getmarrow', 'mcp', 'dist', 'env.js'), `\nrequire('fs').writeFileSync(${JSON.stringify(marker)}, 'loaded');\n`);
      const off = launch(planted, ['mcp'], { home: makeHome('t24b-offline'), input: MCP_INPUT, extra: OFFLINE() });
      result(off.status === 1 && off.stdout === '' && !off.stderr.includes(STUB_NOTICE) && !fs.existsSync(marker), 'T2-4b tampered copy (planted env.js), nothing verified to fall back on: no stub, exit 1, the planted file never ran', `exit ${off.status}`);
      const on = launch(planted, ['mcp'], { home: makeHome('t24b-online'), input: MCP_INPUT });
      result(on.status === 0 && on.stderr.includes(STUB_NOTICE) && !fs.existsSync(marker), 'T2-4b tampered copy, a verified copy installed beside it: the stub runs from the verified copy and the planted file never ran', `exit ${on.status}`);
    }

    // T2-5 resolver throws: today's path, never the stub
    {
      const once = makeHome('t25-once');
      const rOnce = launch(plug, ['mcp'], { home: once, input: MCP_INPUT, extra: { ...nodeOptions(THROW), T2_THROW: 'once' } });
      result(rOnce.status === 1 && rOnce.stdout === '' && rOnce.stderr.includes(REQUIRED_LINE) && !rOnce.stderr.includes(STUB_NOTICE), 'T2-5 resolver throws once (the launcher\'s call): keyless runs the real server, which exits 1 with the "required" line, no stub');
      const always = makeHome('t25-always');
      const rAlways = launch(plug, ['mcp'], { home: always, input: MCP_INPUT, extra: { ...nodeOptions(THROW), T2_THROW: 'always' } });
      const pristineAlways = baselinePlug ? launch(baselinePlug, ['mcp'], { home: always, input: MCP_INPUT, extra: { ...nodeOptions(THROW), T2_THROW: 'always' } }) : null;
      result(rAlways.status === 1 && rAlways.stdout === '' && !rAlways.stderr.includes(STUB_NOTICE) && /t2 resolver failure/.test(rAlways.stderr), 'T2-5 resolver always throws: the real server runs and fails as it does today, no stub');
      result(pristineAlways !== null && pristineAlways.status === rAlways.status && pristineAlways.stdout === rAlways.stdout
        && /t2 resolver failure/.test(pristineAlways.stderr), 'T2-5 ...and be64842b behaves the same (exit code, empty stdout, same failure)');
      const keyedHome = makeHome('t25-keyed');
      const rKeyed = launch(plug, ['mcp'], { home: keyedHome, input: MCP_INPUT, extra: { ...nodeOptions(NETGUARD, THROW), T2_THROW: 'once', MARROW_API_KEY: KEY, ...keyed } });
      const proofKeyed = realProof(rKeyed);
      result(proofKeyed.notStub && proofKeyed.realInit && proofKeyed.tools > 0, 'T2-5 resolver throws once, key present: the real server runs');
    }

    // T2-6 the stub writes nothing
    {
      const home = makeHome('t26');
      const pluginDir = plugin({ modules: false });
      const prep = launch(pluginDir, ['prepare'], { home });
      const snap = (dir) => {
        const lines = [];
        const walk = (d) => {
          for (const name of fs.readdirSync(d).sort()) {
            const full = path.join(d, name);
            const st = fs.lstatSync(full);
            lines.push(`${path.relative(dir, full)} ${(st.mode & 0o7777).toString(8)} ${st.size} ${st.mtimeMs}`);
            if (st.isDirectory()) walk(full);
          }
        };
        walk(dir);
        return lines.join('\n');
      };
      const before = [snap(home), snap(pluginDir)].join('\n--\n');
      const r = await session(pluginDir, { home, lines: [INIT(1), NOTIFIED, rpc(2, 'tools/list'), rpc(3, 'tools/call', { name: 'x' }), rpc(4, 'ping')].map((l) => `${l}\n`), replies: 4 });
      const after = [snap(home), snap(pluginDir)].join('\n--\n');
      result(prep.status === 0 && r.status === 0 && r.stderr.includes(STUB_NOTICE) && before === after && before.split('\n').length > 10, 'T2-6 HOME and plugin tree (paths, modes, sizes, mtimes) are identical before and after a stub session', `${before.split('\n').length} entries`);
      // The hooks' seatbelt-mode probe reads state under HOME. be64842b's keyless start wrote nothing there either, so the stub shifts nothing.
      if (baselinePlug) {
        const oldHome = makeHome('t26-old');
        const oldBefore = snap(oldHome);
        const o = launch(baselinePlug, ['mcp'], { home: oldHome, input: MCP_INPUT });
        result(o.status === 1 && o.stderr.includes(REQUIRED_LINE) && snap(oldHome) === oldBefore, 'T2-6 be64842b\'s keyless mcp start also left HOME untouched, so the stub changes nothing the hooks can see', `exit ${o.status}`);
      }
    }

    // T2-7 no network, no child process, no other module
    {
      const home = makeHome('t27');
      const log = path.join(work, 't27-guard.json');
      const unguarded = await session(plug, { home, lines: [INIT(1), NOTIFIED, rpc(2, 'tools/list'), rpc(3, 'ping')].map((l) => `${l}\n`), replies: 3 });
      const guarded = await session(plug, { home, lines: [INIT(1), NOTIFIED, rpc(2, 'tools/list'), rpc(3, 'ping')].map((l) => `${l}\n`), replies: 3, extra: { ...nodeOptions(GUARD), T2_GUARD_LOG: log } });
      const record = JSON.parse(fs.readFileSync(log, 'utf8'));
      result(guarded.status === 0 && guarded.stdout === unguarded.stdout && guarded.stderr === unguarded.stderr, 'T2-7 with a preload that throws on net/http/https/http2/tls/dns/dgram/child_process, the stub session is byte-identical');
      result(record.attempts.length === 0 && record.internalBlocked.length === 0, 'T2-7 no connect, request, lookup, spawn or require of those modules was attempted, and none is loaded', `attempts ${record.attempts.length}`);
      report.t27 = { requiredBuiltins: record.loaded };
      result(record.loaded.every((m) => ['fs', 'os', 'path', 'crypto', 'net', 'module'].includes(m)), 'T2-7 builtin modules required by code in the stub process', record.loaded.join(','));
    }

    // T2-8 forged initialize
    {
      const home = makeHome('t28');
      const variants = [
        ['plain', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't2', version: '0' } }],
        ['clientInfo marrow', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'marrow', version: '9' } }],
        ['clientInfo cursor-admin', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'cursor-admin', version: '9' } }],
        ['elicitation+sampling+roots', { protocolVersion: '2025-06-18', capabilities: { elicitation: {}, sampling: {}, roots: { listChanged: true }, experimental: { x: {} } }, clientInfo: { name: 'cursor', version: '1' } }],
        ['protocolVersion 9999', { protocolVersion: '9999', capabilities: {}, clientInfo: { name: 't2', version: '0' } }],
        ['protocolVersion object', { protocolVersion: { a: 1 }, capabilities: {}, clientInfo: { name: 't2', version: '0' } }],
        ['protocolVersion marker string', { protocolVersion: 'FORGED-VERSION-MARKER', capabilities: {}, clientInfo: { name: 't2', version: '0' } }],
        ['unknown fields', { protocolVersion: '2025-11-25', capabilities: { a: 1 }, clientInfo: { name: 't2', version: '0', extra: 'FORGED-FIELD-MARKER' }, unknown: { deep: [1, 2, 3] }, _meta: { progressToken: 'p' } }],
        ['no params', undefined],
        ['params is an array', ['2025-06-18']],
      ];
      const transcripts = [];
      for (const [label, params] of variants) {
        const initLine = params === undefined ? JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }) : INIT(1, params);
        const r = await session(plug, { home, lines: [initLine, NOTIFIED, rpc(2, 'tools/list')].map((l) => `${l}\n`), replies: 2 });
        const { messages } = parseLines(r.stdout);
        transcripts.push({ label, params, init: messages.find((m) => m.id === 1), tools: messages.find((m) => m.id === 2), raw: r.stdout });
      }
      const norm = (t) => { const c = JSON.parse(JSON.stringify(t.init)); delete c.result.protocolVersion; return JSON.stringify(c); };
      result(transcripts.every((t) => JSON.stringify(t.tools) === JSON.stringify(transcripts[0].tools) && t.tools.result.tools.length === 0), 'T2-8 forged initialize: the tools list is identical (empty) in all variants', `${transcripts.length} variants`);
      result(transcripts.every((t) => norm(t) === norm(transcripts[0])), 'T2-8 forged initialize: the initialize result is identical apart from protocolVersion (same capabilities, serverInfo and instructions)');
      // F1: the stub answers protocolVersion exactly as the pinned server does (dist/cli.js:605-617), asked of the real server with a key.
      const ci = { name: 't2', version: '0' };
      const versionCases = [
        ...variants.map(([label, params]) => [label, params]),
        ['2024-11-05', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: ci }],
        ['2024-11-05 with elicitation', { protocolVersion: '2024-11-05', capabilities: { elicitation: {} }, clientInfo: ci }],
        ['2025-03-26', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: ci }],
        ['2025-03-26 with elicitation', { protocolVersion: '2025-03-26', capabilities: { elicitation: {} }, clientInfo: ci }],
        ['2025-06-18 without elicitation', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: ci }],
        ['2025-06-18 with elicitation', { protocolVersion: '2025-06-18', capabilities: { elicitation: {} }, clientInfo: ci }],
        ['2025-11-25 without elicitation', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: ci }],
        ['2025-11-25 with elicitation', { protocolVersion: '2025-11-25', capabilities: { elicitation: {} }, clientInfo: ci }],
        ['2025-11-25 elicitation null', { protocolVersion: '2025-11-25', capabilities: { elicitation: null }, clientInfo: ci }],
        ['2025-11-25 elicitation string', { protocolVersion: '2025-11-25', capabilities: { elicitation: 'x' }, clientInfo: ci }],
        ['2025-11-25 elicitation true', { protocolVersion: '2025-11-25', capabilities: { elicitation: true }, clientInfo: ci }],
        ['2025-11-25 capabilities null', { protocolVersion: '2025-11-25', capabilities: null, clientInfo: ci }],
        ['unknown version with elicitation', { protocolVersion: '2099-01-01', capabilities: { elicitation: {} }, clientInfo: ci }],
        ['numeric version', { protocolVersion: 20251125, capabilities: { elicitation: {} }, clientInfo: ci }],
        ['missing version', { capabilities: { elicitation: {} }, clientInfo: ci }],
        ['missing version, no capabilities', { clientInfo: ci }],
        ['empty version with elicitation', { protocolVersion: '', capabilities: { elicitation: {} }, clientInfo: ci }],
        ['params null', null],
        ['params string', '2025-11-25'],
      ];
      let versionsEqual = true;
      const seenAnswers = new Set();
      const mismatches = [];
      for (const [label, params] of versionCases) {
        const initLine = `${rpc(1, 'initialize', params)}\n`;
        const stubRun = await session(plug, { home, lines: [initLine], replies: 1 });
        const realRun = await session(plug, { home, lines: [initLine], replies: 1, extra: { MARROW_API_KEY: KEY, ...keyed } });
        const stubAnswer = (parseLines(stubRun.stdout).messages[0] || {}).result;
        const realAnswer = (parseLines(realRun.stdout).messages[0] || {}).result;
        const same = Boolean(stubAnswer && realAnswer) && stubAnswer.protocolVersion === realAnswer.protocolVersion;
        if (stubAnswer) seenAnswers.add(stubAnswer.protocolVersion);
        if (!same) { versionsEqual = false; mismatches.push(label); }
      }
      result(versionsEqual, `T2-8 F1 protocolVersion: the stub answers exactly what the real pinned server answers for all ${versionCases.length} initialize inputs (2024-11-05, 2025-03-26, unknown, missing, non-string, null/odd params, with and without elicitation)`, mismatches.join('; '));
      result(seenAnswers.size === 3 && seenAnswers.has('2024-11-05') && seenAnswers.has('2025-06-18') && seenAnswers.has('2025-11-25'), 'T2-8 F1 the inputs cover all three answers the server can give', [...seenAnswers].join(' '));
      result(transcripts.every((t) => !/FORGED|9999|cursor-admin/.test(t.raw)), 'T2-8 no client-supplied string (version, name, marker) is echoed in any reply');
    }

    // T2-9 hostile input
    {
      const home = makeHome('t29');
      const big = `${'x'.repeat(1536 * 1024)}\n`;
      const lines = [
        `${rpc(10, 'tools/list')}\n`, // before initialize
        '{not json\n',
        `${JSON.stringify([{ jsonrpc: '2.0', id: 11, method: 'ping' }])}\n`,
        '42\n', 'null\n', '"text"\n', 'true\n',
        `${JSON.stringify({ id: 12, method: 'ping' })}\n`,
        `${JSON.stringify({ jsonrpc: '2.0', id: 13, method: 5 })}\n`,
        `${JSON.stringify({ jsonrpc: '1.0', id: 14, method: 'ping' })}\n`,
        `${INIT(1)}\n`,
        `${JSON.stringify({ jsonrpc: '2.0', id: { a: 1 }, method: 'ping' })}\n`,
        `${JSON.stringify({ jsonrpc: '2.0', id: [1], method: 'ping' })}\n`,
        `${JSON.stringify({ jsonrpc: '2.0', id: true, method: 'ping' })}\n`,
        '{"jsonrpc":"2.0","id":1e999,"method":"ping"}\n',
        `${rpc('x', 'no/such/method')}\n`,
        `${rpc(20, '__proto__')}\n`, `${rpc(21, 'constructor')}\n`, `${rpc(22, 'toString')}\n`,
        `${JSON.stringify({ jsonrpc: '2.0', method: 'no/such/notification' })}\n`,
        `${JSON.stringify({ jsonrpc: '2.0', id: null, method: 'ping' })}\n`,
        `${rpc(23, 'resources/read', { uri: 'file:///etc/passwd' })}\n`,
        `${rpc(24, 'prompts/get', { name: 'marrow-always-on' })}\n`,
        `${rpc(25, 'completion/complete', {})}\n`,
        `${rpc(26, 'tools/call', { name: 'marrow_commit', arguments: { committed: true } })}\n`,
        big,
        `${rpc(99, 'ping')}\n`,
        `${'['.repeat(900000)}\n`,
        '\n', '   \n',
        `${rpc(100, 'ping')}\r\n`,
        `${rpc('ü-id', 'ping')}\n`,
        rpc(101, 'ping'), // no trailing newline
      ];
      // Expected replies: before-init(1) parse(1) batch(1) 4 scalars(4) no-jsonrpc(1) bad-method(1) bad-version(1) init(1) 3 bad ids(3) 1e999(1) unknown(1)
      // 3 proto names(3) null id(1) 3 unknown requests(3) tools/call(1) oversize(1) ping 99(1) deep(1) crlf(1) unicode id(1) last(1) = 38
      const expected = 1 + 1 + 1 + 4 + 1 + 1 + 1 + 1 + 3 + 1 + 1 + 3 + 1 + 3 + 1 + 1 + 1 + 1 + 1 + 1 + 1;
      // The last line has no newline, so its reply comes only once stdin ends: wait for the others first.
      const r = await session(plug, { home, lines, replies: expected - 1, chunked: true, timeoutMs: 90000 });
      const { messages, bad } = parseLines(r.stdout);
      result(bad === 0 && messages.length === expected && messages.every(isRpc), 'T2-9 hostile input: every stdout line is a JSON-RPC 2.0 reply (result xor error)', `${messages.length}/${expected} lines, ${bad} bad`);
      result(r.alive === true && r.status === 0, 'T2-9 hostile input: the process stayed alive through all of it and exits 0 at stdin end', `alive ${r.alive}, exit ${r.status}`);
      const tooLarge = messages.filter((m) => m.error && m.error.message === 'Request too large.');
      result(tooLarge.length === 1 && tooLarge[0].id === null && tooLarge[0].error.code === -32600, 'T2-9 a line over 1 MB is answered once with -32600 and id null');
      const ids = new Map(messages.map((m) => [m.id, m]));
      result(ids.get(99) && ids.get(99).result && JSON.stringify(ids.get(99).result) === '{}', 'T2-9 the next valid request after the oversized line is answered');
      result(messages.filter((m) => m.error && m.error.code === -32600 && m.id === null).length >= 13 && !messages.some((m) => m.id && typeof m.id === 'object'), 'T2-9 invalid requests, bad ids and batches get -32600 with id null; no object id is ever echoed');
      result(ids.get(10) && ids.get(10).error.code === -32002, 'T2-9 a request before initialize gets -32002');
      result([20, 21, 22, 23, 24, 25, 'x'].every((id) => ids.get(id) && ids.get(id).error && ids.get(id).error.code === -32601), 'T2-9 unknown methods, including __proto__/constructor/toString, get -32601');
      result(ids.get(26) && ids.get(26).error && !('result' in ids.get(26)) && ids.get(100) && ids.get(101) && ids.get('ü-id'), 'T2-9 tools/call is an error; CRLF, no trailing newline and a unicode id are handled');
      result(r.stderr === `${STUB_NOTICE} The plugin hooks still apply.\n` && !DENY_WORDS.test(r.stdout.replace(/"instructions":"[^"]*"/, '')), 'T2-9 stderr is only the fixed line; no decision-like word in any reply');
    }

    await differential();
    await honest();
    await slowRows();

    // T2-12 the dummy key never appears in anything captured
    {
      const hay = captured.join('\n');
      result(!hay.includes(KEY) && captured.length > 50, 'T2-12 the dummy key bytes appear in no stdout or stderr captured by any T2 row', `${captured.length} captured streams`);
    }
  }

  // ---- T2-10 never looser than be64842b ----------------------------------------------------------------
  const SHELL = [
    'git status', 'git push --force origin main', 'ls', 'npm test',
    'git status && git push --force origin main', 'git status; git push --force origin main', 'git status || git push --force origin main',
    'echo x | git push --force origin main', '(git push --force origin main)', 'bash -c "git push -f origin master"',
    'git push --no-force --force origin main', 'B=main; git push --force origin $B', 'git commit -m "push --force to prod"',
    'npm publish', 'vercel deploy --prod', 'git push origin +main', 'git commit -m t', 'git push origin main', 'rm -rf "$HOME/sbx-outside"',
  ];
  function calls(cwd) {
    const list = [];
    let i = 0;
    const id = () => { i += 1; return i; };
    const shell = (cmd) => (CURSOR
      ? { conversation_id: `t2-${id()}`, generation_id: 'g', hook_event_name: 'beforeShellExecution', command: cmd, cwd, workspace_roots: [cwd] }
      : { session_id: `t2-${id()}`, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: cmd }, tool_use_id: `t${i}`, cwd });
    const read = () => (CURSOR
      ? { conversation_id: `t2-${id()}`, generation_id: 'g', hook_event_name: 'preToolUse', tool_name: 'Read', tool_input: { file_path: path.join(cwd, 'README.md') }, cwd, workspace_roots: [cwd] }
      : { session_id: `t2-${id()}`, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: path.join(cwd, 'README.md') }, tool_use_id: `t${i}`, cwd });
    const post = (cmd) => (CURSOR
      ? { conversation_id: `t2-${id()}`, generation_id: 'g', hook_event_name: 'afterShellExecution', command: cmd, output: 'out', duration: 5, cwd, workspace_roots: [cwd] }
      : { session_id: `t2-${id()}`, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: cmd }, tool_response: { stdout: 'out', stderr: '', exit_code: 0 }, tool_use_id: `t${i}`, cwd });
    for (const cmd of SHELL) list.push({ entry: H.pre, label: `${H.pre} ${cmd}`, input: JSON.stringify(shell(cmd)) });
    list.push({ entry: H.pre, label: `${H.pre} Read README.md`, input: JSON.stringify(read()) });
    // Calls to Marrow's own tool names, which a keyless machine no longer serves, and to look-alikes: the hook must treat them as before.
    const mcp = (server, tool) => (CURSOR
      ? { conversation_id: `t2-${id()}`, generation_id: 'g', hook_event_name: 'beforeMCPExecution', server, tool_name: tool, tool_input: { decision: 'allow' }, cwd, workspace_roots: [cwd] }
      : { session_id: `t2-${id()}`, hook_event_name: 'PreToolUse', tool_name: server ? `mcp__${server}__${tool}` : tool, tool_input: { decision: 'allow' }, tool_use_id: `t${i}`, cwd });
    const own = CURSOR ? ['marrow', 'Marrow', 'marrow-fake'] : ['plugin_marrow_marrow', 'marrow', 'other'];
    for (const server of own) list.push({ entry: H.pre, label: `${H.pre} MCP ${server} marrow_agent_runtime`, input: JSON.stringify(mcp(server, 'marrow_agent_runtime')) });
    if (CURSOR) list.push({ entry: H.pre, label: `${H.pre} preToolUse MCP:marrow_agent_runtime`, input: JSON.stringify({ conversation_id: `t2-${id()}`, generation_id: 'g', hook_event_name: 'preToolUse', tool_name: 'MCP:marrow_agent_runtime', tool_input: { decision: 'allow' }, cwd, workspace_roots: [cwd] }) });
    for (const cmd of ['git status', 'git push --force origin main', 'npm test']) list.push({ entry: H.post, label: `${H.post} ${cmd}`, input: JSON.stringify(post(cmd)) });
    list.push({ entry: H.session, label: `${H.session}`, input: JSON.stringify(CURSOR ? { conversation_id: 't2-s', hook_event_name: 'stop', status: 'completed', cwd, workspace_roots: [cwd] } : { session_id: 't2-s', hook_event_name: 'Stop', cwd, stop_hook_active: false }) });
    list.push({ entry: H.ctx, label: `${H.ctx}`, input: JSON.stringify(CURSOR ? { conversation_id: 't2-c', generation_id: 'g', hook_event_name: 'beforeSubmitPrompt', prompt: 'hello', cwd, workspace_roots: [cwd] } : { session_id: 't2-c', hook_event_name: 'UserPromptSubmit', prompt: 'hello', cwd }) });
    for (const extra of H.extra) list.push({ entry: extra, label: `${extra} git status`, input: JSON.stringify({ session_id: 't2-p', hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'git status' }, cwd }) });
    list.push({ entry: 'prepare', label: 'prepare', input: '' });
    return list;
  }
  // JSON paths where two values differ.
  function volatilePaths(a, b, prefix = '', out = new Set()) {
    if (a && b && typeof a === 'object' && typeof b === 'object') {
      for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) volatilePaths(a[key], b[key], `${prefix}/${key}`, out);
    } else if (JSON.stringify(a) !== JSON.stringify(b)) {
      out.add(prefix);
    }
    return out;
  }
  function maskPaths(value, paths, prefix = '') {
    if (value && typeof value === 'object') {
      const copy = Array.isArray(value) ? [] : {};
      for (const key of Object.keys(value)) copy[key] = paths.has(`${prefix}/${key}`) ? '<volatile>' : maskPaths(value[key], paths, `${prefix}/${key}`);
      return copy;
    }
    return value;
  }
  const tryJson = (text) => { try { return JSON.parse(text); } catch { return undefined; } };
  function compare(label, b1, b2, c) {
    const same = (x, y) => x.status === y.status && x.stdout === y.stdout && x.stderr === y.stderr;
    if (same(b1, c)) return { label, verdict: 'identical' };
    if (b1.status !== c.status) return { label, verdict: 'DIFFERENT', why: `exit ${b1.status} vs ${c.status}` };
    const masked = [];
    let ok = true;
    for (const stream of ['stdout', 'stderr']) {
      if (b1[stream] === c[stream]) continue;
      const jb1 = tryJson(b1[stream]); const jb2 = tryJson(b2[stream]); const jc = tryJson(c[stream]);
      if (jb1 === undefined || jb2 === undefined || jc === undefined) {
        // Plain text: equal once the digits and hex runs that differ between two baseline runs are masked.
        const mask = (t) => t.replace(/[0-9a-f]{8,}|\d+/g, '#');
        if (b1[stream] !== b2[stream] && mask(b1[stream]) === mask(b2[stream]) && mask(b1[stream]) === mask(c[stream])) masked.push(`${stream}:digits`); else ok = false;
        continue;
      }
      const volatile = volatilePaths(jb1, jb2);
      if (volatile.size === 0) { ok = false; continue; }
      if (JSON.stringify(maskPaths(jb1, volatile)) === JSON.stringify(maskPaths(jc, volatile))) masked.push(...[...volatile].map((p) => `${stream}${p}`)); else ok = false;
    }
    return ok ? { label, verdict: 'masked', fields: masked } : { label, verdict: 'DIFFERENT', why: 'bytes differ' };
  }
  async function differential() {
    if (!baselinePlug) {
      result(false, 'T2-10 baseline be64842b is available for the differential', baselineError || 'no baseline');
      return;
    }
    const baselineLauncher = fs.readFileSync(path.join(baselineSource, 'scripts', 'marrow-launch.cjs'));
    const candidateLauncher = fs.readFileSync(path.join(source, 'scripts', 'marrow-launch.cjs'));
    const target = path.join(plug, 'scripts', 'marrow-launch.cjs');
    const stateDefs = [
      ['keyless', () => ({ extra: {} })],
      ['key in env', () => ({ extra: { MARROW_API_KEY: KEY, ...keyed } })],
      ['key in ~/.marrow/env', (home) => { ownerFile(home); return { extra: {} }; }],
    ];
    const summary = { states: {}, rows: 0, identical: 0, masked: [], different: [] };
    for (const [stateName, prep] of stateDefs) {
      const runAll = (launcherBytes, tag) => {
        fs.writeFileSync(target, launcherBytes);
        const home = makeHome(`t210-${host}-${stateName.replace(/\W+/g, '-')}`);
        const prepared = prep(home);
        const cwd = path.join(home, 'project');
        const out = [];
        for (const call of calls(cwd)) {
          out.push(launch(plug, [call.entry], { home, cwd, input: call.input, extra: { ...nodeOptions(NETGUARD), ...prepared.extra } }));
        }
        if (!CURSOR) {
          const check = path.join(plug, 'scripts', 'marrow-session-check.cjs');
          out.push(take(spawnSync(process.execPath, [check], { cwd, input: '{}', encoding: 'utf8', env: envFor(plug, home, prepared.extra) })));
        }
        return out;
      };
      const labels = calls(path.join(work, 'x')).map((c) => c.label).concat(CURSOR ? [] : ['marrow-session-check.cjs']);
      const b1 = runAll(baselineLauncher, 'B1');
      const b2 = runAll(baselineLauncher, 'B2');
      const c = runAll(candidateLauncher, 'C');
      fs.writeFileSync(target, candidateLauncher);
      const verdicts = labels.map((label, i) => compare(label, b1[i], b2[i], c[i]));
      summary.states[stateName] = { calls: verdicts.length, identical: verdicts.filter((v) => v.verdict === 'identical').length, masked: verdicts.filter((v) => v.verdict === 'masked').length, different: verdicts.filter((v) => v.verdict === 'DIFFERENT').length };
      summary.rows += verdicts.length;
      summary.identical += summary.states[stateName].identical;
      for (const v of verdicts) {
        if (v.verdict === 'masked') summary.masked.push({ state: stateName, label: v.label, fields: v.fields });
        if (v.verdict === 'DIFFERENT') summary.different.push({ state: stateName, label: v.label, why: v.why });
      }
      const s = summary.states[stateName];
      result(s.different === 0, `T2-10 ${H.pre}/${H.post}/${H.session}/${H.ctx}${H.extra.length ? `/${H.extra[0]}` : ''}/prepare${CURSOR ? '' : '/session-check'}, state "${stateName}": stdout, stderr and exit code equal be64842b`, `${s.calls} calls: ${s.identical} identical, ${s.masked} equal after masking volatile fields, ${s.different} different`);
    }
    report.t210 = summary;
    result(summary.different.length === 0 && summary.rows >= 60, 'T2-10 no difference anywhere (never looser, never different)', `${summary.rows} calls, ${summary.identical} byte-identical, ${summary.masked.length} masked`);

    // keyed mcp: initialize + tools/list byte-identical
    const keyedStates = [['key in env', () => ({ home: makeHome('t210-mcp-env'), extra: { MARROW_API_KEY: KEY, ...keyed } })],
      ['key in ~/.marrow/env', () => { const home = makeHome('t210-mcp-file'); ownerFile(home); return { home, extra: {} }; }]];
    for (const [name, build] of keyedStates) {
      const one = (pluginDir, launcherBytes) => {
        fs.writeFileSync(path.join(plug, 'scripts', 'marrow-launch.cjs'), launcherBytes);
        const s = build();
        return launch(plug, ['mcp'], { home: s.home, input: MCP_INPUT, extra: { ...nodeOptions(NETGUARD), ...s.extra } });
      };
      const b1 = one(plug, baselineLauncher);
      const b2 = one(plug, baselineLauncher);
      const c = one(plug, candidateLauncher);
      fs.writeFileSync(target, candidateLauncher);
      const v = compare(`mcp ${name}`, b1, b2, c);
      result(v.verdict !== 'DIFFERENT' && !c.stderr.includes(STUB_NOTICE) && parseLines(c.stdout).messages.filter((m) => m.id === 1 || m.id === 2).length === 2, `T2-10 keyed mcp (${name}): initialize and tools/list bytes equal be64842b`, v.verdict === 'masked' ? `masked ${v.fields.join(',')}` : v.verdict);
      if (v.verdict === 'masked') summary.masked.push({ state: `mcp ${name}`, label: 'mcp', fields: v.fields });
    }
  }

  // ---- T2-10/T2-11 honest messages, same shape ---------------------------------------------------------
  const entriesFor = () => [H.pre, H.post, H.session, H.ctx, ...H.extra, 'mcp', 'prepare'];
  const formOf = (r) => {
    const json = tryJson(r.stdout.trim());
    return { status: r.status, keys: json ? Object.keys(json).sort().join(',') + (json.hookSpecificOutput ? `|${Object.keys(json.hookSpecificOutput).sort().join(',')}` : '') : '', permission: json ? (json.permission || (json.hookSpecificOutput && json.hookSpecificOutput.permissionDecision) || '') : '' };
  };
  const OFFLINE = () => ({ npm_config_registry: 'http://127.0.0.1:9/', npm_config_cache: fs.mkdtempSync(path.join(work, 'empty-cache-')), npm_config_fetch_retries: '0', npm_config_fetch_timeout: '2000' });
  async function honest() {
    const texts = [];
    // no verified copy / offline, and a bad manifest: same keys, same permission, same exit code as be64842b; texts differ by design
    if (baselinePlug) {
      for (const [caseName, build] of [
        ['no verified copy (offline)', () => ({ dir: plugin({ modules: false }), extra: OFFLINE() })],
        ['bad manifest (package.json pin edited)', () => {
          const dir = plugin({ modules: false });
          const file = path.join(dir, 'package.json');
          const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
          pkg.dependencies['@getmarrow/mcp'] = '3.9.50';
          fs.writeFileSync(file, JSON.stringify(pkg));
          return { dir, extra: OFFLINE() };
        }],
      ]) {
        const forms = [];
        for (const entry of entriesFor()) {
          const pair = [baselineSource, source].map((from) => {
            const built = build();
            fs.copyFileSync(path.join(from, 'scripts', 'marrow-launch.cjs'), path.join(built.dir, 'scripts', 'marrow-launch.cjs'));
            const home = makeHome(`t210-honest-${copies}`);
            const r = launch(built.dir, [entry], { home, input: entry.includes('hook') ? JSON.stringify({ hook_event_name: 'x', cwd: home }) : MCP_INPUT, extra: built.extra });
            return r;
          });
          const [oldR, newR] = pair;
          const fo = formOf(oldR); const fn = formOf(newR);
          const sameForm = JSON.stringify(fo) === JSON.stringify(fn);
          const textOf = (r) => ((tryJson(r.stdout.trim()) && (tryJson(r.stdout.trim()).user_message || (tryJson(r.stdout.trim()).hookSpecificOutput || {}).permissionDecisionReason)) || r.stderr.trim());
          forms.push({ case: caseName, entry, sameForm, old: textOf(oldR), new: textOf(newR), form: fn });
          result(sameForm, `T2-10 ${caseName}, ${entry}: same JSON keys, permission value and exit code as be64842b`, `exit ${fn.status}${fn.permission ? `, ${fn.permission}` : ''}`);
        }
        texts.push(...forms);
      }
    }
    report.texts = texts;

    // T2-11 Node and npm messages
    const stateful = (dirs) => fs.existsSync(dirs) ? fs.readdirSync(dirs) : [];
    // Node below 18 (simulated: no old Node on this machine)
    {
      const forms = [];
      let ok = true;
      for (const entry of entriesFor()) {
        const dir = plugin({ modules: false });
        const home = makeHome(`t211-old-${copies}`);
        const log = path.join(work, `spawn-${copies}.log`);
        fs.writeFileSync(log, '');
        const r = launch(dir, [entry], { home, input: JSON.stringify({ hook_event_name: 'x' }), extra: { ...nodeOptions(OLDNODE, SPY), T2_SPAWN_LOG: log, ...OFFLINE() } });
        const spawned = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).length;
        const f = formOf(r);
        const isPre = entry === H.pre;
        const expectStatus = isPre ? (CURSOR ? 2 : 0) : 1;
        const text = isPre ? (tryJson(r.stdout.trim()) || {}).user_message || ((tryJson(r.stdout.trim()) || {}).hookSpecificOutput || {}).permissionDecisionReason || '' : r.stderr;
        const good = f.status === expectStatus && /Node\.js is too old \(major version 16\)/.test(text) && /Install Node\.js 18 or newer with npm on PATH, then restart (Cursor|Claude Code)\./.test(text)
          && spawned === 0 && stateful(dataOf(home)).length === 0 && (isPre ? f.permission === 'deny' : r.stdout === '') && !/[\\/]/.test(text.replace(/npm on PATH|Node\.js 18|@getmarrow\/mcp/g, '').replace(/claude plugin[^.]*\./, ''));
        ok = ok && good;
        forms.push({ entry, status: f.status, keys: f.keys, text: text.trim() });
        result(good, `T2-11 Node 16 (simulated by a process.versions preload; no old Node on this machine) ${entry}: exit ${expectStatus}${isPre ? ' + deny' : ''}, names the Node version and the fix, starts no npm, creates nothing`, `exit ${f.status}`);
      }
      report.t211Node = forms;
      void ok;
    }
    // npm missing: a node binary with no npm next to it and a PATH without npm
    if (POSIX) {
      const forms = [];
      for (const entry of ['mcp', 'prepare', H.ctx]) {
        const dir = plugin({ modules: false });
        const home = makeHome(`t211-nonpm-${copies}`);
        const r = take(spawnSync(noNpmNode, [path.join(dir, 'scripts', 'marrow-launch.cjs'), entry], {
          cwd: path.join(home, 'project'), input: entry === 'mcp' ? MCP_INPUT : JSON.stringify({ hook_event_name: 'x', prompt: 'hi', cwd: home }), encoding: 'utf8', timeout: 60000,
          env: envFor(dir, home, { PATH: path.dirname(noNpmNode) }),
        }));
        const good = r.status === 1 && r.stdout === '' && /npm was not found or could not be started/.test(r.stderr) && /Install Node\.js 18 or newer with npm on PATH, then restart (Cursor|Claude Code)\./.test(r.stderr)
          && r.stderr.trim().split('\n').length === 1 && stateful(dataOf(home)).filter((e) => /stage|lock/.test(e)).length === 0;
        forms.push({ entry, status: r.status, text: r.stderr.trim() });
        result(good, `T2-11 npm missing, ${entry}: exit 1, one stderr line naming npm and the fix, no stage or lock left`, `exit ${r.status}`);
      }
      report.t211NoNpm = forms;
    }
    // npm ci failing: dead registry, empty cache
    {
      const forms = [];
      for (const entry of ['mcp', 'prepare', H.ctx]) {
        const dir = plugin({ modules: false });
        const home = makeHome(`t211-net-${copies}`);
        const r = launch(dir, [entry], { home, input: entry === 'mcp' ? MCP_INPUT : JSON.stringify({ hook_event_name: 'x', prompt: 'hi', cwd: home }), extra: OFFLINE() });
        const good = r.status === 1 && r.stdout === '' && /npm could not install the pinned @getmarrow\/mcp \(usually no network or an unreachable npm registry\)\./.test(r.stderr)
          && /Reconnect to the network and retry, or ask the owner to reinstall/.test(r.stderr) && r.stderr.trim().split('\n').length === 1 && !/npm (ERR|WARN)|ECONNREFUSED|127\.0\.0\.1/.test(r.stderr);
        forms.push({ entry, status: r.status, text: r.stderr.trim() });
        result(good, `T2-11 npm ci fails (dead registry, empty cache), ${entry}: exit 1, network text, no npm output`, `exit ${r.status}`);
      }
      report.t211Net = forms;
    }
    // data folder not private/owned
    if (POSIX) {
      const dir = plugin({ modules: false });
      const home = makeHome('t211-folder');
      const data = dataOf(home);
      fs.mkdirSync(data, { recursive: true });
      fs.chmodSync(data, 0o777);
      const r = launch(dir, ['mcp'], { home, input: MCP_INPUT, extra: OFFLINE() });
      result(r.status === 1 && /data folder is missing, not owned by this user or open to other users/.test(r.stderr) && r.stdout === '', 'T2-11 data folder open to other users, mcp: exit 1 and says so', `exit ${r.status}`);
      report.t211Folder = r.stderr.trim();
    }
    // tool hook without a verified copy keeps "not installed yet"
    {
      const dir = plugin({ modules: false });
      const home = makeHome('t211-idle');
      const r = launch(dir, [H.pre], { home, input: JSON.stringify({ hook_event_name: 'x', cwd: home }) });
      result(/not installed yet/.test(r.stdout + r.stderr) && r.status === (CURSOR ? 2 : 0), 'T2-11 the pre-action hook without a verified copy still says "not installed yet" and installs nothing', `exit ${r.status}`);
    }
  }

  async function slowRows() {
    const [timeout, lock] = await Promise.all([slowTimeout, slowLock]);
    if (timeout) {
      const left = fs.existsSync(dataOf(timeout.home)) ? fs.readdirSync(dataOf(timeout.home)) : [];
      result(timeout.status === 1 && timeout.stdout === '' && /took longer than 120 seconds/.test(timeout.stderr) && timeout.stderr.trim().split('\n').length === 1
        && timeout.ms >= 119000 && left.length === 0, 'T2-11 npm ci timeout (real 120 s wait, a fake npm that hangs), mcp: exit 1, says it took longer than 120 seconds, no stage or lock left', `${Math.round(timeout.ms / 1000)} s`);
      report.t211Timeout = { ms: timeout.ms, text: timeout.stderr.trim() };
    }
    {
      lockOwner.kill('SIGKILL');
      const lockDir = path.join(dataOf(lock.home), `${manifestId(lock.pluginDir)}.lock`);
      result(lock.status === 0 && lock.ms >= 134000 && !fs.existsSync(lockDir) && fs.existsSync(path.join(dataOf(lock.home), manifestId(lock.pluginDir))),
        'T2-11 lock wait (a fresh lock held by a live owner, real wait): the start waits until the 135 s stale age, takes the lock over before its 150 s wait ends (exit 0, not the lock failure), installs', `${Math.round(lock.ms / 1000)} s, exit ${lock.status}`);
      report.t211Lock = { ms: lock.ms, text: lock.stderr.trim() };
    }
  }

  // ---- T2-13 nothing else moved ------------------------------------------------------------------------
  function integrity() {
    const bytes = (...p) => fs.readFileSync(path.join(...p));
    const eq = (a, b) => a.equals(b);
    const claude = path.join(repo, 'plugins', 'marrow');
    const cursor = path.join(repo, 'plugins', 'marrow-cursor');
    result(eq(bytes(claude, 'scripts', 'marrow-launch.cjs'), bytes(cursor, 'scripts', 'marrow-launch.cjs')), 'T2-13 the Claude and Cursor launchers are byte-identical');
    if (!baselineDir) { result(false, 'T2-13 baseline available for manifest and lockfile comparison', baselineError); return; }
    const files = [];
    for (const plug of ['plugins/marrow', 'plugins/marrow-cursor', 'codex/marrow', 'codex/marrow-advisory']) {
      for (const f of ['package.json', 'package-lock.json', 'scripts/mcp-manifest.json', 'scripts/marrow-launch.cjs', 'hooks/hooks.json', 'LICENSE']) {
        if (fs.existsSync(path.join(baselineDir, plug, f))) files.push(path.join(plug, f));
      }
    }
    const moved = files.filter((f) => !bytes(baselineDir, f).equals(bytes(repo, f)));
    const allowedMoved = ['plugins/marrow/scripts/marrow-launch.cjs', 'plugins/marrow-cursor/scripts/marrow-launch.cjs'];
    result(moved.every((f) => allowedMoved.includes(f)) && moved.length === 2, 'T2-13 against be64842b, every package.json, package-lock.json, mcp-manifest.json, hooks.json and every Codex file is byte-identical; only the two launchers moved', `${files.length} files compared, moved: ${moved.join(',')}`);
    const sha = (dir) => JSON.parse(bytes(dir, 'plugins', 'marrow', 'scripts', 'mcp-manifest.json')).sha256;
    result(sha(baselineDir) === sha(repo), 'T2-13 the mcp-manifest sha256 is unchanged');
    // The files that differ from the baseline are exactly the expected ones.
    const walk = (dir, rel = '') => fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).flatMap((e) => {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (['.git', 'node_modules'].includes(e.name)) return [];
      return e.isDirectory() ? walk(dir, r) : [r];
    });
    const all = new Set([...walk(baselineDir), ...walk(repo)]);
    const differing = [...all].filter((f) => !fs.existsSync(path.join(baselineDir, f)) || !fs.existsSync(path.join(repo, f)) || !bytes(baselineDir, f).equals(bytes(repo, f))).sort();
    const expected = ['README.md', 'plugins/marrow-cursor/.cursor-plugin/plugin.json', 'plugins/marrow-cursor/scripts/marrow-launch.cjs', 'plugins/marrow-cursor/skills/marrow/SKILL.md',
      'plugins/marrow/.claude-plugin/plugin.json', 'plugins/marrow/scripts/marrow-launch.cjs', 'plugins/marrow/skills/marrow/SKILL.md',
      'tools/check.cjs', 'tools/test-launcher-lock.cjs', 'tools/test-launcher-t2.cjs', 'tools/test-launcher.cjs'];
    result(JSON.stringify(differing) === JSON.stringify(expected), 'T2-13 against be64842b, exactly these files differ: README, both SKILL.md, both plugin.json, both launchers, check.cjs, the three test files', differing.length === expected.length ? `${differing.length} files` : `unexpected: ${differing.filter((f) => !expected.includes(f)).join(',')} missing: ${expected.filter((f) => !differing.includes(f)).join(',')}`);
    // No new Windows claim in either direction: existing Windows wording is untouched; the only new line is the placeholder marker.
    const windowsLines = (dir, file) => fs.readFileSync(path.join(dir, file), 'utf8').split('\n').filter((l) => /windows/i.test(l));
    let windowsOk = true;
    let markers = 0;
    for (const file of ['README.md', 'plugins/marrow/skills/marrow/SKILL.md', 'plugins/marrow-cursor/skills/marrow/SKILL.md', 'plugins/marrow-cursor/README.md']) {
      const before = windowsLines(baselineDir, file);
      const after = windowsLines(repo, file);
      const added = after.filter((l) => !before.includes(l));
      windowsOk = windowsOk && before.every((l) => after.includes(l)) && added.every((l) => l.includes('<!-- WINDOWS-STATUS: set with the MCP 3.9.106 pin commit -->'));
      markers += added.length;
    }
    result(windowsOk && markers === 1, 'T2-13 Windows wording: every existing line kept byte for byte; the only new Windows line is the WINDOWS-STATUS placeholder comment', `${markers} marker`);
    const dep = (dir) => JSON.stringify(JSON.parse(bytes(dir, 'plugins', 'marrow', 'package.json')).dependencies);
    result(dep(baselineDir) === dep(repo), 'T2-13 plugin dependencies are unchanged');
    const check = spawnSync(process.execPath, [path.join(repo, 'tools', 'check.cjs')], { cwd: repo, encoding: 'utf8', env: env() });
    const fails = (check.stdout || '').split('\n').filter((l) => l.startsWith('FAIL')).map((l) => l.replace(/:.*/, ''));
    const baseCheck = spawnSync(process.execPath, [path.join(baselineDir, 'tools', 'check.cjs')], { cwd: baselineDir, encoding: 'utf8', env: env() });
    const baseFails = (baseCheck.stdout || '').split('\n').filter((l) => l.startsWith('FAIL')).map((l) => l.replace(/:.*/, ''));
    result(JSON.stringify(fails) === JSON.stringify(baseFails) && /PASS keyless MCP stub/.test(check.stdout || ''), 'T2-13 tools/check.cjs: same checks fail as on be64842b (those that need the installer\'s pins.js and own-tools files, which are not available here), the new stub check passes', `${(check.stdout.match(/^PASS/gm) || []).length} pass, failing: ${fails.length}`);
    report.check = { fails, baseFails };
  }

  async function finish() {
    try {
      integrity();
      await main();
    } finally {
      if (process.env.T2_REPORT_DIR) {
        fs.mkdirSync(process.env.T2_REPORT_DIR, { recursive: true });
        fs.writeFileSync(path.join(process.env.T2_REPORT_DIR, `t2-${host}.json`), JSON.stringify(report, null, 1));
      }
      lockOwner.kill('SIGKILL');
      forceRemove(work);
    }
  }
  return { finish };
}

module.exports = { start };

if (require.main === module) {
  const host = process.argv[2] === 'cursor' ? 'cursor' : 'claude';
  let pass = 0;
  let fail = 0;
  const t2 = start({
    host,
    repo: path.resolve(__dirname, '..'),
    result: (ok, name, detail) => {
      if (ok) pass += 1; else fail += 1;
      process.stdout.write(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}\n`);
    },
  });
  t2.finish().then(() => {
    process.stdout.write(`RESULT pass=${pass} fail=${fail}\n`);
    process.exit(fail ? 1 : 0);
  });
}
