'use strict';
// First use of the shared launcher, both trees (plugins/marrow-cursor and plugins/marrow).
//   node tools/test-cursor-first-install.cjs
// T-1 Cursor, empty HOME, cursor-pre-action-hook: deny, exit 2, and the installing text (never the network text).
// T-2 Claude Code, no copy yet, claude-pre-action-hook: exit 0 with permissionDecision deny and the same installing text.
// T-3 every other cause keeps its text byte for byte (npm, network, mismatch, folder, manifest, toolchain; timeout and lock
//     are held by their source lines, the slow waits run in tools/test-launcher-lock.cjs), and a verified copy still answers
//     through the pinned entry with a deny when the API is unreachable, when there is no key, and for a malformed hook event.
// T-4 no tool hook starts npm: a recording npm on PATH, with a node that has no npm beside it, sees 0 calls.
// Every child runs in the private offline npm environment of test/npm-env.cjs with the loopback network guard. The verified
// copy rows need the pinned tarballs in the cache named by npm_config_cache (as tools/test-launcher.cjs does).
// A dummy key is generated at runtime and must appear in no output.
require('../test/isolate.cjs'); // private HOME and spawn guard for every child this tool starts (test/child-isolation.cjs)
const netGuard = require('../test/net-guard.cjs');
const npmEnvironment = require('../test/npm-env.cjs');
const { spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const repo = path.resolve(__dirname, '..');
const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-first-install-')));
const NPM = npmEnvironment.create({ root: work });
const KEY = `dummy_first_install_${crypto.randomBytes(16).toString('hex')}`;
if (/^(sk_|pk_|rk_|ghp_|xox|mk_)/.test(KEY)) throw new Error('dummy key is shaped like a live key');
// A second runtime dummy in a fleet key variable (MARROW_KEY_<NAME>, which the launcher reads), for the fleet-key-only runs.
const FLEET_KEY = `dummy_first_install_fleet_${crypto.randomBytes(16).toString('hex')}`;
if (/^(sk_|pk_|rk_|ghp_|xox|mk_)/.test(FLEET_KEY)) throw new Error('dummy fleet key is shaped like a live key');
const KEYED = [{ label: 'a dummy key', extra: { MARROW_API_KEY: KEY } }, { label: 'a fleet key only', extra: { MARROW_KEY_FIRST_INSTALL: FLEET_KEY } }];
// The random part of each dummy and every 8-character slice of it, in lower case: no stream may hold one.
const KEY_SLICES = [KEY, FLEET_KEY].map((k) => k.slice(k.lastIndexOf('_') + 1))
  .flatMap((part) => Array.from({ length: part.length - 7 }, (_, i) => part.slice(i, i + 8)));

let pass = 0;
let fail = 0;
function result(ok, name, detail = '') {
  if (ok) pass += 1; else fail += 1;
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}\n`);
}

// A node with no npm beside it, so the launcher can only find npm on PATH, and a recording npm there.
const bareNode = path.join(work, 'bare', 'bin', 'node');
fs.mkdirSync(path.dirname(bareNode), { recursive: true });
try { fs.linkSync(process.execPath, bareNode); } catch { fs.copyFileSync(process.execPath, bareNode); fs.chmodSync(bareNode, 0o755); }
function fakeNpm(name, body) {
  const bin = path.join(work, name);
  fs.mkdirSync(bin);
  const log = path.join(work, `${name}.log`);
  fs.writeFileSync(log, '');
  fs.writeFileSync(path.join(bin, 'npm'), `#!/bin/sh\necho "$PPID $*" >> "${log}"\n${body}\n`, { mode: 0o755 });
  return { bin, calls: () => fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).length };
}
const recorder = fakeNpm('npm-recorder', 'exit 1');
const okNpm = fakeNpm('npm-ok', 'exit 0');
const emptyBin = path.join(work, 'empty-bin');
fs.mkdirSync(emptyBin);
const toolchainShim = path.join(work, 'old-node.cjs');
fs.writeFileSync(toolchainShim, "Object.defineProperty(process, 'versions', { value: { ...process.versions, node: '16.20.0' } });\n");

