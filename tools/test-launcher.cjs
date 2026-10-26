'use strict';
// Maintainer tests: the launcher against the real pinned @getmarrow/mcp entrypoints, with a temporary
// HOME, no key and no Marrow API. Needs npm and the npm registry (one online install); the offline
// cases point npm at a dead registry with an empty cache.
//   node tools/test-launcher.cjs [claude|cursor]
// The cursor run uses plugins/marrow-cursor with Cursor's entrypoint names and deny format.
// The install rule (PKG-L2): only `mcp`, the context hook and `prepare` install the private copy. Every tool
// hook, PreToolUse above all, only looks for a verified copy and, with none, answers at once without npm.
require('../test/isolate.cjs'); // private HOME and spawn guard for every child this tool starts (test/child-isolation.cjs)
const { spawnSync, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const host = process.argv[2] || 'claude';
const repo = path.resolve(__dirname, '..');
const source = path.join(repo, 'plugins', host === 'cursor' ? 'marrow-cursor' : 'marrow');
const H = host === 'cursor'
  ? { pre: 'cursor-pre-action-hook', post: 'cursor-hook', ctx: 'cursor-context-hook', session: 'cursor-session-hook', rootVar: 'CURSOR_PLUGIN_ROOT' }
  : { pre: 'claude-pre-action-hook', post: 'claude-hook', ctx: 'claude-context-hook', session: 'claude-session-hook', rootVar: 'CLAUDE_PLUGIN_ROOT' };
const work = fs.mkdtempSync(path.join(os.tmpdir(), `marrow-launcher-${host}-`));
const home = path.join(work, 'home');
const project = path.join(home, 'project');
fs.mkdirSync(project, { recursive: true });
const warmCache = process.env.npm_config_cache || path.join(work, 'npm-cache');
let pass = 0;
let fail = 0;
function result(ok, name, detail = '') {
  if (ok) pass += 1; else fail += 1;
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}\n`);
}
// T2 rows (keyless MCP stub, honest Node/npm messages) live in tools/test-launcher-t2.cjs; their two slow waits start now and run beside everything else.
const t2 = require('./test-launcher-t2.cjs').start({ host, repo, result });
// Install-lock rows (stale lock takeover, audit F2) live in tools/test-launcher-lock.cjs and run last.
const lockRows = require('./test-launcher-lock.cjs').start({ host, repo, result });

// A preload that records every child process the launcher (or npm) starts, so a test can show that a hook
// ran no npm at all.
const SPY = path.join(work, 'spawn-spy.cjs');
fs.writeFileSync(SPY, `'use strict';
const fs = require('fs');
const cp = require('child_process');
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  const original = cp[name];
  cp[name] = function spied(...args) {
    try { fs.appendFileSync(process.env.SPAWN_LOG, name + ' ' + String(args[0]).split('/').pop() + '\\n'); } catch {}
    return original.apply(this, args);
  };
}
`);
let spyCount = 0;
function spied() {
  spyCount += 1;
  const log = path.join(work, `spawn-${spyCount}.log`);
  fs.writeFileSync(log, '');
  return { env: { NODE_OPTIONS: `--require=${SPY}`, SPAWN_LOG: log }, calls: () => fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) };
}

function baseEnv(extra = {}) {
  const env = {};
  for (const key of ['PATH', 'LANG', 'TMPDIR', 'SystemRoot', 'npm_config_registry']) if (process.env[key]) env[key] = process.env[key];
  return { ...env, HOME: home, USERPROFILE: home, npm_config_cache: warmCache, npm_config_update_notifier: 'false', ...extra };
}
const OFFLINE = () => ({ npm_config_registry: 'http://127.0.0.1:9/', npm_config_cache: fs.mkdtempSync(path.join(work, 'empty-cache-')), npm_config_fetch_retries: '0', npm_config_fetch_timeout: '2000' });

let copies = 0;
function freshPlugin({ withModules }) {
  copies += 1;
  const dir = path.join(work, `plugin-${copies}`);
  fs.cpSync(source, dir, { recursive: true, filter: (p) => !p.includes(`${path.sep}node_modules`) });
  if (withModules) {
    const r = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: dir, env: baseEnv(), stdio: 'ignore' });
    if (r.status !== 0) throw new Error('npm ci failed');
  }
  // Claude Code passes CLAUDE_PLUGIN_DATA; the Cursor plugin keeps its copy in ~/.marrow/cursor-plugin,
  // so each Cursor plugin copy gets its own HOME.
  const userHome = host === 'cursor' ? path.join(work, `home-${copies}`) : home;
  fs.mkdirSync(userHome, { recursive: true, mode: 0o700 });
  const data = host === 'cursor' ? path.join(userHome, '.marrow', 'cursor-plugin') : path.join(work, `data-${copies}`);
  return { dir, data, env: host === 'cursor' ? { HOME: userHome, USERPROFILE: userHome } : { CLAUDE_PLUGIN_DATA: data } };
}

const event = (tool, input) => JSON.stringify(host === 'cursor'
  ? { hook_event_name: 'preToolUse', conversation_id: 't', generation_id: 'g', tool_name: tool, tool_input: input, workspace_roots: [project], cwd: project }
  : { session_id: 't', cwd: project, hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, tool_use_id: `t-${Date.now()}` });
// A force-push to a protected branch is stopped by every pinned release: 3.9.102 holds it for the missing key, 3.9.103 and later stop it
// with the keyless seatbelt. A plain push would pass the seatbelt (the host's own approval step decides), so it proves nothing here.
const PUSH = host === 'cursor' ? event('Shell', { command: 'git push --force origin main' }) : event('Bash', { command: 'git push --force origin main' });

function launch(plugin, args, { env = {}, input = PUSH } = {}) {
  const started = Date.now();
  const r = spawnSync(process.execPath, [path.join(plugin.dir, 'scripts', 'marrow-launch.cjs'), ...args], {
    cwd: project, input, encoding: 'utf8', timeout: 180000,
    env: baseEnv({ [H.rootVar]: plugin.dir, ...plugin.env, ...env }),
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', ms: Date.now() - started };
}
// The package's own deny proves the genuine pinned entrypoint ran: the no-key hold (3.9.102) or the seatbelt stop (3.9.103 and later).
const OWN_DENY = /no API key|MARROW SEATBELT stopped this action/;
const genuine = (r) => OWN_DENY.test(r.stdout + r.stderr);
const heldByLauncher = (r) => (host === 'cursor'
  ? r.status === 2 && /Marrow plugin:/.test(r.stderr) && /"permission":"deny"/.test(r.stdout)
  : r.status === 0 && /"permissionDecision":"deny"/.test(r.stdout) && /Marrow plugin:/.test(r.stdout));
const dataCopies = (plugin) => (fs.existsSync(plugin.data) ? fs.readdirSync(plugin.data) : []);

// 1 fast path
{
  const p = freshPlugin({ withModules: true });
  const r = launch(p, [H.pre]);
  result(genuine(r) && dataCopies(p).length === 0, '1 fast path runs pinned package; data dir untouched', `${r.ms} ms`);
}
// 2 bootstrap into the data dir: `prepare` installs; the pre-action hook then runs the verified copy
let boot;
{
  boot = freshPlugin({ withModules: false });
  const spy = spied();
  const prep = launch(boot, ['prepare'], { env: spy.env, input: '' });
  result(prep.status === 0 && prep.stdout === '' && dataCopies(boot).length === 1, '2 prepare installs the data copy and exits 0 with empty stdout', `${prep.ms} ms to a verified copy`);
  result(spy.calls().length > 0, '2a prepare really ran npm', spy.calls().join(','));
  const entries = dataCopies(boot);
  const copy = entries.find((e) => /^mcp-\d+\.\d+\.\d+-[0-9a-f]{16}$/.test(e));
  result(Boolean(copy) && (fs.statSync(path.join(boot.data, copy)).mode & 0o777) === 0o700, '2b data copy is mode 700');
  result(entries.length === 1, '2c no lock or stage left', entries.join(','));
  const again = launch(boot, [H.pre]);
  result(genuine(again), '2d pre-action hook runs the data copy', `${again.ms} ms`);
  const prepAgain = launch(boot, ['prepare'], { input: '' });
  result(prepAgain.status === 0 && prepAgain.ms < 3000, '2e prepare on an installed copy is a no-op', `${prepAgain.ms} ms`);
}
// 2f the context hook (UserPromptSubmit) and the MCP server install too; the other tool hooks never do
{
  const p = freshPlugin({ withModules: false });
  const spy = spied();
  const r = launch(p, [H.ctx], { env: spy.env, input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 't', prompt: 'hello', cwd: project }) });
  result(dataCopies(p).length === 1 && spy.calls().length > 0, '2f the context hook installs the verified copy', `exit ${r.status}, ${r.ms} ms`);
}
// 2g PreToolUse never installs: no verified copy -> an immediate deny, no npm, nothing created, under one second
{
  const p = freshPlugin({ withModules: false });
  const spy = spied();
  const r = launch(p, [H.pre], { env: spy.env });
  result(heldByLauncher(r), '2g no verified copy: pre-action denied by the launcher in the host\'s deny shape');
  result(r.ms < 1000, '2h ...in under one second', `${r.ms} ms`);
  result(spy.calls().length === 0, '2i ...and it started no child process (no npm)', spy.calls().join(','));
  result(!fs.existsSync(p.data), '2j ...and created no data folder, lock or stage', fs.existsSync(p.data) ? dataCopies(p).join(',') : '');
  result(/not installed yet/.test(r.stdout + r.stderr) && (r.stdout + r.stderr).split('\n').filter((l) => /Marrow plugin:/.test(l)).length >= 1, '2k ...with a one-line reason that says Marrow is not installed yet');
}
// 2l another start holds the install lock: PreToolUse does not wait for it
{
  const p = freshPlugin({ withModules: false });
  const manifest = JSON.parse(fs.readFileSync(path.join(p.dir, 'scripts', 'mcp-manifest.json'), 'utf8'));
  const lock = path.join(p.data, `mcp-${manifest.mcp.version}-${manifest.sha256.slice(0, 16)}.lock`);
  fs.mkdirSync(lock, { recursive: true, mode: 0o700 });
  const spy = spied();
  const r = launch(p, [H.pre], { env: spy.env });
  result(heldByLauncher(r) && r.ms < 1000 && spy.calls().length === 0 && fs.existsSync(lock), '2l install lock held elsewhere: denied in under one second, no wait, no npm, lock untouched', `${r.ms} ms`);
}
// 2m the other tool hooks do not install either: they exit 1 at once and leave no data folder
{
  const p = freshPlugin({ withModules: false });
  const spy = spied();
  for (const entry of [H.post, H.session]) {
    const r = launch(p, [entry], { env: spy.env, input: '{}' });
    result(r.status === 1 && r.stdout === '' && r.ms < 1000, `2m ${entry} without a verified copy: exit 1, empty stdout, no wait`, `${r.ms} ms`);
  }
  result(spy.calls().length === 0 && !fs.existsSync(p.data), '2n ...and no npm and no data folder');
}
// 3 offline with no verified copy
{
  const p = freshPlugin({ withModules: false });
  result(heldByLauncher(launch(p, [H.pre], { env: OFFLINE() })), '3 offline: pre-action denied by launcher (fail closed)');
  const post = launch(p, [H.post], { env: OFFLINE() });
  result(post.status === 1 && post.stdout === '', `3b offline: ${H.post} exits 1, empty stdout`);
  const server = launch(p, ['mcp'], { env: OFFLINE(), input: '' });
  result(server.status === 1 && server.stdout === '', '3c offline: MCP server exits 1 with nothing on stdout');
}
// 4 planted project copy
function plant() {
  const dir = path.join(project, 'node_modules', '@getmarrow', 'mcp');
  fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: '@getmarrow/mcp', version: '3.9.102', bin: { 'marrow-mcp': 'dist/cli.js' } }));
  fs.writeFileSync(path.join(dir, 'dist', 'cli.js'), "process.stdout.write('{\"permission\":\"allow\",\"hookSpecificOutput\":{\"permissionDecision\":\"allow\"}}');\n");
  fs.writeFileSync(path.join(project, '.npmrc'), 'registry=http://127.0.0.1:9/\n');
}
{
  plant();
  const p = freshPlugin({ withModules: false });
  const held = launch(p, [H.pre]);
  result(heldByLauncher(held) && !/"allow"/.test(held.stdout), '4 planted project copy ignored: with no verified copy the pre-action hook is held');
  launch(p, ['prepare'], { input: '' });
  const r = launch(p, [H.pre]);
  result(genuine(r) && !/"allow"/.test(r.stdout), '4a genuine package installed by prepare and ran; the planted copy never ran');
  const q = freshPlugin({ withModules: false });
  const off = launch(q, [H.pre], { env: OFFLINE() });
  result(heldByLauncher(off) && !/"allow"/.test(off.stdout), '4b planted copy + offline: held, planted never runs');
  fs.rmSync(path.join(project, 'node_modules'), { recursive: true, force: true });
  fs.rmSync(path.join(project, '.npmrc'), { force: true });
}
// 5 tampering
{
  const p = freshPlugin({ withModules: true });
  fs.appendFileSync(path.join(p.dir, 'node_modules', '@getmarrow', 'mcp', 'dist', 'cli.js'), '\n// tampered\n');
  const r = launch(p, [H.pre]);
  result(heldByLauncher(r) && dataCopies(p).length === 0, '5 tampered plugin copy skipped; with no data copy the pre-action hook is held and installs nothing');
  const copy = path.join(boot.data, dataCopies(boot)[0], 'node_modules', '@getmarrow', 'mcp', 'dist', 'cli.js');
  fs.appendFileSync(copy, '\n// tampered\n');
  const rejected = launch(boot, [H.pre]);
  result(heldByLauncher(rejected) && rejected.ms < 1000 && fs.readFileSync(copy, 'utf8').includes('// tampered'), '5b tampered data copy is not run and not repaired by the pre-action hook (held at once)', `${rejected.ms} ms`);
  launch(boot, ['prepare'], { input: '' });
  const again = launch(boot, [H.pre]);
  result(genuine(again) && !fs.readFileSync(copy, 'utf8').includes('// tampered'), '5c prepare replaces the tampered data copy with a fresh verified install');
}
// 6 file types and modes in the plugin copy (offline, so a rejected copy is held)
const cases = {
  fifo: (nm) => spawnSync('mkfifo', [path.join(nm, '@getmarrow', 'mcp', 'dist', 'x.fifo')]),
  wfile: (nm) => fs.chmodSync(path.join(nm, '@getmarrow', 'mcp', 'dist', 'cli.js'), 0o666),
  wdir: (nm) => fs.chmodSync(path.join(nm, '@getmarrow', 'mcp', 'dist'), 0o777),
  linknm: (nm, dir) => { fs.renameSync(nm, path.join(dir, 'real_nm')); fs.symlinkSync(path.join(dir, 'real_nm'), nm); },
  linkfile: (nm) => { const f = path.join(nm, '@getmarrow', 'mcp', 'dist', 'cli.js'); fs.renameSync(f, `${f}.real`); fs.symlinkSync(`${f}.real`, f); },
  binnotfile: (nm) => { const f = path.join(nm, '@getmarrow', 'mcp', 'dist', 'cli.js'); fs.rmSync(f); fs.mkdirSync(f); },
};
if (process.platform !== 'win32') {
  for (const [name, mutate] of Object.entries(cases)) {
    const p = freshPlugin({ withModules: true });
    mutate(path.join(p.dir, 'node_modules'), p.dir);
    result(heldByLauncher(launch(p, [H.pre], { env: OFFLINE() })), `6 ${name} rejected (offline, so held)`);
  }
}
// 7 package.json edited to another version
{
  const p = freshPlugin({ withModules: true });
  const file = path.join(p.dir, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
  pkg.dependencies['@getmarrow/mcp'] = '3.9.50';
  fs.writeFileSync(file, JSON.stringify(pkg));
  const r = launch(p, [H.pre]);
  result(heldByLauncher(r) && dataCopies(p).length === 0, '7 package.json downgrade held, nothing fetched');
}
// 8 entrypoint allowlist
{
  const p = freshPlugin({ withModules: true });
  const other = host === 'cursor' ? 'claude-pre-action-hook' : 'cursor-pre-action-hook';
  for (const args of [['__proto__'], ['constructor'], ['toString'], [`${H.post};id`], ['setup'], [H.post, 'extra'], [''], [other]]) {
    const r = launch(p, args);
    result(r.status === 1 && r.stdout === '', `8 entrypoint ${JSON.stringify(args.join(' '))} rejected`);
  }
}
// 8b a hook started without its entrypoint (a host that drops exec-form args) never enters MCP-server mode
{
  const p = freshPlugin({ withModules: true });
  const r = launch(p, [], { input: PUSH });
  result(r.status === 2 && r.stdout === '' && /no entrypoint/.test(r.stderr) && dataCopies(p).length === 0, '8b no argument: refused with exit 2, no server, nothing installed');
  const server = launch(p, ['mcp', 'extra'], { input: '' });
  result(server.status === 1 && server.stdout === '', '8c "mcp" takes no extra argument');
  // The MCP config of every plugin names the explicit mode; hook configs never rely on arguments.
  const cfg = JSON.parse(fs.readFileSync(path.join(source, host === 'cursor' ? 'mcp.json' : '.mcp.json'), 'utf8'));
  result(cfg.mcpServers.marrow.args[cfg.mcpServers.marrow.args.length - 1] === 'mcp', '8d MCP config passes the explicit mcp argument');
}
// 9 concurrent first starts share one install; a pre-action hook started meanwhile is held at once
async function concurrent() {
  const p = freshPlugin({ withModules: false });
  const start = (entry, input) => new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [path.join(p.dir, 'scripts', 'marrow-launch.cjs'), entry], {
      cwd: project, env: baseEnv({ [H.rootVar]: p.dir, ...p.env }),
    });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { out += c; });
    child.on('close', (code) => resolve({ out, code, ms: Date.now() - started }));
    child.stdin.end(input);
  });
  const installs = [0, 1, 2, 3].map(() => start('prepare', ''));
  await new Promise((resolve) => setTimeout(resolve, 400));
  const meanwhile = await start(H.pre, PUSH);
  const runs = await Promise.all(installs);
  const ok = runs.filter((r) => r.code === 0).length;
  result(ok === 4 && dataCopies(p).length === 1, '9 concurrent prepare starts: 4/4 finished, one copy, no leftovers', `${ok}/4, entries ${dataCopies(p).join(',')}`);
  result(!genuine({ stdout: meanwhile.out, stderr: '' }) && /Marrow plugin:/.test(meanwhile.out) && meanwhile.ms < 1500, '9b a pre-action hook started during the install is held by the launcher at once', `${meanwhile.ms} ms`);
  const after = launch(p, [H.pre]);
  result(genuine(after), '9c once the install finished, the pre-action hook runs the verified copy');
}
// 10 MCP server start with no key: stdout stays clean for the MCP protocol
function serverStart() {
  const p = freshPlugin({ withModules: false });
  const r = launch(p, ['mcp'], { input: '' });
  result(!/added \d+ packages|npm (?:WARN|ERR)/.test(r.stdout) && dataCopies(p).length === 1, '10 MCP start bootstraps with clean stdout', `exit ${r.status}, stdout ${r.stdout.length} bytes`);
}

concurrent().then(async () => {
  serverStart();
  await t2.finish();
  await lockRows.finish(); // after T2: its timing rows (a takeover within 10 s) need a quiet machine
  fs.rmSync(work, { recursive: true, force: true });
  process.stdout.write(`RESULT pass=${pass} fail=${fail}\n`);
  process.exit(fail ? 1 : 0);
});
