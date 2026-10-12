'use strict';
// Consistency and safety checks for the Codex packages (codex/marrow, codex/marrow-advisory). No network.
//   node tools/codex-check.cjs [marrow-install/src/pins.js] [marrow-mcp/src/cli.ts or src/tool-catalog.ts] [marrow-install/src/installer.js]
//     [--table <file>] [--rust <codex-matcher-check.wasm>]
// --table writes the generated name table; --rust also compiles every matcher with Rust's `regex` crate
// (tools/codex-rust-matcher, built for wasm32-wasip1) under Node's WASI and checks the whole table.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { OWN_TOOLS, OWN_NAMES, MATCHER, complement } = require('./codex-matcher.cjs');

const repo = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  const value = argv[i + 1];
  argv.splice(i, 2);
  return value;
};
const skillsRepo = flag('--skills');
const tableOut = flag('--table');
const wasm = flag('--rust');
const [pinsPath, cliPath, installerPath] = argv;

const read = (file) => fs.readFileSync(path.join(repo, file), 'utf8');
const json = (file) => JSON.parse(read(file));
let failures = 0;
function check(name, fn) {
  try {
    fn();
    process.stdout.write(`PASS ${name}\n`);
  } catch (error) {
    failures += 1;
    process.stdout.write(`FAIL ${name}: ${error.message}\n`);
  }
}

const A = 'codex/marrow';
const B = 'codex/marrow-advisory';
const marketplace = json('.agents/plugins/marketplace.json');
const hooks = json(`${A}/hooks/hooks.json`);
const LAUNCH = 'node "${PLUGIN_ROOT}/scripts/marrow-launch.cjs"';
// The installer's Codex matcher (marrow-install 0.1.70 src/installer.js CODEX_NATIVE_HOOK_MATCHER =
// OWN_TOOL_MATCHERS.codex), built by the sibling src/marrow-own-tools.js. It skips the exact label
// mcp__marrow__<registered name> for all 58 registered names, and it uses a lookahead that Codex's
// Rust regex rejects, so the installer's Codex tool hooks still do not load in Codex.
function installerMatcher() {
  if (!installerPath) throw new Error('pass the path to marrow-install/src/installer.js');
  const own = require(path.join(path.dirname(path.resolve(installerPath)), 'marrow-own-tools.js'));
  return own.buildOwnToolMatchers().codex;
}

check('marketplace lists both Codex packages with policy and category', () => {
  assert.strictEqual(marketplace.name, 'getmarrow');
  assert.ok(marketplace.interface && marketplace.interface.displayName);
  assert.deepStrictEqual(marketplace.plugins.map((p) => p.name), ['marrow', 'marrow-advisory']);
  for (const [entry, dir] of [[marketplace.plugins[0], A], [marketplace.plugins[1], B]]) {
    assert.deepStrictEqual(entry.source, { source: 'local', path: `./${dir}` });
    assert.deepStrictEqual(entry.policy, { installation: 'AVAILABLE', authentication: 'ON_USE' });
    assert.strictEqual(entry.category, 'Security');
  }
});

