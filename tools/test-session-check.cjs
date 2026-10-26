'use strict';
// Maintainer test: the SessionStart session check (plugins/marrow/scripts/marrow-session-check.cjs) in a fake HOME per case, with a
// scrubbed environment, no network and no Marrow API. Keys are random dummies made at run time and are only counted in the output,
// never printed.
//
// What it holds:
//   * The keyless line shows ONLY while the pinned hook is in its keyless `seatbelt` mode. Two independent oracles say what that mode is
//     for each state: the pinned resolvers called the way the hook calls them (hook-contract's key lookup, resolveSeatbeltModeOnHost,
//     the rollout switch) and the real hook (marrow-launch.cjs claude-pre-action-hook answering a force-push to main). A state where
//     the line shows and either oracle is not `seatbelt` is a collision; the table at the end counts them (must be 0).
//   * Everywhere else the script prints what the earlier tip (TIP_SHA) printed minus the keyless line, and what the release line
//     (BASE_SHA) printed in the duplicate-setup case.
//   * The script never opens an owner key file that exists (a spy preload records every open and read; a canary shows the spy can see one).
//     It looks at the owner files with lstat first; only when both are absent does the pinned key lookup run, and that finds nothing to open.
//   * Only a copy of the pinned @getmarrow/mcp that matches mcp-manifest.json is ever loaded: a missing, tampered, planted, group- or
//     world-writable copy gives no line and runs nothing; a re-hashed copy whose rollout switch, resolver or key lookup says otherwise
//     gives no line, and an unchanged re-hashed copy does (control).
//   node tools/test-session-check.cjs [--cells]
// The pinned copy is installed with `npm ci --ignore-scripts` from the plugin's own lockfile, using npm_config_cache from the environment
// (a cache seeded with the pinned tarballs keeps it offline), like the launcher tests. The hook and the resolvers see a fake passwd home
// (os.userInfo and os.homedir are replaced by a test-only preload written here): the real home is never read.
require('../test/isolate.cjs'); // private HOME and spawn guard for every child this tool starts (test/child-isolation.cjs)
const { spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const repo = path.resolve(__dirname, '..');
const SCRIPT_REL = 'plugins/marrow/scripts/marrow-session-check.cjs';
const pluginSource = path.join(repo, 'plugins', 'marrow');
const script = path.join(repo, ...SCRIPT_REL.split('/'));
const BASE_SHA = '5537049fccaf5b3bfb2215cf094d431cb5e0d0ed'; // the release line: no keyless line at all
const TIP_SHA = '5c657b1c959846161a21b2c2dff43e86ba52b786'; // the plugins final this branch starts from: the line in every keyless state
// The approved copy (COPY-approved P1), repeated here so a change to the script's text fails this test.
const P1 = 'Marrow seatbelt is on (no key yet): it stops actions like force-push to main, production deploys, package publishes and secret files. For approval prompts instead, add a key: getmarrow.ai/docs#start-here';
const NOTICE = JSON.stringify({ systemMessage: P1 });
const showCells = process.argv.includes('--cells');
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
const posix = process.platform !== 'win32';

function gitShow(sha) {
  const shown = spawnSync('git', ['-C', repo, 'show', `${sha}:${SCRIPT_REL}`], { encoding: 'utf8' });
  if (shown.status !== 0) throw new Error(`cannot read the script from git (${sha})`);
  return shown.stdout;
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-session-check-'));
const restore = [];
let failures = 0;
let runs = 0;
function check(name, fn) {
  try {
    const note = fn();
    process.stdout.write(`PASS ${name}${note ? ` (${note})` : ''}\n`);
  } catch (error) {
    failures += 1;
    process.stdout.write(`FAIL ${name}: ${error.message}\n`);
  }
}

for (const [dir, sha] of [['base', BASE_SHA], ['tip', TIP_SHA]]) {
  fs.mkdirSync(path.join(root, dir));
  fs.writeFileSync(path.join(root, dir, 'marrow-session-check.cjs'), gitShow(sha));
}
const baseScript = path.join(root, 'base', 'marrow-session-check.cjs');
const tipScript = path.join(root, 'tip', 'marrow-session-check.cjs');

// ---- test-only helpers, written here so nothing in the product knows about them ---------------------------------
const preload = path.join(root, 'preload.cjs');
fs.writeFileSync(preload, `'use strict';
// TEST_PASSWD_HOME: the passwd home. os.homedir() answers $HOME when it is set (even empty, as libuv does), else the passwd home.
// TEST_OPEN_LOG: every path opened or read through fs is appended to that file (the spy).
const os = require('node:os');
const fs = require('node:fs');
const fake = process.env.TEST_PASSWD_HOME;
if (fake && fake.startsWith('/')) {
  const real = os.userInfo;
  os.userInfo = function userInfo(options) { return { ...real.call(os, options), homedir: fake }; };
  os.homedir = function homedir() { return process.env.HOME !== undefined ? process.env.HOME : fake; };
}
const log = process.env.TEST_OPEN_LOG;
if (log) {
  const append = fs.appendFileSync.bind(fs);
  const note = (name, target) => { try { append(log, name + ' ' + String(target) + '\\n'); } catch { /* never throws into the program */ } };
  for (const name of ['openSync', 'readFileSync', 'createReadStream', 'open', 'readFile']) {
    const original = fs[name];
    fs[name] = function spied(...args) { note(name, args[0]); return original.apply(this, args); };
  }
  for (const name of ['open', 'readFile']) {
    const original = fs.promises[name];
    fs.promises[name] = function spied(...args) { note('promises.' + name, args[0]); return original.apply(this, args); };
  }
}
// The network guard: no program started by this test can reach a non-loopback host. The pinned hook uses the production API address
// whenever its key comes from an owner file (a MARROW_BASE_URL in the process environment is ignored then), so every connect and lookup
// to anything but loopback fails at once, and is appended to TEST_NET_LOG.
const net = require('node:net');
const dns = require('node:dns');
const netLog = process.env.TEST_NET_LOG;
const loopback = (host) => host === undefined || host === null || host === '' || host === 'localhost' || host === '::1' || host === '[::1]' || /^127\\./.test(String(host));
const blocked = (what, host) => { if (netLog) { try { fs.appendFileSync(netLog, what + ' ' + String(host) + '\\n'); } catch { /* ignore */ } } };
const realConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function guardedConnect(...args) {
  let options = null;
  try { options = net._normalizeArgs(args)[0]; } catch { options = null; }
  if (!options || (options.path === undefined && !loopback(options.host))) {
    blocked('connect', options ? options.host : 'unparsed');
    const socket = this;
    process.nextTick(() => socket.destroy(Object.assign(new Error('blocked by the test network guard'), { code: 'ECONNREFUSED' })));
    return socket;
  }
  return realConnect.apply(this, args);
};
const realLookup = dns.lookup;
dns.lookup = function guardedLookup(host, ...rest) {
  if (!loopback(host)) {
    blocked('lookup', host);
    const done = rest[rest.length - 1];
    if (typeof done === 'function') process.nextTick(() => done(Object.assign(new Error('blocked by the test network guard'), { code: 'ENOTFOUND' })));
    return {};
  }
  return realLookup.call(this, host, ...rest);
};
const realPromiseLookup = dns.promises.lookup;
dns.promises.lookup = async function guardedPromiseLookup(host, ...rest) {
  if (!loopback(host)) {
    blocked('lookup', host);
    throw Object.assign(new Error('blocked by the test network guard'), { code: 'ENOTFOUND' });
  }
  return realPromiseLookup.call(this, host, ...rest);
};
`);
const otherNetLog = path.join(root, 'net-other.log'); // attempts by programs other than the session check (the oracle, the real hook)
const sessionNetLog = path.join(root, 'net-session.log'); // attempts by the session check scripts: must stay empty
const hookNetLog = path.join(root, 'net-hook.log');
const oracleScript = path.join(root, 'oracle.cjs');
fs.writeFileSync(oracleScript, `'use strict';
// The mode the pinned hook is in, computed the way the hook computes it, from the pinned dist of <plugin root>. One JSON line, fixed codes only.
const path = require('path');
const dist = path.join(process.argv[2], 'node_modules', '@getmarrow', 'mcp', 'dist');
try {
  const { resolveMarrowEnv } = require(path.join(dist, 'env.js'));
  const resolved = resolveMarrowEnv({ trustedOnly: true }); // hook-contract resolveNativeHookIdentity; the keyless branch is taken when apiKey is empty
  const res = require(path.join(dist, 'seatbelt-mode.js')).resolveSeatbeltModeOnHost();
  const rollout = require(path.join(dist, 'seatbelt', 'hook.js')).SEATBELT_ROLLOUT.keyless;
  const effective = !resolved.apiKey ? (res.mode === 'seatbelt' && rollout === 'on' ? 'seatbelt' : 'claimed_no_key') : 'account';
  process.stdout.write(JSON.stringify({ effective, reasons: res.reasons }) + '\\n');
} catch (error) {
  process.stdout.write(JSON.stringify({ error: 'oracle threw' }) + '\\n');
}
`);

// ---- plugin copies --------------------------------------------------------------------------------------------
const npmCache = process.env.npm_config_cache || path.join(root, 'npm-cache');
let copies = 0;
function pluginCopy() {
  copies += 1;
  const dir = path.join(root, `plugin-${copies}`);
  fs.cpSync(pluginSource, dir, { recursive: true, filter: (p) => !p.includes(`${path.sep}node_modules`) });
  return dir;
}
function installed() {
  const dir = pluginCopy();
  const env = { npm_config_cache: npmCache, npm_config_update_notifier: 'false', HOME: path.join(root, 'npm-home'), USERPROFILE: path.join(root, 'npm-home') };
  for (const name of ['PATH', 'LANG', 'TMPDIR', 'SystemRoot', 'npm_config_registry']) if (process.env[name]) env[name] = process.env[name];
  fs.mkdirSync(env.HOME, { recursive: true });
  const r = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: dir, env, stdio: 'ignore' });
  if (r.status !== 0) throw new Error('npm ci failed (the pinned @getmarrow/mcp must be installable: seed npm_config_cache or allow the registry)');
  return dir;
}
const plugin = installed();
const scriptIn = (dir) => path.join(dir, 'scripts', 'marrow-session-check.cjs');
const product = scriptIn(plugin); // the script under test, run from a plugin copy that has the pinned package installed beside it
const launcherIn = (dir) => path.join(dir, 'scripts', 'marrow-launch.cjs');
const distIn = (dir) => path.join(dir, 'node_modules', '@getmarrow', 'mcp', 'dist');
const manifestIn = (dir) => path.join(dir, 'scripts', 'mcp-manifest.json');
// The manifest's tree hash, the way the launcher computes it: every package file, sorted, name and bytes with NUL separators.
function treeHash(base, files) {
  const hash = crypto.createHash('sha256');
  for (const file of files) { hash.update(file); hash.update('\0'); hash.update(fs.readFileSync(path.join(base, file))); hash.update('\0'); }
  return hash.digest('hex');
}
// A copy whose package files were changed and whose manifest was re-hashed to match: "verified" under its own manifest, with different behaviour.
function rehashed(edit) {
  const dir = pluginCopy();
  fs.cpSync(path.join(plugin, 'node_modules'), path.join(dir, 'node_modules'), { recursive: true });
  edit(distIn(dir));
  const manifest = JSON.parse(fs.readFileSync(manifestIn(dir), 'utf8'));
  manifest.sha256 = treeHash(path.join(dir, 'node_modules'), manifest.files);
  fs.writeFileSync(manifestIn(dir), `${JSON.stringify(manifest, null, 2)}\n`);
  return dir;
}

