'use strict';
// Test isolation, part 2 (plugins): the seam (private HOME, scratch passwd home, empty private git config) and the spawn guard
// (a git push, fetch, pull, clone or ls-remote to a non-local address is refused, on every child_process function, even when the
// test swallows the refusal). Every address here ends in .invalid, which never resolves, and every refusal happens before a
// process starts. Run it alone, from the repository root:   node --test test/child-isolation.test.cjs
// The tools under tools/ are scripts, not node:test files; they load the same isolation first (test/isolate.cjs).
const { tempRoot: testTempRoot, home: isolatedHome, passwdHome } = require('./isolate.cjs');
const iso = require('./child-isolation.cjs');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const NODE = process.execPath;
const PATH = process.env.PATH;
const PROBE = path.join(__dirname, 'fixtures', 'isolation-probe.cjs');
const REPO_ROOT = path.resolve(__dirname, '..');
const HOST = 'example.invalid';
const SSH_USER = 'git@';
const quote = (word) => `'${String(word).replace(/'/g, "'\\''")}'`;
const textOf = (file, args) => [file, ...args].map(quote).join(' ');
const scratch = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const git = (cwd, ...args) => cp.spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t', ...args], { cwd, encoding: 'utf8', env: { PATH } });
const OPTIONS = () => ({ env: { PATH }, stdio: 'pipe' });
const writable = (folder) => {
  try {
    fs.accessSync(folder, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
};

const ARGV_FUNCTIONS = {
  spawn: (file, args, options) => cp.spawn(file, args, options),
  spawnSync: (file, args, options) => cp.spawnSync(file, args, options),
  execFile: (file, args, options) => cp.execFile(file, args, options, () => {}),
  execFileSync: (file, args, options) => cp.execFileSync(file, args, options),
  exec: (file, args, options) => cp.exec(textOf(file, args), options, () => {}),
  execSync: (file, args, options) => cp.execSync(textOf(file, args), options),
  'spawnSync with a shell': (file, args, options) => cp.spawnSync(file, args, { ...options, shell: true }),
  fork: (file, args, options) => cp.fork(PROBE, [file, ...args], options),
};
const TEXT_FUNCTIONS = {
  exec: (text, options) => cp.exec(text, options, () => {}),
  execSync: (text, options) => cp.execSync(text, options),
  'spawn with a shell': (text, options) => cp.spawn(text, [], { ...options, shell: true }),
  'spawnSync with a shell': (text, options) => cp.spawnSync(text, [], { ...options, shell: true }),
  'execFile sh -c': (text, options) => cp.execFile('sh', ['-c', text], options, () => {}),
  'execFileSync bash -lc': (text, options) => cp.execFileSync('bash', ['-lc', text], options),
};

function refused(run, what) {
  const error = iso.refuses(run);
  assert.ok(error, `${what}: the guard did not refuse`);
  assert.equal(error.code, 'ESPAWNGUARD', what);
  return error;
}
const gitRefused = (args, options, what) => {
  for (const [name, call] of Object.entries(ARGV_FUNCTIONS)) refused(() => call('git', args, { ...OPTIONS(), ...options }), `${what} / ${name}`);
};
const textRefused = (text, options, what) => {
  for (const [name, call] of Object.entries(TEXT_FUNCTIONS)) refused(() => call(text, { ...OPTIONS(), ...options }), `${what} / ${name}`);
};
const plan = (cwd, ...args) => iso.plan('spawnSync', 'git', args, { cwd, env: { PATH } });
function repoWith(config) {
  const root = scratch('iso-repo-');
  assert.equal(git(root, 'init', '-q').status, 0);
  fs.appendFileSync(path.join(root, '.git', 'config'), config);
  return root;
}
function collect(child) {
  return new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, out }));
  });
}

const URLS = {
  https: `https://${HOST}/o/r.git`,
  http: `http://${HOST}/o/r.git`,
  ssh: `ssh://${SSH_USER}${HOST}/o/r.git`,
  'git://': `git://${HOST}/o/r.git`,
  'scp-style': `${SSH_USER}${HOST}:o/r.git`,
  'host:path': `${HOST}:o/r.git`,
  'ext::': 'ext::sh -c true',
  'file:// with a host': `file://${HOST}/o/r.git`,
};

test('the isolation starts once per process: a private 0700 temp root that holds HOME and the scratch passwd home, and is the temp dir', () => {
  assert.equal(require('./isolate.cjs'), require('./isolate.cjs'), 'a second require is the same bootstrap, not a new temp root');
  assert.equal(fs.statSync(testTempRoot).mode & 0o777, 0o700);
  assert.equal(os.tmpdir(), testTempRoot);
  assert.equal(process.env.HOME, isolatedHome);
  for (const folder of [isolatedHome, passwdHome]) assert.ok(folder.startsWith(`${testTempRoot}/`));
  assert.notEqual(isolatedHome, iso.realPasswdHome());
  assert.notEqual(passwdHome, iso.realPasswdHome());
  assert.equal(os.userInfo().homedir, passwdHome, 'this process reads the scratch passwd home too');
});

test('every node child gets a private HOME, the scratch passwd home and a --require on its command line, no NODE_OPTIONS and no GIT_ names', async () => {
  const expected = { homeUnderTemp: true, passwdHomeIsScratch: true, noNodeOptions: true, noGitNames: true, preloaded: true };
  const args = [PROBE, testTempRoot, passwdHome];
  const calls = {
    spawn: async () => collect(cp.spawn(NODE, args, { env: { PATH } })),
    spawnSync: async () => { const r = cp.spawnSync(NODE, args, { env: { PATH }, encoding: 'utf8' }); return { code: r.status, out: r.stdout }; },
    execFile: () => new Promise((resolve) => cp.execFile(NODE, args, { env: { PATH } }, (error, stdout) => resolve({ code: error ? error.code : 0, out: stdout }))),
    execFileSync: async () => ({ code: 0, out: cp.execFileSync(NODE, args, { env: { PATH }, encoding: 'utf8' }) }),
  };
  for (const [name, call] of Object.entries(calls)) {
    const { code, out } = await call();
    assert.equal(code, 0, name);
    assert.deepEqual(JSON.parse(out), expected, name);
  }
  const forked = await new Promise((resolve, reject) => {
    const child = cp.fork(PROBE, [testTempRoot, passwdHome], { env: { PATH } });
    child.once('message', resolve);
    child.once('error', reject);
  });
  assert.deepEqual(forked, { ...expected, preloaded: true }, 'fork');
  // With the child's own explicit home under the temp dir, that home is kept.
  const own = scratch('iso-own-home-');
  const kept = iso.plan('spawnSync', NODE, [PROBE], { env: { PATH, HOME: own } });
  assert.equal(kept.refused, null);
  assert.equal(kept.argv[2].env.HOME, own);
});

test('HOME: unset becomes the private home; outside the temp dir, relative, empty or the real passwd home is refused (all 7 functions)', () => {
  const asArgs = (name, options) => (name === 'exec' || name === 'execSync' ? [name, 'true', options] : [name, name === 'fork' ? PROBE : NODE, name === 'fork' ? [] : ['-e', ''], options]);
  const envOf = (name, argv) => (name === 'exec' || name === 'execSync' ? argv[1] : argv[2]).env;
  for (const name of Object.keys(ARGV_FUNCTIONS).filter((key) => !key.includes('shell') && key !== 'exec' && key !== 'execSync').concat(['exec', 'execSync'])) {
    const filled = iso.plan(...asArgs(name, { env: { PATH } }));
    assert.equal(filled.refused, null, name);
    assert.equal(envOf(name, filled.argv).HOME, isolatedHome, `${name}: HOME is filled with the private home`);
    const inherited = iso.plan(...asArgs(name, {}));
    assert.equal(envOf(name, inherited.argv).HOME, process.env.HOME, `${name}: the inherited home is under the temp dir and kept`);
    for (const [label, home, pattern] of [['outside', '/nonexistent-home', /HOME is outside the test temp dir/], ['relative', 'some/dir', /HOME is relative/], ['empty', '', /HOME is empty/], ['the real passwd home', iso.realPasswdHome(), /HOME is the real passwd home/]]) {
      const result = iso.plan(...asArgs(name, { env: { PATH, HOME: home } }));
      assert.match(String(result.refused), pattern, `${name} with HOME ${label}`);
    }
  }
});

