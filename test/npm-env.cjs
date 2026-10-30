'use strict';
// Test-only private npm environment: the ONE place that builds the environment of every npm child (and of the node children that run
// npm for the launcher) in the maintainer tests. Nothing under plugins/ or codex/ names or loads this file.
//   * From the runner it takes PATH, LANG, TMPDIR (and SystemRoot on Windows) and, for seeding only, the one path in npm_config_cache.
//     Nothing else: no npm_config_*, NPM_*, *_TOKEN or *_KEY name is copied, and the runner's npm user config file is never read, because
//     every config path npm would look at is set here, inside the test's temp root.
//   * HOME and USERPROFILE are the test's own folder. npm_config_userconfig is a file this helper writes (registry = a loopback port
//     nothing listens on, offline, no auth lines, no update notifier, no retries); npm_config_globalconfig is an empty file; the cache is
//     a seeded COPY (index copied, content files hard-linked or copied; the runner's cache is never written); the prefix is empty.
//   * NODE_OPTIONS carries --require <test/net-guard.cjs> first, so npm and every node process it starts run under the loopback guard.
//   * A test may add names through env(extra), but not the guard's own names, not the config-path names above, not a registry that is
//     not loopback, and not an NPM_ / token / auth name for npm: those throw, so a typo cannot reopen the network.
//   node test/npm-env.cjs --selftest
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const guard = require('./net-guard.cjs');

const DEAD_REGISTRY = 'http://127.0.0.1:9/';
const ALLOWED_EXTRA_NPM = new Set(['npm_config_registry', 'npm_config_cache', 'npm_config_fetch_retries', 'npm_config_fetch_timeout', 'npm_config_update_notifier', 'npm_config_offline', 'npm_config_audit', 'npm_config_fund', 'npm_config_loglevel', 'npm_config_ignore_scripts']);
const FORBIDDEN = /^(?:NETGUARD_|NPM_|npm_config_(?:userconfig|globalconfig|prefix|_auth|always_auth|proxy|https_proxy|noproxy|cafile|ca|registry_auth)|.*(?:_authToken|_auth|_password|TOKEN)$)/i;

function copyOrLink(from, to) {
  try { fs.linkSync(from, to); } catch { fs.copyFileSync(from, to); }
}

// index-v5 is copied (npm appends to it); content-v2 is content addressed and never rewritten, so its files are hard-linked.
function seedCache(source, target) {
  const cacache = path.join(target, '_cacache');
  fs.mkdirSync(path.join(cacache, 'tmp'), { recursive: true, mode: 0o700 });
  const from = source ? path.join(source, '_cacache') : '';
  if (!from || !fs.existsSync(from)) return 0;
  const walk = (src, dst, link) => {
    fs.mkdirSync(dst, { recursive: true, mode: 0o700 });
    let files = 0;
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      const a = path.join(src, entry.name);
      const b = path.join(dst, entry.name);
      if (entry.isDirectory()) files += walk(a, b, link);
      else if (entry.isFile()) { if (link) copyOrLink(a, b); else fs.copyFileSync(a, b); files += 1; }
    }
    return files;
  };
  let files = 0;
  if (fs.existsSync(path.join(from, 'index-v5'))) files += walk(path.join(from, 'index-v5'), path.join(cacache, 'index-v5'), false);
  if (fs.existsSync(path.join(from, 'content-v2'))) files += walk(path.join(from, 'content-v2'), path.join(cacache, 'content-v2'), true);
  return files;
}

function isLoopbackRegistry(value) {
  try {
    const url = new URL(String(value));
    return /^https?:$/.test(url.protocol) && guard.judgeHost(url.hostname) === 'loopback' && !url.username && !url.password;
  } catch {
    return false;
  }
}