// ---- machines and runs ----------------------------------------------------------------------------------------
const dummy = () => crypto.randomBytes(24).toString('hex');
const secrets = new Set();
const secret = () => {
  const value = dummy();
  secrets.add(value);
  return value;
};

let counter = 0;
// One fake machine: its own home (also the passwd home) and project folder, optionally with a duplicate setup (a marrow MCP server in the
// project's .mcp.json, which the check reports).
function machine(dup) {
  counter += 1;
  const dir = path.join(root, `m${counter}`);
  const home = path.join(dir, 'home');
  const project = path.join(dir, 'project');
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.mkdirSync(project, { recursive: true });
  if (dup) fs.writeFileSync(path.join(project, '.mcp.json'), JSON.stringify({ mcpServers: { marrow: { command: 'x' } } }));
  return { dir, home, project, passwd: home, homeEnv: undefined };
}

function envFor(m, extra) {
  const env = {
    PATH: process.env.PATH || '/usr/bin:/bin',
    HOME: m.homeEnv === undefined ? m.home : m.homeEnv,
    CLAUDE_PROJECT_DIR: m.project,
    TEST_PASSWD_HOME: m.passwd,
    TEST_NET_LOG: otherNetLog,
    NODE_OPTIONS: `--require=${preload}`,
  };
  const twice = [];
  for (const [name, value] of Object.entries(extra)) {
    if (name === '__twice') twice.push(...value);
    else env[name] = value;
  }
  for (const name of Object.keys(env)) if (env[name] === null) delete env[name];
  return { env, twice };
}

