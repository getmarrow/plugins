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
// Differential rows (T2-4, T2-5, T2-6, T2-10, T2-13) compare against the baseline commit 5c657b1c, the plugins final that pins the
// PUBLISHED @getmarrow/mcp 3.9.106: set T2_BASELINE_DIR to an extracted tree of it, or leave it unset and the rows extract
// T2_BASELINE_REF (default: 5c657b1c) with `git archive`. Without a baseline those rows fail loudly. A baseline whose pinned MCP is
// not BASELINE_VERSION aborts the run (the commit be64842b pinned 3.9.105, which was never published, so it can not be installed).
// T2-13 also compares against PREPIN_REF, the commit just before the 3.9.106 pin commit, and against OLD_REF (be64842b), which is
// only unpacked with `git archive` and compared as files: it is never installed or run (no override).
// The baseline's pinned server is 3.9.106, the same as this tree's: the rows name the 3.9.106 behaviour as measured from the
// pinned tarball (keyless start, refusal text), they never assume it.
// Optional T2_REPORT_DIR: a JSON file with the matrices and texts of the run is written there.
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const BASELINE_REF = process.env.T2_BASELINE_REF || '5c657b1c959846161a21b2c2dff43e86ba52b786';
// The commit before the 3.9.106 pin commit (the pre-pin tip). T2-13: the pin commit moved the files named in PIN_FILES and nothing else.
const PREPIN_REF = 'ccbe0c329365e8903e8c2b9227e2c17050e512f9';
// The fri-train tip that pinned MCP 3.9.105 (never published). T2-13 keeps it as a file anchor only: unpacked, compared, never installed.
const OLD_REF = 'be64842b6120af91edc44854569124b38730614f';
const PINNED_VERSION = '3.9.106'; // @getmarrow/mcp as pinned by this tree
const BASELINE_VERSION = '3.9.106'; // @getmarrow/mcp as pinned by the baseline 5c657b1c (published)
const OLD_VERSION = '3.9.105'; // @getmarrow/mcp as pinned by PREPIN_REF and OLD_REF (never published)
const DEAD_URL = 'https://127.0.0.1:9';
// The 3.9.106 server's no-key refusal, whole stderr, measured from the pinned tarball (dist/cli.js serverKeyRequiredText). In the Claude plugin
// (CLAUDE_PLUGIN_ROOT set) it is PLUGIN_KEY_ERROR + GET_A_KEY_LINE; Cursor sets no CLAUDE_PLUGIN_ROOT, so it gets the plain text with
// the resolver's exactFix. The T2-14 oracle row checks that these strings are in the pinned dist.
const GET_A_KEY_URL = 'https://getmarrow.ai/signup';
const GET_A_KEY_LINE = `Get a key: ${GET_A_KEY_URL}. Day-one steps and commands: npx @getmarrow/mcp --help`;
const PLUGIN_KEY_STEPS = 'Marrow plugin: put MARROW_API_KEY in ~/.marrow/env, run chmod 600 ~/.marrow/env, then /reload-plugins. The seatbelt hooks keep working without a key. Do not run marrow-mcp setup or activate for the plugin.';
const NO_KEY_FIX = 'Create an API key at https://getmarrow.ai, then export MARROW_API_KEY from trusted secret storage or place it in ~/.marrow/env with owner-only permissions before running npx -y --package=@getmarrow/mcp@latest marrow-mcp setup.';
// The launcher's own refusal for a fleet key (MARROW_KEY_<NAME>) with no MARROW_API_KEY (the `mcp` argument only): exit 1 like the pinned server, but its text, with no npx and no unpinned spec.
const FLEET_REFUSAL = 'Error: MARROW_API_KEY required. Marrow plugin: a fleet key (MARROW_KEY_<NAME>) is set but MARROW_API_KEY is not, and the Marrow MCP server needs MARROW_API_KEY, so it did not start. '
  + 'To connect an account, create an agent key at https://getmarrow.ai, put MARROW_API_KEY in ~/.marrow/env, run chmod 600 ~/.marrow/env, '
  + 'then restart Claude Code or Cursor. The plugin hooks still apply without a key. Do not run marrow-mcp setup or activate for the plugin.\n';
const REQUIRED_LINE_CLAUDE = `Error: MARROW_API_KEY required. ${PLUGIN_KEY_STEPS}\n${GET_A_KEY_LINE}\n`;
const REQUIRED_LINE_CURSOR = `Error: MARROW_API_KEY environment variable is required\n${NO_KEY_FIX}\n${GET_A_KEY_LINE}\n`;
// The 3.9.106 keyless server's own notice (dist/keyless-server.js KEYLESS_NOTICE): it tells a real server run from the launcher's stub.
const SERVER_KEYLESS_NOTICE = 'Marrow: no Marrow key on this machine, so the Marrow MCP server started with no tools. Marrow hooks, where they are set up, keep their free keyless seatbelt.';
// The files the 3.9.106 pin commit moved against PREPIN_REF, each named, plus the one test file this row lives in (moved by the test commit).
// Any other file moving fails T2-13.
const PIN_FILES = [
  '.claude-plugin/marketplace.json',
  '.cursor-plugin/marketplace.json',
  'README.md',
  'plugins/marrow-cursor/.cursor-plugin/plugin.json',
  'plugins/marrow-cursor/README.md',
  'plugins/marrow-cursor/package-lock.json',
  'plugins/marrow-cursor/package.json',
  'plugins/marrow-cursor/scripts/mcp-manifest.json',
  'plugins/marrow-cursor/skills/marrow/SKILL.md',
  'plugins/marrow/.claude-plugin/plugin.json',
  'plugins/marrow/package-lock.json',
  'plugins/marrow/package.json',
  'plugins/marrow/scripts/mcp-manifest.json',
  'plugins/marrow/skills/marrow/SKILL.md',
  'tools/mcp-pins/SOURCE.md',
];
const TEST_COMMIT_FILES = ['tools/test-launcher-t2.cjs'];
// The base of the session-notice branch (the plugins final, pinned to MCP 3.9.106) and every file that branch moved against it: the launcher's
// fleet-key refusal (both copies), the session check's notice, and the checks and tests that hold them. T2-13 names them so nothing else moves quietly.
const NOTICE_BASE_REF = '5c657b1c959846161a21b2c2dff43e86ba52b786';
const BRANCH_FILES = [
  'plugins/marrow-cursor/scripts/marrow-launch.cjs',
  'plugins/marrow/scripts/marrow-launch.cjs',
  'plugins/marrow/scripts/marrow-session-check.cjs',
  'tools/check.cjs',
  'tools/test-launcher-t2.cjs',
  'tools/test-session-check.cjs',
];
// The only places a server's stdout carries its own version: result.serverInfo.version of the initialize answer and the two client_update
// fields of the log notification. T2-4 normalizes exactly these paths, each only when it equals the pinned version string.
const VERSION_PATHS = [['result', 'serverInfo', 'version'], ['params', 'data', 'client_update', 'installed_version'], ['params', 'data', 'client_update', 'latest_version']];
const VERSION_TOKEN = '<pinned-version>';
const STUB_NOTICE = 'Marrow plugin: no Marrow key on this machine, so the Marrow MCP server started with no tools.';
const DENY_WORDS = /allow|approv|permit|grant|authori[sz]|proceed|decision|safe to/i;
const POSIX = process.platform !== 'win32';