test('isolationOddHome waives only an empty, relative or unwritable absolute HOME, only with a cwd under the temp dir; the option is stripped before the real call', () => {
  const inside = scratch('iso-odd-cwd-');
  const outside = path.dirname(testTempRoot);
  const asArgs = (name, options) => (name === 'exec' || name === 'execSync' ? [name, 'true', options] : [name, name === 'fork' ? PROBE : NODE, name === 'fork' ? [] : ['-e', ''], options]);
  const optionsOf = (name, argv) => (name === 'exec' || name === 'execSync' ? argv[1] : argv[2]);
  const names = ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'fork', 'exec', 'execSync'];
  for (const name of names) {
    for (const [label, home] of [['empty', ''], ['relative', 'some/dir']]) {
      const planned = iso.plan(...asArgs(name, { env: { PATH, HOME: home }, cwd: inside, isolationOddHome: true }));
      assert.equal(planned.refused, null, `${name} with an ${label} HOME and the option`);
      const options = optionsOf(name, planned.argv);
      assert.equal(options.isolationOddHome, undefined, `${name}: the option is stripped before the real call`);
      assert.equal(options.env.HOME, home, `${name}: the child sees the HOME the row set`);
      assert.ok(String(options.env.SBT_PASSWD_HOME).startsWith(`${testTempRoot}/`), `${name}: the scratch passwd home is still given`);
      assert.match(String(iso.plan(...asArgs(name, { env: { PATH, HOME: home }, cwd: inside })).refused), /HOME is (empty|relative)/, `${name}: without the option it is refused`);
    }
    // Everything else stays refused, with the option and a cwd under the temp dir.
    for (const [label, home, pattern] of [
      ['the real passwd home', iso.realPasswdHome(), /HOME is the real passwd home/],
      ['a writable folder outside the temp dir', outside, /HOME is outside the test temp dir/],
      ['a folder that does not exist', '/nonexistent-home', /HOME is outside the test temp dir/],
    ]) {
      assert.match(String(iso.plan(...asArgs(name, { env: { PATH, HOME: home }, cwd: inside, isolationOddHome: true })).refused), pattern, `${name} with ${label}`);
    }
    // A cwd outside the temp dir, or none at all (the repository), takes the waiver away.
    assert.match(String(iso.plan(...asArgs(name, { env: { PATH, HOME: '' }, cwd: outside, isolationOddHome: true })).refused), /HOME is empty/, `${name}: cwd outside the temp dir`);
    assert.match(String(iso.plan(...asArgs(name, { env: { PATH, HOME: 'some/dir' }, isolationOddHome: true })).refused), /HOME is relative/, `${name}: no cwd`);
    // Only the boolean true counts, and a name in the child's environment is not the option.
    assert.match(String(iso.plan(...asArgs(name, { env: { PATH, HOME: '' }, cwd: inside, isolationOddHome: 'yes' })).refused), /HOME is empty/, `${name}: 'yes' is not true`);
    assert.match(String(iso.plan(...asArgs(name, { env: { PATH, HOME: '', isolationOddHome: 'true' }, cwd: inside })).refused), /HOME is empty/, `${name}: an environment name is not the option`);
  }
  // Another account's folder: allowed when this user cannot write there (as on a developer machine or this server), refused when it can (root).
  const other = ['/root', '/proc', '/sys', '/boot'].find((folder) => fs.existsSync(folder));
  const planned = iso.plan('spawnSync', NODE, ['-e', ''], { env: { PATH, HOME: other }, cwd: inside, isolationOddHome: true });
  if (writable(other)) assert.match(String(planned.refused), /HOME is outside the test temp dir/, 'writable here (root): refused');
  else assert.equal(planned.refused, null, 'not writable here: allowed');
});

test('isolationKeepsArgv leaves a node child\'s command line as built (no --require) but keeps the private HOME and scratch passwd name; the option is stripped; only true counts', () => {
  const kept = iso.plan('spawnSync', NODE, [PROBE], { env: { PATH }, isolationKeepsArgv: true });
  assert.equal(kept.refused, null);
  assert.deepEqual(kept.argv[1], [PROBE]);
  assert.equal(kept.argv[2].isolationKeepsArgv, undefined);
  assert.equal(kept.argv[2].env.HOME, isolatedHome);
  assert.equal(kept.argv[2].env.SBT_PASSWD_HOME, passwdHome);
  assert.deepEqual(iso.plan('spawnSync', NODE, [PROBE], { env: { PATH } }).argv[1].slice(0, 2), ['--require', iso.SELF]);
  assert.deepEqual(iso.plan('spawnSync', NODE, [PROBE], { env: { PATH }, isolationKeepsArgv: 'yes' }).argv[1].slice(0, 2), ['--require', iso.SELF]);
  // It never waives the home check.
  assert.match(String(iso.plan('spawnSync', NODE, [PROBE], { env: { PATH, HOME: '/nonexistent-home' }, isolationKeepsArgv: true }).refused), /HOME is outside the test temp dir/);
});

test('a scratch passwd home that is relative or the real one is refused for a node child', () => {
  assert.match(String(iso.plan('spawnSync', NODE, ['-e', ''], { env: { PATH, SBT_PASSWD_HOME: 'relative' } }).refused), /SBT_PASSWD_HOME is not a scratch folder/);
  assert.match(String(iso.plan('spawnSync', NODE, ['-e', ''], { env: { PATH, SBT_PASSWD_HOME: iso.realPasswdHome() } }).refused), /SBT_PASSWD_HOME is not a scratch folder/);
  const own = scratch('iso-own-passwd-');
  assert.equal(iso.plan('spawnSync', NODE, ['-e', ''], { env: { PATH, SBT_PASSWD_HOME: own } }).argv[2].env.SBT_PASSWD_HOME, own);
});