for (const dir of [A, B]) {
  const manifest = json(`${dir}/.codex-plugin/plugin.json`);
  check(`${dir}: manifest, pins and lockfile`, () => {
    assert.strictEqual(manifest.name, dir === A ? 'marrow' : 'marrow-advisory');
    assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
    assert.strictEqual(manifest.skills, './skills/');
    assert.strictEqual(manifest.mcpServers, './.mcp.json');
    assert.strictEqual(manifest.userConfig, undefined);
    assert.ok(fs.existsSync(path.join(repo, dir, 'skills/marrow/SKILL.md')));
    const pkg = json(`${dir}/package.json`);
    const lock = json(`${dir}/package-lock.json`);
    const pins = json(`${dir}/scripts/mcp-manifest.json`);
    assert.deepStrictEqual(Object.keys(pkg.dependencies).sort(), ['@getmarrow/mcp', '@getmarrow/sdk']);
    assert.strictEqual(pkg.scripts, undefined);
    for (const [name, version] of Object.entries(pkg.dependencies)) {
      assert.match(version, /^\d+\.\d+\.\d+$/);
      const entry = lock.packages[`node_modules/${name}`];
      assert.strictEqual(entry.version, version);
      assert.strictEqual(entry.resolved, `https://registry.npmjs.org/${name}/-/${name.split('/')[1]}-${version}.tgz`);
      assert.deepStrictEqual(pins[name.split('/')[1]], { version, integrity: entry.integrity });
    }
    assert.strictEqual(Object.keys(lock.packages).filter(Boolean).length, 2, 'only the two pinned packages');
    assert.deepStrictEqual(manifest.metadata.pins, pkg.dependencies);
  });
  check(`${dir}: MCP server runs the launcher from the plugin root and carries no key`, () => {
    assert.deepStrictEqual(json(`${dir}/.mcp.json`), { mcpServers: { marrow: {
      command: 'node', args: ['./scripts/marrow-launch.cjs', 'mcp'], cwd: './', env_vars: ['MARROW_API_KEY'] } } });
  });
  if (pinsPath) {
    check(`${dir}: pins equal the @getmarrow/install release pins (src/pins.js)`, () => {
      const release = require(path.resolve(pinsPath));
      const pins = json(`${dir}/scripts/mcp-manifest.json`);
      assert.strictEqual(pins.mcp.version, release.MCP_ADAPTER_VERSION);
      assert.strictEqual(pins.mcp.integrity, release.MCP_ADAPTER_INTEGRITY);
      assert.strictEqual(pins.sdk.version, release.SDK_ADAPTER_VERSION);
      assert.strictEqual(pins.sdk.integrity, release.SDK_ADAPTER_INTEGRITY);
    });
  }
}

check('both packages share the same launcher, lockfile dependencies and manifest', () => {
  for (const file of ['scripts/marrow-launch.cjs', 'scripts/mcp-manifest.json', 'skills/marrow/SKILL.md', 'LICENSE']) {
    assert.strictEqual(read(`${A}/${file}`), read(`${B}/${file}`), file);
  }
  assert.deepStrictEqual(json(`${A}/package.json`).dependencies, json(`${B}/package.json`).dependencies);
  const strip = (lock) => Object.fromEntries(Object.entries(lock.packages).filter(([k]) => k));
  assert.deepStrictEqual(strip(json(`${A}/package-lock.json`)), strip(json(`${B}/package-lock.json`)));
});

// The bundled skill is the skills repo's skill, byte for byte, and its pins are the package's pins.
for (const file of ['SKILL.md', 'references/hosts.md']) {
  check(`bundled skill ${file} equals the skills repo copy (both packages)`, () => {
    if (!skillsRepo) throw new Error('pass --skills <path to the getmarrow/skills checkout>');
    const want = fs.readFileSync(path.join(path.resolve(skillsRepo), 'skills', 'marrow', file), 'utf8');
    for (const dir of [A, B]) assert.strictEqual(read(`${dir}/skills/marrow/${file}`), want, `${dir}/skills/marrow/${file}`);
  });
}
check('bundled skill pins equal the package pins; Codex goes to the plugin, install one not both', () => {
  const skill = read(`${A}/skills/marrow/SKILL.md`);
  const mcp = json(`${A}/package.json`).dependencies['@getmarrow/mcp'];
  assert.ok(skill.includes(`mcp-package: "@getmarrow/mcp@${mcp}"`), 'skill mcp-package differs from the package pin');
  if (pinsPath) {
    const installVersion = JSON.parse(fs.readFileSync(path.resolve(pinsPath, '..', '..', 'package.json'), 'utf8')).version;
    assert.ok(skill.includes(`install-package: "@getmarrow/install@${installVersion}"`), 'skill install-package differs from the installer release');
    for (const m of skill.matchAll(/@getmarrow\/install@(\d+\.\d+\.\d+)/g)) assert.strictEqual(m[1], installVersion);
  }
  for (const m of skill.matchAll(/@getmarrow\/mcp@(\d+\.\d+\.\d+)/g)) assert.strictEqual(m[1], mcp);
  assert.ok(skill.includes('codex plugin add marrow@getmarrow') && /never both/.test(skill));
  assert.ok(!/\*\*Codex, /.test(skill), 'Codex is listed with the installer hosts');
});