// create({ root }): a private npm environment inside `root` (a temp folder of the test). Returns { env(extra), dir, log, seeded }.
function create({ root, home, cacheFrom = process.env.npm_config_cache } = {}) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) throw new Error('npm-env: root must be an absolute path');
  const dir = fs.mkdtempSync(path.join(root, 'npm-env-'));
  const homeDir = home || path.join(dir, 'home');
  const cache = path.join(dir, 'cache');
  const prefix = path.join(dir, 'prefix');
  const userconfig = path.join(dir, 'userconfig');
  const globalconfig = path.join(dir, 'globalconfig');
  const log = path.join(dir, 'netguard.tsv');
  for (const folder of [homeDir, cache, prefix]) fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  fs.writeFileSync(userconfig, [`registry=${DEAD_REGISTRY}`, 'offline=true', 'update-notifier=false', 'fetch-retries=0', 'audit=false', 'fund=false', ''].join('\n'), { mode: 0o600 });
  fs.writeFileSync(globalconfig, '', { mode: 0o600 });
  fs.writeFileSync(log, '', { mode: 0o600 });
  const seeded = seedCache(cacheFrom, cache);

  function env(extra = {}) {
    const out = {};
    for (const name of ['PATH', 'LANG', 'TMPDIR', 'SystemRoot']) if (process.env[name]) out[name] = process.env[name];
    Object.assign(out, {
      HOME: homeDir, USERPROFILE: homeDir,
      npm_config_userconfig: userconfig, npm_config_globalconfig: globalconfig, npm_config_cache: cache, npm_config_prefix: prefix,
      npm_config_registry: DEAD_REGISTRY, npm_config_offline: 'true', npm_config_update_notifier: 'false', npm_config_fetch_retries: '0',
    });
    let nodeOptions;
    for (const [name, value] of Object.entries(extra)) {
      if (name === 'NODE_OPTIONS') { nodeOptions = value; continue; }
      if (name === 'HOME' || name === 'USERPROFILE') { out[name] = value; continue; }
      if (FORBIDDEN.test(name) && !ALLOWED_EXTRA_NPM.has(name)) throw new Error(`npm-env: ${name} may not be set through env()`);
      if (/^npm_config_/i.test(name) && !ALLOWED_EXTRA_NPM.has(name)) throw new Error(`npm-env: ${name} may not be set through env()`);
      if (name === 'npm_config_registry' && !isLoopbackRegistry(value)) throw new Error('npm-env: the registry must be a loopback address');
      if (name === 'npm_config_cache' && !path.resolve(String(value)).startsWith(path.resolve(root) + path.sep)) throw new Error('npm-env: the cache must be inside the test root');
      out[name] = value;
    }
    return { ...out, ...guard.env({ log, root: dir, nodeOptions }) };
  }
  return { env, dir, log, seeded, userconfig, cache, home: homeDir };
}

module.exports = { create, seedCache, isLoopbackRegistry, DEAD_REGISTRY };