test('a child that is not node gets empty private git config files, no credential helper, no prompt, only the file protocol, and no askpass or ssh names', () => {
  const probe = 'printf "%s\\n" "$GIT_CONFIG_GLOBAL" "$GIT_CONFIG_SYSTEM" "$GIT_CONFIG_NOSYSTEM" "$GIT_TERMINAL_PROMPT" "$GIT_ALLOW_PROTOCOL" "${GIT_ASKPASS-unset}" "${SSH_ASKPASS-unset}" "${GIT_SSH_COMMAND-unset}" "${GIT_CONFIG_COUNT-unset}" "$HOME"';
  const ambient = { GIT_ASKPASS: 'ambient-a', SSH_ASKPASS: 'ambient-b', GIT_SSH_COMMAND: 'ambient-c', GIT_CONFIG_COUNT: '0' };
  const saved = Object.fromEntries(Object.keys(ambient).map((name) => [name, process.env[name]]));
  Object.assign(process.env, ambient);
  try {
    const rows = {
      spawnSync: () => cp.spawnSync('sh', ['-c', probe], { env: { PATH }, encoding: 'utf8' }).stdout,
      'spawnSync, inherited environment': () => cp.spawnSync('sh', ['-c', probe], { encoding: 'utf8' }).stdout,
      'spawnSync, ambient names copied by the test': () => cp.spawnSync('sh', ['-c', probe], { env: { ...process.env }, encoding: 'utf8' }).stdout,
      execFileSync: () => cp.execFileSync('sh', ['-c', probe], { env: { PATH }, encoding: 'utf8' }),
      execSync: () => cp.execSync(probe, { env: { PATH }, encoding: 'utf8' }),
    };
    for (const [name, run] of Object.entries(rows)) {
      const lines = run().split('\n');
      for (const file of lines.slice(0, 2)) {
        assert.ok(file.startsWith(`${testTempRoot}/`), `${name}: a private file under the test temp dir`);
        const stat = fs.statSync(file);
        assert.equal(stat.size, 0, `${name}: empty`);
        assert.equal(stat.mode & 0o777, 0o600, `${name}: mode 600`);
      }
      assert.deepEqual(lines.slice(2, 9), ['1', '0', 'file', 'unset', 'unset', 'unset', 'unset'], name);
      assert.equal(lines[9], name.includes('inherited') ? process.env.HOME : isolatedHome, `${name}: HOME`);
    }
    const own = path.join(scratch('iso-own-config-'), 'gitconfig');
    fs.writeFileSync(own, '', { mode: 0o600 });
    assert.equal(iso.plan('spawnSync', 'git', ['status'], { env: { PATH, GIT_CONFIG_GLOBAL: own } }).argv[2].env.GIT_CONFIG_GLOBAL, own, 'a test\'s own config file under the temp dir is kept');
    assert.notEqual(iso.plan('spawnSync', 'git', ['status'], { env: { PATH, GIT_CONFIG_GLOBAL: '/nonexistent/config' } }).argv[2].env.GIT_CONFIG_GLOBAL, '/nonexistent/config', 'one outside it is replaced');
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test('a git or sh child is refused when the test itself sets an ssh, askpass, proxy, exec-path or config-injection name; a node child is not given or refused any GIT_ name', () => {
  for (const name of ['GIT_SSH_COMMAND', 'GIT_SSH', 'GIT_ASKPASS', 'SSH_ASKPASS', 'GIT_PROXY_COMMAND', 'GIT_EXEC_PATH', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0']) {
    const value = `dummy-${crypto.randomBytes(6).toString('hex')}`;
    for (const [fn, file, args] of [['spawnSync', 'git', ['status']], ['execFileSync', 'sh', ['-c', 'true']]]) {
      const error = refused(() => cp[fn](file, args, { env: { PATH, [name]: value } }), `${name} / ${fn}`);
      assert.ok(error.message.includes(name), `${name}: named`);
      assert.ok(!error.message.includes(value), `${name}: its value is never in the message`);
    }
  }
  refused(() => cp.spawnSync('git', ['status'], { env: { PATH, GIT_ALLOW_PROTOCOL: 'https:file' } }), 'GIT_ALLOW_PROTOCOL with more than file');
  // A node child (the shipped hook reads GIT_* names as the agent's environment) is left alone: nothing added, nothing refused.
  const planned = iso.plan('spawnSync', NODE, ['-e', ''], { env: { PATH, GIT_ASKPASS: 'x' } });
  assert.equal(planned.refused, null);
  assert.equal(planned.argv[2].env.GIT_ASKPASS, 'x');
  assert.deepEqual(Object.keys(planned.argv[2].env).filter((name) => name.startsWith('GIT_') && name !== 'GIT_ASKPASS'), []);
});

test('a planted global git config (credential helper, insteadOf rewrite, identity, XDG config) is invisible to a git child', () => {
  const home = scratch('iso-planted-home-');
  const xdg = path.join(scratch('iso-planted-xdg-'));
  fs.mkdirSync(path.join(xdg, 'git'));
  const planted = `[user]\n\tname = planted\n[credential]\n\thelper = store\n[url "https://${HOST}/"]\n\tinsteadOf = up:\n`;
  fs.writeFileSync(path.join(home, '.gitconfig'), planted);
  fs.writeFileSync(path.join(xdg, 'git', 'config'), planted);
  for (const key of ['user.name', 'credential.helper', 'url.https://example.invalid/.insteadof']) {
    const result = cp.spawnSync('git', ['config', '--get', key], { env: { PATH, HOME: home, XDG_CONFIG_HOME: xdg }, encoding: 'utf8' });
    assert.equal(result.status, 1, `${key} is not visible`);
    assert.equal(result.stdout, '');
  }
});

test('local work still passes: init, commit, log, status, branch/tag/message words like push, local push, fetch, pull, clone and ls-remote between temp repos, file://, git archive of a local ref, npm in the private HOME', () => {
  const root = scratch('iso-local-');
  const bare = path.join(root, 'bare.git');
  const work = path.join(root, 'work');
  const other = path.join(root, 'other');
  for (const result of [
    git(root, 'init', '-q', '--bare', bare),
    git(root, 'init', '-q', work),
    git(work, 'commit', '-q', '--allow-empty', '-m', 'push the fetch and clone words'),
    git(work, 'branch', 'push'),
    git(work, 'tag', 'pull'),
    git(work, 'checkout', '-q', '-b', 'clone'),
    git(work, 'status'),
    git(work, '--no-pager', 'log', '-1'),
    git(root, '-C', work, 'log', '-1'),
    git(work, 'archive', '-o', path.join(root, 'tree.tar'), 'HEAD'),
    git(work, 'remote', 'add', 'origin', bare),
    git(work, 'push', '-q', 'origin', 'HEAD:refs/heads/push'),
    git(work, 'push', '-q', `file://${bare}`, 'HEAD:refs/heads/viafile'),
    git(work, 'push', '-q', bare, 'HEAD:refs/heads/master'),
    git(work, 'fetch', '-q', 'origin'),
    git(work, 'fetch', '-q', '--all'),
    git(work, 'ls-remote', 'origin'),
    git(work, 'ls-remote', bare),
    git(root, 'clone', '-q', bare, other),
    git(other, 'pull', '-q', 'origin', 'push'),
    git(work, 'remote', 'update'),
  ]) assert.equal(result.status, 0, result.stderr);
  assert.equal(cp.execSync(`cd ${quote(work)} && git status --short && git log -1 --format=%s`, { env: { PATH }, encoding: 'utf8' }).includes('push the fetch'), true);
  for (const [key, folder] of [['userconfig', isolatedHome], ['cache', isolatedHome]]) {
    const npm = cp.spawnSync('npm', ['config', 'get', key], { env: { PATH }, encoding: 'utf8' });
    assert.equal(npm.status, 0, npm.stderr);
    assert.ok(npm.stdout.trim().startsWith(`${folder}/`), `npm's ${key} is in the private HOME, not the caller's`);
  }
  // Accepted by the guard when the remote is local, whatever the words around it.
  const local = repoWith(`[url "${bare}"]\n\tinsteadOf = up\n[remote "origin"]\n\turl = ${bare}\n`);
  for (const args of [['ls-remote', 'up'], ['push', 'origin'], ['fetch', 'origin'], ['push', '--', bare], ['-C', work, '--no-pager', 'fetch', bare], ['remote', 'add', 'x', URLS.https], ['commit', '-m', `push ${URLS.https}`], ['remote', '-v'], ['archive', 'HEAD']]) {
    assert.equal(plan(local, ...args).refused, null, args.join(' ').replace(/https:\/\/\S+/, '<url>'));
  }
  assert.equal(iso.plan('execSync', `echo "git push ${URLS.https}"`, { cwd: local, env: { PATH } }).refused, null, 'quoted text that only mentions git');
});

test('abuse: every non-local address form x git push, fetch, pull, ls-remote, clone, push after -- (every child_process function)', () => {
  const commands = {
    push: (url) => ['push', url, 'HEAD:main'],
    fetch: (url) => ['fetch', url],
    pull: (url) => ['pull', url, 'main'],
    'ls-remote': (url) => ['ls-remote', url],
    clone: (url) => ['clone', url, 'dest'],
    'push after --': (url) => ['push', '--', url],
  };
  for (const [form, url] of Object.entries(URLS)) {
    for (const [command, build] of Object.entries(commands)) gitRefused(build(url), {}, `${command} ${form}`);
  }
});

test('abuse: config keys, unknown flags, misleading words and other network subcommands (every child_process function)', () => {
  const rows = {
    '-c remote.x.url': ['-c', `remote.x.url=${URLS.https}`, 'fetch', 'x'],
    '-c url insteadOf': ['-c', `url.https://${HOST}/.insteadOf=up:`, 'push', 'up:o/r.git'],
    '-c url pushInsteadOf': ['-c', `url.https://${HOST}/.pushInsteadOf=up:`, 'push', 'up:o/r'],
    'repeated -c insteadOf (last wins)': ['-c', 'url.a.insteadOf=x', '-c', `url.https://${HOST}/.insteadOf=x`, 'fetch', 'x'],
    '--config-env remote url': ['--config-env=remote.x.url=SOMEVAR', 'fetch', 'x'],
    '-c credential.helper on a local command': ['-c', 'credential.helper=store', 'status'],
    '-c core.sshCommand on a local command': ['-c', 'core.sshCommand=ssh -o X=1', 'status'],
    '-c alias to push': ['-c', 'alias.p=push', 'p', 'origin'],
    '-c http.proxy': ['-c', 'http.proxy=http://127.0.0.1:9', 'fetch', 'origin'],
    'unknown flag before push': ['-C', '.', '--frobnicate', 'push', URLS.https],
    'unknown flag before a remote by name': ['--frobnicate', 'fetch', 'origin'],
    '--exec-path with a value': ['--exec-path=/nowhere', 'status'],
    'a directory named push': ['-C', 'push', 'push', URLS.https],
    'a git-dir named fetch': ['--git-dir=fetch', 'fetch', URLS.https],
    'url after a value option': ['push', '-o', 'x', URLS.http],
    'upload-pack with an ssh url': ['fetch', '--upload-pack=x', URLS.ssh],
    'submodule recursion': ['fetch', '--recurse-submodules=yes', 'origin'],
    'submodule add': ['submodule', 'add', URLS.https, 'sub'],
    'archive --remote': ['archive', `--remote=${URLS.ssh}`, 'HEAD'],
    'remote add -f': ['remote', 'add', '-f', 'x', URLS.https],
    lfs: ['lfs', 'pull'],
    svn: ['svn', 'fetch'],
    'send-email': ['send-email', 'x.patch'],
    'an unknown subcommand (an alias or an external command)': ['frobnicate'],
  };
  for (const [name, args] of Object.entries(rows)) gitRefused(args, {}, name);
});

test('abuse: configured remotes, rewrites and branch remotes in the repository config (every child_process function)', () => {
  const bare = path.join(scratch('iso-bare-'), 'bare.git');
  const configs = {
    'origin is https': { text: `[remote "origin"]\n\turl = ${URLS.https}\n`, commands: [['push'], ['push', 'origin'], ['push', 'origin', 'HEAD:main'], ['fetch'], ['fetch', '--all'], ['pull'], ['remote', 'update'], ['ls-remote', 'origin'], ['push', '--mirror']] },
    'pushurl is https while url is local': { text: `[remote "origin"]\n\turl = ${bare}\n\tpushurl = ${URLS.https}\n`, commands: [['push', 'origin'], ['push']] },
    'insteadOf turns a plain word into https': { text: `[url "https://${HOST}/"]\n\tinsteadOf = up\n`, commands: [['push', 'up'], ['fetch', 'up']] },
    'pushInsteadOf turns a plain word into https': { text: `[url "https://${HOST}/"]\n\tpushInsteadOf = up\n`, commands: [['push', 'up']] },
    'insteadOf rewrites a local path prefix to https': { text: `[url "https://${HOST}/"]\n\tinsteadOf = ${os.tmpdir()}/\n`, commands: [['push', `${os.tmpdir()}/x.git`]] },
    'the branch remote is a url': { text: `[branch "main"]\n\tremote = ${URLS.https}\n`, commands: [['push'], ['pull']] },
    'a second remote is ssh': { text: `[remote "origin"]\n\turl = ${bare}\n[remote "mirror"]\n\turl = ${URLS['scp-style']}\n`, commands: [['push'], ['fetch', '--all'], ['remote', 'update']] },
    'a submodule url is https': { text: `[submodule "s"]\n\turl = ${URLS.https}\n`, commands: [['submodule', 'update', '--init']] },
    'an alias to push': { text: '[alias]\n\tp = push\n', commands: [['p', 'origin']] },
  };
  for (const [name, { text, commands }] of Object.entries(configs)) {
    const repo = repoWith(text);
    for (const args of commands) gitRefused(args, { cwd: repo }, `${name}: git ${args.join(' ')}`);
    for (const args of commands) gitRefused(['-C', repo, ...args], {}, `${name}: git -C ${args.join(' ')}`);
  }
  // A rewrite in the test's own global config file is read the way git will read it.
  const globalFile = path.join(scratch('iso-own-global-'), 'gitconfig');
  fs.writeFileSync(globalFile, `[url "https://${HOST}/"]\n\tinsteadOf = up\n`, { mode: 0o600 });
  gitRefused(['push', 'up'], { env: { PATH, GIT_CONFIG_GLOBAL: globalFile } }, 'a rewrite in the test\'s own GIT_CONFIG_GLOBAL');
  // The net: a child that reaches ChildProcess.spawn without a wrapped function is checked as it stands.
  refused(() => new cp.ChildProcess().spawn({ file: 'git', args: ['git', 'push', URLS.https], envPairs: [`PATH=${PATH}`] }), 'ChildProcess.spawn with a git push and no seam');
  refused(() => new cp.ChildProcess().spawn({ file: 'true', args: ['true'], envPairs: [`PATH=${PATH}`] }), 'ChildProcess.spawn without the seam');
  const onlyLocal = repoWith(`[remote "origin"]\n\turl = ${bare}\n[remote "mirror"]\n\turl = ${URLS['scp-style']}\n`);
  assert.equal(plan(onlyLocal, 'push', 'origin').refused, null, 'a named local remote is judged on its own addresses');
  assert.match(String(plan(onlyLocal, 'push', 'mirror').refused), /non-local/);
});

test('abuse: chaining and shell forms inside a child command (exec, execSync, spawn/spawnSync with a shell, sh -c, bash -lc)', () => {
  const U = URLS.https;
  const chains = {
    '&&': `true && git push ${U} HEAD:main`,
    ';': `git status; git push ${U}`,
    '||': `false || git fetch ${U}`,
    pipe: `echo x | git push ${U}`,
    subshell: `(git push ${U})`,
    '$( )': `echo $(git ls-remote ${U})`,
    backticks: `echo \`git ls-remote ${U}\``,
    'inside double quotes': `echo "$(git push ${U})"`,
    'sh -c': `sh -c 'git push ${U}'`,
    'nested bash -c': `bash -c "bash -c 'git push ${U}'"`,
    'absolute path': `/usr/bin/git push ${U}`,
    'env prefix': `env FOO=1 git push ${U}`,
    nohup: `nohup git push ${U}`,
    time: `time git push ${U}`,
    eval: `eval "git push ${U}"`,
    newline: `true\ngit push ${U}`,
    background: `git push ${U} &`,
    redirect: `git push ${U} > /dev/null 2>&1`,
    'brace group': `{ git push ${U}; }`,
    if: `if true; then git push ${U}; fi`,
    'a url in a variable': `U=${U}; git push $U`,
    'a variable in braces': 'git push ${U}',
    'a url from a command substitution': `git push $(echo ${U})`,
    'a url in -c remote.x.url': `git -c remote.x.url=${U} fetch x`,
    'an unknown flag before the subcommand': `git -C . --frobnicate push ${U}`,
    'after --': `git push -- ${U}`,
  };
  for (const [name, text] of Object.entries(chains)) textRefused(text, {}, name);
});

test('a url that a shell variable or a pipe hides from the guard is stopped by git itself: GIT_ALLOW_PROTOCOL=file refuses the https transport', () => {
  const result = cp.spawnSync('sh', ['-c', `G=git; U=${URLS.https}; $G ls-remote $U`], { env: { PATH }, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not allowed/, 'git refused the transport before any lookup');
});

test('refusal messages carry the subcommand and a reason, never a url, a credential or an environment value', () => {
  const secret = `tok_${crypto.randomBytes(12).toString('hex')}`;
  const urlWithCredential = `https://user:${secret}@${HOST}/o/r.git`;
  const repo = repoWith(`[remote "origin"]\n\turl = ${urlWithCredential}\n`);
  const errors = [
    refused(() => cp.spawnSync('git', ['push', urlWithCredential], OPTIONS()), 'url'),
    refused(() => cp.execSync(`git fetch ${urlWithCredential}`, OPTIONS()), 'text'),
    refused(() => cp.spawnSync('git', ['push', 'origin'], { ...OPTIONS(), cwd: repo }), 'configured remote'),
    refused(() => cp.spawnSync('git', ['-c', `remote.x.url=${urlWithCredential}`, 'fetch', 'x'], OPTIONS()), 'config key'),
    refused(() => cp.spawnSync('git', ['status'], { env: { PATH, GIT_SSH_COMMAND: secret } }), 'env name'),
    refused(() => cp.spawnSync('git', ['status'], { env: { PATH, HOME: `/outside/${secret}` } }), 'home'),
    refused(() => cp.spawnSync(NODE, ['-e', ''], { env: { PATH, HOME: `/outside/${secret}` }, cwd: repo, isolationOddHome: true }), 'home with the option'),
  ];
  for (const error of errors) {
    for (const text of [error.message, String(error.stack)]) {
      assert.ok(!text.includes(secret) && !text.includes(HOST) && !text.includes('user:'), 'no url, host or credential in the message or stack');
    }
    assert.match(error.message, /^ESPAWNGUARD at (\S*\/)?test\/child-isolation\.test\.cjs:\d+: /);
  }
});

test('a refusal that the test swallows still fails the test and the run (nested node --test); a local push in the same shape passes', () => {
  const nested = (fixture) => cp.spawnSync(NODE, ['--test', path.join(__dirname, 'fixtures', fixture)], { env: { PATH }, encoding: 'utf8' });
  const swallowed = nested('git-push-swallow.cjs');
  assert.notEqual(swallowed.status, 0, 'the nested run is red');
  assert.match(swallowed.stdout, /not ok/);
  const control = nested('git-push-local-control.cjs');
  assert.equal(control.status, 0, control.stdout.slice(-600));
});

test('static: every tool that can start a child loads the isolation before child_process; nothing under plugins/ or codex/ names the helper; the vendored pins are untouched', () => {
  const READ = (file) => fs.readFileSync(file, 'utf8');
  const CHILD = /require\((['"])(node:)?child_process\1\)/;
  const ISOLATE = "require('../test/isolate.cjs')";
  const tools = fs.readdirSync(path.join(REPO_ROOT, 'tools')).filter((name) => name.endsWith('.cjs'));
  const spawners = tools.filter((name) => CHILD.test(READ(path.join(REPO_ROOT, 'tools', name)))).sort();
  assert.deepEqual(spawners, ['bench-hooks.cjs', 'pins-check-ci.cjs', 'test-launcher-lock.cjs', 'test-launcher-t2.cjs', 'test-launcher-win32.cjs', 'test-launcher.cjs', 'test-session-check.cjs']);
  for (const name of spawners) {
    const text = READ(path.join(REPO_ROOT, 'tools', name));
    const first = text.indexOf(ISOLATE);
    assert.ok(first >= 0 && first < text.search(CHILD), `tools/${name} loads the isolation before child_process`);
  }
  const names = ['child-isolation', 'isolate.cjs', 'SBT_', 'isolationKeepsArgv', 'isolationOddHome', 'isolationShellNode', 'SPAWN_GUARD', 'ESPAWNGUARD'];
  const walk = (directory) => fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => (entry.name === 'node_modules' ? [] : entry.isDirectory() ? walk(path.join(directory, entry.name)) : [path.join(directory, entry.name)]));
  const shipped = ['plugins', 'codex'].flatMap((directory) => walk(path.join(REPO_ROOT, directory)));
  assert.ok(shipped.length > 20);
  for (const file of shipped) {
    const text = fs.readFileSync(file, 'latin1');
    for (const name of names) assert.ok(!text.includes(name), `${path.relative(REPO_ROOT, file)} does not name ${name}`);
  }
  const sums = READ(path.join(REPO_ROOT, 'tools', 'mcp-pins', 'SHA256SUMS')).split('\n').filter(Boolean).map((line) => line.split(/\s+/));
  assert.equal(sums.length, 2);
  for (const [digest, file] of sums) assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(REPO_ROOT, 'tools', 'mcp-pins', file))).digest('hex'), digest, `${file} equals SHA256SUMS`);
});

// ---- network lint (plugins-test-network): the five test tools must use the shared, private npm environment and the loopback guard ----
// networkLint() judges the text of a tool: no npm_config_* copied from the runner, the npm-env helper loaded, and every spawn of node or npm
// (spawn, spawnSync, execFile, execFileSync, fork) carries an env option, so no child can inherit the runner's registry, token or proxy.
const NETWORK_TOOLS = ['test-launcher.cjs', 'test-launcher-lock.cjs', 'test-launcher-t2.cjs', 'test-launcher-win32.cjs', 'test-session-check.cjs'];
function callsOf(text) {
  // returns [{ name, args }] for each spawn-like call, where args is the balanced text between the call parentheses
  const out = [];
  const code = text.replace(/^\s*\/\/.*$/gm, '');
  const open = /(?<![\w.$])(?:cp\.|child_process\.)?(spawnSync|spawn|execFileSync|execFile|fork)\s*\(/g;
  let match;
  while ((match = open.exec(code)) !== null) {
    let depth = 1;
    let index = open.lastIndex;
    const modes = [];
    while (index < code.length && depth > 0) {
      const ch = code[index];
      const mode = modes[modes.length - 1];
      if (mode === 'template') {
        if (ch === '\\') index += 1;
        else if (ch === '`') modes.pop();
        else if (ch === '$' && code[index + 1] === '{') { modes.push('expr'); index += 1; }
      } else if (mode === "'" || mode === '"') {
        if (ch === '\\') index += 1;
        else if (ch === mode) modes.pop();
      } else if (ch === "'" || ch === '"') modes.push(ch);
      else if (ch === '`') modes.push('template');
      else if (ch === '{' && mode === 'expr') modes.push('expr');
      else if (ch === '}' && mode === 'expr') modes.pop();
      else if (modes.length === 0 || mode === 'expr') {
        if (ch === '(') depth += 1;
        else if (ch === ')') depth -= 1;
      }
      index += 1;
    }
    out.push({ name: match[1], args: code.slice(open.lastIndex, index - 1) });
  }
  return out;
}
function networkLint(name, text) {
  const problems = [];
  const code = text.replace(/^\s*\/\/.*$/gm, '');
  if (!/require\((['"])\.\.\/test\/npm-env\.cjs\1\)/.test(code) && name !== 'test-session-check.cjs') problems.push('does not load test/npm-env.cjs');
  if (name === 'test-session-check.cjs' && !/require\((['"])\.\.\/test\/net-guard\.cjs\1\)/.test(code)) problems.push('does not load test/net-guard.cjs');
  if (/\.\.\.\s*process\.env\b(?!\.)/.test(code) || /Object\.assign\(\s*\{[^}]*\}\s*,\s*process\.env\b(?!\.)/.test(code) || /\benv\s*:\s*process\.env\b(?!\.)/.test(code)) problems.push('copies the whole runner environment');
  for (const line of code.split('\n')) if (/process\.env\[/.test(line) && /npm_config_|NPM_/i.test(line)) problems.push(`copies an npm name from the runner: ${line.trim().slice(0, 90)}`);
  if (/for \(const \w+ of \[[^\]]*'npm_config_[a-z_]+'[^\]]*\]\)\s*if \(process\.env/.test(code)) problems.push('copies an npm_config_ name from the runner');
  const NODE_OR_NPM = /^\s*(?:process\.execPath|noNpmNode|opts\.node|node\b|'node'|"node"|[\w.]*node\w*\s*\|\||process\.platform\s*===\s*'win32'\s*\?\s*'npm\.cmd'|'npm'|"npm"|'npm\.cmd')/;
  let spawns = 0;
  for (const call of callsOf(code)) {
    if (!NODE_OR_NPM.test(call.args)) continue;
    spawns += 1;
    if (!/\benv\b/.test(call.args)) problems.push(`${call.name}(${call.args.trim().slice(0, 60).replace(/\s+/g, ' ')}...) has no env option`);
  }
  return { problems, spawns };
}

test('lint: the five test tools run every node and npm child on the private npm environment and the shared guard; master\'s versions fail the same lint', () => {
  const BASE = '1a7f043f352ab3cceac2bf2c3fa5832922b2d7c5';
  const head = {};
  for (const name of NETWORK_TOOLS) {
    head[name] = networkLint(name, fs.readFileSync(path.join(REPO_ROOT, 'tools', name), 'utf8'));
    assert.deepEqual(head[name].problems, [], `tools/${name}: ${head[name].problems.join('; ')}`);
    assert.ok(head[name].spawns >= 1, `tools/${name}: the scan found its node/npm spawns (${head[name].spawns})`);
  }
  // the lint itself: synthetic bad and good shapes (nested parens, template strings, shell words in strings)
  const bad = [
    "const { spawnSync } = require('child_process');\nspawnSync(process.execPath, ['-e', '0'], { stdio: 'ignore' });",
    "const { spawn } = require('child_process');\nspawn(process.execPath, [path.join(a, 'b(')], { cwd: x });",
    "cp.spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['ci'], { cwd: dir });",
    "execFileSync('node', [`${f(1)}`]);",
    "const env = { ...process.env };",
    "for (const name of ['PATH', 'npm_config_registry']) if (process.env[name]) out[name] = process.env[name];",
    "const e = { env: process.env };",
  ];
  const good = [
    "const NPM = require('../test/npm-env.cjs');\nspawnSync(process.execPath, ['-e', '0'], { stdio: 'ignore', env: NPM.env() });\nspawn('chmod', ['-R', 'u+rwX', dir], { stdio: 'ignore' });\n// spawn(process.execPath) in a comment",
    "const NPM = require('../test/npm-env.cjs');\nspawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['ci', `--prefix=${a(b)}`], { cwd: dir, env: NPM.env({ HOME: h }) });",
  ];
  const lintOf = (text) => networkLint('test-launcher.cjs', text).problems;
  for (const text of bad) assert.ok(lintOf(text).length > 0, `lint flags: ${text.slice(0, 70)}`);
  for (const text of good) assert.deepEqual(lintOf(text), [], `lint passes: ${text.slice(0, 70)}`);
  // RED-first: the same lint on the tools as they stand at the base commit
  const red = {};
  for (const name of ['test-launcher.cjs', 'test-launcher-lock.cjs', 'test-launcher-t2.cjs']) {
    const shown = git(REPO_ROOT, 'show', `${BASE}:tools/${name}`);
    assert.equal(shown.status, 0, `git show ${BASE.slice(0, 7)}:tools/${name}`);
    red[name] = networkLint(name, shown.stdout).problems;
    assert.ok(red[name].length > 0, `the base version of tools/${name} fails the lint`);
  }
  assert.ok(Object.values(red).every((list) => list.some((line) => /npm-env|npm name|npm_config_|no env option/.test(line))));
});

// ---- patch round 1 (aud-test-iso-2c findings F1 to F5) -------------------------------------------------------------------
// These rows judge a command with plan() so that nothing is started: a bundle URI or a missed refusal must never reach a network.
const planOf = (cwd, args) => iso.plan('spawnSync', 'git', args, { cwd, env: { PATH } });
const planRefusedRows = (cwd, rows, pattern) => {
  for (const [name, args] of Object.entries(rows)) assert.match(String(planOf(cwd, args).refused), pattern, `${name}: git ${args.join(' ').replace(new RegExp(`\\S*${HOST}\\S*`, 'g'), '<url>')}`);
};
const planAllowedRows = (cwd, rows) => {
  for (const [name, args] of Object.entries(rows)) assert.equal(planOf(cwd, args).refused, null, `${name}: git ${args.join(' ')}`);
};

test('F1: option arity follows git per subcommand: -u, -o, -j, --repo and refspec-free forms cannot hide a remote (judged with the next word as a value and as a positional)', () => {
  const U = URLS.https;
  const S = URLS['scp-style'];
  const publicOrigin = repoWith(`[remote "origin"]\n\turl = ${U}\n`);
  const publicPushUrl = repoWith(`[remote "origin"]\n\turl = ${path.join(scratch('iso-bare-'), 'b.git')}\n\tpushurl = ${U}\n`);
  const rows = {
    'push -u <url> main': ['push', '-u', U, 'main'],
    'push -u <scp> main': ['push', '-u', S, 'main'],
    'push -u <url> (no refspec)': ['push', '-u', U],
    'push -u <scp> (no refspec)': ['push', '-u', S],
    'push --set-upstream <scp>': ['push', '--set-upstream', S],
    'push -v -u <scp> main': ['push', '-v', '-u', S, 'main'],
    'push -vu <scp> (a cluster of flags)': ['push', '-vu', S],
    'fetch -u <url>': ['fetch', '-u', U],
    'fetch -u <scp>': ['fetch', '-u', S],
    'pull -u <scp> main (pull has no -u: unknown arity, both readings)': ['pull', '-u', S, 'main'],
    'push -o x <url>': ['push', '-o', 'x', U],
    'push -o x <scp>': ['push', '-o', 'x', S],
    'push -ox <scp> (value glued on)': ['push', '-ox', S],
    'push --push-option x <scp>': ['push', '--push-option', 'x', S],
    'push --repo <url>': ['push', '--repo', U],
    'push --repo <scp>': ['push', '--repo', S],
    'push --repo <scp> main': ['push', '--repo', S, 'main'],
    'push --repo=<scp>': ['push', `--repo=${S}`],
    'push --repo <scp> ./local (the first positional wins in git, both are judged)': ['push', '--repo', S, './local.git'],
    'push -j <scp> (push has no -j: unknown arity)': ['push', '-j', S],
    'push --frobnicate <scp> (unknown long option)': ['push', '--frobnicate', S],
    'push -x <scp> (unknown short option)': ['push', '-x', S],
    'push --rep <scp> (an abbreviated --repo)': ['push', '--rep', S],
    'push --all <scp>': ['push', '--all', S],
    'push --mirror <scp>': ['push', '--mirror', S],
    'push -o <url> origin (a url as an option value is judged too)': ['push', '-o', U, './local.git'],
    'fetch --depth <url> ./local': ['fetch', '--depth', U, './local.git'],
    'fetch -j 4 <scp>': ['fetch', '-j', '4', S],
    'fetch --upload-pack x <scp>': ['fetch', '--upload-pack', 'x', S],
    'clone -u x <scp> dest (-u takes a value for clone)': ['clone', '-u', 'x', S, 'dest'],
    'clone -b main <scp> dest': ['clone', '-b', 'main', S, 'dest'],
    'clone --depth 1 <scp> dest': ['clone', '--depth', '1', S, 'dest'],
    'clone -j 4 <url> dest': ['clone', '-j', '4', U, 'dest'],
    'clone --template t --reference r <scp> dest': ['clone', '--template', 't', '--reference', 'r', S, 'dest'],
    'ls-remote --heads <scp>': ['ls-remote', '--heads', S],
    'ls-remote -o x <scp>': ['ls-remote', '-o', 'x', S],
    'ls-remote --upload-pack x <scp>': ['ls-remote', '--upload-pack', 'x', S],
    'archive --remote <scp> HEAD': ['archive', '--remote', S, 'HEAD'],
    'archive --remote=<scp> HEAD': ['archive', `--remote=${S}`, 'HEAD'],
  };
  planRefusedRows(publicOrigin, rows, /: git [a-z-]+: a non-local address/);
  // The same words with a remote NAME: the name resolves to a public address in the repository config.
  const named = {
    'push -u origin main': ['push', '-u', 'origin', 'main'],
    'push -u origin (no refspec)': ['push', '-u', 'origin'],
    'push -v -u origin main': ['push', '-v', '-u', 'origin', 'main'],
    'push --set-upstream origin': ['push', '--set-upstream', 'origin'],
    'fetch -u origin': ['fetch', '-u', 'origin'],
    'pull -u origin main': ['pull', '-u', 'origin', 'main'],
    'push -o x origin': ['push', '-o', 'x', 'origin'],
    'push --repo origin': ['push', '--repo', 'origin'],
    'push --repo=origin main': ['push', '--repo=origin', 'main'],
    'push -j origin (unknown arity)': ['push', '-j', 'origin'],
    'push --frobnicate origin (unknown arity)': ['push', '--frobnicate', 'origin'],
    'push -x origin': ['push', '-x', 'origin'],
    'fetch -j 4 origin': ['fetch', '-j', '4', 'origin'],
    'clone -u x origin': ['clone', '-u', 'x', 'origin', 'dest'],
    'ls-remote --heads origin': ['ls-remote', '--heads', 'origin'],
    'archive --remote=origin HEAD': ['archive', '--remote=origin', 'HEAD'],
    'archive --remote origin HEAD': ['archive', '--remote', 'origin', 'HEAD'],
    'push -u (no remote named: every remote is judged)': ['push', '-u'],
  };
  planRefusedRows(publicOrigin, named, /^ESPAWNGUARD .*(non-local|resolves)/);
  planRefusedRows(publicPushUrl, { 'push -u origin main (pushurl is public)': ['push', '-u', 'origin', 'main'], 'push -u origin (pushurl is public)': ['push', '-u', 'origin'] }, /resolves to a non-local/);
  // The key rows again on every child_process function (a missed refusal would stop at GIT_ALLOW_PROTOCOL=file, never at a lookup).
  gitRefused(['push', '-u', U, 'main'], {}, 'push -u <url> main');
  gitRefused(['fetch', '-u', U], {}, 'fetch -u <url>');
  gitRefused(['push', '-o', 'x', U], {}, 'push -o x <url>');
  gitRefused(['push', '--repo', U], {}, 'push --repo <url>');
  gitRefused(['push', '-u', 'origin', 'main'], { cwd: publicOrigin }, 'push -u origin main');
  gitRefused(['push', '-u', 'origin'], { cwd: publicOrigin }, 'push -u origin');
  // Local forms stay allowed, whatever the option.
  const bare = path.join(scratch('iso-bare-'), 'bare.git');
  const localOrigin = repoWith(`[remote "origin"]\n\turl = ${bare}\n`);
  planAllowedRows(localOrigin, {
    'push -u ./bare.git main': ['push', '-u', './bare.git', 'main'],
    'push -u <abs bare> main': ['push', '-u', bare, 'main'],
    'push -u origin main': ['push', '-u', 'origin', 'main'],
    'push -u origin': ['push', '-u', 'origin'],
    'push -vu origin': ['push', '-vu', 'origin'],
    'fetch -u origin': ['fetch', '-u', 'origin'],
    'fetch file:///tmp/x': ['fetch', 'file:///tmp/x'],
    'fetch file://localhost/tmp/x': ['fetch', 'file://localhost/tmp/x'],
    'fetch -u file:///tmp/x': ['fetch', '-u', 'file:///tmp/x'],
    'push -o x ./bare.git': ['push', '-o', 'x', './bare.git'],
    'push --repo ./bare.git': ['push', '--repo', './bare.git'],
    'push --repo=./bare.git main': ['push', '--repo=./bare.git', 'main'],
    'push --force-with-lease=main:abc origin main': ['push', '--force-with-lease=main:abc', 'origin', 'main'],
    'fetch -j 4 origin': ['fetch', '-j', '4', 'origin'],
    'fetch --depth 1 origin': ['fetch', '--depth', '1', 'origin'],
    'pull --rebase origin main': ['pull', '--rebase', 'origin', 'main'],
    'clone -b main ./src dest': ['clone', '-b', 'main', './src', 'dest'],
    'clone --depth 1 file:///tmp/src dest': ['clone', '--depth', '1', 'file:///tmp/src', 'dest'],
    'clone -u x ./src dest': ['clone', '-u', 'x', './src', 'dest'],
    'ls-remote --heads ./bare.git': ['ls-remote', '--heads', './bare.git'],
    'ls-remote -o x origin': ['ls-remote', '-o', 'x', 'origin'],
    'push --frobnicate origin (unknown option, every reading is local)': ['push', '--frobnicate', 'origin'],
    'push -x ./bare.git main (unknown option, every reading is local)': ['push', '-x', './bare.git', 'main'],
  });
  // --all, --multiple and no named remote: every remote in the config is judged, so a public second remote is found.
  const publicMirror = repoWith(`[remote "origin"]\n\turl = ${bare}\n[remote "mirror"]\n\turl = ${S}\n`);
  planRefusedRows(publicMirror, {
    'push --all origin': ['push', '--all', 'origin'],
    'fetch --all': ['fetch', '--all'],
    'fetch --multiple origin': ['fetch', '--multiple', 'origin'],
    'push -u (no remote named)': ['push', '-u'],
    'fetch -u (no remote named)': ['fetch', '-u'],
  }, /^ESPAWNGUARD .*(resolves to a non-local|non-local)/);
  assert.equal(planOf(publicMirror, ['push', '--repo=origin']).refused, null, 'a named local remote through --repo is judged on its own address');
  assert.equal(planOf(publicMirror, ['push', '-u', 'origin', 'main']).refused, null, 'a named local remote is judged on its own address');
  // Too many options of unknown arity to judge: refused rather than guessed.
  const many = (count) => ['push', ...Array.from({ length: count }, (_, at) => [`--unknown${at}`, `w${at}`]).flat(), './bare.git'];
  assert.equal(planOf(localOrigin, many(4)).refused, null, 'a few unknown options are judged');
  assert.match(String(planOf(localOrigin, many(9)).refused), /too many options of unknown arity/);
});

test('F2: --bundle-uri (the = form and the space form) is refused unless its value is a local path or a file: URL', () => {
  const U = URLS.https;
  const S = URLS['scp-style'];
  const root = scratch('iso-bundle-');
  const refusedRows = {
    '--bundle-uri=<https>': ['clone', `--bundle-uri=${U}`, './src', 'dest'],
    '--bundle-uri <https>': ['clone', '--bundle-uri', U, './src', 'dest'],
    '--bundle-uri=<http>': ['clone', `--bundle-uri=${URLS.http}`, './src', 'dest'],
    '--bundle-uri <http>': ['clone', '--bundle-uri', URLS.http, './src', 'dest'],
    '--bundle-uri=<ssh>': ['clone', `--bundle-uri=${URLS.ssh}`, './src', 'dest'],
    '--bundle-uri <scp>': ['clone', '--bundle-uri', S, './src', 'dest'],
    '--bundle-uri=<scp>': ['clone', `--bundle-uri=${S}`, './src', 'dest'],
    '--bundle-uri <file: URL with a host>': ['clone', '--bundle-uri', URLS['file:// with a host'], './src', 'dest'],
    '--bundle-uri=<ext::>': ['clone', `--bundle-uri=${URLS['ext::']}`, './src', 'dest'],
    '--bundle-uri with no value': ['clone', './src', 'dest', '--bundle-uri'],
    '--bundle-uri <https> before a local source': ['clone', '--depth', '1', '--bundle-uri', U, '-b', 'main', './src', 'dest'],
    '--bundle-uri <https> with a url source': ['clone', '--bundle-uri', U, S, 'dest'],
    '--bundle-uri=<variable>': ['clone', '--bundle-uri=$U', './src', 'dest'],
    '--bundle-uri <variable>': ['clone', '--bundle-uri', '$U', './src', 'dest'],
    '--bundle-uri after a global option': ['-C', '.', '-c', 'user.name=t', 'clone', '--bundle-uri', U, './src', 'dest'],
  };
  planRefusedRows(root, refusedRows, /^ESPAWNGUARD .*(--bundle-uri|non-local|unexpanded)/);
  for (const [name, args] of Object.entries(refusedRows).filter(([, row]) => !row.some((word) => word.includes('$')))) {
    for (const [fn, call] of Object.entries({ execSync: (text) => iso.plan('execSync', text, { cwd: root, env: { PATH } }), 'sh -c': (text) => iso.plan('execFileSync', 'sh', ['-c', text], { cwd: root, env: { PATH } }) })) {
      assert.match(String(call(textOf('git', args)).refused), /^ESPAWNGUARD /, `${name} as shell text / ${fn}`);
    }
  }
  const bundle = path.join(root, 'b.bundle');
  planAllowedRows(root, {
    '--bundle-uri=<absolute path>': ['clone', `--bundle-uri=${bundle}`, './src', 'dest'],
    '--bundle-uri <absolute path>': ['clone', '--bundle-uri', bundle, './src', 'dest'],
    '--bundle-uri=<relative path>': ['clone', '--bundle-uri=b.bundle', './src', 'dest'],
    '--bundle-uri=<file: URL>': ['clone', `--bundle-uri=file://${bundle}`, './src', 'dest'],
    '--bundle-uri <file: URL>': ['clone', '--bundle-uri', `file://${bundle}`, './src', 'dest'],
    '--bundle-uri <file://localhost URL>': ['clone', '--bundle-uri', `file://localhost${bundle}`, './src', 'dest'],
    '--bundle-uri <file: URL> with file:// source': ['clone', '--bundle-uri', `file://${bundle}`, `file://${root}/src`, 'dest'],
  });
});

test('F3: a node child started through sh -c, env, exec or another wrapper cannot get the preload, so it is refused; a direct node child and an explicit --require are not', () => {
  const root = scratch('iso-node-');
  const probe = `node ${quote(PROBE)} ${quote(testTempRoot)} ${quote(passwdHome)}`;
  const text = {
    'sh -c node': `sh -c ${quote(probe)}`,
    'bash -lc node': `bash -lc ${quote(probe)}`,
    'nested sh -c': `sh -c ${quote(`sh -c ${quote(probe)}`)}`,
    'node after &&': `true && ${probe}`,
    'node after a pipe': `printf x | ${probe}`,
    'node with an assignment': `FOO=1 ${probe}`,
    'NODE_OPTIONS= node (the empty-NODE_OPTIONS form installed hooks use)': `printf x | NODE_OPTIONS= ${probe}`,
    'exec node': `exec ${probe}`,
    'env node': `env ${probe}`,
    'env -i FOO=1 node': `env -i FOO=1 ${probe}`,
    'env -u X node': `env -u X ${probe}`,
    'nice node': `nice -n 5 ${probe}`,
    'timeout node': `timeout 5 ${probe}`,
    'xargs node': `xargs ${probe}`,
    'nohup node': `nohup ${probe}`,
    'time node': `time ${probe}`,
    'absolute node path': `${quote(process.execPath)} -e 1`,
    'nodejs': 'nodejs -e 1',
    'in a command substitution': `echo $(${probe})`,
    'in backticks': `echo \`${probe}\``,
    'eval node': `eval ${quote(probe)}`,
  };
  for (const [name, command] of Object.entries(text)) {
    for (const [fn, call] of Object.entries({ execSync: (value) => iso.plan('execSync', value, { cwd: root, env: { PATH } }), 'spawnSync with a shell': (value) => iso.plan('spawnSync', value, [], { cwd: root, env: { PATH }, shell: true }), 'execFileSync sh -c': (value) => iso.plan('execFileSync', 'sh', ['-c', value], { cwd: root, env: { PATH } }) })) {
      assert.match(String(call(command).refused), /a node child started through a shell, env or exec has no isolation preload/, `${name} / ${fn}`);
    }
  }
  for (const [file, args] of [['env', ['node', PROBE]], ['env', ['-i', 'FOO=1', 'node', PROBE]], ['nice', ['node', PROBE]], ['timeout', ['5', 'node', PROBE]], ['xargs', ['node', PROBE]], ['sh', ['-c', probe]], ['bash', ['-lc', probe]]]) {
    assert.match(String(iso.plan('spawnSync', file, args, { cwd: root, env: { PATH } }).refused), /no isolation preload/, `${file} ${args[0]}`);
  }
  // Not a node command: the word only appears as an argument or in a lookup.
  for (const command of ['echo node', 'command -v node', 'which node', 'git commit -m node', 'grep node file.txt', 'printf "%s\n" node', 'true # node', 'ls ./node', 'echo $(command -v node)']) {
    assert.equal(iso.plan('execSync', command, { cwd: root, env: { PATH } }).refused, null, command);
  }
  // A node child started directly, and one whose command line already carries the preload, are not refused.
  assert.equal(iso.plan('spawnSync', NODE, [PROBE], { cwd: root, env: { PATH } }).refused, null);
  assert.equal(iso.plan('spawnSync', 'node', [PROBE], { cwd: root, env: { PATH } }).refused, null);
  const preloaded = `node --require ${quote(iso.SELF)} ${quote(PROBE)} ${quote(testTempRoot)} ${quote(passwdHome)}`;
  assert.equal(iso.plan('execSync', `sh -c ${quote(preloaded)}`, { cwd: root, env: { PATH } }).refused, null);
  assert.equal(iso.plan('spawnSync', 'env', ['node', '--require', iso.SELF, PROBE], { cwd: root, env: { PATH } }).refused, null);
  // The explicit waiver (a test that runs an installed hook through /bin/sh) is per call and does not touch the HOME rules.
  assert.equal(iso.plan('execFileSync', 'sh', ['-c', probe], { cwd: root, env: { PATH }, isolationShellNode: true }).refused, null);
  const waived = iso.plan('execFileSync', 'sh', ['-c', probe], { cwd: root, env: { PATH, HOME: '/nonexistent-home' }, isolationShellNode: true });
  assert.match(String(waived.refused), /HOME is outside the test temp dir/);
  // Probe: the one allowed way through a shell still sees the private HOME and the scratch passwd home, never the real one.
  const seen = JSON.parse(cp.execSync(`exec ${preloaded}`, { env: { PATH }, encoding: 'utf8' }));
  assert.equal(seen.homeUnderTemp, true, 'the node child under sh sees the private HOME');
  assert.equal(seen.passwdHomeIsScratch, true, 'the passwd-home reader sees the scratch folder, not the real home');
  assert.equal(seen.preloaded, true);
});

test('F4: a HOME under the temp dir that is a symlink to somewhere outside is refused; one that stays inside is not (every child_process function)', () => {
  const outside = fs.mkdtempSync('/tmp/iso-outside-');
  try {
    const holder = scratch('iso-link-');
    const toOutside = path.join(holder, 'to-outside');
    const toInside = path.join(holder, 'to-inside');
    const toReal = path.join(holder, 'to-real-home');
    const inside = scratch('iso-inside-');
    fs.symlinkSync(outside, toOutside);
    fs.symlinkSync(inside, toInside);
    fs.symlinkSync(iso.realPasswdHome(), toReal);
    fs.mkdirSync(path.join(inside, 'sub'));
    fs.symlinkSync(outside, path.join(inside, 'sub', 'back-out'));
    const asArgs = (name, options) => (name === 'exec' || name === 'execSync' ? [name, 'true', options] : [name, name === 'fork' ? PROBE : NODE, name === 'fork' ? [] : ['-e', ''], options]);
    for (const name of Object.keys(ARGV_FUNCTIONS).filter((key) => !key.includes('shell') && key !== 'exec' && key !== 'execSync').concat(['exec', 'execSync'])) {
      for (const [label, home] of [['a link to a folder outside', toOutside], ['a path below a link to outside', path.join(toOutside, 'deeper', 'still')], ['a link to the real passwd home', toReal], ['a link below the temp dir that goes back out', path.join(inside, 'sub', 'back-out')], ['a path below a link that goes back out', path.join(inside, 'sub', 'back-out', 'x')]]) {
        assert.match(String(iso.plan(...asArgs(name, { env: { PATH, HOME: home } })).refused), /HOME is outside the test temp dir/, `${name} with HOME ${label}`);
      }
      for (const [label, home] of [['a link to a folder inside', toInside], ['a path below a link to inside', path.join(toInside, 'new', 'home')], ['a plain folder', inside]]) {
        assert.equal(iso.plan(...asArgs(name, { env: { PATH, HOME: home } })).refused, null, `${name} with HOME ${label}`);
      }
    }
    // A relative HOME stays refused for every child, even one that resolves from its cwd to a folder under the temp dir.
    assert.match(String(iso.plan('spawnSync', NODE, ['-e', ''], { cwd: inside, env: { PATH, HOME: 'sub' } }).refused), /HOME is relative/);
    // The private config files are judged the same way: a link to outside is replaced by the empty private file, never used.
    const link = path.join(holder, 'gitconfig-link');
    fs.writeFileSync(path.join(outside, 'gitconfig'), `[url "https://${HOST}/"]\n\tinsteadOf = up\n`);
    fs.symlinkSync(path.join(outside, 'gitconfig'), link);
    const planned = iso.plan('spawnSync', 'git', ['status'], { cwd: inside, env: { PATH, GIT_CONFIG_GLOBAL: link } });
    assert.equal(planned.refused, null);
    assert.notEqual(planned.argv[2].env.GIT_CONFIG_GLOBAL, link, 'the linked config is not used');
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('F5: with isolationOddHome, a relative HOME counts only where it lands from the child\'s cwd (links followed): under the temp dir is allowed, the real passwd home or anywhere outside is refused', () => {
  const inside = scratch('iso-odd-rel-');
  const outside = fs.mkdtempSync('/tmp/iso-odd-outside-');
  try {
    const asArgs = (name, options) => (name === 'exec' || name === 'execSync' ? [name, 'true', options] : [name, name === 'fork' ? PROBE : NODE, name === 'fork' ? [] : ['-e', ''], options]);
    const real = iso.realPasswdHome();
    const relativeFrom = (cwd, target) => path.relative(cwd, target);
    fs.mkdirSync(path.join(inside, 'home-here'));
    fs.symlinkSync(real, path.join(inside, 'link-to-real-home'));
    fs.symlinkSync(outside, path.join(inside, 'link-to-outside'));
    fs.symlinkSync(path.join(inside, 'home-here'), path.join(inside, 'link-to-inside'));
    const cases = [
      ['a relative path that resolves to the real passwd home', relativeFrom(inside, real), /HOME is relative/, false],
      ['a relative path with .. that leaves the temp dir', path.join('..', '..', '..', '..', '..', 'nowhere'), /HOME is relative/, false],
      ['two levels up: the parent of the temp root', path.join('..', '..'), /HOME is relative/, false],
      ['one level up: the temp root itself is still under the temp dir', '..', null, true],
      ['a relative link to the real passwd home', 'link-to-real-home', /HOME is relative/, false],
      ['a relative link to a folder outside', 'link-to-outside', /HOME is relative/, false],
      ['a path below a relative link to a folder outside', path.join('link-to-outside', 'deeper'), /HOME is relative/, false],
      ['a relative folder under the cwd', 'home-here', null, true],
      ['a relative folder that does not exist yet, under the cwd', path.join('new', 'home'), null, true],
      ['a relative link to a folder inside', 'link-to-inside', null, true],
      ['an empty HOME', '', null, true],
    ];
    for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'fork', 'exec', 'execSync']) {
      for (const [label, home, pattern, allowed] of cases) {
        const planned = iso.plan(...asArgs(name, { env: { PATH, HOME: home }, cwd: inside, isolationOddHome: true }));
        if (allowed) assert.equal(planned.refused, null, `${name} with ${label}`);
        else assert.match(String(planned.refused), pattern, `${name} with ${label}`);
        if (!allowed) assert.match(String(iso.plan(...asArgs(name, { env: { PATH, HOME: home }, cwd: inside })).refused), /HOME is (relative|empty)/, `${name} with ${label}: refused without the option too`);
      }
      // An absolute HOME that is a link to the real passwd home or a link that leaves the temp dir is refused (it is writable here).
      for (const [label, link] of [['an absolute link to the real passwd home', path.join(inside, 'link-to-real-home')], ['an absolute link to a folder outside', path.join(inside, 'link-to-outside')]]) {
        assert.match(String(iso.plan(...asArgs(name, { env: { PATH, HOME: link }, cwd: inside, isolationOddHome: true })).refused), /HOME is outside the test temp dir/, `${name} with ${label}`);
      }
    }
    // The flag with a cwd that is itself a link to outside is refused: the cwd is judged by where it lands.
    const cwdLink = path.join(inside, 'cwd-link');
    fs.symlinkSync(outside, cwdLink);
    assert.match(String(iso.plan('spawnSync', NODE, ['-e', ''], { env: { PATH, HOME: '' }, cwd: cwdLink, isolationOddHome: true }).refused), /HOME is empty/, 'a cwd that links outside takes the waiver away');
    assert.match(String(iso.plan('spawnSync', NODE, ['-e', ''], { env: { PATH, HOME: 'x' }, cwd: cwdLink, isolationOddHome: true }).refused), /HOME is relative/);
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
  }
});