check('advisory package is directory-eligible: no hooks, userConfig, commands or agents', () => {
  const manifest = json(`${B}/.codex-plugin/plugin.json`);
  for (const key of ['hooks', 'userConfig', 'commands', 'agents', 'apps']) assert.strictEqual(manifest[key], undefined, key);
  for (const sub of ['hooks', 'commands', 'agents', '.app.json']) assert.ok(!fs.existsSync(path.join(repo, B, sub)), sub);
  assert.ok(/advisory/i.test(manifest.description) && /advisory/i.test(manifest.interface.displayName));
  assert.strictEqual(manifest.metadata.advisory, true);
});

const EXPECTED = {
  SessionStart: { matcher: 'startup|resume', entry: 'prepare', timeout: 150 },
  UserPromptSubmit: { matcher: undefined, entry: 'codex-context-hook', timeout: 5 },
  PreToolUse: { matcher: MATCHER, entry: 'codex-pre-action-hook', timeout: 5 },
  PostToolUse: { matcher: MATCHER, entry: 'codex-hook', timeout: 5 },
  SessionEnd: { matcher: undefined, entry: 'codex-session-hook', timeout: 3 },
};
check('hooks are the installer\'s Codex events, entrypoints and timeouts, plus the SessionStart install', () => {
  assert.strictEqual(json(`${A}/.codex-plugin/plugin.json`).hooks, './hooks/hooks.json');
  assert.deepStrictEqual(Object.keys(hooks.hooks).sort(), Object.keys(EXPECTED).sort());
  for (const [event, want] of Object.entries(EXPECTED)) {
    const entries = hooks.hooks[event];
    assert.strictEqual(entries.length, 1, event);
    assert.strictEqual(entries[0].matcher, want.matcher, `${event} matcher`);
    assert.deepStrictEqual(entries[0].hooks, [{ type: 'command', command: `${LAUNCH} ${want.entry}`, timeout: want.timeout }], event);
  }
});

if (installerPath) {
  check('installer writes the same Codex entrypoints, events and timeouts', () => {
    const src = fs.readFileSync(installerPath, 'utf8');
    assert.ok(src.includes('const CODEX_NATIVE_HOOK_MATCHER = OWN_TOOL_MATCHERS.codex;'), 'installer matcher changed: re-check the never-looser table');
    for (const entry of ['codex-context-hook', 'codex-pre-action-hook', 'codex-hook', 'codex-session-hook']) {
      assert.ok(src.includes(`marrow-mcp ${entry}\``), entry);
    }
    assert.ok(/CODEX_HOOK_TIMEOUT_SECONDS = 5;/.test(src) && /CODEX_SESSION_TIMEOUT_SECONDS = 3;/.test(src));
    for (const event of ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'SessionEnd']) {
      assert.ok(new RegExp(`settings, '${event}', '[a-z-]+', CODEX_`).test(src), event);
    }
  });
}

check('launcher allowlist equals the entrypoints in hooks.json; only prepare and the MCP server install', () => {
  const launcher = read(`${A}/scripts/marrow-launch.cjs`);
  const allow = [...launcher.matchAll(/^ {2}'(codex-[a-z-]+)',$/gm)].map((m) => m[1]).concat('prepare').sort();
  assert.deepStrictEqual(allow, Object.values(EXPECTED).map((v) => v.entry).sort());
  assert.ok(launcher.includes("const MCP_MODE = 'mcp';") && launcher.includes('  MCP_MODE,\n  PREPARE,\n'));
  assert.ok(launcher.includes("const install = args[0] === MCP_MODE || args[0] === PREPARE;"));
  assert.ok(/if \(args\.length === 0\) \{[\s\S]*?process\.exitCode = 2;/.test(launcher), 'no argument must refuse, never start the server');
  assert.ok(launcher.includes('if (entry || !install) return entry;'));
  assert.ok(/permissionDecision: 'deny'/.test(launcher) && launcher.includes("const PRE_ACTION = 'codex-pre-action-hook';"));
  assert.ok(/'ci', '--ignore-scripts'/.test(launcher) && !/shell:/.test(launcher));
  const code = launcher.replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/@latest\b|\bnpx\b|--package=/.test(code), 'launcher resolves a package at run time');
});

