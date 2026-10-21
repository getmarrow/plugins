#!/usr/bin/env node
'use strict';
// Starts one pinned @getmarrow/mcp entrypoint for this plugin's hooks, or the MCP server when the
// explicit `mcp` argument is given (no argument at all refuses). It adds no policy: every decision comes from the same entrypoints that
// `npx @getmarrow/install` writes into .claude/settings.json (Claude Code) or .cursor/hooks.json
// (Cursor). The same file ships in the Claude Code plugin and the Cursor plugin; the plugin's own
// manifest folder (.claude-plugin or .cursor-plugin) picks the host.
//
// Only a copy whose files match mcp-manifest.json byte for byte ever runs:
//   1. node_modules in this plugin, which Claude Code installs from package-lock.json (exact
//      versions, sha512 integrity, install scripts off) when it caches the plugin;
//   2. otherwise a private copy in ${CLAUDE_PLUGIN_DATA} (Claude Code) or ~/.marrow/cursor-plugin
//      (Cursor, which has no plugin data folder), installed once with `npm ci` from the same lockfile
//      (install scripts off, outside the project directory) and checked against the manifest.
// Nothing resolves a version at run time and nothing runs from the project's node_modules.
// Only the MCP server (`mcp`), the context hook (UserPromptSubmit) and `prepare` install that private
// copy. Every tool hook, PreToolUse above all, only looks for an already verified copy: an install
// (`npm ci`, up to 120 s, or a wait on another start's lock, up to 150 s) inside a hook that the host
// stops after its timeout would let the tool call run. When no verified copy can be loaded, the
// pre-action hook holds the tool call at once (fail closed) and the other entrypoints exit with a
// non-blocking error.
// With no Marrow key the pinned server would exit at once, and the host would show the plugin as broken. For the
// `mcp` argument only, and only when the pinned server's own key check says there is no key, the launcher answers
// the MCP protocol itself with a server that has no tools (see the keyless stub below). A key anywhere the server reads
// one, or any doubt, runs the pinned server exactly as before.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const VERSION_RE = /^\d+\.\d+\.\d+$/;
const POSIX = process.platform !== 'win32';
const CURSOR = fs.existsSync(path.join(ROOT, '.cursor-plugin', 'plugin.json'));
const CLAUDE = fs.existsSync(path.join(ROOT, '.claude-plugin', 'plugin.json'));
const PRE_ACTION = CURSOR ? 'cursor-pre-action-hook' : 'claude-pre-action-hook';
const MCP_MODE = 'mcp';
const PREPARE = 'prepare';
const CONTEXT_HOOK = CURSOR ? 'cursor-context-hook' : 'claude-context-hook';
// The entrypoints that may install the private copy. Never a tool hook.
const INSTALLERS = new Set([MCP_MODE, PREPARE, CONTEXT_HOOK]);
const ENTRYPOINTS = new Set(CURSOR === CLAUDE ? [] : CURSOR ? [
  MCP_MODE,
  PREPARE,
  'cursor-context-hook',
  'cursor-pre-action-hook',
  'cursor-hook',
  'cursor-session-hook',
] : [
  MCP_MODE,
  PREPARE,
  'claude-context-hook',
  'claude-pre-action-hook',
  'claude-hook',
  'claude-session-hook',
  'claude-permission-request-hook',
]);
const NPM_TIMEOUT_MS = 120000;
const LOCK_WAIT_MS = 150000;
// One npm run (at most NPM_TIMEOUT_MS) plus its checks. Kept below LOCK_WAIT_MS so a start that waits can take over a lock
// that was left behind (its owner was killed) before its own wait runs out.
const LOCK_STALE_MS = NPM_TIMEOUT_MS + 15000;
const NODE_MIN = 18;
const HOST_NAME = CURSOR ? 'Cursor' : 'Claude Code';

const args = process.argv.slice(2);

const REINSTALL = CURSOR
  ? 'ask the owner to reinstall the Marrow plugin in Cursor.'
  : 'ask the owner to reinstall the plugin: '
    + 'claude plugin uninstall marrow@getmarrow, then claude plugin install marrow@getmarrow.';