const ISOLATION_PRELOAD = require('../test/child-isolation.cjs').SELF; // the file the spawn guard looks for after --require on a command line
function spawnIn(m, extra, file, args, input) {
  const { env, twice } = envFor(m, extra);
  runs += 1;
  // HOME empty, relative or the filesystem root is the row's subject: child-isolation.cjs allows it (cwd under the test temp dir) only with this option.
  const oddHome = typeof env.HOME === 'string' && (env.HOME === '' || !path.isAbsolute(env.HOME) || env.HOME === path.parse(env.HOME).root);
  // env(1) starts the node child, for two kinds of row, so that its environment is exactly the row's and nothing the spawn guard adds: `__twice`, the same name
  // set twice on the command line, where the last one wins (a process only ever sees one value); and HOME unset (`-i`, and no HOME among the names), which
  // the guard would fill in for a direct child. The guard cannot add its preload to a node child that env(1) starts, so `--require` is put on the command
  // line here, as the guard does for a direct node child; env(1) itself runs with the empty environment.
  const viaEnv = twice.length > 0 || env.HOME === undefined;
  const r = viaEnv
    ? spawnSync('/usr/bin/env', ['-i', ...Object.entries(env).map(([k, v]) => `${k}=${v}`), ...twice, process.execPath, '--require', ISOLATION_PRELOAD, file, ...args], { env: {}, cwd: m.project, input, encoding: 'utf8', timeout: 9000, killSignal: 'SIGKILL' })
    : spawnSync(process.execPath, [file, ...args], { env, cwd: m.project, input, encoding: 'utf8', timeout: 9000, killSignal: 'SIGKILL', ...(oddHome ? { isolationOddHome: true } : {}) });
  assert.ok(!r.error, `did not finish: ${r.error && r.error.code}`);
  assert.strictEqual(r.signal, null);
  return r;
}

const SESSION_INPUT = (source) => JSON.stringify({ hook_event_name: 'SessionStart', source, session_id: 'test-session' });
// A run of a session-check script. spyLog: the file the open/read spy writes to (the product script only).
function run(file, m, extra, source, spyLog) {
  const withSpy = { ...extra, TEST_NET_LOG: sessionNetLog, ...(spyLog ? { TEST_OPEN_LOG: spyLog } : {}) };
  const r = spawnIn(m, withSpy, file, [], SESSION_INPUT(source));
  assert.strictEqual(r.status, 0, 'exit status');
  assert.strictEqual(r.stderr, '', 'stderr is empty');
  return r.stdout;
}

const count = (text, value) => text.split(value).length - 1;
const label = (out) => (out === '' ? 'empty' : out === NOTICE ? 'notice' : out.includes('is also set up outside') ? 'dup-message' : 'other');

// The mode of the pinned resolvers, and what the real hook does with a force-push to main (the S1 stop text names the mode it is in).
function oracleOf(m, extra, dir = plugin) {
  const r = spawnIn(m, extra, oracleScript, [dir], '');
  return JSON.parse(r.stdout);
}
function hookClassOf(m, extra, dir = plugin) {
  const event = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git push --force origin main' }, session_id: 's-test', cwd: m.project });
  const r = spawnIn(m, { ...extra, MARROW_BASE_URL: 'https://127.0.0.1:9', CLAUDE_PLUGIN_ROOT: dir, TEST_NET_LOG: hookNetLog }, launcherIn(dir), ['claude-pre-action-hook'], event);
  const text = r.stdout + r.stderr;
  if (text.includes('For approval prompts instead of stops, add a Marrow key')) return 'seatbelt';
  if (text.includes('stricter no-key mode here') || text.includes('linked to an account but has no working key')) return 'claimed_no_key';
  if (text.includes('loop guard state is unsafe')) return 'held_loop_guard';
  return 'other';
}

// ---- the network guard works (canary against a reserved name that never resolves, and the loopback discard port) ----
check('network guard canary: a connect or lookup to a non-loopback name is refused and logged, loopback is left alone', () => {
  const probe = path.join(root, 'net-canary.cjs');
  fs.writeFileSync(probe, [
    "const out = [];",
    "fetch('https://guard-canary.invalid/').then(() => out.push('fetch reached'), (e) => out.push('fetch ' + String((e.cause && e.cause.code) || e.code)))",
    "  .then(() => new Promise((resolve) => require('node:dns').lookup('guard-canary.invalid', (e) => { out.push('lookup ' + (e ? e.code : 'ok')); resolve(); })))",
    "  .then(() => new Promise((resolve) => require('node:net').connect({ host: '127.0.0.1', port: 9 }).on('error', (e) => { out.push('loopback ' + e.code); resolve(); })))",
    "  .then(() => process.stdout.write(out.join('|')));",
  ].join('\n'));
  const canaryLog = path.join(root, 'net-canary.log');
  const r = spawnIn(machine(false), { TEST_NET_LOG: canaryLog }, probe, [], '');
  assert.strictEqual(r.stdout, 'fetch ECONNREFUSED|lookup ENOTFOUND|loopback ECONNREFUSED', 'what the probe saw');
  const logged = fs.readFileSync(canaryLog, 'utf8').trim().split('\n').sort();
  assert.deepStrictEqual(logged, ['connect guard-canary.invalid', 'lookup guard-canary.invalid'], 'what the guard logged');
});

// ---- machine states -------------------------------------------------------------------------------------------
// notice: the keyless line is expected (while no duplicate is found). Every other state prints no line. The ids follow the review's S/K numbers
// where it had one; the rest are the same families (strict spellings, homes, modes, owner files, fleet keys, look-alike names).
const NOTICE_STATES = new Set(['S01', 'S02', 'S03', 'S11e', 'S12b', 'S12c', 'S12d', 'S12e', 'S12f', 'S12g', 'S14b', 'S14c', 'S17', 'S17b', 'K18',
  'K05', 'K05b', 'K08', 'K08b', 'K08c', 'K09', 'K09b', 'K10', 'K11', 'K13', 'K13b', 'K13c']);
// The duplicate message is the whole output in these states whatever else is true (hooks that carry a Marrow entry sit in the Claude settings).
const DUP_STATES = new Set(['S11b', 'S11c']);