function start({ host, repo, result: countRow }) {
  const CURSOR = host === 'cursor';
  const REQUIRED_LINE = CURSOR ? REQUIRED_LINE_CURSOR : REQUIRED_LINE_CLAUDE;
  const source =path.join(repo, 'plugins', CURSOR ? 'marrow-cursor' : 'marrow');
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
  // Records, never blocks: every connect, lookup, http(s)/fetch request, child process and file-changing call of the process, to T2_COUNT_LOG.
  // (The T2-7 GUARD above refuses instead; this one measures a server whose own behaviour is the thing under test.)
  const COUNT = preload('count.cjs', `'use strict';
const fs = require('fs');
const net = require('net');
const dns = require('dns');
const cp = require('child_process');
const http = require('http');
const https = require('https');
const http2 = require('http2');
const tls = require('tls');
const writeLog = fs.writeFileSync;
const log = process.env.T2_COUNT_LOG;
const counts = { connect: 0, lookup: 0, request: 0, fetch: 0, spawn: 0, fsWrite: [] };
const wrap = (obj, name, fn) => {
  const original = obj[name];
  if (typeof original !== 'function') return;
  obj[name] = function counted(...args) { fn(args); return original.apply(this, args); };
};
wrap(net.Socket.prototype, 'connect', () => { counts.connect += 1; });
for (const name of ['lookup', 'resolve', 'resolve4', 'resolve6']) wrap(dns, name, () => { counts.lookup += 1; });
for (const mod of [http, https, http2, tls]) for (const name of ['request', 'get', 'connect']) wrap(mod, name, () => { counts.request += 1; });
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) wrap(cp, name, () => { counts.spawn += 1; });
if (typeof globalThis.fetch === 'function') {
  const original = globalThis.fetch;
  globalThis.fetch = function counted(...args) { counts.fetch += 1; return original.apply(this, args); };
}
const changing = ['writeFile', 'appendFile', 'createWriteStream', 'mkdir', 'rename', 'copyFile', 'unlink', 'rm', 'rmdir', 'symlink', 'chmod', 'utimes', 'truncate', 'link', 'mkdtemp'];
for (const name of changing) {
  wrap(fs, name, (args) => { counts.fsWrite.push(name); });
  wrap(fs, name + 'Sync', () => { counts.fsWrite.push(name + 'Sync'); });
  wrap(fs.promises, name, () => { counts.fsWrite.push('promises.' + name); });
}
const writes = (flags) => (typeof flags === 'string' && /[wa+]/.test(flags)) || (typeof flags === 'number' && (flags & 3) !== 0);
for (const name of ['open', 'openSync']) wrap(fs, name, (args) => { if (writes(args[1])) counts.fsWrite.push(name); });
wrap(fs.promises, 'open', (args) => { if (writes(args[1])) counts.fsWrite.push('promises.open'); });
process.on('exit', () => { writeLog.call(fs, log, JSON.stringify(counts)); });
`);
  const nodeOptions = (...files) => ({ NODE_OPTIONS: files.map((f) => `--require=${f}`).join(' ') });
  // The numbers COUNT recorded for one run: all four network counters and the child-process counter must be 0 for a run that owes nothing.
  const countsOf = (file) => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  };
  const noActivity = (c) => c !== null && c.connect === 0 && c.lookup === 0 && c.request === 0 && c.fetch === 0 && c.spawn === 0;
  // Paths, modes, sizes and mtimes of everything under the given folders (an unreadable folder is listed as such), for before/after proofs.
  const treeSnapshot = (...dirs) => {
    const lines = [];
    const walk = (base, d) => {
      let names;
      try { names = fs.readdirSync(d).sort(); } catch { lines.push(`${path.relative(base, d)} <unreadable>`); return; }
      for (const name of names) {
        const full = path.join(d, name);
        const st = fs.lstatSync(full);
        lines.push(`${path.relative(base, full)} ${(st.mode & 0o7777).toString(8)} ${st.size} ${st.mtimeMs}`);
        if (st.isDirectory()) walk(base, full);
      }
    };
    for (const dir of dirs) { lines.push(`# ${path.basename(dir)}`); walk(dir, dir); }
    return lines.join('\n');
  };
  // The files under the given folders whose bytes hold the dummy key (an unreadable file holds none we can see).
  const filesWithKey = (...dirs) => {
    const found = [];
    const needle = Buffer.from(KEY);
    const walk = (d) => {
      let names;
      try { names = fs.readdirSync(d).sort(); } catch { return; }
      for (const name of names) {
        const full = path.join(d, name);
        const st = fs.lstatSync(full);
        if (st.isDirectory()) walk(full);
        else if (st.isFile() && st.size <= 4 * 1024 * 1024) {
          try { if (fs.readFileSync(full).includes(needle)) found.push(full); } catch { /* unreadable */ }
        }
      }
    };
    for (const dir of dirs) walk(dir);
    return found.sort();
  };
  // T2-4 byte equality against the baseline: stdout is compared line by line after exactly three JSON paths (VERSION_PATHS) are
  // replaced by VERSION_TOKEN, each only when its value equals the side's pinned version string exactly. Every line must be the compact
  // JSON the server writes (JSON.stringify of itself), so re-serializing loses nothing. No wildcard, no regex, no other masking.
  const normalizeVersions = (stdout, version) => {
    const lines = stdout.split('\n');
    const paths = [];
    const out = lines.map((line, index) => {
      if (line === '') return line;
      let value;
      try { value = JSON.parse(line); } catch { return line; }
      if (JSON.stringify(value) !== line) return line;
      for (const keys of VERSION_PATHS) {
        let holder = value;
        for (const key of keys.slice(0, -1)) holder = holder && typeof holder === 'object' ? holder[key] : undefined;
        const last = keys[keys.length - 1];
        if (holder && typeof holder === 'object' && Object.prototype.hasOwnProperty.call(holder, last) && holder[last] === version) {
          holder[last] = VERSION_TOKEN;
          paths.push(`#${index}/${keys.join('/')}`);
        }
      }
      return JSON.stringify(value);
    });
    return { text: out.join('\n'), paths };
  };
  // Same status, same stderr, stdout equal after normalizeVersions on each side with its own pinned version, and the same set of
  // normalized paths on both sides (so a version value can not have moved to another place).
  const sameApartFromVersions = (baseline, candidate, baselineVersion = BASELINE_VERSION, candidateVersion = PINNED_VERSION) => {
    const b = normalizeVersions(baseline.stdout, baselineVersion);
    const c = normalizeVersions(candidate.stdout, candidateVersion);
    return baseline.status === candidate.status && baseline.stderr === candidate.stderr && b.text === c.text
      && b.paths.length > 0 && JSON.stringify(b.paths) === JSON.stringify(c.paths);
  };

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
  // MCP_INPUT plus a tools/call: the keyless oracle asks the pinned server for a tool it must not have.
  const KEYLESS_INPUT = `${[INIT(1), NOTIFIED, rpc(2, 'tools/list'), rpc(3, 'tools/call', { name: 'marrow_agent_runtime', arguments: {} })].join('\n')}\n`;

  // ---- baseline (5c657b1c, pins the published MCP 3.9.106) ------------------------------------------------
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
  // Fail closed: a baseline is only a baseline if it pins the published MCP this test was written for, in its package.json, lockfile and
  // manifest of both plugins. Any other baseline (be64842b pins 3.9.105, which was never published; T2_BASELINE_DIR or T2_BASELINE_REF pointed
  // at some other tree) aborts the run before a single row can pass against it.
  if (baselineDir) {
    const pinnedBy = (plugin) => {
      const read = (...p) => JSON.parse(fs.readFileSync(path.join(baselineDir, plugin, ...p), 'utf8'));
      try {
        return [read('package.json').dependencies['@getmarrow/mcp'], read('package-lock.json').packages['node_modules/@getmarrow/mcp'].version, read('scripts', 'mcp-manifest.json').mcp.version];
      } catch (error) { return [`unreadable: ${error.code || error.message}`]; }
    };
    const wrong = ['plugins/marrow', 'plugins/marrow-cursor'].filter((plugin) => { const pins = pinnedBy(plugin); return pins.length !== 3 || pins.some((v) => v !== BASELINE_VERSION); });
    if (wrong.length) throw new Error(`T2 baseline ${BASELINE_REF.slice(0, 8)} does not pin the published @getmarrow/mcp ${BASELINE_VERSION} (${wrong.map((p) => `${p}: ${pinnedBy(p).join(' / ')}`).join('; ')}): aborting, no row can pass against it`);
  }
  // ---- the old fri-train tip (be64842b, pinned the unpublished MCP 3.9.105), for T2-13 as a file anchor only -------------
  let oldDir = '';
  let oldError = '';
  {
    const dir = path.join(work, 'old');
    fs.mkdirSync(dir);
    const archive = spawnSync('git', ['-C', repo, 'archive', OLD_REF], { maxBuffer: 256 * 1024 * 1024 });
    const untar = archive.status === 0 ? spawnSync('tar', ['-x', '-C', dir], { input: archive.stdout }) : { status: 1 };
    if (archive.status === 0 && untar.status === 0) oldDir = dir; else oldError = `git archive ${OLD_REF.slice(0, 8)} failed`;
  }
  // ---- the commit before the pin commit (ccbe0c32), for T2-13 -------------------------------------------
  let prepinDir = '';
  let prepinError = '';
  {
    const dir = path.join(work, 'prepin');
    fs.mkdirSync(dir);
    const archive = spawnSync('git', ['-C', repo, 'archive', PREPIN_REF], { maxBuffer: 256 * 1024 * 1024 });
    const untar = archive.status === 0 ? spawnSync('tar', ['-x', '-C', dir], { input: archive.stdout }) : { status: 1 };
    if (archive.status === 0 && untar.status === 0) prepinDir = dir; else prepinError = `git archive ${PREPIN_REF.slice(0, 8)} failed`;
  }

  // ---- the base of the session-notice branch (5c657b1c), for T2-13 ---------------------------------------
  let noticeBaseDir = '';
  let noticeBaseError = '';
  {
    const dir = path.join(work, 'notice-base');
    fs.mkdirSync(dir);
    const archive = spawnSync('git', ['-C', repo, 'archive', NOTICE_BASE_REF], { maxBuffer: 256 * 1024 * 1024 });
    const untar = archive.status === 0 ? spawnSync('tar', ['-x', '-C', dir], { input: archive.stdout }) : { status: 1 };
    if (archive.status === 0 && untar.status === 0) noticeBaseDir = dir; else noticeBaseError = `git archive ${NOTICE_BASE_REF.slice(0, 8)} failed`;
  }

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
    const { pluginDir, home, extra, node, input = '' } = build();
    return new Promise((resolve) => {
      const child = spawn(node || process.execPath, [path.join(pluginDir, 'scripts', 'marrow-launch.cjs'), 'mcp'], {
        cwd: path.join(home, 'project'), env: envFor(pluginDir, home, extra), stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (c) => { stdout += c; });
      child.stderr.on('data', (c) => { stderr += c; });
      child.stdin.on('error', () => {});
      child.stdin.end(input);
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
    // Once it holds the lock the start installs and runs the keyless stub, which exits 0 at EOF only after an initialize (the start guard).
    return { pluginDir, home, extra: {}, input: `${INIT(1)}\n` };
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
      // Every state has an explicit kind: what the launcher does with it and what the pinned 3.9.106 server does, never inferred from the oracle.
      //   keyless: a clear "no key". The launcher serves the stub (T2-4c: keyless() true). The pinned server, started directly, answers keyless:
      //     0 tools, a tools/call error, no request, no file written (measured here from the pinned tarball). The baseline (5c657b1c) serves the same stub.
      //   fleet:   a MARROW_KEY_<NAME> variable is set and no direct key. It is no usable key and never the stub's case. The launcher refuses with FLEET_REFUSAL
      //     (exit 1, nothing on stdout, nothing started): the pinned server exits 1 too, but with its own text, which names unpinned npx commands;
      //     the baseline launcher (5c657b1c, no fleet rule) runs that server, so the baseline refuses with the server's text.
      //   refused: an owner key file the resolver refused (620, 644, 000, symlinks, group-writable folders, FIFO, directory; ownerFileRefused from 3.9.106).
      //     keyless() is false (T2-4c), so the server runs, with no key: the key in the file is never accepted, exit 1, nothing sent, nothing echoed.
      //   keyed:   a key (or key-shaped value) the server accepts: the real server runs and its bytes equal the baseline's apart from the three version fields.
      //   badurl:  no key but a base URL the server refuses: the real server crashes, as the baseline does.
      const KIND = {
        none: 'keyless',
        'empty MARROW_API_KEY': 'keyless',
        'whitespace-only MARROW_API_KEY': 'keyed',
        'dummy key in env': 'keyed',
        'MARROW_KEY alias': 'keyed',
        'garbage key in env (invalid format)': 'keyed',
        'garbage key in env file 600': 'keyed',
        'env file 600, dir 700': 'keyed',
        'env.local file 600': 'keyed',
        'env file with CRLF, comments, export, quotes': 'keyed',
        'env file: key line commented out': 'keyless',
        'env file empty value': 'keyless',
        'FLEET_AGENT_ID set, no key': 'keyless',
        'AGENT_ID + per-agent key vars, no direct key': 'fleet',
        'per-agent key var alone, no agent id': 'fleet',
        'per-agent key var, lowercase suffix': 'fleet',
        'per-agent key var empty (an empty slot is no key)': 'keyless',
        'per-agent key var named PROD (misleading word)': 'fleet',
        'per-agent key var named TEST (misleading word)': 'fleet',
        'two per-agent key vars, one empty one set': 'fleet',
        'per-agent key var + MARROW_API_KEY empty': 'fleet',
        'per-agent key var + dummy MARROW_API_KEY': 'keyed',
        'project .env with a key (never read as a key)': 'keyless',
        'MARROW_BASE_URL http (invalid), no key': 'badurl',
        'MARROW_BASE_URL https custom, no key': 'keyless',
        'MARROW_BASE_URL with credentials, no key': 'badurl',
        'MARROW_BASE_URL unparsable, no key': 'badurl',
        'env file group-writable (620)': 'refused',
        'env file world-readable (644)': 'refused',
        'env file unreadable (000)': 'refused',
        'env file symlinked': 'refused',
        '~/.marrow symlinked folder': 'refused',
        '~/.marrow dir 755, file 600': 'keyed',
        '~/.marrow dir 775 (group-writable), file 600': 'refused',
        'HOME group-writable (770), file 600': 'refused',
        'env file is a FIFO': 'refused',
        'env file is a directory': 'refused',
        'HOME is an unreadable folder (000)': 'keyless',
        "HOME is another account's folder (/root)": 'keyless',
      };
      const add = (name, prep) => {
        if (!KIND[name]) throw new Error('T2-4 state without an explicit kind: ' + name);
        states.push({ name, prep, kind: KIND[name] });
      };
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
      add('per-agent key var alone, no agent id', () => ({ extra: { MARROW_KEY_X: KEY } }));
      add('per-agent key var, lowercase suffix', () => ({ extra: { MARROW_KEY_x: KEY } }));
      add('per-agent key var empty (an empty slot is no key)', () => ({ extra: { MARROW_KEY_X: '' } }));
      add('per-agent key var named PROD (misleading word)', () => ({ extra: { MARROW_KEY_PROD: KEY } }));
      add('per-agent key var named TEST (misleading word)', () => ({ extra: { MARROW_KEY_TEST: KEY } }));
      add('two per-agent key vars, one empty one set', () => ({ extra: { MARROW_KEY_A: '', MARROW_KEY_B: KEY } }));
      add('per-agent key var + MARROW_API_KEY empty', () => ({ extra: { MARROW_KEY_X: KEY, MARROW_API_KEY: '' } }));
      add('per-agent key var + dummy MARROW_API_KEY', () => ({ extra: { MARROW_KEY_X: KEY, MARROW_API_KEY: KEY, ...keyed } }));
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
      // The crash the badurl states print: the same statement in each pinned dist (baseline and candidate both 3.9.106, line 603). The frames are equal
      // once each side's exact position (dist/cli.js:603:58) is read as that statement; the test reads the statement from both dists, so a frame that
      // moved is measured, not assumed.
      const distLine = (dir, line) => (fs.readFileSync(path.join(dir, 'node_modules', '@getmarrow', 'mcp', 'dist', 'cli.js'), 'utf8').split('\n')[line - 1] || '');
      const CRASH_STATEMENT = '(0, index_1.validateBaseUrl)(rawBaseUrl)';
      const crashFramesOk = Boolean(baselinePlug) && distLine(baselinePlug, 603).includes(CRASH_STATEMENT) && distLine(plug, 603).includes(CRASH_STATEMENT);
      // A crash prints a stack trace that names the plugin folder and the launcher's own frames (line numbers); only those and the pinned frame differ.
      const crashText = (t) => t.replace(/plugin-\d+/g, 'plugin-#').replace(/marrow-launch\.cjs:\d+:\d+/g, 'marrow-launch.cjs:#:#')
        .split('dist/cli.js:603:58').join('dist/cli.js:#:#');
      const KIND_TEXT = {
        keyless: 'the stub runs (and so does the baseline) and the pinned 3.9.106 server, started directly, answers keyless: 0 tools, a tools/call error, no request, no file written',
        fleet: 'the launcher refuses (never the stub, never the server): exit 1 like the pinned server, nothing on stdout, exactly the fleet refusal text (no npx, no unpinned spec), no request, no key echoed',
        refused: 'the server (never the stub) runs with no key: exit 1, nothing on stdout, the exact 3.9.106 refusal, no request, the refused file\'s key in no stream and in no new file',
        keyed: 'the real server runs and its bytes equal the baseline\'s (5c657b1c, pinned 3.9.106) apart from the three exact version fields, which both carry as 3.9.106',
        badurl: 'the real server runs and crashes as the baseline does: exit 1, nothing on stdout, the same stack apart from the plugin folder and the launcher\'s own frames',
      };
      // The exact refusal. Cursor sets no CLAUDE_PLUGIN_ROOT, so for a refused owner file its server adds one line, 'Ignored the Marrow key in <file>: <why>',
      // whose file path and reason are the state's own; every other line is exact.
      const refusalText = (text, refusedFile) => {
        if (!CURSOR || !refusedFile) return text === REQUIRED_LINE;
        const lines = text.split('\n');
        return lines.length === 5 && lines[0] === 'Error: MARROW_API_KEY environment variable is required' && lines[1] === NO_KEY_FIX
          && lines[2].startsWith('Ignored the Marrow key in ') && lines[3] === GET_A_KEY_LINE && lines[4] === '';
      };
      let n = 0;
      for (const state of states) {
        n += 1;
        const { kind } = state;
        const home = makeHome(`t24-${n}`);
        const prepared = state.prep(home);
        if (prepared === null) continue;
        const useHome = prepared.home || home;
        const keyFilesBefore = filesWithKey(home);
        const counted = (label) => path.join(work, `count-t24-${n}-${label}.json`);
        const run = (fn, dir, { input = MCP_INPUT, count = '' } = {}) => fn(dir, {
          home: useHome, cwd: prepared.cwd || path.join(home, 'project'), input,
          extra: { ...nodeOptions(NETGUARD, ...(count ? [COUNT] : [])), ...(count ? { T2_COUNT_LOG: count } : {}), ...(prepared.extra || {}) },
        });
        const serverRun = kind === 'fleet' || kind === 'refused';
        const cand = run((dir, o) => launch(dir, ['mcp'], o), plug, { count: serverRun ? counted('cand') : '' });
        const stub = cand.stderr.includes(STUB_NOTICE);
        const oracleA = baselinePlug ? run((dir, o) => launch(dir, ['mcp'], o), baselinePlug) : null;
        // What the baseline launcher (5c657b1c) did in this state, measured from its own run: it served the stub, or it started the pinned server and
        // that refused (exit 1, nothing on stdout, the server's exact refusal text), or neither (the server ran, or crashed).
        const baselineOutcome = (r) => (r.stderr.includes(STUB_NOTICE) ? 'stub' : (r.status === 1 && r.stdout === '' && refusalText(r.stderr, kind === 'refused') ? 'refused' : 'other'));
        const messages = (r) => parseLines(r.stdout).messages;
        const toolCount = (r) => { const m = messages(r).find((x) => x.id === 2); return m && m.result && Array.isArray(m.result.tools) ? m.result.tools.length : -1; };
        const nothingEchoed = (...rs) => rs.every((r) => !(r.stdout + r.stderr).includes(KEY));
        const checks = {};
        // The launcher's choice, explicit per state (T2-4c holds the decision table), and the measured baseline behaviour it is tied to: the stub
        // for a clear no-key state, the pinned server's refusal for the fleet and refused states, the server itself otherwise.
        checks.launcherChoice = oracleA !== null && stub === (kind === 'keyless');
        checks.baselineOutcome = oracleA !== null && baselineOutcome(oracleA) === (kind === 'keyless' ? 'stub' : (kind === 'fleet' || kind === 'refused') ? 'refused' : 'other');
        if (oracleA !== null && kind === 'keyless') {
          const log = counted('direct');
          const before = treeSnapshot(home, plug);
          const d = run(direct, plug, { input: KEYLESS_INPUT, count: log });
          const after = treeSnapshot(home, plug);
          const dm = messages(d);
          const byId = (id) => dm.find((m) => m.id === id) || {};
          const c = countsOf(log);
          checks.stubServes = cand.status === 0 && messages(cand).length === 2 && toolCount(cand) === 0;
          checks.stubSameAsBaseline = cand.status === oracleA.status && cand.stdout === oracleA.stdout && cand.stderr === oracleA.stderr;
          checks.pinnedKeyless = d.status === 0 && dm.length === 3 && dm.every(isRpc) && Boolean(byId(1).result) && byId(1).result.serverInfo.version === PINNED_VERSION
            && toolCount(d) === 0 && Boolean(byId(3).error) && byId(3).result === undefined && byId(3).error.code === -32602 && byId(3).error.message === 'This server has no tools.'
            && d.stderr.split('\n')[0] === SERVER_KEYLESS_NOTICE;
          checks.pinnedSentNothing = noActivity(c);
          checks.pinnedWroteNothing = c !== null && c.fsWrite.length === 0 && before === after;
          checks.keyNotEchoed = nothingEchoed(cand, d);
        } else if (oracleA !== null && kind === 'fleet') {
          const log = counted('direct');
          const d = run(direct, plug, { count: log });
          const out = cand.stdout + cand.stderr;
          checks.launcherRefuses = cand.status === 1 && cand.stdout === '' && cand.stderr === FLEET_REFUSAL;
          checks.sameExitAndStdoutAsPinnedServer = d.status === 1 && d.stdout === '' && cand.status === d.status && cand.stdout === d.stdout;
          checks.noUnpinnedNextStep = !/npx|@latest|--package=/.test(out);
          checks.startedNothing = noActivity(countsOf(counted('cand'))) && noActivity(countsOf(log));
          checks.keyNeverEchoed = nothingEchoed(cand, d);
        } else if (oracleA !== null && serverRun) {
          const log = counted('direct');
          const d = run(direct, plug, { count: log });
          checks.pinnedRefuses = d.status === 1 && d.stdout === '' && refusalText(d.stderr, kind === 'refused');
          checks.candidateIsThePinnedServer = cand.status === d.status && cand.stdout === d.stdout && cand.stderr === d.stderr;
          checks.sentNothing = noActivity(countsOf(log)) && noActivity(countsOf(counted('cand')));
          checks.keyNeverAccepted = cand.stdout === '' && d.stdout === '' && toolCount(cand) === -1 && nothingEchoed(cand, d)
            && JSON.stringify(filesWithKey(home)) === JSON.stringify(keyFilesBefore);
        } else if (oracleA !== null && kind === 'keyed') {
          const d = run(direct, plug);
          const again = run((dir, o) => launch(dir, ['mcp'], o), baselinePlug);
          checks.baselineRanTheServer = oracleA.status === 0 && toolCount(oracleA) > 0 && baselineOutcome(oracleA) === 'other';
          checks.baselineIsRepeatable = again.status === oracleA.status && again.stdout === oracleA.stdout && again.stderr === oracleA.stderr;
          checks.sameAsBaseline = sameApartFromVersions(oracleA, cand);
          checks.sameToolCount = toolCount(cand) > 0 && toolCount(cand) === toolCount(oracleA);
          checks.directIsTheCandidate = d.status === cand.status && d.stdout === cand.stdout && d.stderr === cand.stderr && d.stderr !== REQUIRED_LINE;
        } else if (oracleA !== null && kind === 'badurl') {
          const d = run(direct, plug);
          checks.baselineCrashed = oracleA.status === 1 && oracleA.stdout === '' && baselineOutcome(oracleA) === 'other';
          checks.sameCrash = crashFramesOk && cand.status === oracleA.status && cand.stdout === oracleA.stdout && crashText(cand.stderr) === crashText(oracleA.stderr);
          checks.directCrashes = d.status === 1 && d.stdout === '' && d.stderr !== REQUIRED_LINE && d.stderr.includes('MARROW_BASE_URL');
        }
        const failed = Object.keys(checks).filter((k) => !checks[k]);
        const row = { state: state.name, kind, oracle: oracleA ? baselineOutcome(oracleA) : null, candidate: stub ? 'stub' : 'server', candidateStatus: cand.status, assertions: Object.keys(checks).length, failed, pass: oracleA !== null && failed.length === 0 };
        rows.push(row);
        result(row.pass, `T2-4 [${n}] ${state.name}: ${KIND_TEXT[kind]}`, `${kind}; baseline ${row.oracle === null ? 'n/a' : row.oracle === 'stub' ? 'served the stub' : row.oracle === 'refused' ? 'refused with the server text' : 'ran or crashed'}, candidate ${row.candidate}, exit ${cand.status}, ${row.assertions} checks${failed.length ? `, failed: ${failed.join(',')}` : ''}`);
      }
      report.t24 = rows;
      // The version normalizer, on made-up streams: only the three exact paths with the exact version strings are masked; a look-alike
      // version, a version at any other path, any other changed byte, a non-canonical line, a changed exit or stderr all fail.
      const normalizerSelfTest = () => {
        const init = (v, extra = {}) => JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2024-11-05', serverInfo: { name: 'marrow', version: v }, ...extra } });
        const note = (installed, latest) => JSON.stringify({ jsonrpc: '2.0', method: 'notifications/message', params: { data: { client_update: { installed_version: installed, latest_version: latest } } } });
        const stream = (v, other = {}, i = v, l = v) => ({ status: 0, stderr: '', stdout: `${init(v, other)}\n${note(i, l)}\n` });
        const base = stream(OLD_VERSION); // a made-up older baseline: the normalizer must handle two different versions as before
        const good = stream(PINNED_VERSION);
        const same = (a, b) => sameApartFromVersions(a, b, OLD_VERSION, PINNED_VERSION);
        // The regime of the real rows: baseline and candidate both carry the pinned version (same pin, the only masked value).
        const sameEq = (a, b) => sameApartFromVersions(a, b, PINNED_VERSION, PINNED_VERSION);
        return same(base, good)
          && !same(base, stream('3.9.1060')) && !same(base, stream('v3.9.106')) && !same(base, stream('3.9.106 ')) && !same(base, stream('3.9.107'))
          && !same(base, stream(PINNED_VERSION, {}, '3.9.1060', PINNED_VERSION)) && !same(base, stream(PINNED_VERSION, {}, PINNED_VERSION, 'v3.9.106'))
          && !same(base, stream(PINNED_VERSION, {}, OLD_VERSION, PINNED_VERSION)) && !same(stream('3.9.104'), good)
          && !same(stream(OLD_VERSION, { other: OLD_VERSION }), stream(PINNED_VERSION, { other: PINNED_VERSION }))
          && !same(base, stream(PINNED_VERSION, { extra: 1 })) && !same(base, { ...good, stdout: good.stdout.replace('"name":"marrow"', '"name":"marrow2"') })
          && !same(base, { ...good, stdout: good.stdout.replace('"id":1', '"id": 1') }) && !same(base, { ...good, stdout: good.stdout.slice(0, -1) })
          && !same(base, { ...good, status: 1 }) && !same(base, { ...good, stderr: 'x' })
          && sameEq(good, stream(PINNED_VERSION)) && !sameEq(good, stream(OLD_VERSION)) && !sameEq(good, stream('3.9.107')) && !sameEq(good, stream('v3.9.106'))
          && !sameEq(good, stream(PINNED_VERSION, {}, OLD_VERSION, PINNED_VERSION)) && !sameEq(good, stream(PINNED_VERSION, { extra: 1 }))
          && !sameEq(stream(PINNED_VERSION, { other: PINNED_VERSION }), stream(PINNED_VERSION, { other: OLD_VERSION }))
          && !sameEq(good, { ...good, stdout: good.stdout.slice(0, -1) }) && !sameEq(good, { ...good, status: 1 }) && !sameEq(good, { ...good, stderr: 'x' });
      };
      result(rows.length >= 12 && rows.some((r) => r.candidate === 'stub') && rows.some((r) => r.candidate === 'server') && normalizerSelfTest(), 'T2-4 the matrix has at least 12 states and exercises both outcomes, and the version normalizer refuses look-alike versions, other paths and any other changed byte', `${rows.length} states`);
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

    // T2-4c the stub decision (keyless() in the launcher) against resolver results: one table, both launchers, the 3.9.105 and 3.9.106 env.js shapes.
    // keyless() is lifted from the launcher source and run with a fake process.env and an env.js that returns the row's result, so the table also
    // covers what the pinned 3.9.105 copy can not produce here (a refused owner file reports ownerFileRefused only from 3.9.106).
    {
      const launcherSource = fs.readFileSync(path.join(source, 'scripts', 'marrow-launch.cjs'), 'utf8');
      // From noDirectKey() to the end of fleetKeyOnly(): the two decisions and the two helpers they share.
      const from = launcherSource.indexOf('function noDirectKey(entry) {');
      const last = launcherSource.indexOf('function fleetKeyOnly(entry) {');
      const to = launcherSource.indexOf('\n}\n', last) + 3;
      const lift = (envVars) => new Function('require', 'path', 'URL', 'process', `${launcherSource.slice(from, to)}\nreturn { keyless, fleetKeyOnly };`)(require, path, URL, { env: envVars });
      const dir = path.join(work, 'keyless-decision');
      fs.mkdirSync(dir, { recursive: true });
      const decide = (resolverBody, envVars = {}) => {
        fs.writeFileSync(path.join(dir, 'env.js'), `exports.resolveMarrowEnv = () => { ${resolverBody} };\n`);
        delete require.cache[path.join(dir, 'env.js')]; // one fresh module per row
        const decisions = lift(envVars);
        return { stub: decisions.keyless(path.join(dir, 'server.js')), fleet: decisions.fleetKeyOnly(path.join(dir, 'server.js')) };
      };
      const none = { apiKey: '', baseUrl: 'https://api.getmarrow.ai', sessionId: undefined, source: null, missing: true, exactFix: 'Create an API key at https://getmarrow.ai' };
      const as = (patch) => `return ${JSON.stringify({ ...none, ...patch })};`;
      const table = [
        // [name, resolver body, env vars, expected stub, expected fleet-key-only refusal (true only where listed)]
        ['3.9.105 shape, no key', as({}), {}, true],
        ['3.9.106 shape, no key, no owner file refused (field absent)', as({}), {}, true],
        ['empty base URL means the default', as({ baseUrl: '' }), {}, true],
        ['https custom base URL', as({ baseUrl: 'https://127.0.0.1:9' }), {}, true],
        ['an owner key file was refused (ownerFileRefused true)', as({ ownerFileRefused: true }), {}, false],
        ['ownerFileRefused false (any defined value is doubt)', as({ ownerFileRefused: false }), {}, false],
        ['missing is false', as({ missing: false }), {}, false],
        ['missing is absent', 'const r = ' + JSON.stringify(none) + '; delete r.missing; return r;', {}, false],
        ['source is set', as({ source: 'MARROW_API_KEY' }), {}, false],
        ['source is absent', 'const r = ' + JSON.stringify(none) + '; delete r.source; return r;', {}, false],
        ['apiKey is whitespace', as({ apiKey: '   ' }), {}, false],
        ['apiKey is a key', as({ apiKey: 'not-a-real-key', missing: false, source: 'MARROW_API_KEY' }), {}, false],
        ['apiKey is absent', 'const r = ' + JSON.stringify(none) + '; delete r.apiKey; return r;', {}, false],
        ['base URL http', as({ baseUrl: 'http://127.0.0.1:9' }), {}, false],
        ['base URL with credentials', as({ baseUrl: 'https://user:pass@127.0.0.1:9' }), {}, false],
        ['base URL unparsable', as({ baseUrl: 'not a url' }), {}, false],
        ['base URL not a string', as({ baseUrl: 42 }), {}, false],
        ['resolver returns null', 'return null;', {}, false],
        ['resolver returns a string', "return '';", {}, false],
        ['resolver throws', "throw new Error('t2 resolver failure');", {}, false],
        ['fleet key alone (MARROW_KEY_A)', as({}), { MARROW_KEY_A: 'x' }, false, true],
        ['fleet key with agent identity', as({}), { MARROW_FLEET_AGENT_ID: 'a', MARROW_AGENT_ID_A: 'a', MARROW_KEY_A: 'x' }, false, true],
        ['fleet key, lowercase suffix', as({}), { MARROW_KEY_a: 'x' }, false, true],
        ['fleet key, bare prefix MARROW_KEY_', as({}), { MARROW_KEY_: 'x' }, false, true],
        ['two fleet slots, one empty', as({}), { MARROW_KEY_A: '', MARROW_KEY_B: 'x' }, false, true],
        ['fleet key named PROD (a misleading word is only a name)', as({}), { MARROW_KEY_PROD: 'x' }, false, true],
        ['fleet key named TEST', as({}), { MARROW_KEY_TEST: 'x' }, false, true],
        ['fleet key, whitespace value (non-empty)', as({}), { MARROW_KEY_A: ' ' }, false, true],
        ['fleet key, 3.9.106 shape with an https custom base URL', as({ baseUrl: 'https://127.0.0.1:9' }), { MARROW_KEY_A: 'x' }, false, true],
        ['fleet key + an owner key file was refused: the server runs', as({ ownerFileRefused: true }), { MARROW_KEY_A: 'x' }, false, false],
        ['fleet key + base URL http: the server runs and shows its own error', as({ baseUrl: 'http://127.0.0.1:9' }), { MARROW_KEY_A: 'x' }, false, false],
        ['fleet key + base URL with credentials: the server runs', as({ baseUrl: 'https://user:pass@127.0.0.1:9' }), { MARROW_KEY_A: 'x' }, false, false],
        ['fleet key + resolver throws: the server runs', "throw new Error('t2 resolver failure');", { MARROW_KEY_A: 'x' }, false, false],
        ['fleet key + resolver returns null: the server runs', 'return null;', { MARROW_KEY_A: 'x' }, false, false],
        ['fleet key + a direct key: the server runs', as({ apiKey: 'not-a-real-key', missing: false, source: 'MARROW_API_KEY' }), { MARROW_KEY_A: 'x' }, false, false],
        ['fleet key + source is set: the server runs', as({ source: 'MARROW_API_KEY' }), { MARROW_KEY_A: 'x' }, false, false],
        ['fleet key + missing is false: the server runs', as({ missing: false }), { MARROW_KEY_A: 'x' }, false, false],
        ['fleet key + apiKey is whitespace: the server runs', as({ apiKey: '   ' }), { MARROW_KEY_A: 'x' }, false, false],
        ['an empty fleet slot is no key', as({}), { MARROW_KEY_A: '' }, true],
        ['other MARROW_ variables are not keys', as({}), { MARROW_APIKEY: 'x', MARROW_KEYS: 'x', MARROW_AGENT_ID: 'a' }, true],
      ];
      const wrong = table.filter(([, body, envVars, expected, fleetExpected]) => {
        const got = decide(body, envVars);
        return got.stub !== expected || got.fleet !== (fleetExpected === true);
      }).map(([name]) => name);
      result(wrong.length === 0, `T2-4c keyless() and fleetKeyOnly() decision table: ${table.length} resolver results and env states, stub only for a clear "no key", the fleet refusal only for a clear "no direct key" plus a fleet key, never both`, wrong.length ? `wrong: ${wrong.join('; ')}` : `${table.length} rows`);
      result(/ownerFileRefused/.test(launcherSource.slice(from, to)) && !/dist\/cli\.js:\d/.test(launcherSource), 'T2-4c the decision code names ownerFileRefused, and no launcher comment cites a dist/cli.js line number');
    }

    // T2-5 resolver throws: today's path, never the stub
    {
      const once = makeHome('t25-once');
      const onceExtra = { ...nodeOptions(THROW), T2_THROW: 'once' };
      const rOnce = launch(plug, ['mcp'], { home: once, input: MCP_INPUT, extra: onceExtra });
      // The same throw, but not an MCP start (stdin ends before any initialize): the real server refuses with its own exact 3.9.106 text.
      const rOnceEof = launch(plug, ['mcp'], { home: makeHome('t25-once-eof'), input: '', extra: onceExtra });
      const onceMessages = parseLines(rOnce.stdout).messages;
      result(rOnceEof.status === 1 && rOnceEof.stdout === '' && rOnceEof.stderr === REQUIRED_LINE && !rOnceEof.stderr.includes(STUB_NOTICE)
        && rOnce.status === 0 && onceMessages.length === 2 && onceMessages.every(isRpc) && onceMessages[0].result.serverInfo.version === PINNED_VERSION && onceMessages[1].result.tools.length === 0
        && rOnce.stderr.split('\n')[0] === SERVER_KEYLESS_NOTICE && !rOnce.stderr.includes(STUB_NOTICE),
      'T2-5 resolver throws once (the launcher\'s call): keyless runs the real 3.9.106 server, never the stub: it answers keyless with its own notice (0 tools), and a start that is not an MCP host exits 1 with exactly the 3.9.106 "required" text');
      const always = makeHome('t25-always');
      const rAlways = launch(plug, ['mcp'], { home: always, input: MCP_INPUT, extra: { ...nodeOptions(THROW), T2_THROW: 'always' } });
      const pristineAlways = baselinePlug ? launch(baselinePlug, ['mcp'], { home: always, input: MCP_INPUT, extra: { ...nodeOptions(THROW), T2_THROW: 'always' } }) : null;
      result(rAlways.status === 1 && rAlways.stdout === '' && !rAlways.stderr.includes(STUB_NOTICE) && /t2 resolver failure/.test(rAlways.stderr), 'T2-5 resolver always throws: the real server runs and fails as it does today, no stub');
      result(pristineAlways !== null && pristineAlways.status === rAlways.status && pristineAlways.stdout === rAlways.stdout
        && /t2 resolver failure/.test(pristineAlways.stderr), 'T2-5 ...and the baseline (5c657b1c) behaves the same (exit code, empty stdout, same failure)');
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
      // The hooks' seatbelt-mode probe reads state under HOME. The baseline's keyless start (the same stub) wrote nothing there either, so the candidate shifts nothing.
      if (baselinePlug) {
        const oldHome = makeHome('t26-old');
        const oldBefore = snap(oldHome);
        const o = launch(baselinePlug, ['mcp'], { home: oldHome, input: MCP_INPUT });
        result(o.status === 0 && o.stderr.includes(STUB_NOTICE) && snap(oldHome) === oldBefore, 'T2-6 the baseline\'s (5c657b1c) keyless mcp start also served the stub and left HOME untouched, so the candidate shifts nothing the hooks can see', `exit ${o.status}`);
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
      // F1: the stub answers protocolVersion exactly as the pinned server does (dist/cli.js, noteClientCapabilities), asked of the real server with a key.
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
      // A bad frame before any initialize now ends the start (T2-14), so the hostile lines follow the initialize; a valid request before it is still answered.
      const lines = [
        `${rpc(10, 'tools/list')}\n`, // before initialize
        `${INIT(1)}\n`,
        '{not json\n',
        `${JSON.stringify([{ jsonrpc: '2.0', id: 11, method: 'ping' }])}\n`,
        '42\n', 'null\n', '"text"\n', 'true\n',
        `${JSON.stringify({ id: 12, method: 'ping' })}\n`,
        `${JSON.stringify({ jsonrpc: '2.0', id: 13, method: 5 })}\n`,
        `${JSON.stringify({ jsonrpc: '1.0', id: 14, method: 'ping' })}\n`,
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

  // ---- T2-10 never looser than the baseline ----------------------------------------------------------------
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
      result(false, 'T2-10 baseline (5c657b1c) is available for the differential', baselineError || 'no baseline');
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
      result(s.different === 0, `T2-10 ${H.pre}/${H.post}/${H.session}/${H.ctx}${H.extra.length ? `/${H.extra[0]}` : ''}/prepare${CURSOR ? '' : '/session-check'}, state "${stateName}": stdout, stderr and exit code equal the baseline's (5c657b1c)`, `${s.calls} calls: ${s.identical} identical, ${s.masked} equal after masking volatile fields, ${s.different} different`);
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
      result(v.verdict !== 'DIFFERENT' && !c.stderr.includes(STUB_NOTICE) && parseLines(c.stdout).messages.filter((m) => m.id === 1 || m.id === 2).length === 2, `T2-10 keyed mcp (${name}): initialize and tools/list bytes equal the baseline's (5c657b1c)`, v.verdict === 'masked' ? `masked ${v.fields.join(',')}` : v.verdict);
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
    // no verified copy / offline, and a bad manifest: same keys, same permission, same exit code as the baseline (5c657b1c); texts differ by design
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
          result(sameForm, `T2-10 ${caseName}, ${entry}: same JSON keys, permission value and exit code as the baseline (5c657b1c)`, `exit ${fn.status}${fn.permission ? `, ${fn.permission}` : ''}`);
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
    if (!oldDir) { result(false, 'T2-13 the old fri-train tip (be64842b) is available as a file anchor', oldError); return; }
    const files = [];
    for (const plug of ['plugins/marrow', 'plugins/marrow-cursor', 'codex/marrow', 'codex/marrow-advisory']) {
      for (const f of ['package.json', 'package-lock.json', 'scripts/mcp-manifest.json', 'scripts/marrow-launch.cjs', 'hooks/hooks.json', 'LICENSE']) {
        if (fs.existsSync(path.join(oldDir, plug, f))) files.push(path.join(plug, f));
      }
    }
    if (!prepinDir) { result(false, 'T2-13 the pre-pin commit (ccbe0c32) is available for the moved-files comparison', prepinError); return; }
    // The pin commit moved the pin files and nothing else. Against ccbe0c32 exactly the six pin files among those compared moved (both package.json,
    // both package-lock.json, both mcp-manifest.json); no launcher, hooks.json or Codex file moved. Against be64842b (file anchor) those six and the two
    // launchers. Against the baseline 5c657b1c, which already pins 3.9.106, only the two launchers moved: no pin file, hooks.json, Codex file or LICENSE.
    const LAUNCHERS = ['plugins/marrow/scripts/marrow-launch.cjs', 'plugins/marrow-cursor/scripts/marrow-launch.cjs'];
    const pinCompared = PIN_FILES.filter((f) => files.includes(f));
    const movedFrom = (dir) => files.filter((f) => !fs.existsSync(path.join(dir, f)) || !bytes(dir, f).equals(bytes(repo, f)));
    const sameSet = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
    const moved = movedFrom(prepinDir);
    const movedOld = movedFrom(oldDir);
    const movedBase = movedFrom(baselineDir);
    result(pinCompared.length === 6 && sameSet(moved, [...pinCompared, ...LAUNCHERS]) && sameSet(movedOld, [...LAUNCHERS, ...pinCompared]) && sameSet(movedBase, LAUNCHERS),
      'T2-13 against ccbe0c32, of every package.json, package-lock.json, mcp-manifest.json, launcher, hooks.json and Codex file only the six pin files and the two launchers (the fleet-key refusal) moved; against be64842b the same eight; against the baseline 5c657b1c only the two launchers; no hooks.json, Codex file or LICENSE moved', `${files.length} files compared, moved since ccbe0c32: ${moved.length}, since be64842b: ${movedOld.length}, since 5c657b1c: ${movedBase.length}`);
    // The manifest hash moved with the pin, and it is the tree hash of what a clean install of the pinned tarballs holds: recomputed here from the
    // verified install in the plugin copy (every file, sorted, name and bytes with NUL separators), not read from the manifest.
    const manifestOf = (dir, plugin) => JSON.parse(bytes(dir, plugin, 'scripts', 'mcp-manifest.json'));
    const installedFiles = (base, rel = '') => fs.readdirSync(path.join(base, rel), { withFileTypes: true })
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .flatMap((e) => {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (r === '.bin' || r === '.package-lock.json') return [];
        return e.isDirectory() ? installedFiles(base, r) : [r];
      });
    const nodeModules = path.join(plug, 'node_modules');
    const installed = installedFiles(nodeModules);
    const treeHash = crypto.createHash('sha256');
    for (const f of installed) { treeHash.update(f); treeHash.update('\0'); treeHash.update(fs.readFileSync(path.join(nodeModules, f))); treeHash.update('\0'); }
    const manifestNow = manifestOf(repo, 'plugins/marrow');
    const manifestWas = manifestOf(prepinDir, 'plugins/marrow');
    result(manifestNow.sha256 !== manifestWas.sha256 && manifestNow.sha256 === treeHash.digest('hex') && JSON.stringify(manifestNow.files) === JSON.stringify(installed)
      && bytes(repo, 'plugins/marrow/scripts/mcp-manifest.json').equals(bytes(repo, 'plugins/marrow-cursor/scripts/mcp-manifest.json'))
      && manifestNow.mcp.version === PINNED_VERSION && manifestWas.mcp.version === OLD_VERSION,
    'T2-13 the mcp-manifest sha256 moved with the pin: it differs from ccbe0c32, equals the tree hash recomputed from the installed pinned tarballs (same file list), and both plugins carry the same manifest', `${installed.length} files`);
    // The files that differ from the baseline are exactly the expected ones.
    const walk = (dir, rel = '') => fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).flatMap((e) => {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (['.git', 'node_modules'].includes(e.name)) return [];
      return e.isDirectory() ? walk(dir, r) : [r];
    });
    const all = new Set([...walk(oldDir), ...walk(repo)]);
    const differing = [...all].filter((f) => !fs.existsSync(path.join(oldDir, f)) || !fs.existsSync(path.join(repo, f)) || !bytes(oldDir, f).equals(bytes(repo, f))).sort();
    const expected = ['README.md', 'plugins/marrow-cursor/.cursor-plugin/plugin.json', 'plugins/marrow-cursor/scripts/marrow-launch.cjs', 'plugins/marrow-cursor/skills/marrow/SKILL.md',
      'plugins/marrow/.claude-plugin/plugin.json', 'plugins/marrow/scripts/marrow-launch.cjs', 'plugins/marrow/scripts/marrow-session-check.cjs', 'plugins/marrow/skills/marrow/SKILL.md',
      'tools/check.cjs', 'tools/test-launcher-lock.cjs', 'tools/test-launcher-t2.cjs', 'tools/test-launcher.cjs', 'tools/test-session-check.cjs'];
    const differingFrom = (dir) => [...new Set([...walk(dir), ...walk(repo)])].filter((f) => !fs.existsSync(path.join(dir, f)) || !fs.existsSync(path.join(repo, f)) || !bytes(dir, f).equals(bytes(repo, f))).sort();
    const differingPrepin = differingFrom(prepinDir);
    const expectedPrepin = [...new Set([...PIN_FILES, ...TEST_COMMIT_FILES, ...BRANCH_FILES])].sort();
    const expectedOld = [...new Set([...expected, ...PIN_FILES])].sort();
    const list = (got, want) => (got.length === want.length ? `${got.length} files` : '') + (JSON.stringify(got) === JSON.stringify(want) ? '' : ` unexpected: ${got.filter((f) => !want.includes(f)).join(',')} missing: ${want.filter((f) => !got.includes(f)).join(',')}`);
    result(JSON.stringify(differingPrepin) === JSON.stringify(expectedPrepin) && JSON.stringify(differing) === JSON.stringify(expectedOld),
      'T2-13 exactly these files differ: against ccbe0c32 the 15 pin files named in PIN_FILES (both package.json, package-lock.json, mcp-manifest.json, plugin.json, SKILL.md and marketplace.json, both READMEs, tools/mcp-pins/SOURCE.md) and the six BRANCH_FILES, nothing else; against be64842b the same fri-train set as before plus the nine more pin files', `since ccbe0c32: ${list(differingPrepin, expectedPrepin)}; since be64842b: ${list(differing, expectedOld)}`);
    // Against the branch's own base exactly the BRANCH_FILES differ: no pin, manifest, lockfile, hooks.json, Codex file, doc or skill moved.
    if (!noticeBaseDir) { result(false, 'T2-13 the branch base (5c657b1c) is available for the moved-files comparison', noticeBaseError); } else {
      const differingBase = differingFrom(noticeBaseDir);
      const differingBaseline = differingFrom(baselineDir);
      result(JSON.stringify(differingBase) === JSON.stringify([...BRANCH_FILES].sort()) && JSON.stringify(differingBaseline) === JSON.stringify([...BRANCH_FILES].sort()),
        'T2-13 against 5c657b1c (the base of this branch and the baseline) exactly the six BRANCH_FILES differ (both launchers, the session check, tools/check.cjs, this test file, tools/test-session-check.cjs), nothing else',
        `since 5c657b1c: ${list(differingBase, [...BRANCH_FILES].sort())}; since the baseline: ${list(differingBaseline, [...BRANCH_FILES].sort())}`);
    }
    // No new Windows claim in either direction: existing Windows wording is untouched, except the one README line that was
    // replaced by the exact public line (ed81aa6a); the only other new line is the placeholder marker.
    const WINDOWS_WAS = '**Windows:** Marrow\'s hooks do not work on native Windows yet: every action is blocked. Use WSL, or wait for the fix.';
    const WINDOWS_PUBLIC = '**Windows:** Native Windows is not supported yet. Use WSL.';
    const WINDOWS_MARKER = '<!-- WINDOWS-STATUS: set with the MCP 3.9.106 pin commit -->';
    const windowsLines = (dir, file) => fs.readFileSync(path.join(dir, file), 'utf8').split('\n').filter((l) => /windows/i.test(l));
    let windowsOk = true;
    let markers = 0;
    let swaps = 0;
    for (const file of ['README.md', 'plugins/marrow/skills/marrow/SKILL.md', 'plugins/marrow-cursor/skills/marrow/SKILL.md', 'plugins/marrow-cursor/README.md']) {
      const before = windowsLines(oldDir, file);
      const after = windowsLines(repo, file);
      const dropped = before.filter((l) => !after.includes(l));
      const added = after.filter((l) => !before.includes(l));
      const markerLines = added.filter((l) => l.includes(WINDOWS_MARKER));
      const publicLines = added.filter((l) => l === WINDOWS_PUBLIC);
      const readme = file === 'README.md' ? 1 : 0;
      windowsOk = windowsOk && dropped.length === readme && dropped.every((l) => l === WINDOWS_WAS)
        && publicLines.length === readme && markerLines.length === readme && added.length === publicLines.length + markerLines.length;
      markers += markerLines.length;
      swaps += publicLines.length;
    }
    result(windowsOk && markers === 1 && swaps === 1, 'T2-13 Windows wording: the one be64842b README Windows line is replaced by exactly the public line (whole line "**Windows:** Native Windows is not supported yet. Use WSL."), every other existing line kept byte for byte; the only other new Windows line is the WINDOWS-STATUS placeholder comment', `${markers} marker, ${swaps} public line`);
    const depsOf = (dir, plugin) => JSON.parse(bytes(dir, plugin, 'package.json')).dependencies;
    const lockMcp = (dir, plugin) => JSON.parse(bytes(dir, plugin, 'package-lock.json')).packages['node_modules/@getmarrow/mcp'].version;
    const depsNow = depsOf(repo, 'plugins/marrow');
    const depsWas = depsOf(prepinDir, 'plugins/marrow');
    const apartFromMcp = (d) => JSON.stringify(Object.entries(d).filter(([k]) => k !== '@getmarrow/mcp'));
    result(depsNow['@getmarrow/mcp'] === PINNED_VERSION && depsWas['@getmarrow/mcp'] === OLD_VERSION && apartFromMcp(depsNow) === apartFromMcp(depsWas)
      && Object.keys(depsNow).length === Object.keys(depsWas).length && JSON.stringify(depsOf(repo, 'plugins/marrow-cursor')) === JSON.stringify(depsNow)
      && lockMcp(repo, 'plugins/marrow') === PINNED_VERSION && lockMcp(repo, 'plugins/marrow-cursor') === PINNED_VERSION,
    'T2-13 plugin dependencies: only @getmarrow/mcp moved, from 3.9.105 to exactly 3.9.106 (both package.json and both lockfiles), the SDK and every other dependency are unchanged');
    const check = spawnSync(process.execPath, [path.join(repo, 'tools', 'check.cjs')], { cwd: repo, encoding: 'utf8', env: env() });
    const fails = (check.stdout || '').split('\n').filter((l) => l.startsWith('FAIL')).map((l) => l.replace(/:.*/, ''));
    const failsOf = (dir) => (spawnSync(process.execPath, [path.join(dir, 'tools', 'check.cjs')], { cwd: dir, encoding: 'utf8', env: env() }).stdout || '').split('\n').filter((l) => l.startsWith('FAIL')).map((l) => l.replace(/:.*/, ''));
    const baseFails = failsOf(baselineDir);
    const oldFails = failsOf(oldDir);
    result(JSON.stringify(fails) === JSON.stringify(baseFails) && JSON.stringify(fails) === JSON.stringify(oldFails) && /PASS keyless MCP stub/.test(check.stdout || ''), 'T2-13 tools/check.cjs: same checks fail as on the baseline 5c657b1c and on be64842b (those that need the installer\'s pins.js and own-tools files, which are not available here), the new stub check passes', `${(check.stdout.match(/^PASS/gm) || []).length} pass, failing: ${fails.length}`);
    report.check = { fails, baseFails, oldFails };
  }

  // ---- T2-14 the start guard: the stub serves only a real MCP host -------------------------------------
  // The same rows as @getmarrow/mcp 3.9.106 keyless-start (F1). Nothing but a valid initialize REQUEST makes the stub serve: any
  // other first frame, or an end of stdin before one, is the launcher's one refusal text on stderr, nothing on stdout, exit 1.
  async function guardRows() {
    const home = makeHome('t214');
    const MAX = 1024 * 1024;
    const NOTICE_LINE = `${STUB_NOTICE} The plugin hooks still apply.\n`;
    const NOT_INITIALIZED = `${JSON.stringify({ jsonrpc: '2.0', id: 7, error: { code: -32002, message: 'Server not initialized. Send initialize first.' } })}\n`;
    const feed = (input) => new Promise((resolve) => {
      const child = spawn(process.execPath, [path.join(plug, 'scripts', 'marrow-launch.cjs'), 'mcp'], {
        cwd: path.join(home, 'project'), env: envFor(plug, home, {}), stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => child.kill('SIGKILL'), 30000);
      child.stdout.on('data', (c) => { stdout += c; });
      child.stderr.on('data', (c) => { stderr += c; });
      child.stdin.on('error', () => {});
      child.on('close', (status, signal) => {
        clearTimeout(timer);
        captured.push(stdout, stderr);
        resolve({ status, signal, stdout, stderr });
      });
      child.stdin.end(input);
    });
    // One refusal text. It is the 3.9.106 plugin no-key text (PLUGIN_KEY_ERROR) without its "Get a key" line; the 3.9.105 server's own text
    // names an unpinned npx command and `marrow-mcp setup`, which tools/check.cjs keeps out of this launcher. The pinned server with
    // no key still ends the start the same way (exit 1, nothing on stdout): only the stderr wording differs.
    const refusal = 'Error: MARROW_API_KEY required. Marrow plugin: no Marrow key on this machine, so the Marrow MCP server did not start. '
      + 'To connect an account, create an agent key at https://getmarrow.ai, put MARROW_API_KEY in ~/.marrow/env, run chmod 600 ~/.marrow/env, '
      + 'then restart Claude Code or Cursor. The plugin hooks still apply without a key. Do not run marrow-mcp setup or activate for the plugin.\n';
    const server = direct(plug, { home });
    // The refusal text is measured from the pinned tarball: the strings below are in its dist, and its output equals them whole.
    const pinnedDist = (name) => fs.readFileSync(path.join(plug, 'node_modules', '@getmarrow', 'mcp', 'dist', name), 'utf8');
    const textsInPack = pinnedDist('cli.js').includes(`const PLUGIN_KEY_STEPS = '${PLUGIN_KEY_STEPS}';`)
      && pinnedDist('cli.js').includes(`const GET_A_KEY_URL = '${GET_A_KEY_URL}';`)
      && pinnedDist('cli.js').includes('const GET_A_KEY_LINE = `Get a key: ${GET_A_KEY_URL}. Day-one steps and commands: npx @getmarrow/mcp --help`;')
      && pinnedDist('cli.js').includes('const PLUGIN_KEY_ERROR = `Error: MARROW_API_KEY required. ${PLUGIN_KEY_STEPS}`;')
      && pinnedDist('cli.js').includes('return `${fix}\\n${GET_A_KEY_LINE}\\n`;')
      && pinnedDist('env.js').includes(`'${NO_KEY_FIX}'`)
      && pinnedDist('keyless-server.js').includes(`exports.KEYLESS_NOTICE = '${SERVER_KEYLESS_NOTICE}';`);
    result(server.status === 1 && server.stdout === '' && server.stderr === REQUIRED_LINE && textsInPack, 'T2-14 oracle: the pinned server with no key exits 1 with nothing on stdout and exactly the 3.9.106 refusal text, which is in the pinned dist (the exit the stub gives a non-MCP start)', `exit ${server.status}`);
    const launcherSource = fs.readFileSync(path.join(plug, 'scripts', 'marrow-launch.cjs'), 'utf8');
    const launcherCode = launcherSource.replace(/^\s*\/\/.*$/gm, '');
    result((launcherCode.match(/MARROW_API_KEY required/g) || []).length === 1 && !/npx|@latest|--package=/.test(launcherCode), 'T2-14 the launcher holds the refusal head once (two bodies share it: no key, fleet key only) and no npx or unpinned spec');

    const hookPayloads = [
      ['Claude PreToolUse hook payload', JSON.stringify({ session_id: 's', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: '/x' })],
      ['Cursor beforeShellExecution hook payload', JSON.stringify({ conversation_id: 'c', hook_event_name: 'beforeShellExecution', command: 'ls', cwd: '/x', workspace_roots: ['/x'] })],
      ['hook payload that carries a jsonrpc field and no method', JSON.stringify({ jsonrpc: '2.0', hook_event_name: 'PreToolUse', tool_name: 'Bash' })],
    ].map(([name, line]) => [name, `${line}\n`]);
    const refused = [
      ...hookPayloads,
      ['empty stdin', ''],
      ['blank lines only', '\n\n\n'],
      ['whitespace only', ' \t \r\n  \n'],
      ['garbage line, then a valid initialize', `not json\n${INIT(1)}\n`],
      ['hook payload, then a valid initialize', `${hookPayloads[0][1]}${INIT(1)}\n`],
      ['truncated first frame, no newline', INIT(1).slice(0, 40)],
      ['binary bytes', Buffer.from([0xff, 0xfe, 0x00, 0x01, 0x80, 0x0a])],
      ['binary bytes, then a valid initialize', Buffer.concat([Buffer.from([0xff, 0xfe, 0x00, 0x80, 0x0a]), Buffer.from(`${INIT(1)}\n`)])],
      ['NUL padding before a valid initialize', `${'\u0000'.repeat(64)}${INIT(1)}\n`],
      ['UTF-8 BOM before a valid initialize', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(`${INIT(1)}\n`)])],
      ['JSON array (batch) holding an initialize', `[${INIT(1)}]\n`],
      ['JSON scalar', '42\n'],
      ['JSON null', 'null\n'],
      ['jsonrpc 1.0 initialize', `${JSON.stringify({ jsonrpc: '1.0', id: 1, method: 'initialize', params: {} })}\n`],
      ['initialize without jsonrpc', `${JSON.stringify({ id: 1, method: 'initialize', params: {} })}\n`],
      ['method is not a string', `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 5 })}\n`],
      ['no method', `${JSON.stringify({ jsonrpc: '2.0', id: 1 })}\n`],
      ['initialize with an object id', `${JSON.stringify({ jsonrpc: '2.0', id: {}, method: 'initialize', params: {} })}\n`],
      ['initialize with a boolean id', `${JSON.stringify({ jsonrpc: '2.0', id: true, method: 'initialize', params: {} })}\n`],
      ['initialize with an array id', `${JSON.stringify({ jsonrpc: '2.0', id: [1], method: 'initialize', params: {} })}\n`],
      ['initialize notification (no id), then EOF', `${JSON.stringify({ jsonrpc: '2.0', method: 'initialize', params: {} })}\n`],
      ['initialized notification only', `${NOTIFIED}\n`],
      ['oversize first line, then a valid initialize', `${'x'.repeat(MAX + 1)}\n${INIT(1)}\n`],
      ['oversize first line, no newline, then EOF', 'x'.repeat(MAX + 10)],
      ['oversize JSON first line', `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"pad":"${'x'.repeat(MAX)}"}}\n`],
    ];
    const wrong = [];
    for (const [name, input] of refused) {
      const r = await feed(input);
      if (!(r.status === 1 && r.stdout === '' && r.stderr === refusal)) wrong.push(`${name}: exit ${r.status}${r.signal ? ` ${r.signal}` : ''}, stdout ${r.stdout.length}B, stderr ${r.stderr === refusal ? 'is the refusal' : `${r.stderr.length}B`}`);
    }
    result(wrong.length === 0, `T2-14 guard: ${refused.length} starts that are not a valid initialize request (hook payloads, empty stdin, garbage, binary, BOM, NUL, oversize, bad id, wrong jsonrpc, batch, notification) exit 1, nothing on stdout, stderr is the one refusal text`, wrong.join('; '));

    // A valid request other than initialize still gets -32002 and serving goes on, but it is not an initialize: EOF after it is exit 1.
    const early = [
      ['ping before initialize, then EOF', `${rpc(7, 'ping')}\n`],
      ['tools/list before initialize, then EOF', `${rpc(7, 'tools/list')}\n`],
      ['tools/call before initialize, then EOF', `${rpc(7, 'tools/call', { name: 'marrow_agent_runtime', arguments: {} })}\n`],
    ];
    const wrongEarly = [];
    for (const [name, input] of early) {
      const r = await feed(input);
      if (!(r.status === 1 && r.stdout === NOT_INITIALIZED && r.stderr === refusal)) wrongEarly.push(`${name}: exit ${r.status}, stdout ${JSON.stringify(r.stdout.slice(0, 80))}`);
    }
    result(wrongEarly.length === 0, 'T2-14 guard: a request before initialize gets the -32002 line, and EOF after it is exit 1 with the refusal', wrongEarly.join('; '));

    const initResult = (m) => m && m.result && m.result.serverInfo && m.result.serverInfo.name === 'marrow' && JSON.stringify(m.result.capabilities) === '{"tools":{"listChanged":false}}';
    const served = [
      ['valid initialize, then EOF', `${INIT(1)}\n`, 1],
      ['CRLF initialize', `${INIT(1)}\r\n`, 1],
      ['initialize with no trailing newline, then EOF', INIT(1), 1],
      ['blank lines, then initialize', `\n\n  \n${INIT(1)}\n`, 1],
      ['initialize with a string id', `${rpc('abc', 'initialize', { protocolVersion: '2025-06-18', capabilities: {} })}\n`, 1],
      ['initialize with a null id', `${JSON.stringify({ jsonrpc: '2.0', id: null, method: 'initialize', params: {} })}\n`, 1],
      ['initialize with no params', `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' })}\n`, 1],
      ['ping before initialize, then initialize, then EOF', `${rpc(7, 'ping')}\n${INIT(1)}\n`, 2],
      ['initialize, then a hook payload, then EOF', `${INIT(1)}\n${hookPayloads[0][1]}`, 2],
      ['initialize, then garbage, then EOF', `${INIT(1)}\ngarbage\n`, 2],
      ['initialize, then an oversize line, then a ping', `${INIT(1)}\n${'x'.repeat(MAX + 1)}\n${rpc(2, 'ping')}\n`, 3],
      ['initialize, then binary bytes, then a ping', Buffer.concat([Buffer.from(`${INIT(1)}\n`), Buffer.from([0xff, 0xfe, 0x00, 0x0a]), Buffer.from(`${rpc(2, 'ping')}\n`)]), 3],
    ];
    const wrongServed = [];
    for (const [name, input, lines] of served) {
      const r = await feed(input);
      const { messages, bad } = parseLines(r.stdout);
      const init = messages.find((m) => initResult(m));
      if (!(r.status === 0 && bad === 0 && messages.length === lines && init && r.stderr === NOTICE_LINE)) {
        wrongServed.push(`${name}: exit ${r.status}, ${messages.length}/${lines} lines, init ${Boolean(init)}, stderr ${r.stderr === NOTICE_LINE ? 'is the notice' : `${r.stderr.length}B`}`);
      }
    }
    result(wrongServed.length === 0, `T2-14 guard: ${served.length} starts with a valid initialize request (CRLF, no newline, blank lines, any id type, junk after it) are served, the notice is the only stderr, EOF is exit 0`, wrongServed.join('; '));
    {
      const r = await feed(`${INIT(1)}\n${'x'.repeat(MAX + 1)}\n${rpc(2, 'ping')}\n`);
      const { messages } = parseLines(r.stdout);
      result(messages.length === 3 && messages[1].error && messages[1].error.code === -32600 && messages[1].id === null && JSON.stringify(messages[2]) === JSON.stringify({ jsonrpc: '2.0', id: 2, result: {} }),
        'T2-14 guard: after an initialize an oversize line is a -32600 reply and the next line is still served');
    }
    {
      const r = await feed(`${INIT(1)}\n${hookPayloads[0][1]}`);
      const { messages } = parseLines(r.stdout);
      result(messages.length === 2 && messages[1].error && messages[1].error.code === -32600, 'T2-14 guard: after an initialize a hook payload is a -32600 reply, not an exit');
    }
    {
      // The guard must not leak the refusal into a served run, nor the notice into a refused one.
      const ok = await feed(`${INIT(1)}\n`);
      const no = await feed('');
      result(!ok.stderr.includes('is required') && !no.stderr.includes(STUB_NOTICE) && no.stdout === '', 'T2-14 guard: a served run never prints the refusal, a refused run never prints the notice or anything on stdout');
    }
    {
      // Closed stdin from a host that spawns and drops the pipe is the same as an empty stdin.
      const r = launch(plug, ['mcp'], { home, input: '' });
      result(r.status === 1 && r.stdout === '' && r.stderr === refusal, 'T2-14 guard: closed stdin through spawnSync is exit 1 with the refusal');
    }
  }

  async function finish() {
    try {
      integrity();
      await main();
      await guardRows();
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
