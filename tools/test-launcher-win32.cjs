'use strict';
// Windows rows of the launcher tests (WIN26 CUR). On Linux and macOS the launcher runs with process.platform forced to win32 by a
// --require preload (the same way the 21 Oct diagnosis emulated Windows), over a fake node layout that has npm-cli.js beside node like
// a Windows install. On a real Windows machine nothing is forced and the same rows run on the real platform.
//   node tools/test-launcher-win32.cjs
// Environment rules: every child env is built from a short allowlist plus the row's own values; no key is ever used (keyless only);
// npm installs run in the private, offline npm environment of test/npm-env.cjs (a seeded COPY of the cache named by npm_config_cache in the runner; it must
// hold the pinned tarballs) and every node child runs under the loopback network guard of test/net-guard.cjs.
// Rows: no .cmd/shell spawn, LF bytes, install through node + npm-cli.js, bounded retry of a transient EPERM/EBUSY directory rename,
// no retry when the copy is already there, npm missing / tampered copy / no copy all DENY, keyless stub answers with zero tools.
require('../test/isolate.cjs'); // private HOME and spawn guard for every child this tool starts (test/child-isolation.cjs)
const npmEnvironment = require('../test/npm-env.cjs'); // private npm environment + loopback network guard for every child
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const repo = path.resolve(__dirname, '..');
const source = path.join(repo, 'plugins', 'marrow-cursor');
const REAL_WIN = process.platform === 'win32';
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-launcher-win32-'));
const NPM = npmEnvironment.create({ root: work });
let pass = 0;
let fail = 0;
function result(ok, name, detail = '') {
  if (ok) pass += 1; else fail += 1;
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}\n`);
}

// ---- preload: platform shim, rename faults, spawn spy --------------------------------------------------
const PRELOAD = path.join(work, 'win32-preload.cjs');
fs.writeFileSync(PRELOAD, `'use strict';
const fs = require('fs');
const cp = require('child_process');
const log = (line) => { try { fs.appendFileSync(process.env.W32_LOG, line + '\\n'); } catch {} };
if (process.env.W32_SHIM === '1') {
  Object.defineProperty(process, 'platform', { value: 'win32' });
  if (process.env.W32_EXEC) Object.defineProperty(process, 'execPath', { value: process.env.W32_EXEC });
}
// W32_RENAME = "<n>:<CODE>[:keep]": the first n renames of a *.stage-* directory fail with CODE (n = 99: all of them). "keep" first copies
// the staged tree to the target, as another start that won the race would have.
if (process.env.W32_RENAME) {
  const [n, code, keep] = process.env.W32_RENAME.split(':');
  const original = fs.renameSync;
  let seen = 0;
  fs.renameSync = function renameSync(from, to) {
    if (!String(from).includes('.stage-')) return original.apply(this, arguments);
    seen += 1;
    log('rename ' + seen);
    if (seen > Number(n)) return original.apply(this, arguments);
    if (keep === 'keep') fs.cpSync(from, to, { recursive: true });
    const error = new Error(code + ': simulated');
    error.code = code;
    throw error;
  };
}
const removal = fs.rmSync;
fs.rmSync = function rmSync(target, options) {
  log('rm retries=' + (options && options.maxRetries));
  return removal.apply(this, arguments);
};
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  const original = cp[name];
  cp[name] = function spied(...args) {
    const options = args.find((a) => a && typeof a === 'object' && !Array.isArray(a)) || {};
    const list = Array.isArray(args[1]) ? args[1] : [];
    log('spawn ' + name + ' self=' + (args[0] === process.execPath) + ' arg0=' + String(list[0]).split(/[\\\\/]/).pop() + ' shell=' + Boolean(options.shell));
    return original.apply(this, args);
  };
}
`);

// ---- fake Windows-style node layout (Linux/macOS only) ------------------------------------------------
let fake = null; // { exec } when the layout could be built
if (!REAL_WIN) {
  const real = fs.realpathSync(process.execPath);
  const bin = path.dirname(real);
  const npmDir = [path.join(bin, '..', 'lib', 'node_modules', 'npm'), '/usr/share/nodejs/npm'].find((d) => fs.existsSync(path.join(d, 'bin', 'npm-cli.js')));
  if (npmDir) {
    const dir = path.join(work, 'fakenode');
    fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true });
    fs.symlinkSync(real, path.join(dir, 'node'));
    fs.symlinkSync(fs.realpathSync(npmDir), path.join(dir, 'node_modules', 'npm'));
    fake = { exec: path.join(dir, 'node') };
  }
}

let copies = 0;
function setup() {
  copies += 1;
  const plugin = path.join(work, `plugin-${copies}`);
  fs.cpSync(source, plugin, { recursive: true, filter: (p) => !p.includes(`${path.sep}node_modules`) });
  const home = path.join(work, `home-${copies}`);
  const project = path.join(home, 'project');
  fs.mkdirSync(project, { recursive: true });
  return { plugin, home, project, log: path.join(work, `log-${copies}.txt`), data: path.join(home, '.marrow', 'cursor-plugin') };
}

function run(ctx, args, { shim = !REAL_WIN, layout = true, rename = '', input = '' } = {}) {
  const env = NPM.env({ HOME: ctx.home, USERPROFILE: ctx.home });
  for (const key of ['PATH', 'Path', 'SystemRoot', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP', 'TMPDIR', 'LANG']) {
    if (process.env[key] && !(key in env)) env[key] = process.env[key];
  }
  Object.assign(env, {
    CURSOR_PLUGIN_ROOT: ctx.plugin, W32_LOG: ctx.log,
    W32_SHIM: shim ? '1' : '0', W32_RENAME: rename,
  });
  if (shim && layout && fake) env.W32_EXEC = fake.exec;
  fs.writeFileSync(ctx.log, '', { flag: 'a' });
  const started = Date.now();
  const r = spawnSync(process.execPath, ['--require', PRELOAD, path.join(ctx.plugin, 'scripts', 'marrow-launch.cjs'), ...args], {
    cwd: ctx.project, input, encoding: 'utf8', env, timeout: 240000,
  });
  const lines = fs.readFileSync(ctx.log, 'utf8').split('\n').filter(Boolean);
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', ms: Date.now() - started, lines };
}

const HOOK_EVENT = (project) => JSON.stringify({
  hook_event_name: 'beforeShellExecution', conversation_id: 'w32', generation_id: 'g', command: 'git status', cwd: project, workspace_roots: [project],
});
const parse = (s) => { try { return JSON.parse(String(s).trim().split('\n').pop()); } catch { return null; } };
const hasCopy = (ctx) => { try { return fs.readdirSync(ctx.data).some((n) => /^mcp-\d+\.\d+\.\d+-[0-9a-f]{16}$/.test(n)); } catch { return false; } };
const launcherHeld = (r) => { const j = parse(r.stdout); return !!j && j.permission === 'deny' && String(j.user_message).startsWith('Marrow plugin:'); };
const ranMcp = (r) => { const j = parse(r.stdout); return !!j && ['allow', 'deny', 'ask'].includes(j.permission) && !launcherHeld(r); };

const launcher = fs.readFileSync(path.join(source, 'scripts', 'marrow-launch.cjs'), 'utf8');

// W32-1/2: static properties of the launcher that matter on Windows
result(!/shell\s*:\s*true/.test(launcher) && !/\.cmd\b/.test(launcher) && (launcher.match(/require\('child_process'\)/g) || []).length === 1
  && /const \{ spawnSync \} = require\('child_process'\);/.test(launcher),
  'W32-1 the launcher never spawns through a shell and never names a .cmd file (npm.cmd would fail with EINVAL on current Node without a shell)');
result((launcher.match(/spawnSync\(/g) || []).length === 1 && /spawnSync\(npm\.file, \[\.\.\.npm\.prefix,/.test(launcher),
  'W32-2 the only process it starts is node running npm-cli.js (npm.file = process.execPath on win32)');
result(fs.readFileSync(path.join(repo, 'plugins', 'marrow', 'scripts', 'marrow-launch.cjs'), 'utf8') === launcher
  && ['hooks/hooks.json', 'mcp.json', 'scripts/mcp-manifest.json', 'package.json', 'package-lock.json'].every((f) => !fs.readFileSync(path.join(source, f), 'utf8').includes('\r'))
  && !launcher.includes('\r') && launcher.charCodeAt(0) !== 0xFEFF,
  'W32-3 the Claude and Cursor launchers are identical and the checked-out launcher, hooks, MCP config, manifest and lockfile have LF endings and no BOM');
{
  const attr = path.join(repo, '.gitattributes');
  let eol = null;
  const g = spawnSync('git', ['-C', repo, 'ls-files', '--eol'], { encoding: 'utf8' });
  if (g.status === 0) eol = g.stdout.split('\n').filter(Boolean).filter((l) => !/^i\/(lf|-text|none)\s/.test(l.trim())).length;
  result(fs.existsSync(attr) && /^\* text=auto eol=lf$/m.test(fs.readFileSync(attr, 'utf8')) && (eol === null || eol === 0),
    'W32-4 .gitattributes keeps every tracked file LF on a Windows checkout (autocrlf cannot rewrite pinned files)', eol === null ? 'git not available: attribute line only' : `${eol} tracked files not LF in the index`);
}

// W32-5..: the install path, over the emulated (or real) platform
if (!REAL_WIN && !fake) {
  result(true, 'W32-5.. skipped: no npm-cli.js found beside this node, so no Windows-style layout can be built');
} else {
  const a = setup();
  const prep = run(a, ['prepare']);
  const spawns = prep.lines.filter((l) => l.startsWith('spawn '));
  result(prep.status === 0 && hasCopy(a) && prep.stdout === '', 'W32-5 prepare installs the verified copy through node + npm-cli.js and exits 0', `exit ${prep.status}, ${prep.ms} ms`);
  result(spawns.length === 1 && /self=true arg0=npm-cli\.js shell=false/.test(spawns[0]), 'W32-6 that install is exactly one spawn: process.execPath running npm-cli.js, shell false', spawns.join(' | '));
  const removals = prep.lines.filter((l) => l.startsWith('rm '));
  result(removals.length > 0 && removals.every((l) => l === 'rm retries=4'), 'W32-5b on win32 the launcher removes its stage folder with bounded retries (maxRetries 4)', removals.join(' | '));
  const hook = run(a, ['cursor-pre-action-hook'], { input: HOOK_EVENT(a.project) });
  result(ranMcp(hook), 'W32-7 the pre-action hook then loads the verified copy and the pinned hook answers (a decision from the package, not the launcher)', `exit ${hook.status}`);

  // tampered copy: one byte appended to a package file -> the hook holds the call, exit 2, deny JSON
  const dir = fs.readdirSync(a.data).find((n) => n.startsWith('mcp-'));
  const victim = path.join(a.data, dir, 'node_modules', '@getmarrow', 'mcp', 'dist', 'cli.js');
  fs.appendFileSync(victim, '\n');
  const tampered = run(a, ['cursor-pre-action-hook'], { input: HOOK_EVENT(a.project) });
  result(tampered.status === 2 && launcherHeld(tampered), 'W32-8 a tampered copy is never run: the pre-action hook denies with exit 2');

  // no copy at all (a tool hook never installs): immediate deny, exit 2
  const b = setup();
  const idle = run(b, ['cursor-pre-action-hook'], { input: HOOK_EVENT(b.project) });
  result(idle.status === 2 && launcherHeld(idle) && idle.ms < 15000 && !hasCopy(b) && !idle.lines.some((l) => l.startsWith('spawn ')),
    'W32-9 with no verified copy the pre-action hook denies at once (exit 2) and starts no process', `${idle.ms} ms`);

  // keyless stub over the emulated platform
  const c = setup();
  run(c, ['prepare']);
  const frames = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'w32', version: '1' } } },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'marrow_agent_runtime', arguments: { decision: 'allow' } } },
  ].map((f) => JSON.stringify(f)).join('\n');
  const mcp = run(c, ['mcp'], { input: `${frames}\n` });
  const out = mcp.stdout.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } });
  const [init, list, call] = out;
  result(mcp.status === 0 && out.length === 3 && init && init.result && init.result.serverInfo.name === 'marrow' && list && Array.isArray(list.result.tools) && list.result.tools.length === 0
    && call && call.error && !/allow|approved/i.test(JSON.stringify(call)), 'W32-10 keyless `mcp` start answers initialize, lists zero tools, refuses a call (no decision words) and exits 0', `exit ${mcp.status}`);

  // transient EPERM on the directory rename: retried, install completes
  const d = setup();
  const transient = run(d, ['prepare'], { rename: '2:EPERM' });
  result(transient.status === 0 && hasCopy(d) && transient.lines.filter((l) => l.startsWith('rename ')).length === 3,
    'W32-11 a transient EPERM on the stage rename is retried (2 failures, 3rd rename succeeds): install completes, exit 0', `${transient.lines.filter((l) => l.startsWith('rename ')).length} renames`);

  // EBUSY too; a hard failure stays a failure and the pre-action hook keeps denying afterwards
  const e = setup();
  const busy = run(e, ['prepare'], { rename: '1:EBUSY' });
  result(busy.status === 0 && hasCopy(e), 'W32-12 a transient EBUSY is retried the same way', `exit ${busy.status}`);
  const f = setup();
  const stuck = run(f, ['prepare'], { rename: '99:EPERM' });
  const stuckHook = run(f, ['cursor-pre-action-hook'], { input: HOOK_EVENT(f.project) });
  const attempts = stuck.lines.filter((l) => l.startsWith('rename ')).length;
  result(stuck.status === 1 && !hasCopy(f) && attempts === 7 && stuck.ms < 30000 && /^Marrow plugin: /.test(stuck.stderr) && stuckHook.status === 2 && launcherHeld(stuckHook),
    'W32-13 a rename that never succeeds stops after 7 attempts, prepare exits 1 with the plugin text, no copy is left, and the hook still denies', `${attempts} attempts, exit ${stuck.status}`);
  const g = setup();
  const other = run(g, ['prepare'], { rename: '99:EIO' });
  result(other.status === 1 && other.lines.filter((l) => l.startsWith('rename ')).length === 1 && !hasCopy(g), 'W32-14 any other rename error is not retried (1 attempt) and fails closed', `exit ${other.status}`);
  const h = setup();
  const raced = run(h, ['prepare'], { rename: '99:EPERM:keep' });
  const racedHook = run(h, ['cursor-pre-action-hook'], { input: HOOK_EVENT(h.project) });
  result(raced.status === 0 && raced.lines.filter((l) => l.startsWith('rename ')).length === 1 && hasCopy(h) && ranMcp(racedHook),
    'W32-15 when the target copy is already there (another start won), EPERM is not retried and that copy is used only because it verifies', `${raced.lines.filter((l) => l.startsWith('rename ')).length} attempt`);

  if (!REAL_WIN) {
    const j = setup();
    const posix = run(j, ['prepare'], { shim: false });
    const posixRemovals = posix.lines.filter((l) => l.startsWith('rm '));
    const k = setup();
    const posixRename = run(k, ['prepare'], { shim: false, rename: '99:EPERM' });
    result(posixRename.status === 1 && posixRename.lines.filter((l) => l.startsWith('rename ')).length === 1 && !hasCopy(k),
      'W32-18 on POSIX a failing rename is never retried (1 attempt), prepare exits 1 (macOS/Linux behaviour unchanged)', `${posixRename.lines.filter((l) => l.startsWith('rename ')).length} attempt`);
    result(posix.status === 0 && posixRemovals.length > 0 && posixRemovals.every((l) => l === 'rm retries=undefined'), 'W32-17 on POSIX the same removal has no retry option (macOS/Linux behaviour unchanged)', posixRemovals.join(' | '));
  }

  // npm not beside node: the honest cause, exit 1 / deny, no process started (emulated layout only; a real Windows node has npm beside it)
  if (!REAL_WIN) {
    const i = setup();
    const noNpm = run(i, ['mcp'], { layout: false });
    const noNpmHook = run(i, ['cursor-pre-action-hook'], { layout: false, input: HOOK_EVENT(i.project) });
    result(noNpm.status === 1 && noNpm.stdout === '' && /npm was not found/.test(noNpm.stderr) && !noNpm.lines.some((l) => l.startsWith('spawn ')) && noNpmHook.status === 2 && launcherHeld(noNpmHook),
      'W32-16 on win32 with npm-cli.js not beside node the launcher starts nothing (never a PATH or cwd lookup of npm): `mcp` exits 1 with the npm cause, the hook denies', `exit ${noNpm.status}`);
  }
}

process.stdout.write(`RESULT pass=${pass} fail=${fail}\n`);
try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* leftover temp folder */ }
process.exit(fail ? 1 : 0);