function states() {
  const marrowDir = (home, mode = 0o700) => {
    const dir = path.join(home, '.marrow');
    fs.mkdirSync(dir, { mode, recursive: true });
    fs.chmodSync(dir, mode);
    return dir;
  };
  const keyFile = (home, name, mode = 0o600) => {
    const file = path.join(marrowDir(home), name);
    fs.writeFileSync(file, `MARROW_API_KEY=${secret()}\n`, { mode });
    fs.chmodSync(file, mode);
    return file;
  };
  const touch = (file, text = '{}') => {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, text, { mode: 0o600 });
  };
  const claimedHooks = (file) => touch(file, JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'node marrow-mcp.js cursor-pre-action-hook --claimed' }] }] } }));
  const list = [];
  const add = (id, name, setup) => list.push({ id, name, setup });
  add('S01', 'clean home, no ~/.marrow', () => ({}));
  add('S02', '~/.marrow exists (empty, 700)', (m) => { marrowDir(m.home); return {}; });
  add('S03', 'project .env, .env.local and .marrow/env hold a key (repo files are not read)', (m) => {
    for (const file of ['.env', '.env.local', path.join('.marrow', 'env')]) touch(path.join(m.project, file), `MARROW_API_KEY=${secret()}\n`);
    return {};
  });
  add('S08', '~/.marrow/claimed', (m) => { touch(path.join(marrowDir(m.home), 'claimed')); return {}; });
  add('S09', '~/.marrow/device/binding.json', (m) => { marrowDir(m.home); touch(path.join(m.home, '.marrow', 'device', 'binding.json')); return {}; });
  add('S10', '~/.marrow/host-approvals/state.json', (m) => { marrowDir(m.home); touch(path.join(m.home, '.marrow', 'host-approvals', 'state.json')); return {}; });
  add('S11', "another host's hooks.json carries --claimed (~/.cursor/hooks.json)", (m) => { claimedHooks(path.join(m.home, '.cursor', 'hooks.json')); return {}; });
  add('S11b', '~/.claude/settings.json carries --claimed', (m) => { claimedHooks(path.join(m.home, '.claude', 'settings.json')); return {}; });
  add('S11c', '$CLAUDE_CONFIG_DIR/settings.json carries --claimed', (m) => {
    const dir = path.join(m.dir, 'cc');
    claimedHooks(path.join(dir, 'settings.json'));
    return { CLAUDE_CONFIG_DIR: dir };
  });
  add('S11d', '$CODEX_HOME/hooks.json carries --claimed', (m) => {
    const dir = path.join(m.dir, 'cx');
    claimedHooks(path.join(dir, 'hooks.json'));
    return { CODEX_HOME: dir };
  });
  add('S11e', '~/.marrow/spool holds an entry', (m) => { marrowDir(m.home); touch(path.join(m.home, '.marrow', 'spool', 'e.json')); return {}; });
  add('S11f', '~/.marrow/runner-holds/.salt', (m) => { marrowDir(m.home); touch(path.join(m.home, '.marrow', 'runner-holds', '.salt'), 'x'); return {}; });
  add('S12', 'MARROW_SEATBELT_STRICT=1', () => ({ MARROW_SEATBELT_STRICT: '1' }));
  add('S12b', 'MARROW_SEATBELT_STRICT=0', () => ({ MARROW_SEATBELT_STRICT: '0' }));
  add('S12c', 'MARROW_SEATBELT_STRICT empty', () => ({ MARROW_SEATBELT_STRICT: '' }));
  add('S12d', 'MARROW_SEATBELT_STRICT=false', () => ({ MARROW_SEATBELT_STRICT: 'false' }));
  add('S12e', 'MARROW_SEATBELT_STRICT=yes (unknown value)', () => ({ MARROW_SEATBELT_STRICT: 'yes' }));
  add('S12f', 'MARROW_SEATBELT_STRICT=" 1" (space)', () => ({ MARROW_SEATBELT_STRICT: ' 1' }));
  add('S12g', 'MARROW_SEATBELT_STRICT set twice, 1 then 0 (env(1): last wins)', () => ({ __twice: ['MARROW_SEATBELT_STRICT=1', 'MARROW_SEATBELT_STRICT=0'] }));
  add('S12h', 'MARROW_SEATBELT_STRICT set twice, 0 then 1 (env(1): last wins)', () => ({ __twice: ['MARROW_SEATBELT_STRICT=0', 'MARROW_SEATBELT_STRICT=1'] }));
  add('S13', 'key in the passwd home ~/.marrow/env, $HOME is another clean folder', (m) => {
    const other = path.join(m.dir, 'otherhome');
    fs.mkdirSync(other, { mode: 0o700 });
    keyFile(m.home, 'env');
    m.homeEnv = other;
    return {};
  });
  add('S14', '$HOME differs from the passwd home (both clean)', (m) => {
    const other = path.join(m.dir, 'otherhome');
    fs.mkdirSync(other, { mode: 0o700 });
    m.homeEnv = other;
    return {};
  });
  add('S14b', '$HOME is a symlink to the passwd home', (m) => {
    const link = path.join(m.dir, 'homelink');
    fs.symlinkSync(m.home, link);
    m.homeEnv = link;
    return {};
  });
  add('S14c', '$HOME has a trailing slash', (m) => { m.homeEnv = `${m.home}/`; return {}; });
  add('S15', 'HOME does not exist', (m) => { m.homeEnv = path.join(m.dir, 'no-such-home'); return {}; });
  add('S16', 'HOME is relative', (m) => { m.homeEnv = 'relative/home'; return {}; });
  add('S17', 'HOME empty, USERPROFILE = the home', (m) => { m.homeEnv = ''; return { USERPROFILE: m.home }; });
  add('S17b', 'HOME unset (the passwd home answers)', (m) => { m.homeEnv = null; return {}; });
  add('S23', 'HOME=/ (the passwd home is the clean folder)', (m) => { m.homeEnv = '/'; return {}; });
  add('S23b', 'the passwd home is /', (m) => { m.passwd = '/'; return {}; });
  add('S23c', 'the passwd home is a missing folder', (m) => { m.passwd = path.join(m.dir, 'gone'); return {}; });
  add('S18', '~/.marrow mode 777', (m) => { marrowDir(m.home, 0o777); return {}; });
  add('S18b', '~/.marrow mode 775', (m) => { marrowDir(m.home, 0o775); return {}; });
  add('S18c', '~/.marrow mode 770', (m) => { marrowDir(m.home, 0o770); return {}; });
  add('S18d', 'the home folder itself mode 777', (m) => { fs.chmodSync(m.home, 0o777); return {}; });
  add('S18e', '~/.claude mode 777', (m) => { fs.mkdirSync(path.join(m.home, '.claude'), { mode: 0o700 }); fs.chmodSync(path.join(m.home, '.claude'), 0o777); return {}; });
  add('S19', '~/.marrow a symlink to an empty folder', (m) => {
    const target = path.join(m.dir, 'elsewhere');
    fs.mkdirSync(target, { mode: 0o700 });
    fs.symlinkSync(target, path.join(m.home, '.marrow'));
    return {};
  });
  add('S19b', '~/.marrow a regular file', (m) => { fs.writeFileSync(path.join(m.home, '.marrow'), 'x'); return {}; });
  add('K01', '~/.marrow/env with a key, mode 600', (m) => { keyFile(m.home, 'env'); return {}; });
  add('K02', '~/.marrow/env.local with a key, mode 600', (m) => { keyFile(m.home, 'env.local'); return {}; });
  add('K16', '~/.marrow/env with a key, mode 644', (m) => { keyFile(m.home, 'env', 0o644); return {}; });
  add('K16b', '~/.marrow/env with a key, mode 666', (m) => { keyFile(m.home, 'env', 0o666); return {}; });
  add('K17', '~/.marrow/env a symlink to a file with a key', (m) => {
    const target = path.join(m.dir, 'real-env');
    fs.writeFileSync(target, `MARROW_API_KEY=${secret()}\n`, { mode: 0o600 });
    fs.symlinkSync(target, path.join(marrowDir(m.home), 'env'));
    return {};
  });
  add('K17b', '~/.marrow/env a dangling symlink', (m) => { fs.symlinkSync(path.join(m.dir, 'nowhere'), path.join(marrowDir(m.home), 'env')); return {}; });
  add('K18', 'a key only in the repo .env', (m) => { touch(path.join(m.project, '.env'), `MARROW_API_KEY=${secret()}\n`); return {}; });
  add('K19', '~/.marrow/env empty file', (m) => { touch(path.join(marrowDir(m.home), 'env'), ''); return {}; });
  add('K19b', '~/.marrow/env a directory', (m) => { fs.mkdirSync(path.join(marrowDir(m.home), 'env')); return {}; });
  add('K19c', '~/.marrow/env without a key line', (m) => { touch(path.join(marrowDir(m.home), 'env'), 'FOO=bar\n'); return {}; });
  if (posix) {
    add('K28', '~/.marrow/env a FIFO', (m) => {
      const made = spawnSync('mkfifo', [path.join(marrowDir(m.home), 'env')]);
      assert.strictEqual(made.status, 0, 'mkfifo');
      return {};
    });
  }
  if (posix && !isRoot) {
    add('K29', '~/.marrow/env mode 000', (m) => { restore.push(keyFile(m.home, 'env', 0o000)); return {}; });
    add('S20', 'HOME unreadable (mode 000)', (m) => { restore.push(m.home); marrowDir(m.home); fs.chmodSync(m.home, 0o000); return {}; });
  }
  add('K03', 'MARROW_API_KEY set', () => ({ MARROW_API_KEY: secret() }));
  add('K04', 'MARROW_KEY set', () => ({ MARROW_KEY: secret() }));
  add('K05', 'MARROW_API_KEY set but empty', () => ({ MARROW_API_KEY: '' }));
  add('K05b', 'MARROW_KEY set but empty', () => ({ MARROW_KEY: '' }));
  add('K06', 'MARROW_API_KEY whitespace', () => ({ MARROW_API_KEY: ' \t ' }));
  add('K07', 'plugin option variable set', () => ({ CLAUDE_PLUGIN_OPTION_API_KEY: secret() }));
  add('K07b', 'plugin option variable empty', () => ({ CLAUDE_PLUGIN_OPTION_API_KEY: '' }));
  add('K08', 'fleet key only: MARROW_KEY_PROD set', () => ({ MARROW_KEY_PROD: secret() }));
  add('K08b', 'fleet key only: MARROW_KEY_TEST set', () => ({ MARROW_KEY_TEST: secret() }));
  add('K08c', 'fleet key only: MARROW_KEY_A set', () => ({ MARROW_KEY_A: secret() }));
  add('K09', 'fleet key empty: MARROW_KEY_PROD=""', () => ({ MARROW_KEY_PROD: '' }));
  add('K09b', 'fleet key whitespace: MARROW_KEY_PROD=" "', () => ({ MARROW_KEY_PROD: ' ' }));
  add('K10', 'fleet key + agent identity, no direct key', () => ({ MARROW_KEY_PROD: secret(), MARROW_AGENT_ID: 'prod' }));
  add('K11', 'fleet key + MARROW_FLEET_AGENT_ID, no direct key', () => ({ MARROW_KEY_PROD: secret(), MARROW_FLEET_AGENT_ID: 'prod' }));
  add('K12', 'fleet key + MARROW_API_KEY', () => ({ MARROW_KEY_PROD: secret(), MARROW_API_KEY: secret() }));
  add('K12b', 'fleet key + MARROW_API_KEY + identity', () => ({ MARROW_KEY_PROD: secret(), MARROW_API_KEY: secret(), MARROW_AGENT_ID: 'prod' }));
  add('K13', 'unknown MARROW_ name set (MARROW_UNKNOWN_THING)', () => ({ MARROW_UNKNOWN_THING: secret() }));
  add('K13b', 'look-alike names: MARROW_KEYS, MARROW_KEY_ (empty suffix)', () => ({ MARROW_KEYS: secret(), MARROW_KEY_: secret() }));
  add('K13c', 'MARROW_BASE_URL http (not https)', () => ({ MARROW_BASE_URL: 'http://127.0.0.1:9' }));
  add('K14', 'fleet key + owner env file key', (m) => { keyFile(m.home, 'env'); return { MARROW_KEY_PROD: secret() }; });
  return list;
}

