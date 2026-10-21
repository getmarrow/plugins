'use strict';
// Install-lock rows of the launcher tests (audit F2): a lock left by a killed install is taken over, a lock that may belong to a live
// start never is, and the verified-copy hash check stays the only trust gate.
// Called by tools/test-launcher.cjs, which counts the rows; it can also run alone:
//   node tools/test-launcher-lock.cjs [claude|cursor]
// Same rules as test-launcher-t2.cjs: children get an allowlisted env, npm uses npm_config_cache from the parent (seeded cache),
// nothing here reads or writes a real key.
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const POSIX = process.platform !== 'win32';
const STALE_MS = 135000;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function start({ host, repo, result }) {
  const CURSOR = host === 'cursor';
  const source = path.join(repo, 'plugins', CURSOR ? 'marrow-cursor' : 'marrow');
  const rootVar = CURSOR ? 'CURSOR_PLUGIN_ROOT' : 'CLAUDE_PLUGIN_ROOT';
  const PRE = CURSOR ? 'cursor-pre-action-hook' : 'claude-pre-action-hook';
  const work = fs.mkdtempSync(path.join(os.tmpdir(), `marrow-lock-${host}-`));
  const cache = process.env.npm_config_cache || path.join(work, 'npm-cache');
  const sleepers = [];
  let counter = 0;

  function env(extra = {}) {
    const out = {};
    for (const name of ['PATH', 'LANG', 'TMPDIR', 'SystemRoot', 'npm_config_registry']) if (process.env[name]) out[name] = process.env[name];
    return { ...out, npm_config_cache: cache, npm_config_update_notifier: 'false', ...extra };
  }
  // A fresh plugin copy (no node_modules, so every run needs the private copy) with its own HOME and data folder.
  function setup() {
    counter += 1;
    const dir = path.join(work, `case-${counter}`);
    const pluginDir = path.join(dir, 'plugin');
    const home = path.join(dir, 'home');
    fs.mkdirSync(path.join(home, 'project'), { recursive: true });
    fs.cpSync(source, pluginDir, { recursive: true, filter: (p) => !p.includes(`${path.sep}node_modules`) });
    const data = CURSOR ? path.join(home, '.marrow', 'cursor-plugin') : path.join(home, '.claude-data');
    const manifest = JSON.parse(fs.readFileSync(path.join(pluginDir, 'scripts', 'mcp-manifest.json'), 'utf8'));
    const id = `mcp-${manifest.mcp.version}-${manifest.sha256.slice(0, 16)}`;
    return { dir, pluginDir, home, data, id, lock: path.join(data, `${id}.lock`), copy: path.join(data, id) };
  }
  function envFor(c, extra = {}) {
    return env({ HOME: c.home, USERPROFILE: c.home, [rootVar]: c.pluginDir, ...(CURSOR ? {} : { CLAUDE_PLUGIN_DATA: c.data }), ...extra });
  }
  const script = (c) => path.join(c.pluginDir, 'scripts', 'marrow-launch.cjs');
  function run(c, args, { node = process.execPath, extra = {}, input = '' } = {}) {
    const started = Date.now();
    return new Promise((resolve) => {
      const child = spawn(node, [script(c), ...args], { cwd: path.join(c.home, 'project'), env: envFor(c, extra), stdio: ['pipe', 'pipe', 'pipe'] });
      let stderr = '';
      let stdout = '';
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });
      child.stdin.on('error', () => {});
      child.stdin.end(input);
      const timer = setTimeout(() => child.kill('SIGKILL'), 120000);
      child.on('close', (status, signal) => { clearTimeout(timer); resolve({ status, signal, stdout, stderr, ms: Date.now() - started, child }); });
    });
  }
  // Starts a launcher and resolves with the live child plus a promise for its end.
  function begin(c, args, opts = {}) {
    const child = spawn(opts.node || process.execPath, [script(c), ...args], {
      cwd: path.join(c.home, 'project'), env: envFor(c, opts.extra), stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.on('error', () => {});
    child.stdin.end();
    child.stdout.resume();
    child.stderr.resume();
    const ended = new Promise((resolve) => child.on('close', (status, signal) => resolve({ status, signal })));
    return { child, ended };
  }
  async function until(test, ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (test()) return true;
      await wait(20);
    }
    return test();
  }
  const exists = (p) => { try { fs.lstatSync(p); return true; } catch { return false; } };
  const entries = (c) => (exists(c.data) ? fs.readdirSync(c.data).sort() : []);
  function sleeper() {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], { stdio: 'ignore' });
    sleepers.push(child);
    return child;
  }
  async function deadPid() {
    const child = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });
    await new Promise((resolve) => child.on('close', resolve));
    return child.pid;
  }
  function plant(c, { owner, raw, ageMs = 0, ownerAsSymlink = false, older } = {}) {
    fs.mkdirSync(c.data, { recursive: true, mode: 0o700 });
    fs.chmodSync(c.data, 0o700);
    fs.mkdirSync(c.lock, { mode: 0o700 });
    const text = raw !== undefined ? raw : owner ? JSON.stringify({ host: os.hostname(), token: 'planted', created: Date.now(), ...owner }) : undefined;
    let gen = 1;
    if (older) { // an earlier generation, as left behind by an earlier takeover
      fs.writeFileSync(path.join(c.lock, 'owner.1'), JSON.stringify({ host: os.hostname(), token: 'earlier', created: Date.now(), ...older }), { mode: 0o600 });
      gen = 2;
    }
    if (text !== undefined) {
      if (ownerAsSymlink) {
        const elsewhere = path.join(c.dir, 'elsewhere-owner');
        fs.writeFileSync(elsewhere, text);
        fs.symlinkSync(elsewhere, path.join(c.lock, `owner.${gen}`));
      } else {
        fs.writeFileSync(path.join(c.lock, `owner.${gen}`), text, { mode: 0o600 });
      }
    }
    if (ageMs) {
      const when = new Date(Date.now() - ageMs);
      for (const name of fs.readdirSync(c.lock)) fs.lutimesSync(path.join(c.lock, name), when, when);
      fs.utimesSync(c.lock, when, when);
    }
  }
  // A launcher that must NOT take the lock over: after `ms` the same lock (same inode) still stands, nothing was staged, no npm ran.
  async function holds(c, ms) {
    const before = fs.lstatSync(c.lock);
    const { child, ended } = begin(c, ['prepare']);
    await wait(ms);
    let stood = false;
    try {
      const now = fs.lstatSync(c.lock);
      stood = now.ino === before.ino && now.dev === before.dev && child.exitCode === null;
    } catch { stood = false; }
    const names = entries(c);
    child.kill('SIGKILL');
    await ended;
    return stood && names.length === 1 && names[0] === path.basename(c.lock);
  }
  // A shim `npm` that counts its runs, so the tests can see how many starts installed. The copy of node has no npm beside it, so the
  // launcher finds the shim through PATH.
  function countingNpm(label, { sleepSeconds = 0, after = '' } = {}) {
    const bin = path.join(work, `shim-${label}`);
    fs.mkdirSync(path.join(bin, 'node-bin'), { recursive: true });
    const node = path.join(bin, 'node-bin', 'node');
    try { fs.linkSync(process.execPath, node); } catch { fs.copyFileSync(process.execPath, node); fs.chmodSync(node, 0o755); }
    const log = path.join(bin, 'runs.log');
    const cli = path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
    fs.writeFileSync(path.join(bin, 'npm'), `#!/bin/sh\necho run >> "${log}"\nsleep ${sleepSeconds}\n"${process.execPath}" "${cli}" "$@" || exit $?\n${after}\n`, { mode: 0o755 });
    const runs = () => (exists(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).length : 0);
    return { node, extra: { PATH: `${bin}:${process.env.PATH || '/usr/bin:/bin'}` }, runs };
  }

  async function main() {
    // 1. owner killed mid-install (SIGTERM, SIGKILL): the lock stays, the pre-action hook denies at once, the next prepare takes over.
    for (const signal of ['SIGTERM', 'SIGKILL']) {
      const c = setup();
      const shim = countingNpm(`kill-${signal}`, { sleepSeconds: 3 });
      const first = begin(c, ['prepare'], shim);
      const appeared = await until(() => exists(path.join(c.lock, 'owner.1')), 20000);
      first.child.kill(signal);
      await first.ended;
      const left = exists(c.lock);
      const hook = spawnSync(process.execPath, [script(c), PRE], {
        cwd: path.join(c.home, 'project'), env: envFor(c), encoding: 'utf8', timeout: 20000,
        input: JSON.stringify({ hook_event_name: 'x', cwd: c.home }) });
      const denied = /not installed yet/.test(`${hook.stdout}${hook.stderr}`) && hook.status === (CURSOR ? 2 : 0);
      const second = await run(c, ['prepare']);
      const copy = exists(c.copy);
      result(appeared && left && denied, `lock ${signal}: a killed install leaves its lock, and the pre-action hook still denies at once`, `lock ${left}, denied ${denied}`);
      result(second.status === 0 && second.ms < 10000 && copy && !exists(c.lock), `lock ${signal}: the next prepare takes the dead owner's lock over, installs, exits 0 in under 10 s`, `exit ${second.status}, ${second.ms} ms`);
    }

    // 2. a dead owner in a planted lock is taken over at once (positive control); a live one never is.
    {
      const c = setup();
      plant(c, { owner: { pid: await deadPid() } });
      const r = await run(c, ['prepare']);
      result(r.status === 0 && r.ms < 10000 && exists(c.copy) && !exists(c.lock), 'lock: a fresh lock whose owner pid is dead is taken over, prepare exits 0', `exit ${r.status}, ${r.ms} ms`);
    }
    const live = sleeper();
    const cases = [
      ['a live owner (fresh lock) is never taken over and nothing is installed', () => ({ owner: { pid: live.pid } })],
      ['a forged owner file with a live pid (this process) is not taken over', () => ({ owner: { pid: process.pid, token: 'forged' } })],
      ['PID reuse: a live pid with a creation time that is not the owner\'s falls back to the age rule', () => ({ owner: { pid: live.pid, created: 1 } })],
      ['EPERM (pid 1 is another user\'s) means alive: not taken over', () => ({ owner: { pid: 1 } })],
      ['a garbled owner file falls back to the age rule', () => ({ raw: '{not json' })],
      ['an empty owner file falls back to the age rule', () => ({ raw: '' })],
      ['no owner file falls back to the age rule', () => ({})],
      ['an oversized owner file falls back to the age rule', () => ({ raw: JSON.stringify({ pid: 2 ** 22 + 77, host: os.hostname(), token: 'x'.repeat(4000) }) })],
      ['owner pid 0, negative, fractional, string: never signalled, not taken over', null],
      ['a dead pid on a different host name is not taken over', () => ({ owner: { pid: 2 ** 22 + 99, host: 'some-other-machine' } })],
      ['an owner file that is a symlink is never read: not taken over', () => ({ owner: { pid: 2 ** 22 + 99 }, ownerAsSymlink: true })],
      ['the highest owner generation governs: owner.1 dead but owner.2 alive is not taken over', () => ({ older: { pid: 2 ** 22 + 5 }, owner: { pid: live.pid } })],
      ['a lock that lives 134 s with a live owner is not taken over (stale age is 135 s)', () => ({ owner: { pid: live.pid }, ageMs: STALE_MS - 5000 })],
    ];
    const outcomes = await Promise.all(cases.map(async ([name, spec]) => {
      if (!spec) {
        const verdicts = await Promise.all([0, -1, 1.5, '4242', null, true].map(async (pid) => {
          const c = setup();
          plant(c, { raw: JSON.stringify({ pid, host: os.hostname(), token: 't' }) });
          return holds(c, 4000);
        }));
        return [name, verdicts.every(Boolean)];
      }
      const c = setup();
      plant(c, spec());
      return [name, await holds(c, 4000)];
    }));
    for (const [name, ok] of outcomes) result(ok, `lock: ${name}`);

    // 3. a symlinked lock: never followed. Fresh: refused. Past the stale age: the link (not its target) is removed.
    {
      const c = setup();
      fs.mkdirSync(c.data, { recursive: true, mode: 0o700 });
      const target = path.join(c.dir, 'precious');
      fs.mkdirSync(target);
      fs.writeFileSync(path.join(target, 'owner.1'), JSON.stringify({ pid: await deadPid(), host: os.hostname(), token: 't' }));
      fs.writeFileSync(path.join(target, 'keep'), 'keep');
      fs.symlinkSync(target, c.lock);
      const fresh = await holds(c, 3000) ;
      result(fresh && fs.readdirSync(target).length === 2, 'lock: a symlinked lock whose target names a dead owner is refused (not followed) while fresh, and its target is untouched');
      const old = new Date(Date.now() - STALE_MS - 10000);
      fs.lutimesSync(c.lock, old, old);
      const r = await run(c, ['prepare']);
      result(r.status === 0 && !exists(c.lock) && fs.readdirSync(target).sort().join() === 'keep,owner.1' && exists(c.copy), 'lock: a symlinked lock past the stale age is replaced as a link only: the target and its files survive, prepare exits 0', `exit ${r.status}`);
    }

    // 4. the age rule: a live owner's lock older than the stale age is taken over; stage dirs of dead installs are swept.
    {
      const c = setup();
      plant(c, { owner: { pid: live.pid }, ageMs: STALE_MS + 10000 });
      const oldStage = path.join(c.data, `${c.id}.stage-1-aaaa`);
      const freshStage = path.join(c.data, `${c.id}.stage-2-bbbb`);
      const otherStage = path.join(c.data, 'mcp-0.0.0-0000000000000000.stage-3-cccc');
      for (const dir of [oldStage, freshStage, otherStage]) fs.mkdirSync(dir, { mode: 0o700 });
      const long = new Date(Date.now() - STALE_MS - 10000);
      fs.utimesSync(oldStage, long, long);
      fs.utimesSync(otherStage, long, long);
      const r = await run(c, ['prepare']);
      const names = entries(c);
      result(r.status === 0 && r.ms < 10000 && exists(c.copy) && !exists(c.lock), 'lock: a lock older than 135 s is taken over even with a live owner pid, prepare exits 0', `exit ${r.status}, ${r.ms} ms`);
      result(!names.includes(path.basename(oldStage)) && names.includes(path.basename(freshStage)) && names.includes(path.basename(otherStage)),
        'lock: the sweep removes only this install\'s stage dirs older than the stale age (a younger one and another version\'s are kept)');
    }

    // 4b. the age rule also frees locks whose owner file is missing or garbled once they are older than the stale age.
    for (const [name, spec] of [['ownerless', {}], ['garbled', { raw: '{not json' }]]) {
      const c = setup();
      plant(c, { ...spec, ageMs: STALE_MS + 10000 });
      const r = await run(c, ['prepare']);
      result(r.status === 0 && r.ms < 10000 && exists(c.copy) && !exists(c.lock), `lock: an ${name} lock older than 135 s is taken over, prepare exits 0`, `exit ${r.status}, ${r.ms} ms`);
    }

    // 5. concurrent takeovers end with exactly one owner: one npm run, all starts succeed, no lock or leftover.
    {
      const c = setup();
      plant(c, { owner: { pid: await deadPid() } });
      const shim = countingNpm('concurrent', { sleepSeconds: 2 });
      const runs = await Promise.all([1, 2, 3, 4, 5, 6].map(() => run(c, ['prepare'], shim)));
      const names = entries(c);
      result(runs.every((r) => r.status === 0) && shim.runs() === 1 && exists(c.copy) && names.length === 1 && names[0] === c.id,
        'lock: 6 concurrent starts over one dead owner\'s lock: exactly one install (one npm run), all exit 0, no lock or stage left', `npm runs ${shim.runs()}, exits ${runs.map((r) => r.status).join('')}, left ${names.length}`);
    }
    {
      const c = setup();
      plant(c, { owner: { pid: live.pid }, ageMs: STALE_MS + 10000 });
      const shim = countingNpm('concurrent-age', { sleepSeconds: 2 });
      const runs = await Promise.all([1, 2, 3, 4, 5, 6].map(() => run(c, ['prepare'], shim)));
      const names = entries(c);
      result(runs.every((r) => r.status === 0) && shim.runs() === 1 && names.length === 1 && names[0] === c.id,
        'lock: 6 concurrent starts over one stale-by-age lock: exactly one install, all exit 0, no lock or stage left', `npm runs ${shim.runs()}, left ${names.join(',')}`);
    }

    // 6. a winner's copy appears while ours is installing (the rename into place fails): a verified winner is used, a tampered one fails closed.
    {
      const c = setup();
      const shim = countingNpm('winner', { after: 'D="$(dirname "$PWD")"; ID="$(basename "$PWD")"; ID="${ID%%.stage-*}"; cp -a "$PWD" "$D/$ID"' });
      const r = await run(c, ['prepare'], shim);
      result(r.status === 0 && exists(path.join(c.copy, 'node_modules')) && !entries(c).some((n) => /\.stage-|\.lock/.test(n)), 'lock: the rename into place loses to another start\'s verified copy: that copy is used, prepare exits 0, our stage is removed', `exit ${r.status}`);
    }
    {
      const c = setup();
      const shim = countingNpm('tamper', { after: 'D="$(dirname "$PWD")"; ID="$(basename "$PWD")"; ID="${ID%%.stage-*}"; cp -a "$PWD" "$D/$ID"; for f in "$D/$ID"/node_modules/@getmarrow/mcp/dist/env.js; do chmod u+w "$f"; echo "// tamper" >> "$f"; done' });
      const r = await run(c, ['prepare'], shim);
      result(r.status === 1 && /Marrow plugin:/.test(r.stderr) && !entries(c).some((n) => /\.stage-|\.lock/.test(n)), 'lock: the rename loses to a copy that fails the hash check: nothing is used, prepare fails closed (exit 1), no stage or lock left', `exit ${r.status}`);
      const hook = spawnSync(process.execPath, [script(c), PRE], {
        cwd: path.join(c.home, 'project'), env: envFor(c), encoding: 'utf8', timeout: 20000, input: JSON.stringify({ hook_event_name: 'x', cwd: c.home }) });
      result(/not installed yet/.test(`${hook.stdout}${hook.stderr}`) && hook.status === (CURSOR ? 2 : 0), 'lock: with only the tampered copy on disk the pre-action hook still denies');
    }
  }

  async function finish() {
    try {
      if (!POSIX) {
        result(true, 'lock rows are POSIX-only (process.kill, lutimes, sh shims): skipped on this platform');
        return;
      }
      await main();
    } finally {
      for (const child of sleepers) child.kill('SIGKILL');
      spawnSync('chmod', ['-R', 'u+rwX', work], { stdio: 'ignore' });
      fs.rmSync(work, { recursive: true, force: true });
    }
  }
  return { finish };
}

module.exports = { start };

if (require.main === module) {
  const host = process.argv[2] === 'cursor' ? 'cursor' : 'claude';
  let pass = 0;
  let fail = 0;
  start({
    host,
    repo: path.resolve(__dirname, '..'),
    result: (ok, name, detail) => {
      if (ok) pass += 1; else fail += 1;
      process.stdout.write(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}\n`);
    },
  }).finish().then(() => {
    process.stdout.write(`RESULT pass=${pass} fail=${fail}\n`);
    process.exit(fail ? 1 : 0);
  });
}