let copies = 0;
function pluginCopy(tree, edit) {
  copies += 1;
  const dir = path.join(work, `plugin-${copies}`);
  fs.cpSync(path.join(repo, 'plugins', tree), dir, { recursive: true, filter: (p) => !p.includes(`${path.sep}node_modules`) });
  if (edit) edit(dir);
  return dir;
}
function freshHome(label) {
  const home = path.join(work, `home-${label}`);
  fs.mkdirSync(path.join(home, 'project'), { recursive: true, mode: 0o700 });
  return home;
}

const outputs = [];
function run({ dir, entry, home, data, node = bareNode, pathDirs = [recorder.bin], extra = {}, input, pre = [] }) {
  const env = NPM.env({ HOME: home, USERPROFILE: home, PATH: [...pathDirs, '/usr/bin', '/bin'].join(':'), ...extra });
  if (data !== undefined) env.CLAUDE_PLUGIN_DATA = data;
  const event = input !== undefined ? input : JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git push origin master' }, cwd: path.join(home, 'project') });
  const r = spawnSync(node, [...pre, path.join(dir, 'scripts', 'marrow-launch.cjs'), entry], {
    cwd: path.join(home, 'project'), env, input: event, encoding: 'utf8', timeout: 60000,
  });
  const out = { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
  outputs.push(out.stdout, out.stderr);
  return out;
}
const parse = (text) => { try { return JSON.parse(text); } catch { return null; } };

const TREES = [
  { tree: 'marrow-cursor', cursor: true, host: 'Cursor', pre: 'cursor-pre-action-hook', ctx: 'cursor-context-hook', tools: ['cursor-pre-action-hook', 'cursor-hook', 'cursor-session-hook'],
    reinstall: 'ask the owner to reinstall the Marrow plugin in Cursor.' },
  { tree: 'marrow', cursor: false, host: 'Claude Code', pre: 'claude-pre-action-hook', ctx: 'claude-context-hook', tools: ['claude-pre-action-hook', 'claude-hook', 'claude-session-hook', 'claude-permission-request-hook'],
    reinstall: 'ask the owner to reinstall the plugin: claude plugin uninstall marrow@getmarrow, then claude plugin install marrow@getmarrow.' },
];
const HELD = 'The action is held until Marrow can start.';
const IDLE_REASON = 'the pinned @getmarrow/mcp is not installed yet (the plugin installs it when its Marrow server starts or on your first prompt).';
const installing = (t) => `The install can take a few minutes; retry the action after it finishes. If this keeps happening, restart ${t.host} so the Marrow server can install it again, and check the network, or ${t.reinstall}`;
const network = (t) => `Reconnect to the network and retry, or ${t.reinstall}`;
const reinstallFix = (t) => `${t.reinstall[0].toUpperCase()}${t.reinstall.slice(1)}`;
const DENY_WORDS = /allow|approv|permit|grant|authori[sz]|proceed|decision|safe to|advice/i;

// The pre-action answer for a held call, exactly as the launcher's fail() writes it on each host.
function heldAnswer(t, r, reason, fix) {
  const message = `Marrow plugin: ${reason} ${HELD} ${fix}`;
  if (t.cursor) {
    const body = parse(r.stdout);
    return r.status === 2 && r.stdout === `${JSON.stringify({ permission: 'deny', user_message: message, agent_message: message })}\n` && r.stderr === `${message}\n`
      && body && body.permission === 'deny';
  }
  const body = parse(r.stdout);
  return r.status === 0 && r.stderr === '' && r.stdout === `${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: message } })}\n`
    && body && body.hookSpecificOutput.permissionDecision === 'deny';
}
const show = (r) => `rc ${r.status}, stdout ${r.stdout.length} bytes, stderr ${r.stderr.length} bytes`;

for (const t of TREES) {
  const dir = pluginCopy(t.tree);
  // ---- T-1 / T-2: first use, no copy anywhere ------------------------------------------------------------------------
  const homes = [{ label: 'empty', home: freshHome(`${t.tree}-empty`) }];
  if (!t.cursor) homes.push({ label: 'empty data folder', home: freshHome(`${t.tree}-data`), data: 'data' }, { label: 'no CLAUDE_PLUGIN_DATA', home: freshHome(`${t.tree}-nodata`), data: null });
  for (const h of homes) {
    let data;
    if (h.data === 'data') { data = path.join(h.home, 'plugin-data'); fs.mkdirSync(data, { mode: 0o700 }); }
    const before = recorder.calls();
    const r = run({ dir, entry: t.pre, home: h.home, data: h.data === null ? undefined : data });
    const id = t.cursor ? 'T-1' : 'T-2';
    result(heldAnswer(t, r, IDLE_REASON, installing(t)) && !(r.stdout + r.stderr).includes('Reconnect to the network') && !DENY_WORDS.test(installing(t)),
      `${id} ${t.host} first use (${h.label}): ${t.pre} holds the call with the installing text, never the network text`, show(r));
    result(recorder.calls() === before, `T-4 ${t.host} first use (${h.label}): ${t.pre} started no npm`, `${recorder.calls() - before} calls`);
    if (t.cursor) result(!fs.existsSync(path.join(h.home, '.marrow')), 'T-4 Cursor first use: a tool hook created no data folder');
  }
  // Every tool hook on first use: the same reason and installing text, no npm.
  for (const entry of t.tools.filter((e) => e !== t.pre)) {
    const home = freshHome(`${t.tree}-${entry}`);
    const before = recorder.calls();
    const r = run({ dir, entry, home, data: t.cursor ? undefined : path.join(home, 'none') });
    result(r.status === 1 && r.stdout === '' && r.stderr === `Marrow plugin: ${IDLE_REASON} ${installing(t)}\n`,
      `${t.cursor ? 'T-1' : 'T-2'} ${t.host} first use: ${entry} reports the installing text, exit 1 as before`, show(r));
    result(recorder.calls() === before, `T-4 ${t.host} first use: ${entry} started no npm`, `${recorder.calls() - before} calls`);
  }
  // The same first-use runs with a dummy key, and with a fleet key only: the same answer, exit code, permission value and
  // installing text as the keyless runs, and their streams go to the outputs the output row reads.
  for (const k of KEYED) {
    for (const h of homes) {
      const home = freshHome(`${t.tree}-${k.label}-${h.label}`.replace(/ /g, '-'));
      let data;
      if (h.data === 'data') { data = path.join(home, 'plugin-data'); fs.mkdirSync(data, { mode: 0o700 }); }
      const before = recorder.calls();
      const r = run({ dir, entry: t.pre, home, data: h.data === null ? undefined : data, extra: k.extra });
      result(heldAnswer(t, r, IDLE_REASON, installing(t)) && !(r.stdout + r.stderr).includes('Reconnect to the network'),
        `${t.cursor ? 'T-1' : 'T-2'} ${t.host} first use with ${k.label} (${h.label}): ${t.pre} holds the call with the installing text`, show(r));
      result(recorder.calls() === before, `T-4 ${t.host} first use with ${k.label} (${h.label}): ${t.pre} started no npm`, `${recorder.calls() - before} calls`);
      if (t.cursor) result(!fs.existsSync(path.join(home, '.marrow')), `T-4 Cursor first use with ${k.label}: a tool hook created no data folder`);
    }
    for (const entry of t.tools.filter((e) => e !== t.pre)) {
      const home = freshHome(`${t.tree}-${k.label}-${entry}`.replace(/ /g, '-'));
      const before = recorder.calls();
      const r = run({ dir, entry, home, data: t.cursor ? undefined : path.join(home, 'none'), extra: k.extra });
      result(r.status === 1 && r.stdout === '' && r.stderr === `Marrow plugin: ${IDLE_REASON} ${installing(t)}\n`,
        `${t.cursor ? 'T-1' : 'T-2'} ${t.host} first use with ${k.label}: ${entry} reports the installing text, exit 1 as before`, show(r));
      result(recorder.calls() === before, `T-4 ${t.host} first use with ${k.label}: ${entry} started no npm`, `${recorder.calls() - before} calls`);
    }
  }

  // ---- T-3: every other cause, BASE text byte for byte ---------------------------------------------------------------
  const installFrom = (label, opts) => {
    const home = freshHome(`${t.tree}-${label}`);
    const data = t.cursor ? undefined : path.join(home, 'plugin-data');
    if (data) fs.mkdirSync(data, { mode: 0o700 });
    if (opts.plant) opts.plant(home, data);
    return { home, data, r: run({ dir: opts.dir || dir, entry: 'prepare', home, data: opts.data !== undefined ? opts.data : data, pathDirs: opts.pathDirs, node: opts.node, pre: opts.pre || [] }) };
  };
  const causeText = (reason, fix) => `Marrow plugin: ${reason} ${fix}\n`;
  const CAUSE_ROWS = [
    ['npm', { pathDirs: [emptyBin] }, 'npm was not found or could not be started, and it is needed to install the pinned @getmarrow/mcp once.',
      `Install Node.js 18 or newer with npm on PATH, then restart ${t.host}.`],
    ['network', { pathDirs: [recorder.bin] }, 'npm could not install the pinned @getmarrow/mcp (usually no network or an unreachable npm registry).', network(t)],
    ['mismatch', { pathDirs: [okNpm.bin] }, 'the installed copy of the pinned @getmarrow/mcp does not match its manifest.', reinstallFix(t)],
    ['folder', t.cursor
      ? { plant: (home) => { fs.mkdirSync(path.join(home, '.marrow', 'cursor-plugin'), { recursive: true }); fs.chmodSync(path.join(home, '.marrow', 'cursor-plugin'), 0o777); } }
      : { data: 'relative/plugin-data' },
    'the Marrow plugin data folder is missing, not owned by this user or open to other users.',
    t.cursor ? 'Ask the owner to make the Marrow plugin data folder private to their account, or delete it, then restart Cursor.' : reinstallFix(t)],
    ['manifest', { dir: pluginCopy(t.tree, (d) => fs.appendFileSync(path.join(d, 'scripts', 'mcp-manifest.json'), 'x')) },
      'its pinned @getmarrow/mcp manifest is missing or does not match package.json.', network(t)],
    ['toolchain', { pre: ['--require', toolchainShim] }, 'this Node.js is too old (major version 16); the pinned @getmarrow/mcp needs Node.js 18 or newer.',
      `Install Node.js 18 or newer with npm on PATH, then restart ${t.host}.`],
  ];
  for (const [cause, opts, reason, fix] of CAUSE_ROWS) {
    const { r } = installFrom(cause, opts);
    result(r.status === 1 && r.stdout === '' && r.stderr === causeText(reason, fix), `T-3 ${t.host} cause ${cause}: the install entrypoint keeps its text and exit 1`, show(r));
    // The same state on the pre-action hook: still held, exit code and permission as before.
    if (cause === 'manifest' || cause === 'toolchain') {
      const p = run({ dir: opts.dir || dir, entry: t.pre, home: freshHome(`${t.tree}-${cause}-pre`), data: t.cursor ? undefined : path.join(work, 'none'), pre: opts.pre || [] });
      result(heldAnswer(t, p, reason, fix), `T-3 ${t.host} cause ${cause}: ${t.pre} holds the call with the same text`, show(p));
    }
  }
  // timeout and lock: their source lines are unchanged (the waits take minutes and run in tools/test-launcher-lock.cjs).
  const source = fs.readFileSync(path.join(dir, 'scripts', 'marrow-launch.cjs'), 'utf8');
  const causeSource = (name) => (source.match(new RegExp(`\\n  ${name}: \\{\\n([\\s\\S]*?)\\n  \\},`)) || [])[1];
  result(causeSource('timeout') === "    reason: `installing the pinned @getmarrow/mcp with npm took longer than ${NPM_TIMEOUT_MS / 1000} seconds.`,\n    fix: FIX_NETWORK,"
    && causeSource('network') === "    reason: 'npm could not install the pinned @getmarrow/mcp (usually no network or an unreachable npm registry).',\n    fix: FIX_NETWORK,"
    && causeSource('lock') === "    reason: `another Marrow start was still installing the pinned @getmarrow/mcp after ${LOCK_WAIT_MS / 1000} seconds.`,\n    fix: FIX_WAIT,"
    && source.includes('const FIX_NETWORK = `Reconnect to the network and retry, or ${REINSTALL}`;'),
  `T-3 ${t.host} the timeout, network and lock causes and FIX_NETWORK keep their source lines`);

  // ---- T-3: a verified copy answers through the pinned entry, as before ----------------------------------------------
  const verified = installFrom('verified', { pathDirs: [], node: process.execPath });
  const vNode = process.execPath;
  const vEnv = (extra) => ({ node: vNode, dir, home: verified.home, data: verified.data, pathDirs: [], extra });
  if (verified.r.status !== 0) {
    result(false, `T-3 ${t.host} a verified copy can be installed from the seeded offline cache (set npm_config_cache)`, show(verified.r));
  } else {
    const closed = `http://127.0.0.1:${9}`;
    const rows = [
      ['AB-1 API unreachable', { MARROW_API_KEY: KEY, MARROW_BASE_URL: closed }, undefined],
      ['AB-2 no key', {}, undefined],
      ['AB-3 malformed hook event', { MARROW_API_KEY: KEY, MARROW_BASE_URL: closed }, 'not json {'],
    ];
    for (const [label, extra, input] of rows) {
      const r = run({ ...vEnv(extra), entry: t.pre, input });
      const body = parse(r.stdout.trim().split('\n').pop() || '');
      const denied = t.cursor ? (body && body.permission === 'deny') : (body && body.hookSpecificOutput && body.hookSpecificOutput.permissionDecision === 'deny');
      result(Boolean(denied) && !r.stdout.includes(IDLE_REASON) && !r.stdout.includes('The install can take a few minutes'),
        `T-3 ${t.host} ${label}: the pinned entry still answers and holds the call`, show(r));
    }
    const before = recorder.calls();
    run({ ...vEnv({}), pathDirs: [recorder.bin], node: bareNode, entry: t.pre });
    result(recorder.calls() === before, `T-4 ${t.host} a verified copy: ${t.pre} started no npm`);
  }
}

// ---- the dummy key never appears in any output -----------------------------------------------------------------------
result(outputs.every((o) => !o.includes(KEY)), 'output: the dummy key appears in no stdout or stderr', `${outputs.length} streams`);
const keyHits = outputs.filter((o) => { const lower = o.toLowerCase(); return o.includes(KEY) || o.includes(FLEET_KEY) || KEY_SLICES.some((s) => lower.includes(s)); }).length;
result(keyHits === 0, 'output: no dummy key, fleet key, random part or 8-character slice of one appears in any stdout or stderr (keyed first use included)',
  `${keyHits} of ${outputs.length} streams`);
const attempts = (() => { try { return netGuard.assertNoAttempts([NPM.log]); } catch (error) { return String(error.message); } })();
result(!attempts, 'no child tried a non-loopback connection', attempts || '');

try { spawnSync('chmod', ['-R', 'u+rwX', work], { stdio: 'ignore' }); fs.rmSync(work, { recursive: true, force: true }); } catch { /* best effort */ }
process.stdout.write(`${fail ? `${fail} FAILED` : 'ALL PASS'} (${pass} passed)\n`);
process.exitCode = fail ? 1 : 0;