const collision = [];
const OWNER_FILE = /\/\.marrow\/env(\.local)?$/;
const spyLog = path.join(root, 'open-spy.log');
// The owner key file paths that were opened or read. Opening a path that is not there is what the pinned key lookup does after the script's lstat
// check found both owner files absent, so it reads nothing; an owner path that EXISTS (any kind: file, folder, symlink, FIFO) must never be opened.
const openedOwnerFile = () => {
  let text = '';
  try { text = fs.readFileSync(spyLog, 'utf8'); } catch { text = ''; }
  fs.rmSync(spyLog, { force: true });
  const exists = (file) => { try { fs.lstatSync(file); return true; } catch { return false; } };
  return text.split('\n').map((line) => line.slice(line.indexOf(' ') + 1)).filter((file) => OWNER_FILE.test(file) && exists(file));
};

for (const state of states()) {
  check(`state ${state.id}: ${state.name}`, () => {
    const wantNotice = NOTICE_STATES.has(state.id);
    const wantDup = DUP_STATES.has(state.id);
    const cells = [];
    for (const dup of [false, true]) {
      for (const source of ['startup', 'resume']) {
        const m = machine(dup);
        const extra = state.setup(m);
        fs.rmSync(spyLog, { force: true });
        const mine = run(product, m, extra, source, spyLog);
        assert.deepStrictEqual(openedOwnerFile(), [], 'the script opened or read an owner key file');
        const tip = run(tipScript, m, extra, source);
        const base = run(baseScript, m, extra, source);
        if (dup || wantDup) {
          assert.strictEqual(label(mine), 'dup-message', `the duplicate message (got ${label(mine)})`);
          assert.ok(!mine.includes('seatbelt is on'), 'no keyless line next to the duplicate message');
          assert.strictEqual(mine, tip, 'equal to the tip');
          assert.strictEqual(mine, base, 'equal to the release line');
        } else if (wantNotice) {
          assert.strictEqual(mine, NOTICE, `exactly the keyless line (got ${label(mine)})`);
          assert.strictEqual(tip, NOTICE, 'the tip printed it too');
          assert.strictEqual(base, '', 'the release line prints nothing here');
        } else {
          assert.strictEqual(mine, '', `no line (got ${label(mine)})`);
          assert.ok(tip === '' || tip === NOTICE, `the tip printed ${label(tip)}`);
          assert.strictEqual(base, '', 'the release line prints nothing here');
        }
        for (const value of secrets) assert.strictEqual(count(mine, value) + count(tip, value) + count(base, value), 0, 'a dummy key reached the output');
        cells.push(`${dup ? 'dup' : 'nodup'} ${source}: ${label(mine)}/tip ${label(tip)}`);
        if (showCells) process.stdout.write(`CELL ${state.id} | dup=${dup ? 'yes' : 'no'} | ${source} | mine=${label(mine)} tip=${label(tip)} base=${label(base)}\n`);
      }
    }
    // The two oracles, on a machine of their own (the real hook writes its own state into its home).
    const mo = machine(false);
    const eo = state.setup(mo);
        const shown = (wantNotice && !wantDup);
    const oracle = oracleOf(mo, eo);
    const mh = machine(false);
    const eh = state.setup(mh);
    const hook = hookClassOf(mh, eh);
    for (const value of secrets) assert.strictEqual(count(JSON.stringify(oracle), value), 0, 'the oracle printed a dummy key');
    // The collision rule: a line only where BOTH oracles say the hook is in its keyless seatbelt mode.
    if (shown) {
      assert.strictEqual(oracle.effective, 'seatbelt', `line shown but the pinned resolvers say ${oracle.effective}`);
      assert.strictEqual(hook, 'seatbelt', `line shown but the real hook answers ${hook}`);
    }
    // The two oracles agree with each other: the real hook is in `seatbelt` exactly when the resolvers say so.
    assert.strictEqual(hook === 'seatbelt', oracle.effective === 'seatbelt', `oracles disagree: resolvers ${oracle.effective}, real hook ${hook}`);
    collision.push({ id: state.id, name: state.name, line: wantDup ? 'dup-message' : wantNotice ? 'keyless line' : 'none', mode: oracle.effective, hook });
    return `4 cells, line ${wantNotice ? 'yes' : 'no'}, hook mode ${oracle.effective}`;
  });
}