// ---- self-test ---------------------------------------------------------------------------------------------------------------------
function selftest() {
  const assert = require('node:assert/strict');
  const cp = require('node:child_process');
  const crypto = require('node:crypto');
  let pass = 0;
  let fail = 0;
  const row = (name, fn) => {
    try { const note = fn(); pass += 1; process.stdout.write(`PASS ${name}${note ? ` (${note})` : ''}\n`); } catch (error) { fail += 1; process.stdout.write(`FAIL ${name}: ${error.message}\n`); }
  };
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'npm-env-selftest-')));
  // A tiny fake runner cache; the real one is never touched by the self-test.
  const source = path.join(root, 'runner-cache');
  fs.mkdirSync(path.join(source, '_cacache', 'index-v5', 'aa'), { recursive: true });
  fs.mkdirSync(path.join(source, '_cacache', 'content-v2', 'sha512', 'bb'), { recursive: true });
  fs.writeFileSync(path.join(source, '_cacache', 'index-v5', 'aa', 'idx'), 'index\n');
  fs.writeFileSync(path.join(source, '_cacache', 'content-v2', 'sha512', 'bb', 'blob'), 'content\n');
  const dummy = `dummy-${crypto.randomBytes(8).toString('hex')}`;
  const poisoned = { ...process.env, NPM_TOKEN: dummy, npm_config_registry: 'http://registry.invalid/', npm_config_userconfig: path.join(root, 'runner-npmrc'), npm_config__authToken: dummy, SOME_API_KEY: dummy, npm_config_cache: source };
  Object.assign(process.env, poisoned);
  const npm = create({ root });
  const base = npm.env({});

  row('the runner is read only for PATH, LANG, TMPDIR and the cache path to seed from: no npm_config_*, NPM_*, token or key name is carried over', () => {
    const names = Object.keys(base).sort();
    const allowed = ['HOME', 'LANG', 'NETGUARD_LOG', 'NETGUARD_ROOT', 'NODE_OPTIONS', 'PATH', 'SystemRoot', 'TMPDIR', 'USERPROFILE', 'npm_config_cache', 'npm_config_fetch_retries', 'npm_config_globalconfig', 'npm_config_offline', 'npm_config_prefix', 'npm_config_registry', 'npm_config_update_notifier', 'npm_config_userconfig'];
    assert.deepEqual(names.filter((n) => !allowed.includes(n)), []);
    for (const value of Object.values(base)) assert.ok(!String(value).includes(dummy), 'a dummy runner value reached the child env');
    assert.equal(base.npm_config_registry, DEAD_REGISTRY);
    return `${names.length} names`;
  });
  row('every config path is inside the test root, HOME and USERPROFILE are the test\'s own folder, the runner\'s npm config file is not used', () => {
    for (const name of ['HOME', 'USERPROFILE', 'npm_config_userconfig', 'npm_config_globalconfig', 'npm_config_cache', 'npm_config_prefix']) assert.ok(base[name].startsWith(root + path.sep), name);
    assert.notEqual(base.npm_config_userconfig, process.env.npm_config_userconfig);
  });
  row('the user config file is written by this helper: loopback registry, offline, no auth, mode 0600', () => {
    const text = fs.readFileSync(npm.userconfig, 'utf8');
    assert.match(text, /^registry=http:\/\/127\.0\.0\.1:9\/$/m);
    assert.match(text, /^offline=true$/m);
    assert.ok(!/_auth|authToken|password|:_|\/\/[^\n]*:/i.test(text.replace(DEAD_REGISTRY, '')), 'an auth-looking line');
    assert.equal(fs.statSync(npm.userconfig).mode & 0o777, 0o600);
  });
  row('the cache is a seeded COPY: index copied, content linked or copied, and removing from the copy leaves the runner\'s cache alone', () => {
    const copy = path.join(npm.cache, '_cacache');
    assert.notEqual(copy, path.join(source, '_cacache'));
    assert.equal(fs.readFileSync(path.join(copy, 'index-v5', 'aa', 'idx'), 'utf8'), 'index\n');
    assert.equal(fs.readFileSync(path.join(copy, 'content-v2', 'sha512', 'bb', 'blob'), 'utf8'), 'content\n');
    assert.notEqual(fs.statSync(path.join(copy, 'index-v5', 'aa', 'idx')).ino, fs.statSync(path.join(source, '_cacache', 'index-v5', 'aa', 'idx')).ino, 'index must be a copy');
    fs.appendFileSync(path.join(copy, 'index-v5', 'aa', 'idx'), 'more\n');
    fs.rmSync(path.join(copy, 'content-v2', 'sha512', 'bb', 'blob'));
    assert.equal(fs.readFileSync(path.join(source, '_cacache', 'index-v5', 'aa', 'idx'), 'utf8'), 'index\n');
    assert.equal(fs.readFileSync(path.join(source, '_cacache', 'content-v2', 'sha512', 'bb', 'blob'), 'utf8'), 'content\n');
    return `${npm.seeded} files seeded`;
  });
  row('NODE_OPTIONS puts the loopback guard first, whatever a test adds', () => {
    const withExtra = npm.env({ NODE_OPTIONS: '--require=/elsewhere.cjs' });
    assert.ok(withExtra.NODE_OPTIONS.startsWith(`--require=${guard.GUARD_PATH}`));
    assert.ok(withExtra.NODE_OPTIONS.includes('--require=/elsewhere.cjs'));
    assert.ok(base.NODE_OPTIONS.startsWith(`--require=${guard.GUARD_PATH}`));
  });
  row('forbidden extras throw: the guard\'s own names, config paths, tokens, a non-loopback registry, a cache outside the root', () => {
    const bad = { NETGUARD_LOG: '/x', NETGUARD_ROOT: '/x', NETGUARD_TAG: 'x', npm_config_userconfig: '/x', npm_config_globalconfig: '/x', npm_config_prefix: '/x', NPM_TOKEN: 'x', npm_config__authToken: 'x', npm_config_proxy: 'http://x', npm_config_https_proxy: 'http://x', npm_config_cafile: '/x', MY_TOKEN: 'x', npm_config_registry: 'https://registry.npmjs.org/', npm_config_cache: path.join(path.dirname(root), `elsewhere-${process.pid}`), npm_config_unknown: 'x' };
    for (const [name, value] of Object.entries(bad)) assert.throws(() => npm.env({ [name]: value }), /npm-env/, name);
    assert.throws(() => npm.env({ npm_config_registry: 'http://127.0.0.1.evil.example/' }), /loopback/);
    assert.throws(() => npm.env({ npm_config_registry: 'http://user:pw@127.0.0.1:9/' }), /loopback/);
    assert.doesNotThrow(() => npm.env({ npm_config_registry: 'http://127.0.0.1:9/', npm_config_cache: path.join(root, 'empty'), npm_config_fetch_timeout: '2000', MARROW_API_KEY: 'a-dummy-made-at-run-time' }));
  });
  row('a real npm child under this environment reads OUR config, not the runner\'s, and reaches no network', () => {
    const run = (args) => cp.spawnSync('npm', args, { encoding: 'utf8', env: base, timeout: 90000 });
    assert.equal(run(['config', 'get', 'registry']).stdout.trim(), DEAD_REGISTRY);
    assert.equal(run(['config', 'get', 'userconfig']).stdout.trim(), npm.userconfig);
    assert.equal(run(['config', 'get', 'cache']).stdout.trim(), npm.cache);
    assert.equal(run(['config', 'get', 'offline']).stdout.trim(), 'true');
    const view = run(['view', 'lodash', 'version', '--prefer-online=false']);
    assert.notEqual(view.status, 0, 'an offline view of an uncached package must fail');
    assert.match(view.stdout + view.stderr, /ENOTCACHED|offline|ECONNREFUSED|EAI_AGAIN/i);
    assert.equal(guard.attemptsIn(npm.log).length, 0, 'the guard log holds an attempt');
    return `guard log lines: ${guard.readLog(npm.log).length}`;
  });
  row('the guard is really loaded in npm\'s node processes: a lookup of a public-looking name by a child of npm is refused and logged', () => {
    const probe = path.join(root, 'npm-probe.cjs');
    fs.writeFileSync(probe, "require('dns').lookup('guard-canary.getmarrow.ai', (e) => process.stdout.write(String(e && e.code)));");
    const r = cp.spawnSync(process.execPath, [probe], { encoding: 'utf8', env: { ...base, [guard.ENV.tag]: 'canary' }, timeout: 30000 });
    assert.equal(r.stdout, 'ENOTFOUND');
    assert.equal(guard.readLog(npm.log).filter((l) => l.tag === 'canary' && l.kind === 'refused').length, 1);
  });
  fs.rmSync(root, { recursive: true, force: true });
  process.stdout.write(`${fail ? `${fail} FAILED` : 'ALL PASS'} (${pass + fail} rows)\n`);
  process.exitCode = fail ? 1 : 0;
}
if (require.main === module && process.argv.includes('--selftest')) selftest();