const FIX_NETWORK = `Reconnect to the network and retry, or ${REINSTALL}`;
const FIX_TOOLCHAIN = `Install Node.js ${NODE_MIN} or newer with npm on PATH, then restart ${HOST_NAME}.`;
const FIX_REINSTALL = `${REINSTALL[0].toUpperCase()}${REINSTALL.slice(1)}`;
const FIX_WAIT = `Wait for the other start to finish, then restart ${HOST_NAME}.`;
const FIX_FOLDER = CURSOR
  ? 'Ask the owner to make the Marrow plugin data folder private to their account, or delete it, then restart Cursor.'
  : FIX_REINSTALL;

// Why no verified copy could be loaded. Every text names the real cause and carries no path, env value or npm output.
const NOT_LOADED = {
  reason: 'could not load a verified copy of the pinned @getmarrow/mcp.',
  fix: FIX_NETWORK,
};
const CAUSES = {
  // A tool hook only looks for a copy; it never installs one.
  idle: {
    reason: 'the pinned @getmarrow/mcp is not installed yet (the plugin installs it when its Marrow server starts or on your first prompt).',
    fix: FIX_NETWORK,
  },
  npm: {
    reason: 'npm was not found or could not be started, and it is needed to install the pinned @getmarrow/mcp once.',
    fix: FIX_TOOLCHAIN,
  },
  timeout: {
    reason: `installing the pinned @getmarrow/mcp with npm took longer than ${NPM_TIMEOUT_MS / 1000} seconds.`,
    fix: FIX_NETWORK,
  },
  network: {
    reason: 'npm could not install the pinned @getmarrow/mcp (usually no network or an unreachable npm registry).',
    fix: FIX_NETWORK,
  },
  mismatch: {
    reason: 'the installed copy of the pinned @getmarrow/mcp does not match its manifest.',
    fix: FIX_REINSTALL,
  },
  lock: {
    reason: `another Marrow start was still installing the pinned @getmarrow/mcp after ${LOCK_WAIT_MS / 1000} seconds.`,
    fix: FIX_WAIT,
  },
  folder: {
    reason: 'the Marrow plugin data folder is missing, not owned by this user or open to other users.',
    fix: FIX_FOLDER,
  },
};

function fail(reason, fix = FIX_NETWORK) {
  if (args[0] === PRE_ACTION && CURSOR) {
    // Cursor: exit 2 blocks, and the hooks that gate are failClosed as the installer writes them.
    const message = `Marrow plugin: ${reason} The action is held until Marrow can start. ${fix}`;
    process.stdout.write(`${JSON.stringify({ permission: 'deny', user_message: message, agent_message: message })}\n`);
    process.stderr.write(`${message}\n`);
    process.exitCode = 2;
    return;
  }
  if (args[0] === PRE_ACTION) {
    process.stdout.write(`${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `Marrow plugin: ${reason} The action is held until Marrow can start. ${fix}`,
      },
    })}\n`);
    process.exitCode = 0;
    return;
  }
  process.stderr.write(`Marrow plugin: ${reason} ${fix}\n`);
  process.exitCode = 1;
}

// `why` is a key of CAUSES; anything else (an unexpected install error) keeps the generic text.
function failFor(why) {
  const cause = Object.prototype.hasOwnProperty.call(CAUSES, why) ? CAUSES[why] : NOT_LOADED;
  return fail(cause.reason, cause.fix);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function loadManifest() {
  try {
    const pin = readJson(path.join(ROOT, 'package.json')).dependencies['@getmarrow/mcp'];
    const manifest = readJson(path.join(__dirname, 'mcp-manifest.json'));
    const ok = VERSION_RE.test(String(pin))
      && manifest.schema === 'marrow-plugin-mcp-manifest.v1'
      && manifest.mcp && manifest.mcp.version === pin
      && /^[0-9a-f]{64}$/.test(String(manifest.sha256))
      && Array.isArray(manifest.files)
      && typeof manifest.bin === 'string'
      && manifest.files.includes(manifest.bin);
    return ok ? manifest : null;
  } catch {
    return null;
  }
}

function owned(stat) {
  return !POSIX || typeof process.getuid !== 'function' || stat.uid === process.getuid();
}

// Package files as sorted relative paths. npm's own lock copy and .bin links are not package files.
// Anything that is not a plain file or directory (links, FIFOs, sockets, devices) and anything
// writable by every user rejects the whole copy.
function listFiles(base, relative) {
  const out = [];
  const entries = fs.readdirSync(path.join(base, relative))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const name of entries) {
    const rel = relative ? `${relative}/${name}` : name;
    if (rel === '.bin' || rel === '.package-lock.json') continue;
    const stat = fs.lstatSync(path.join(base, rel));
    if (POSIX && (stat.mode & 0o002) !== 0) throw new Error('writable');
    if (stat.isDirectory()) out.push(...listFiles(base, rel));
    else if (stat.isFile()) out.push(rel);
    else throw new Error('type');
  }
  return out;
}