check('notice collision table: for every state the line vs the hook\'s mode (mismatches must be 0)', () => {
  const wrong = collision.filter((row) => row.line === 'keyless line' && row.mode !== 'seatbelt');
  const omitted = collision.filter((row) => row.line === 'none' && row.mode === 'seatbelt').map((row) => row.id);
  if (showCells) for (const row of collision) process.stdout.write(`TABLE ${row.id} | ${row.name} | line=${row.line} | resolvers=${row.mode} | real hook=${row.hook}\n`);
  assert.strictEqual(wrong.length, 0, `${wrong.length} states show the line while the hook is not in seatbelt mode: ${wrong.map((row) => row.id).join(',')}`);
  // A state where the hook is in seatbelt mode and the script stays silent is allowed (fail closed), but only the ones named here.
  assert.deepStrictEqual(omitted, ['K07', 'K07b'], 'silent while the hook is in seatbelt mode');
  assert.ok(collision.some((row) => row.line === 'keyless line') && collision.some((row) => row.mode === 'claimed_no_key') && collision.some((row) => row.mode === 'account'), 'the table covers all three modes');
  // Two states with different hook modes never get the same line: the line implies seatbelt.
  const byLine = new Set(collision.filter((row) => row.line === 'keyless line').map((row) => row.mode));
  assert.deepStrictEqual([...byLine], ['seatbelt']);
  return `${collision.length} states, 0 mismatches, silent-though-seatbelt: ${omitted.join(',')}`;
});

check('the spy can see an owner key file open (canary): the pinned key lookup opens it, the script never does', () => {
  const m = machine(false);
  fs.mkdirSync(path.join(m.home, '.marrow'), { mode: 0o700 });
  fs.writeFileSync(path.join(m.home, '.marrow', 'env'), `MARROW_API_KEY=${secret()}\n`, { mode: 0o600 });
  fs.rmSync(spyLog, { force: true });
  spawnIn(m, { TEST_OPEN_LOG: spyLog }, oracleScript, [plugin], '');
  assert.ok(openedOwnerFile().length > 0, 'the spy saw no owner file open by the pinned key lookup');
  run(product, m, {}, 'startup', spyLog);
  assert.deepStrictEqual(openedOwnerFile(), [], 'the script opened an owner key file');
});

check('two machines that differ only in the key value print the same', () => {
  for (const dup of [false, true]) {
    for (const how of ['env var', 'owner file']) {
      const outputs = [secret(), secret()].map((value) => {
        const m = machine(dup);
        if (how === 'env var') return run(product, m, { MARROW_API_KEY: value }, 'startup');
        fs.mkdirSync(path.join(m.home, '.marrow'), { mode: 0o700 });
        fs.writeFileSync(path.join(m.home, '.marrow', 'env'), `MARROW_API_KEY=${value}\n`, { mode: 0o600 });
        return run(product, m, {}, 'startup');
      });
      assert.strictEqual(outputs[0], outputs[1], `${how}, dup=${dup}`);
    }
  }
});

check('the home folder decides: another HOME is judged on its own files (and the passwd home is checked too)', () => {
  const withKey = machine(false);
  fs.mkdirSync(path.join(withKey.home, '.marrow'), { mode: 0o700 });
  fs.writeFileSync(path.join(withKey.home, '.marrow', 'env'), `MARROW_API_KEY=${secret()}\n`, { mode: 0o600 });
  const clean = machine(false);
  assert.strictEqual(run(product, withKey, {}, 'startup'), '', 'home with a key file');
  assert.strictEqual(run(product, clean, {}, 'startup'), NOTICE, 'a clean home');
  assert.strictEqual(run(product, clean, { HOME: withKey.home }, 'startup'), '', 'HOME names the home with the key file');
  // The key file sits in the passwd home only: the hook's mode lookup finds it, so the line is not shown.
  const passwdOnly = machine(false);
  passwdOnly.passwd = withKey.home;
  assert.strictEqual(run(product, passwdOnly, {}, 'startup'), '', 'the passwd home holds the key file');
});

// ---- the verified copy ----------------------------------------------------------------------------------------
const cleanMachine = () => ({ m: machine(false), extra: {} });
function lineWith(dir, extraEnv = {}) {
  const { m, extra } = cleanMachine();
  return run(scriptIn(dir), m, { ...extra, ...extraEnv }, 'startup');
}

check('verified copy: control: the installed copy shows the line, an unchanged re-hashed copy shows it too', () => {
  assert.strictEqual(lineWith(plugin), NOTICE, 'installed copy');
  assert.strictEqual(lineWith(rehashed(() => {})), NOTICE, 're-hashed copy, nothing changed');
});

check('verified copy: no copy installed (no node_modules, no data folder): no line, nothing loaded', () => {
  const dir = pluginCopy();
  assert.strictEqual(lineWith(dir), '');
  assert.strictEqual(lineWith(dir, { CLAUDE_PLUGIN_DATA: path.join(root, 'no-data-folder') }), '');
  assert.strictEqual(lineWith(dir, { CLAUDE_PLUGIN_DATA: 'relative/data' }), '');
});

