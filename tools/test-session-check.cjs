'use strict';
// Maintainer test: the SessionStart session check (plugins/marrow/scripts/marrow-session-check.cjs) in a fake
// HOME per case, with a scrubbed environment, no network and no Marrow API. Every case runs the base copy
// and this copy; their stdout must be byte-for-byte equal, except while no Marrow key can be set and no
// duplicate setup is found, where the output is exactly the one-line keyless notice. Keys are random
// dummies made at run time and are only counted in the output, never printed.
//   node tools/test-session-check.cjs [--base <the base marrow-session-check.cjs>] [--cells]
// Without --base the base copy comes from `git show` of BASE_SHA in this repository.
const { spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const repo = path.resolve(__dirname, '..');
const SCRIPT_REL = 'plugins/marrow/scripts/marrow-session-check.cjs';
const script = path.join(repo, ...SCRIPT_REL.split('/'));
const BASE_SHA = 'f2fa1ab14792ea2154e81f0bd4ab275c4139fc03';
// The approved copy (COPY-approved P1), repeated here so a change to the script's text fails this test.
const P1 = 'Marrow seatbelt is on (no key yet): it stops a short list of actions, like force-push to main, production deploys, package publishes and secret files. For approval prompts instead, add a key: getmarrow.ai/docs#start-here';
const NOTICE = JSON.stringify({ systemMessage: P1 });
const showCells = process.argv.includes('--cells');
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
const posix = process.platform !== 'win32';

function baseText() {
  const at = process.argv.indexOf('--base');
  if (at >= 0) return fs.readFileSync(process.argv[at + 1], 'utf8');
  const shown = spawnSync('git', ['-C', repo, 'show', `${BASE_SHA}:${SCRIPT_REL}`], { encoding: 'utf8' });
  if (shown.status !== 0) throw new Error(`cannot read the base script from git (${BASE_SHA}); pass --base <file>`);
  return shown.stdout;
}
const baseSource = baseText();

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

fs.mkdirSync(path.join(root, 'base'));
const baseScript = path.join(root, 'base', 'marrow-session-check.cjs');
fs.writeFileSync(baseScript, baseSource);

const dummy = () => crypto.randomBytes(24).toString('hex');
const secrets = new Set();
const secret = () => {
  const value = dummy();
  secrets.add(value);
  return value;
};

let counter = 0;
// One fake machine: its own home and project folder, optionally with a duplicate setup (a marrow MCP
// server in the project's .mcp.json, which the check reports).
function machine(dup) {
  counter += 1;
  const dir = path.join(root, `m${counter}`);
  const home = path.join(dir, 'home');
  const project = path.join(dir, 'project');
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.mkdirSync(project, { recursive: true });
  if (dup) fs.writeFileSync(path.join(project, '.mcp.json'), JSON.stringify({ mcpServers: { marrow: { command: 'x' } } }));
  return { dir, home, project };
}

function run(file, m, extra, source) {
  const env = { PATH: process.env.PATH || '/usr/bin:/bin', HOME: m.home, CLAUDE_PROJECT_DIR: m.project, ...extra };
  for (const name of Object.keys(env)) if (env[name] === null) delete env[name];
  const input = JSON.stringify({ hook_event_name: 'SessionStart', source, session_id: 'test-session' });
  runs += 1;
  const r = spawnSync(process.execPath, [file], { env, cwd: m.project, input, encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL' });
  assert.ok(!r.error, `the script did not finish: ${r.error && r.error.code}`);
  assert.strictEqual(r.signal, null);
  assert.strictEqual(r.status, 0, 'exit status');
  assert.strictEqual(r.stderr, '', 'stderr is empty');
  return r.stdout;
}

const count = (text, value) => text.split(value).length - 1;
const label = (out) => (out === '' ? 'empty' : out === NOTICE ? 'notice' : out.includes('is also set up outside') ? 'dup-message' : 'other');

// A state is a way a machine can hold, or not hold, a Marrow key. notice: the output is the keyless
// notice while no duplicate is found. Every other state must print exactly what the base prints.
function states() {
  const marrowDir = (m) => {
    fs.mkdirSync(path.join(m.home, '.marrow'), { mode: 0o700 });
    return path.join(m.home, '.marrow');
  };
  const envFile = (m, name, mode) => {
    const file = path.join(marrowDir(m), name);
    fs.writeFileSync(file, `MARROW_API_KEY=${secret()}\n`, { mode });
    fs.chmodSync(file, mode);
    return file;
  };
  const list = [
    { name: 'no key', notice: true, setup: () => ({}) },
    { name: 'MARROW_API_KEY set', notice: false, setup: () => ({ MARROW_API_KEY: secret() }) },
    { name: 'MARROW_API_KEY empty (forged)', notice: true, setup: () => ({ MARROW_API_KEY: '' }) },
    { name: 'MARROW_API_KEY whitespace (forged)', notice: false, setup: () => ({ MARROW_API_KEY: ' \t ' }) },
    { name: 'MARROW_KEY set', notice: false, setup: () => ({ MARROW_KEY: secret() }) },
    { name: 'plugin option variable set', notice: false, setup: () => ({ CLAUDE_PLUGIN_OPTION_API_KEY: secret() }) },
    { name: 'plugin option variable empty', notice: false, setup: () => ({ CLAUDE_PLUGIN_OPTION_API_KEY: '' }) },
    { name: '~/.marrow/env present (mode 600)', notice: false, setup: (m) => { envFile(m, 'env', 0o600); return {}; } },
    { name: '~/.marrow/env.local present', notice: false, setup: (m) => { envFile(m, 'env.local', 0o600); return {}; } },
    { name: '~/.marrow/env present, mode 644', notice: false, setup: (m) => { envFile(m, 'env', 0o644); return {}; } },
    { name: '~/.marrow/env empty file', notice: false, setup: (m) => { fs.writeFileSync(path.join(marrowDir(m), 'env'), ''); return {}; } },
    { name: '~/.marrow exists, no env files', notice: true, setup: (m) => { marrowDir(m); return {}; } },
    {
      // The key resolver reads no key from the project (it only mentions one it skipped), so these change nothing.
      name: 'project .env and .marrow/env hold a key (ignored by the resolver)',
      notice: true,
      setup: (m) => {
        fs.mkdirSync(path.join(m.project, '.marrow'));
        for (const file of ['.env', '.env.local', path.join('.marrow', 'env')]) {
          fs.writeFileSync(path.join(m.project, file), `MARROW_API_KEY=${secret()}\n`, { mode: 0o600 });
        }
        return {};
      },
    },
    {
      name: '~/.marrow/env a directory',
      notice: false,
      setup: (m) => { fs.mkdirSync(path.join(marrowDir(m), 'env')); return {}; },
    },
    {
      name: '~/.marrow/env a dangling symlink',
      notice: false,
      setup: (m) => { fs.symlinkSync(path.join(m.dir, 'nowhere'), path.join(marrowDir(m), 'env')); return {}; },
    },
    {
      name: '~/.marrow a symlink to an empty folder',
      notice: false,
      setup: (m) => {
        const target = path.join(m.dir, 'elsewhere');
        fs.mkdirSync(target, { mode: 0o700 });
        fs.symlinkSync(target, path.join(m.home, '.marrow'));
        return {};
      },
    },
    {
      name: '~/.marrow a symlink to a folder with env',
      notice: false,
      setup: (m) => {
        const target = path.join(m.dir, 'elsewhere');
        fs.mkdirSync(target, { mode: 0o700 });
        fs.writeFileSync(path.join(target, 'env'), `MARROW_API_KEY=${secret()}\n`, { mode: 0o600 });
        fs.symlinkSync(target, path.join(m.home, '.marrow'));
        return {};
      },
    },
    {
      name: '~/.marrow a regular file',
      notice: false,
      setup: (m) => { fs.writeFileSync(path.join(m.home, '.marrow'), 'x'); return {}; },
    },
    {
      name: 'HOME does not exist',
      notice: false,
      setup: (m) => ({ HOME: path.join(m.dir, 'no-such-home') }),
    },
    { name: 'HOME is relative', notice: false, setup: () => ({ HOME: 'relative/home' }) },
    {
      name: 'HOME empty, USERPROFILE clean',
      notice: true,
      setup: (m) => ({ HOME: '', USERPROFILE: m.home, CLAUDE_CONFIG_DIR: path.join(m.dir, 'claude-config') }),
    },
    {
      name: 'HOME empty, USERPROFILE has env',
      notice: false,
      setup: (m) => { envFile(m, 'env', 0o600); return { HOME: '', USERPROFILE: m.home, CLAUDE_CONFIG_DIR: path.join(m.dir, 'claude-config') }; },
    },
  ];
  if (posix && !isRoot) {
    list.push({
      name: '~/.marrow/env present, mode 000',
      notice: false,
      setup: (m) => { restore.push(envFile(m, 'env', 0o000)); return {}; },
    });
    list.push({
      name: 'HOME unreadable (mode 000)',
      notice: false,
      setup: (m) => { restore.push(m.home); fs.mkdirSync(path.join(m.home, '.marrow'), { mode: 0o700 }); fs.chmodSync(m.home, 0o000); return {}; },
    });
  }
  if (posix) {
    list.push({
      name: '~/.marrow/env a FIFO',
      notice: false,
      setup: (m) => {
        const made = spawnSync('mkfifo', [path.join(marrowDir(m), 'env')]);
        assert.strictEqual(made.status, 0, 'mkfifo');
        return {};
      },
    });
  }
  return list;
}

for (const state of states()) {
  check(`state: ${state.name}`, () => {
    const cells = [];
    for (const dup of [false, true]) {
      for (const source of ['startup', 'resume']) {
        const m = machine(dup);
        const extra = state.setup(m);
        const mine = run(script, m, extra, source);
        const base = run(baseScript, m, extra, source);
        if (state.notice && !dup) {
          assert.strictEqual(base, '', 'base prints nothing here');
          assert.strictEqual(mine, NOTICE, `exactly the keyless notice (got ${label(mine)})`);
        } else {
          assert.strictEqual(mine, base, `must equal base (mine ${label(mine)}, base ${label(base)})`);
        }
        if (dup) {
          assert.strictEqual(label(mine), 'dup-message', 'the duplicate message, with no keyless notice added');
          assert.ok(!mine.includes('seatbelt is on'), 'no keyless notice next to the duplicate message');
        }
        for (const value of secrets) assert.strictEqual(count(mine, value) + count(base, value), 0, 'a dummy key reached the output');
        cells.push(`dup=${dup ? 'yes' : 'no'} ${source}: ${label(mine)}/${label(base)}`);
        if (showCells) process.stdout.write(`CELL ${state.name} | dup=${dup ? 'yes' : 'no'} | ${source} | mine=${label(mine)} base=${label(base)} equal=${mine === base ? 'yes' : 'no'}\n`);
      }
    }
    return `4 cells, notice ${state.notice ? 'yes' : 'no'}`;
  });
}

check('two machines that differ only in the key value print the same', () => {
  for (const dup of [false, true]) {
    for (const how of ['env var', 'owner file']) {
      const outputs = [secret(), secret()].map((value) => {
        const m = machine(dup);
        if (how === 'env var') return run(script, m, { MARROW_API_KEY: value }, 'startup');
        fs.mkdirSync(path.join(m.home, '.marrow'), { mode: 0o700 });
        fs.writeFileSync(path.join(m.home, '.marrow', 'env'), `MARROW_API_KEY=${value}\n`, { mode: 0o600 });
        return run(script, m, {}, 'startup');
      });
      assert.strictEqual(outputs[0], outputs[1], `${how}, dup=${dup}`);
    }
  }
});

check('the home folder decides: another HOME is judged on its own files', () => {
  const withKey = machine(false);
  fs.mkdirSync(path.join(withKey.home, '.marrow'), { mode: 0o700 });
  fs.writeFileSync(path.join(withKey.home, '.marrow', 'env'), `MARROW_API_KEY=${secret()}\n`, { mode: 0o600 });
  const clean = machine(false);
  assert.strictEqual(run(script, withKey, {}, 'startup'), '', 'home with a key file');
  assert.strictEqual(run(script, clean, {}, 'startup'), NOTICE, 'a clean home');
  assert.strictEqual(run(script, clean, { HOME: withKey.home }, 'startup'), '', 'HOME names the home with the key file');
});

check('the notice is the approved copy: one plain ASCII line, no placeholders, once in the script', () => {
  const text = fs.readFileSync(script, 'utf8');
  assert.strictEqual(count(text, P1), 1);
  assert.ok(/^[\t -~]+$/.test(P1) && !/[<>{}]/.test(P1));
  assert.ok(!/[^\t\n -~]/.test(text), 'the script is plain ASCII');
  for (const word of ['risk', 'score', 'classifier']) assert.ok(!P1.toLowerCase().includes(word), word);
});

check('the keyless code only calls lstat on files and writes only the fixed notice', () => {
  const text = fs.readFileSync(script, 'utf8');
  const block = text.slice(text.indexOf('const KEYLESS_NOTICE'), text.indexOf('const home = os.homedir();')).replace(/^\s*\/\/.*$/gm, '');
  assert.ok(block.includes('lstatSync'));
  const calls = [...block.matchAll(/\bfs\.(\w+)/g)].map((match) => match[1]);
  assert.deepStrictEqual([...new Set(calls)], ['lstatSync']);
  for (const word of ['openSync', 'readFileSync', 'readSync', 'createReadStream', 'readdirSync', 'readlink', 'realpath', 'crypto', 'console', 'stdout', 'stderr']) {
    assert.ok(!block.includes(word), `the keyless code uses ${word}`);
  }
  const tail = text.slice(text.indexOf('} else if (noKeyIsSet())'));
  assert.ok(/^\} else if \(noKeyIsSet\(\)\) \{\n  process\.stdout\.write\(JSON\.stringify\(\{ systemMessage: KEYLESS_NOTICE \}\)\);\n\}\n$/.test(tail), 'the only write is the fixed notice');
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