// Returns the entry file when `base` (a node_modules directory) matches the manifest exactly.
function verifiedEntry(manifest, base) {
  try {
    const stat = fs.lstatSync(base);
    if (!stat.isDirectory() || !owned(stat) || (POSIX && (stat.mode & 0o002) !== 0)) return null;
    const files = listFiles(base, '');
    if (JSON.stringify(files) !== JSON.stringify(manifest.files)) return null;
    const hash = crypto.createHash('sha256');
    for (const file of files) {
      hash.update(file);
      hash.update('\0');
      hash.update(fs.readFileSync(path.join(base, file)));
      hash.update('\0');
    }
    return hash.digest('hex') === manifest.sha256 ? path.join(base, manifest.bin) : null;
  } catch {
    return null;
  }
}

// A directory this plugin owns: real directory, this user's, closed to group and others.
function privateDir(dir) {
  try {
    const stat = fs.lstatSync(dir);
    return stat.isDirectory() && owned(stat) && (!POSIX || (stat.mode & 0o077) === 0);
  } catch {
    return false;
  }
}

function npmCommand() {
  const bin = path.dirname(process.execPath);
  const candidates = POSIX
    ? [path.join(bin, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'), '/usr/share/nodejs/npm/bin/npm-cli.js']
    : [path.join(bin, 'node_modules', 'npm', 'bin', 'npm-cli.js')];
  for (const cli of candidates) {
    try {
      if (fs.statSync(cli).isFile()) return { file: process.execPath, prefix: [cli] };
    } catch {
      // try the next location
    }
  }
  // POSIX PATH lookup never searches the current directory unless PATH asks for it; no shell.
  return POSIX ? { file: 'npm', prefix: [] } : null;
}

function removeQuietly(target) {
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch {
    // a leftover directory is removed by the next successful install
  }
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Returns '' once the verified copy is in place, otherwise the key of CAUSES that names what went wrong.
function installCopy(data, id, manifest) {
  const npm = npmCommand();
  if (!npm) return 'npm';
  const stage = path.join(data, `${id}.stage-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
  try {
    fs.mkdirSync(stage, { mode: 0o700 });
    for (const file of ['package.json', 'package-lock.json']) {
      fs.copyFileSync(path.join(ROOT, file), path.join(stage, file));
    }
    const { spawnSync } = require('child_process');
    const result = spawnSync(npm.file, [...npm.prefix, 'ci', '--ignore-scripts', '--no-bin-links', '--omit=dev',
      '--no-audit', '--no-fund', '--loglevel=error'], {
      cwd: stage,
      env: { ...process.env, npm_config_ignore_scripts: 'true', npm_config_update_notifier: 'false' },
      stdio: 'ignore',
      timeout: NPM_TIMEOUT_MS,
      windowsHide: true,
    });
    if (result.error) return result.error.code === 'ETIMEDOUT' ? 'timeout' : 'npm';
    if (result.status !== 0) return result.status === null ? 'copy' : 'network'; // no exit status: npm was killed by a signal
    if (!verifiedEntry(manifest, path.join(stage, 'node_modules'))) return 'mismatch';
    const final = path.join(data, id);
    try {
      fs.renameSync(stage, final);
    } catch {
      // Another start (one that took over our lock) put its copy there first: use it only if it passes the same check.
      return privateDir(final) && verifiedEntry(manifest, path.join(final, 'node_modules')) ? '' : 'copy';
    }
    return '';
  } catch {
    return 'copy';
  } finally {
    removeQuietly(stage);
  }
}

// The install lock only serializes installs; the verified-copy check (verifiedEntry) stays the one thing that decides what runs.
// The lock directory holds numbered owner files, owner.1, owner.2, ...: the highest number is the current owner (pid, host name, random
// token). A file is created complete and exclusively (written under a temporary name, then link()ed to its number), so for each
// number exactly one start wins. That is also how a lock is taken over: the winner of owner.<n+1> owns it, with no lock removed or moved,
// so concurrent takeovers end with exactly one owner. A waiting start takes a lock over only when the current owner file is older than
// LOCK_STALE_MS, or is a trustworthy file (plain, this user's, small, valid JSON, same host) whose pid is certainly gone (ESRCH).
// A live pid, EPERM, a missing, garbled, symlinked or foreign owner file all mean "maybe alive": only the age rule applies.
const OWNER_FILE = /^owner\.(\d{1,6})$/;

function ownerGone(owner) {
  if (!owner || owner.host !== os.hostname()) return false;
  try {
    process.kill(owner.pid, 0);
    return false;
  } catch (error) {
    return Boolean(error) && error.code === 'ESRCH';
  }
}

// { gone } when there is no lock; { dir: false, mtime } for anything that is not a plain directory of ours (a symlink is never
// followed); else { dir: true, gen, owner (null when untrustworthy), mtime } for the highest numbered owner file.
function lockState(lock) {
  let stat;
  try {
    stat = fs.lstatSync(lock);
  } catch {
    return { gone: true };
  }
  if (!stat.isDirectory() || !owned(stat)) return { dir: false, mtime: stat.mtimeMs };
  let gen = 0;
  try {
    for (const name of fs.readdirSync(lock)) {
      const match = OWNER_FILE.exec(name);
      if (match && Number(match[1]) > gen) gen = Number(match[1]);
    }
  } catch {
    return { dir: false, mtime: stat.mtimeMs };
  }
  if (gen === 0) return { dir: true, gen, owner: null, mtime: stat.mtimeMs };
  try {
    const file = path.join(lock, `owner.${gen}`);
    const info = fs.lstatSync(file);
    let owner = null;
    if (info.isFile() && owned(info) && info.size <= 512) {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (parsed !== null && typeof parsed === 'object' && Number.isSafeInteger(parsed.pid) && parsed.pid > 0
        && typeof parsed.host === 'string' && typeof parsed.token === 'string') owner = parsed;
    }
    return { dir: true, gen, owner, mtime: info.mtimeMs };
  } catch {
    return { dir: true, gen, owner: null, mtime: stat.mtimeMs };
  }
}

// Creates owner.<gen> for this process. Returns the token when this start won that number, otherwise ''.
function writeOwner(lock, gen) {
  const token = crypto.randomBytes(16).toString('hex');
  const temp = path.join(lock, `owner.tmp-${process.pid}-${token.slice(0, 8)}`);
  try {
    fs.writeFileSync(temp, JSON.stringify({ pid: process.pid, host: os.hostname(), token, created: Date.now() }), { flag: 'wx', mode: 0o600 });
    fs.linkSync(temp, path.join(lock, `owner.${gen}`));
    return token;
  } catch {
    return '';
  } finally {
    try { fs.unlinkSync(temp); } catch { /* already gone */ }
  }
}

// Returns this start's token when it now owns the lock, otherwise ''. 'folder' when the lock cannot be created at all.
function claimLock(data, id, lock) {
  try {
    fs.mkdirSync(lock, { mode: 0o700 });
    return writeOwner(lock, 1) || ''; // '' if a waiting start already took the new, still ownerless lock over
  } catch (error) {
    if (!error || error.code !== 'EEXIST') return 'folder';
  }
  const state = lockState(lock);
  if (state.gone) return '';
  const stale = Date.now() - state.mtime > LOCK_STALE_MS || (state.dir && ownerGone(state.owner));
  if (!stale) return '';
  if (state.dir) return state.gen < 999999 ? writeOwner(lock, state.gen + 1) : '';
  // Not a plain directory of ours (a symlink, a file, someone else's directory), older than the stale age: move only that name aside.
  const aside = path.join(data, `${id}.lock.old-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
  try {
    fs.renameSync(lock, aside);
    removeQuietly(aside);
  } catch {
    // another start was first
  }
  return '';
}

function releaseLock(lock, token) {
  const state = lockState(lock);
  if (state.dir && state.owner && state.owner.token === token) removeQuietly(lock);
}

// Stage directories and moved-aside locks of killed installs, older than the stale age. Run only by the start that holds the lock.
function sweep(data, id) {
  try {
    for (const name of fs.readdirSync(data)) {
      if (!name.startsWith(`${id}.stage-`) && !name.startsWith(`${id}.lock.old-`)) continue;
      const target = path.join(data, name);
      const stat = fs.lstatSync(target);
      if (stat.isDirectory() && owned(stat) && Date.now() - stat.mtimeMs > LOCK_STALE_MS) removeQuietly(target);
    }
  } catch {
    // best effort
  }
}

// One-time install into ${CLAUDE_PLUGIN_DATA}; concurrent starts wait on a lock directory. Claude Code
// deletes this directory when the plugin is uninstalled. Cursor gives plugins no data folder, so the
// Cursor plugin keeps its copy in ~/.marrow/cursor-plugin (removed by hand after an uninstall).
// Without `install`, only an already verified copy is used: nothing is created, installed or waited for.
// Returns { entry } for a verified copy, otherwise { why } (a key of CAUSES).
function dataCopy(manifest, install) {
  const data = CURSOR ? path.join(os.homedir(), '.marrow', 'cursor-plugin') : process.env.CLAUDE_PLUGIN_DATA;
  if (!data || !path.isAbsolute(data)) return { why: install ? 'folder' : 'idle' };
  const id = `mcp-${manifest.mcp.version}-${manifest.sha256.slice(0, 16)}`;
  const dir = path.join(data, id);
  const check = () => (privateDir(dir) ? verifiedEntry(manifest, path.join(dir, 'node_modules')) : null);
  let entry = check();
  if (entry) return { entry };
  if (!install) return { why: 'idle' };
  try {
    fs.mkdirSync(data, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(data);
    if (!stat.isDirectory() || !owned(stat) || (POSIX && (stat.mode & 0o002) !== 0)) return { why: 'folder' };
  } catch {
    return { why: 'folder' };
  }
  const lock = path.join(data, `${id}.lock`);
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (Date.now() < deadline) {
    const token = claimLock(data, id, lock);
    if (token === 'folder') return { why: 'folder' };
    if (!token) {
      sleep(250);
      entry = check();
      if (entry) return { entry };
      continue;
    }
    try {
      entry = check();
      if (entry) return { entry };
      sweep(data, id);
      removeQuietly(dir);
      const why = installCopy(data, id, manifest);
      if (why) return { why };
      entry = check();
      return entry ? { entry } : { why: 'mismatch' };
    } finally {
      releaseLock(lock, token);
    }
  }
  return { why: 'lock' };
}

// ---- keyless MCP stub (begin) ----------------------------------------------------------------------
// Without a key, the pinned server prints "MARROW_API_KEY environment variable is required" and exits 1
// (@getmarrow/mcp 3.9.105 dist/cli.js:575-579), which hosts show as a broken plugin. This stub keeps the host's
// connection healthy with zero tools. It judges nothing and records nothing, and the plugin's hooks are separate
// entrypoints that it never touches.
//
// When it runs: only for the `mcp` argument, only from a verified copy, and only when the pinned server's own
// key test (dist/cli.js:560-579: resolveMarrowEnv() with no options, a base URL it accepts, then an empty apiKey)
// says there is no key.
// The test is asked of the verified copy's own dist/env.js (listed in mcp-manifest.json, so covered by its sha256).
// Loading env.js and calling resolveMarrowEnv() only reads files and the environment: no writes, no network, no child
// process (it requires fs, os and path). Nothing selects the stub: no flag, no env variable, no file. Any doubt (the
// call throws, returns a non-object, or the key is anything but an empty string) runs the pinned server as before.
//
// The stub itself (serveKeyless) requires nothing, starts no child process, opens no network and no file, and writes only to
// stdout and stderr.
const ELICITATION_VERSIONS = ['2025-06-18', '2025-11-25']; // dist/cli.js:599
const DEFAULT_MCP_VERSION = '2024-11-05'; // dist/cli.js:616
const MAX_LINE_BYTES = 1024 * 1024;
const STUB_NOTICE = 'Marrow plugin: no Marrow key on this machine, so the Marrow MCP server started with no tools. The plugin hooks still apply.';
const STUB_INSTRUCTIONS = 'This Marrow server started without a Marrow key on this machine, so it has no tools. '
  + 'It does not judge, check or record any action. '
  + 'The Marrow plugin hooks still apply on this machine, with their free keyless seatbelt. '
  + `To connect a Marrow account, the owner follows the key steps in the Marrow skill in their own terminal, then restarts ${HOST_NAME}. `
  + 'A key can not be added from this chat.';

function keyless(entry) {
  try {
    const envFile = path.join(path.dirname(entry), 'env.js');
    const resolved = require(envFile).resolveMarrowEnv();
    if (resolved === null || typeof resolved !== 'object' || resolved.apiKey !== '') return false;
    // Before it looks at the key the server checks its base URL (dist/cli.js:564-565, validateBaseUrl in dist/index.js): one that is
    // not https or that carries credentials ends the server with a different error, which the owner needs to see. Same test here.
    const base = resolved.baseUrl || 'https://api.getmarrow.ai';
    if (typeof base !== 'string') return false;
    const url = new URL(base);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch {
    return false;
  }
}

// The protocolVersion the pinned server answers (noteClientCapabilities, dist/cli.js:605-617): the requested one only when it is
// in ELICITATION_VERSIONS AND the client's capabilities.elicitation is an object; every other input gets 2024-11-05.
function negotiate(params) {
  const record = params && typeof params === 'object' ? params : {};
  const capabilities = record.capabilities && typeof record.capabilities === 'object' ? record.capabilities : {};
  const requested = typeof record.protocolVersion === 'string' ? record.protocolVersion : '';
  const elicits = Boolean(capabilities.elicitation && typeof capabilities.elicitation === 'object')
    && ELICITATION_VERSIONS.includes(requested);
  return elicits ? requested : DEFAULT_MCP_VERSION;
}

// Newline-delimited JSON-RPC 2.0 on stdio. Exits 0 when stdin ends.
function serveKeyless(serverVersion) {
  const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  const send = (id, body) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, ...body })}\n`);
  const refuse = (id, code, message) => send(id, { error: { code, message } });
  let initialized = false;

  function handle(text) {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return refuse(null, -32700, 'Parse error.');
    }
    if (msg === null || typeof msg !== 'object' || Array.isArray(msg) || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
      return refuse(null, -32600, 'Invalid request.');
    }
    if (!has(msg, 'id')) return undefined; // a notification gets no reply
    const id = msg.id;
    if (!(typeof id === 'string' || id === null || (typeof id === 'number' && Number.isFinite(id)))) {
      return refuse(null, -32600, 'Invalid request.');
    }
    if (msg.method === 'initialize') {
      initialized = true;
      return send(id, {
        result: {
          protocolVersion: negotiate(msg.params),
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'marrow', version: serverVersion },
          instructions: STUB_INSTRUCTIONS,
        },
      });
    }
    if (!initialized) return refuse(id, -32002, 'Server not initialized. Send initialize first.');
    switch (msg.method) {
      case 'ping': return send(id, { result: {} });
      case 'tools/list': return send(id, { result: { tools: [] } });
      case 'prompts/list': return send(id, { result: { prompts: [] } });
      case 'resources/list': return send(id, { result: { resources: [] } });
      case 'resources/templates/list': return send(id, { result: { resourceTemplates: [] } });
      case 'tools/call': return refuse(id, -32602, 'This server has no tools.');
      default: return refuse(id, -32601, 'Method not found.');
    }
  }

  function dispatch(chunks) {
    const text = Buffer.concat(chunks).toString('utf8');
    if (!text.trim()) return;
    try {
      handle(text);
    } catch {
      refuse(null, -32603, 'Internal error.');
    }
  }

  let chunks = [];
  let size = 0;
  let skipping = false; // inside a line over the limit: dropped up to the next newline, never buffered
  process.stdout.on('error', () => process.exit(0));
  process.stdin.on('error', () => { process.exitCode = 1; });
  process.stdin.on('data', (chunk) => {
    let from = 0;
    while (from < chunk.length) {
      const newline = chunk.indexOf(10, from);
      const to = newline === -1 ? chunk.length : newline;
      if (!skipping) {
        size += to - from;
        if (size > MAX_LINE_BYTES) {
          skipping = true;
          chunks = [];
          size = 0;
          refuse(null, -32600, 'Request too large.');
        } else if (to > from) {
          chunks.push(chunk.subarray(from, to));
        }
      }
      if (newline === -1) return;
      if (!skipping) dispatch(chunks);
      chunks = [];
      size = 0;
      skipping = false;
      from = newline + 1;
    }
  });
  process.stdin.on('end', () => {
    if (!skipping) dispatch(chunks);
  });
  try {
    process.stderr.write(`${STUB_NOTICE}\n`);
  } catch {
    // a closed stderr changes nothing
  }
}
// ---- keyless MCP stub (end) -------------------------------------------------------------------------

function main() {
  if (args.length === 0) {
    // A hook whose host dropped its arguments must never fall into MCP-server mode: the server
    // waits on stdin and times out, which fails open. The server is started only by the explicit
    // `mcp` argument in the plugin's MCP config. This path prints one line to stderr, nothing to stdout,
    // and exits 2 without starting anything. What exit 2 does depends on the event: on Claude Code Stop
    // it keeps the agent going (stderr goes to the model); on PreToolUse it blocks the tool call; on
    // UserPromptSubmit it blocks the prompt; on result and session events it blocks nothing. No shipped
    // hook command reaches this path, because each one names its entrypoint inline.
    process.stderr.write('Marrow plugin: no entrypoint given (the MCP server needs the explicit "mcp" argument). Nothing was started.\n');
    process.exitCode = 2;
    return;
  }
  if (args.length > 1 || !ENTRYPOINTS.has(args[0])) {
    process.stderr.write('Marrow plugin: unknown entrypoint.\n');
    process.exitCode = 1;
    return;
  }
  // Checked before anything else is read or started, so a machine with an old Node says so instead of failing in some
  // other way. Not a number (an odd runtime) counts as too old.
  const nodeMajor = Number.parseInt(process.versions.node, 10);
  if (!(nodeMajor >= NODE_MIN)) {
    return fail(`this Node.js is too old (major version ${Number.isFinite(nodeMajor) ? nodeMajor : 'unknown'}); the pinned @getmarrow/mcp needs Node.js ${NODE_MIN} or newer.`, FIX_TOOLCHAIN);
  }
  const manifest = loadManifest();
  if (!manifest) return fail('its pinned @getmarrow/mcp manifest is missing or does not match package.json.');
  const install = INSTALLERS.has(args[0]);
  let entry = verifiedEntry(manifest, path.join(ROOT, 'node_modules'));
  if (!entry) {
    const copy = dataCopy(manifest, install);
    if (!copy.entry) return failFor(copy.why);
    entry = copy.entry;
  }
  // `prepare` only makes sure the verified copy exists.
  if (args[0] === PREPARE) return;
  // No key anywhere the pinned server reads one: answer the MCP protocol with a server that has no tools.
  if (args[0] === MCP_MODE && keyless(entry)) return serveKeyless(manifest.mcp.version);
  process.argv = [process.argv[0], entry, ...(args[0] === MCP_MODE ? [] : args)];
  require(entry);
}

main();