function tampered(name, edit, extra = {}) {
  check(`verified copy: ${name}: no line, and the planted code never runs`, () => {
    const marker = path.join(root, `marker-${copies + 1}`);
    const dir = pluginCopy();
    fs.cpSync(path.join(plugin, 'node_modules'), path.join(dir, 'node_modules'), { recursive: true });
    edit(dir, marker);
    assert.strictEqual(lineWith(dir, extra), '');
    assert.ok(!fs.existsSync(marker), 'the planted code ran');
  });
}
const plant = (marker) => `\nrequire('fs').writeFileSync(${JSON.stringify(marker)}, 'loaded');\n`;
tampered('env.js has a planted line', (dir, marker) => fs.appendFileSync(path.join(distIn(dir), 'env.js'), plant(marker)));
tampered('seatbelt-mode.js has a planted line', (dir, marker) => fs.appendFileSync(path.join(distIn(dir), 'seatbelt-mode.js'), plant(marker)));
tampered('seatbelt/hook.js has a planted line', (dir, marker) => fs.appendFileSync(path.join(distIn(dir), 'seatbelt', 'hook.js'), plant(marker)));
tampered('an extra file in the package', (dir, marker) => fs.writeFileSync(path.join(distIn(dir), 'extra.js'), plant(marker)));
tampered('a package file is missing', (dir) => fs.rmSync(path.join(distIn(dir), 'seatbelt', 'mapper.js')));
tampered('a package file is a symlink', (dir, marker) => {
  const target = path.join(root, `planted-${copies}.js`);
  fs.writeFileSync(target, plant(marker));
  fs.rmSync(path.join(distIn(dir), 'env.js'));
  fs.symlinkSync(target, path.join(distIn(dir), 'env.js'));
});
if (posix) {
  tampered('a package file is world-writable', (dir) => fs.chmodSync(path.join(distIn(dir), 'env.js'), 0o666));
  tampered('node_modules is world-writable', (dir) => fs.chmodSync(path.join(dir, 'node_modules'), 0o777));
}
tampered('the manifest hash is wrong', (dir) => {
  const manifest = JSON.parse(fs.readFileSync(manifestIn(dir), 'utf8'));
  manifest.sha256 = `${manifest.sha256.slice(0, 63)}${manifest.sha256.endsWith('0') ? '1' : '0'}`;
  fs.writeFileSync(manifestIn(dir), JSON.stringify(manifest));
});
tampered('the manifest is not valid JSON', (dir) => fs.writeFileSync(manifestIn(dir), '{'));
tampered('package.json pins another version than the manifest', (dir) => {
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  pkg.dependencies['@getmarrow/mcp'] = '3.9.105';
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg));
});

check('verified copy: the private copy in CLAUDE_PLUGIN_DATA is found the way the launcher finds it', () => {
  const manifest = JSON.parse(fs.readFileSync(manifestIn(plugin), 'utf8'));
  const id = `mcp-${manifest.mcp.version}-${manifest.sha256.slice(0, 16)}`;
  const make = (mode, edit) => {
    const dir = pluginCopy(); // a plugin with no node_modules of its own
    const data = path.join(root, `data-${copies}`);
    fs.mkdirSync(path.join(data, id), { recursive: true, mode: 0o700 });
    fs.cpSync(path.join(plugin, 'node_modules'), path.join(data, id, 'node_modules'), { recursive: true });
    fs.chmodSync(path.join(data, id), mode);
    if (edit) edit(path.join(data, id));
    return { dir, data };
  };
  const good = make(0o700);
  assert.strictEqual(lineWith(good.dir, { CLAUDE_PLUGIN_DATA: good.data }), NOTICE, 'a verified private copy');
  const open = make(0o755);
  assert.strictEqual(lineWith(open.dir, { CLAUDE_PLUGIN_DATA: open.data }), '', 'a copy folder open to group and others');
  const marker = path.join(root, 'data-marker');
  const bad = make(0o700, (d) => fs.appendFileSync(path.join(d, 'node_modules', '@getmarrow', 'mcp', 'dist', 'env.js'), plant(marker)));
  assert.strictEqual(lineWith(bad.dir, { CLAUDE_PLUGIN_DATA: bad.data }), '', 'a tampered private copy');
  assert.ok(!fs.existsSync(marker), 'the planted code ran');
});

// A re-hashed copy is "verified" under its own manifest, so only the pinned code's answers differ: every guard must hold on its own.
const REWRITES = [
  ['the rollout switch is off', 'seatbelt/hook.js', (t) => t.replace("keyless: 'on'", "keyless: 'off'")],
  ['the mode resolver says claimed_no_key', 'seatbelt-mode.js', (t) => `${t}\nconst realOnHost = exports.resolveSeatbeltModeOnHost;\nexports.resolveSeatbeltModeOnHost = (o) => ({ ...realOnHost(o), mode: 'claimed_no_key' });\n`],
  ['the mode resolver says account', 'seatbelt-mode.js', (t) => `${t}\nconst realOnHost = exports.resolveSeatbeltModeOnHost;\nexports.resolveSeatbeltModeOnHost = (o) => ({ ...realOnHost(o), mode: 'account' });\n`],
  ['the mode resolver throws', 'seatbelt-mode.js', (t) => `${t}\nexports.resolveSeatbeltModeOnHost = () => { throw new Error('t'); };\n`],
  ['the mode resolver returns null', 'seatbelt-mode.js', (t) => `${t}\nexports.resolveSeatbeltModeOnHost = () => null;\n`],
  ['the key lookup finds a key', 'env.js', (t) => `${t}\nconst realResolve = exports.resolveMarrowEnv;\nexports.resolveMarrowEnv = (o) => ({ ...realResolve(o), apiKey: 'x' });\n`],
  ['the key lookup throws', 'env.js', (t) => `${t}\nexports.resolveMarrowEnv = () => { throw new Error('t'); };\n`],
  ['the key lookup returns null', 'env.js', (t) => `${t}\nexports.resolveMarrowEnv = () => null;\n`],
  ['the key lookup is gone', 'env.js', (t) => `${t}\ndelete exports.resolveMarrowEnv;\n`],
  ['the rollout table is gone', 'seatbelt/hook.js', (t) => `${t}\ndelete exports.SEATBELT_ROLLOUT;\n`],
  ['the rollout value is not the string on', 'seatbelt/hook.js', (t) => t.replace("keyless: 'on'", 'keyless: true')],
];
for (const [name, file, change] of REWRITES) {
  check(`verified copy, re-hashed: ${name}: no line`, () => {
    const dir = rehashed((dist) => {
      const target = path.join(dist, ...file.split('/'));
      const before = fs.readFileSync(target, 'utf8');
      const after = change(before);
      assert.notStrictEqual(after, before, 'the rewrite changed nothing (the test is stale)');
      fs.writeFileSync(target, after);
    });
    assert.strictEqual(lineWith(dir), '');
  });
}

// ---- the script's own text ------------------------------------------------------------------------------------
check('the notice is the approved copy: one plain ASCII line, no placeholders, once in the script', () => {
  const text = fs.readFileSync(script, 'utf8');
  assert.strictEqual(count(text, P1), 1);
  assert.ok(/^[\t -~]+$/.test(P1) && !/[<>{}]/.test(P1));
  assert.ok(!/[^\t\n -~]/.test(text), 'the script is plain ASCII');
  for (const word of ['risk', 'score', 'classifier']) assert.ok(!P1.toLowerCase().includes(word), word);
});