check('no secret-looking values, no key variables with values, in the Codex files', () => {
  const patterns = [/mrw_(?:live|test)_[A-Za-z0-9]{6,}/, /\bsk-[A-Za-z0-9_-]{20,}/, /\bgh[pousr]_[A-Za-z0-9]{20,}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\bAKIA[0-9A-Z]{16}\b/, /MARROW_API_KEY"\s*:/];
  const files = [...listRepo(path.join(repo, 'codex')), path.join(repo, '.agents/plugins/marketplace.json')];
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    for (const pattern of patterns) assert.ok(!pattern.test(text), `${path.relative(repo, file)} matches ${pattern}`);
  }
});

check('exempt names equal the pinned release\'s default tool set', () => {
  if (!cliPath) throw new Error('pass the path to marrow-mcp/src/cli.ts (3.9.101) or src/tool-catalog.ts (3.9.102 on)');
  const source = fs.readFileSync(cliPath, 'utf8');
  const start = source.search(/const PRIMARY_TOOL_NAMES(?:: ReadonlySet<string>)? = new Set\(\[/);
  assert.ok(start >= 0, 'PRIMARY_TOOL_NAMES not found');
  const block = source.slice(start);
  const names = [...block.slice(0, block.indexOf(']);')).matchAll(/'(marrow_[a-z_]+)'/g)].map((m) => m[1]).sort();
  assert.deepStrictEqual(names, [...OWN_TOOLS].sort());
  assert.strictEqual(MATCHER, complement(OWN_NAMES));
});

// The name table. Codex names a plugin MCP tool mcp__<server>__<tool> in hook input (seen in Codex
// 0.161.0: mcp__marrow__marrow_think) and its shell tool Bash. Every name is gated except the 17 exact
// own names.
const FIXED = [
  'Bash', 'apply_patch', 'Edit', 'Write', 'MultiEdit', 'exec_command', 'write_stdin', 'view_image', 'web_search',
  'list_mcp_resources', 'read_mcp_resource', 'list_mcp_resource_templates', 'update_plan', 'spawn_agent',
  'request_user_input', '', ' ', '\n', 'mcp__', 'mcp__marrow__', 'mcp__marrow__marrow_', 'mcp__marrow__marrow_comm',
  'mcp__github__create_pull_request', 'mcp__codex_apps__github__push',
  'mcp__marrow__marrow_delete_all', 'mcp__marrow__marrow_auto', 'mcp__marrow__marrow_create_key', 'mcp__marrow__marrow_run',
  'mcp__marrow__marrow_commitx', 'mcp__marrow__marrow_commit ', 'mcp__marrow__marrow_commit\n', 'mcp__marrow__marrow_commit\r\n',
  'mcp__marrow__marrow_commit\0', ' mcp__marrow__marrow_commit', '\nmcp__marrow__marrow_commit', 'mcp__marrow__marrow_commit\nBash',
  'mcp__marrow__MARROW_COMMIT', 'mcp__MARROW__marrow_commit', 'mcp__Marrow__marrow_think', 'MCP__marrow__marrow_commit',
  'mcp__marrow2__marrow_commit', 'mcp__xmarrow__marrow_commit', 'mcp__evil_marrow__marrow_commit', 'mcp__marrow_evil__marrow_commit',
  'mcp__marrow__marrow_x__mcp__github__push', 'mcp__evil__mcp__marrow__marrow_commit', 'xmcp__marrow__marrow_commit',
  'functions.mcp__marrow__marrow_think', 'functions.marrow_think', 'functions.mcp__github__push',
  'mcp__plugin_marrow_marrow__marrow_commit', 'MCP:marrow:marrow_commit', 'MCP:marrow_commit', 'mcp_marrow_marrow_commit',
  'mcp__marrow__marrow_cоmmit', 'mcp__marrow__marrow_commit​', 'mcp__marrow__ｍarrow_commit',
];
function corpus() {
  const out = new Set([...FIXED, ...OWN_NAMES]);
  const prefixes = ['', ' ', '\n', '\t', 'x', 'functions.', 'mcp__'];
  const servers = ['mcp__marrow__', 'functions.mcp__marrow__', 'mcp__Marrow__', 'mcp__marrow2__', 'mcp__xmarrow__',
    'mcp__evil_marrow__', 'mcp__marrow__marrow__', 'mcp__plugin_marrow_marrow__', 'MCP:marrow:', 'mcp_marrow_', 'functions.', ''];
  const tools = [...OWN_TOOLS, 'marrow_auto', 'MARROW_COMMIT', 'marrow_delete_all', 'marrow_x__mcp__a__b', 'evil', 'Bash', 'apply_patch'];
  const suffixes = ['', '\n', ' ', 'x', '\0', '__mcp__a__b', '\r\n', '$'];
  for (const a of prefixes) for (const b of servers) for (const c of tools) for (const d of suffixes) out.add(a + b + c + d);
  return [...out];
}
const NAMES = corpus();
const own = new Set(OWN_NAMES);

check(`name table (${NAMES.length} names): only the 17 exact own names are skipped (JavaScript engine)`, () => {
  const re = new RegExp(MATCHER);
  let skipped = 0;
  for (const name of NAMES) {
    assert.strictEqual(re.test(name), !own.has(name), JSON.stringify(name));
    if (!re.test(name)) skipped += 1;
  }
  assert.strictEqual(skipped, OWN_NAMES.length);
});

check('never looser than the installer\'s intended Codex matcher (unanchored search, as Codex tests it)', () => {
  const INSTALLER_MATCHER = installerMatcher();
  const installer = new RegExp(INSTALLER_MATCHER);
  const plugin = new RegExp(MATCHER);
  let installerSkips = 0;
  for (const name of NAMES) {
    if (installer.test(name)) assert.ok(plugin.test(name) || own.has(name), `${JSON.stringify(name)} gated by the installer, skipped here`);
    if (!installer.test(name) && plugin.test(name)) installerSkips += 1;
  }
  // The installer skips 41 more exact names (the registered tools outside the default 17) and every
  // name without its tool words; this plugin gates all of those.
  assert.ok(installerSkips > 0);
});

if (tableOut || wasm) {
  const hex = (s) => Buffer.from(s, 'utf8').toString('hex');
  const lines = [
    ...Object.entries(hooks.hooks).filter(([, e]) => e[0].matcher === MATCHER).map(([event]) => `M ${event} ${hex(MATCHER)}`),
    `I ${hex(installerMatcher())}`,
    ...NAMES.map((name) => `N ${own.has(name) ? 0 : 1} ${hex(name)}`),
  ];
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-table-')), 'table.txt');
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  if (tableOut) fs.copyFileSync(file, path.resolve(tableOut));
  if (wasm) {
    check('Rust regex crate: matchers compile, the name table matches, the installer matcher is rejected', () => {
      const { WASI } = require('node:wasi');
      const wasi = new WASI({ version: 'preview1', args: ['check', '/t/table.txt'], preopens: { '/t': path.dirname(file) }, returnOnExit: true });
      const instance = new WebAssembly.Instance(new WebAssembly.Module(fs.readFileSync(wasm)), wasi.getImportObject());
      const code = wasi.start(instance);
      assert.strictEqual(code, 0, `Rust checker exit ${code}`);
    });
  }
}

function listRepo(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['.git', 'node_modules', 'target'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listRepo(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

process.stdout.write(failures ? `${failures} FAILED\n` : 'ALL PASS\n');
process.exit(failures ? 1 : 0);