const strip = (text) => text.replace(/^\s*\/\/.*$/gm, '');
const between = (text, from, to) => {
  const a = text.indexOf(from);
  const b = text.indexOf(to);
  assert.ok(a >= 0 && b > a, `markers ${from} ... ${to}`);
  return text.slice(a, b);
};

check('the owner-file code only calls lstat: no owner file is opened, read, hashed or printed', () => {
  const text = fs.readFileSync(script, 'utf8');
  const block = strip(between(text, '// ---- owner files, lstat only (begin)', '// ---- owner files, lstat only (end)'));
  assert.ok(block.includes('lstatSync'));
  const calls = [...block.matchAll(/\bfs\.(\w+)/g)].map((match) => match[1]);
  assert.deepStrictEqual([...new Set(calls)], ['lstatSync']);
  for (const word of ['openSync', 'readFileSync', 'readSync', 'createReadStream', 'readdirSync', 'readlink', 'realpath', 'crypto', 'console', 'stdout', 'stderr', 'require']) {
    assert.ok(!block.includes(word), `the owner-file code uses ${word}`);
  }
  assert.ok(block.includes('os.userInfo().homedir'), 'the passwd home is checked too');
});

check('the pinned-mode code reads only the plugin\'s own package files, loads only through path.join(dist, ...), and writes nothing', () => {
  const text = fs.readFileSync(script, 'utf8');
  const block = strip(between(text, "// ---- the hook's mode, asked of the verified pinned copy (begin)", "// ---- the hook's mode, asked of the verified pinned copy (end)"));
  const reads = [...block.matchAll(/fs\.readFileSync\(([^)]*\)\)?)/g)].map((match) => match[1]);
  assert.deepStrictEqual(reads.filter((r) => !r.startsWith('path.join(base, file)')), [], `readFileSync of something else: ${reads.join(' | ')}`);
  const calls = [...new Set([...block.matchAll(/\bfs\.(\w+)/g)].map((match) => match[1]))].sort();
  assert.deepStrictEqual(calls, ['lstatSync', 'readFileSync', 'readdirSync']);
  const requires = [...block.matchAll(/\brequire\(([^)]*\)?)\)/g)].map((match) => match[1]);
  assert.strictEqual(requires.length, 3, `three loads: ${requires.join(' | ')}`);
  for (const arg of requires) assert.ok(/^path\.join\(dist, /.test(arg), `require of ${arg}`);
  for (const word of ['writeFile', 'appendFile', 'writeSync', 'mkdir', 'rename', 'unlink', 'rmSync', 'spawn', 'exec', 'child_process', 'fetch', 'http', 'console', 'stdout', 'stderr']) {
    assert.ok(!block.includes(word), `the pinned-mode code uses ${word}`);
  }
  // The calls are the hook's: the key lookup with trustedOnly, the mode resolver with its defaults, the rollout switch; and every other answer is false.
  for (const piece of ["resolveMarrowEnv({ trustedOnly: true })", 'resolved.apiKey !== \'\'', 'resolveSeatbeltModeOnHost()', "resolution.mode !== 'seatbelt'", "SEATBELT_ROLLOUT.keyless === 'on'"]) {
    assert.ok(block.includes(piece), `missing ${piece}`);
  }
  assert.ok(/catch \{\s*return false;\s*\}\s*\}\s*\n?$/.test(block.trimEnd()) || /function hookModeIsSeatbelt\(\) \{\s*try \{[\s\S]*\} catch \{\s*return false;/.test(block), 'a throw is false');
});

check('the only write is the fixed notice, and only after the lstat check and the pinned-mode check', () => {
  const text = fs.readFileSync(script, 'utf8');
  const tail = text.slice(text.indexOf('} else if (noKeyIsSet()'));
  assert.ok(/^\} else if \(noKeyIsSet\(\) && hookModeIsSeatbelt\(\)\) \{\n  process\.stdout\.write\(JSON\.stringify\(\{ systemMessage: KEYLESS_NOTICE \}\)\);\n\}\n$/.test(tail), 'the only write is the fixed notice');
  assert.strictEqual(count(text, 'KEYLESS_NOTICE'), 2, 'defined once, written once');
  // A system message only: nothing for the model (no additionalContext) is added by the keyless path.
  assert.ok(!tail.includes('additionalContext'), 'the keyless path adds no model context');
});

check('the plugin declares no option that could carry a key, and the hook keeps its 5 s timeout', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(repo, 'plugins', 'marrow', '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.strictEqual(manifest.userConfig, undefined);
  const hooks = JSON.parse(fs.readFileSync(path.join(repo, 'plugins', 'marrow', 'hooks', 'hooks.json'), 'utf8'));
  const entry = hooks.hooks.SessionStart;
  assert.strictEqual(entry.length, 1);
  assert.strictEqual(entry[0].matcher, 'startup|resume');
  assert.strictEqual(entry[0].hooks[0].timeout, 5);
});

check('session start time: the new script is within noise of the tip (median of 15 runs, one clean state)', () => {
  const time = (file) => {
    const samples = [];
    for (let i = 0; i < 15; i += 1) {
      const m = machine(false);
      const started = process.hrtime.bigint();
      run(file, m, {}, 'startup');
      samples.push(Number(process.hrtime.bigint() - started) / 1e6);
    }
    samples.sort((a, b) => a - b);
    return samples[7];
  };
  const tip = time(tipScript);
  const mine = time(product);
  // The hook budget is 5000 ms; the added work is one hash of the pinned package files and two module loads. Allow generous load noise.
  assert.ok(mine < tip + 400, `median ${mine.toFixed(0)} ms against the tip's ${tip.toFixed(0)} ms`);
  return `median ${mine.toFixed(0)} ms, tip ${tip.toFixed(0)} ms`;
});

check('no session check script (this one, the tip, the release line) tried to reach a non-loopback host in any run; the real hook\'s blocked attempts are counted', () => {
  assert.ok(!fs.existsSync(sessionNetLog) || fs.readFileSync(sessionNetLog, 'utf8') === '', 'a session check script opened a connection or lookup');
  const attempts = fs.existsSync(hookNetLog) ? fs.readFileSync(hookNetLog, 'utf8').split('\n').filter(Boolean).length : 0;
  return `${attempts} blocked attempts by the real hook in key states`;
});

for (const item of restore) {
  try {
    fs.chmodSync(item, 0o700);
  } catch {
    // The folder or file is already gone.
  }
}
fs.rmSync(root, { recursive: true, force: true });
process.stdout.write(failures ? `${failures} FAILED (${runs} script runs)\n` : `ALL PASS (${runs} script runs)\n`);
process.exitCode = failures ? 1 : 0;
