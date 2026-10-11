'use strict';
// Consistency and safety checks for the marrow plugin. No network, no writes.
//   node tools/check.cjs [path/to/marrow-install/src/pins.js] [path/to/marrow-mcp/src/cli.ts]
// With pins.js, the plugin's pins must equal the @getmarrow/install release's pins. With cli.ts, the
// matcher's exempt tool names must equal that release's default (primary) tool set.
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const repo = path.resolve(__dirname, '..');
const plugin = path.join(repo, 'plugins', 'marrow');
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

const marketplace = json('.claude-plugin/marketplace.json');
const manifest = json('plugins/marrow/.claude-plugin/plugin.json');
const pkg = json('plugins/marrow/package.json');
const lock = json('plugins/marrow/package-lock.json');
const pins = json('plugins/marrow/scripts/mcp-manifest.json');
const hooks = json('plugins/marrow/hooks/hooks.json');
const mcp = json('plugins/marrow/.mcp.json');
const launcher = read('plugins/marrow/scripts/marrow-launch.cjs');
const sessionCheck = read('plugins/marrow/scripts/marrow-session-check.cjs');

const LAUNCH = '${CLAUDE_PLUGIN_ROOT}/scripts/marrow-launch.cjs';
const CHECK = '${CLAUDE_PLUGIN_ROOT}/scripts/marrow-session-check.cjs';
// @getmarrow/mcp 3.9.100 NATIVE_HOOK_MATCHER, as `npx @getmarrow/install` writes it.
const MASTER_MATCHER = 'Bash|Edit|Write|MultiEdit|Read|Glob|Grep|Search|WebSearch|Task|functions\\.(?!mcp__marrow__marrow_).*|mcp__(?!marrow__marrow_).*';
// The 17 tools @getmarrow/mcp 3.9.100 serves by default (PRIMARY_TOOL_NAMES in src/cli.ts). In this
// plugin they are named mcp__plugin_marrow_marrow__<tool>.
const OWN_TOOLS = ['marrow_agent_runtime', 'marrow_agent_status', 'marrow_arbitrate', 'marrow_buyer_proof',
  'marrow_commit', 'marrow_completion_contracts', 'marrow_coordinate', 'marrow_decision_brief',
  'marrow_decision_trace', 'marrow_evaluate_completion_contract', 'marrow_fleet_lessons',
  'marrow_governance_timeline', 'marrow_model_usage', 'marrow_replay_compare', 'marrow_think',
  'marrow_value_report', 'marrow_workflow_gate'];
// Every tool call that contains one of the installer's tool words or prefixes, except exactly those
// 17 whole names. Tested by Claude Code with RegExp.prototype.test (unanchored), so ^ pins the
// exemption to the whole name and [\s\S]* keeps "anywhere in the name" for the rest.
const PLUGIN_MATCHER = `^(?!mcp__plugin_marrow_marrow__(?:${OWN_TOOLS.join('|')})$)[\\s\\S]*`
  + '(?:Bash|Edit|Write|MultiEdit|Read|Glob|Grep|Search|WebSearch|Task|functions\\.|mcp__)';

check('marketplace and manifest name the plugin "marrow" with a pinned version', () => {
  assert.strictEqual(marketplace.name, 'getmarrow');
  assert.strictEqual(marketplace.plugins.length, 1);
  assert.strictEqual(marketplace.plugins[0].name, 'marrow');
  assert.strictEqual(marketplace.plugins[0].source, './plugins/marrow');
  assert.strictEqual(manifest.name, 'marrow');
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.strictEqual(marketplace.plugins[0].version, undefined, 'version belongs in plugin.json only');
});

check('package.json pins exact versions that the lockfile resolves with sha512 integrity', () => {
  const deps = pkg.dependencies;
  assert.deepStrictEqual(Object.keys(deps).sort(), ['@getmarrow/mcp', '@getmarrow/sdk']);
  for (const [name, version] of Object.entries(deps)) {
    assert.match(version, /^\d+\.\d+\.\d+$/, `${name} must be an exact version`);
    const entry = lock.packages[`node_modules/${name}`];
    assert.ok(entry, `${name} missing from the lockfile`);
    assert.strictEqual(entry.version, version);
    assert.match(entry.integrity, /^sha512-/);
    assert.strictEqual(entry.resolved, `https://registry.npmjs.org/${name}/-/${name.split('/')[1]}-${version}.tgz`);
  }
  assert.deepStrictEqual(lock.packages[''].dependencies, deps);
  assert.ok([2, 3].includes(lock.lockfileVersion));
  assert.strictEqual(pkg.overrides, undefined, 'Claude Code skips the dependency install when overrides are set');
  assert.strictEqual(pkg.scripts, undefined);
  assert.strictEqual(Object.keys(lock.packages).filter(Boolean).length, 2, 'only the two pinned packages');
});

check('mcp-manifest.json matches the lockfile', () => {
  assert.strictEqual(pins.schema, 'marrow-plugin-mcp-manifest.v1');
  for (const name of ['mcp', 'sdk']) {
    const entry = lock.packages[`node_modules/@getmarrow/${name}`];
    assert.deepStrictEqual(pins[name], { version: entry.version, integrity: entry.integrity });
  }
  assert.strictEqual(pins.bin, '@getmarrow/mcp/dist/cli.js');
  assert.ok(pins.files.includes(pins.bin));
  assert.match(pins.sha256, /^[0-9a-f]{64}$/);
});

const pinsPath = process.argv[2];
check('pins equal the @getmarrow/install release pins (src/pins.js)', () => {
  if (!pinsPath) throw new Error('pass the path to marrow-install/src/pins.js');
  const release = require(path.resolve(pinsPath));
  assert.strictEqual(pkg.dependencies['@getmarrow/mcp'], release.MCP_ADAPTER_VERSION);
  assert.strictEqual(pins.mcp.integrity, release.MCP_ADAPTER_INTEGRITY);
  assert.strictEqual(pkg.dependencies['@getmarrow/sdk'], release.SDK_ADAPTER_VERSION);
  assert.strictEqual(pins.sdk.integrity, release.SDK_ADAPTER_INTEGRITY);
});

const EXPECTED = {
  UserPromptSubmit: { matcher: undefined, entry: 'claude-context-hook' },
  PreToolUse: { matcher: PLUGIN_MATCHER, entry: 'claude-pre-action-hook' },
  PostToolUse: { matcher: PLUGIN_MATCHER, entry: 'claude-hook' },
  PostToolUseFailure: { matcher: PLUGIN_MATCHER, entry: 'claude-hook' },
  Stop: { matcher: undefined, entry: 'claude-session-hook' },
  PermissionRequest: { matcher: PLUGIN_MATCHER, entry: 'claude-permission-request-hook', async: true },
  PostToolBatch: { matcher: undefined, entry: 'claude-hook', async: true },
};

check('hooks are exactly the installer\'s Claude Code events, entrypoints and fields', () => {
  const events = Object.keys(hooks.hooks).sort();
  assert.deepStrictEqual(events, [...Object.keys(EXPECTED), 'SessionStart'].sort());
  for (const [event, want] of Object.entries(EXPECTED)) {
    const entries = hooks.hooks[event];
    assert.strictEqual(entries.length, 1, event);
    assert.strictEqual(entries[0].matcher, want.matcher, `${event} matcher`);
    assert.strictEqual(entries[0].hooks.length, 1, event);
    const handler = entries[0].hooks[0];
    const expected = { type: 'command', command: 'node', args: [LAUNCH, want.entry] };
    if (want.async) expected.async = true;
    assert.deepStrictEqual(handler, expected, event);
  }
  const start = hooks.hooks.SessionStart;
  assert.deepStrictEqual(start, [{ matcher: 'startup|resume', hooks: [{ type: 'command', command: 'node', args: [CHECK], timeout: 5 }] }]);
});

check('MCP server runs the same launcher with no entrypoint', () => {
  assert.deepStrictEqual(mcp, { mcpServers: { marrow: { command: 'node', args: [LAUNCH] } } });
});

check('launcher allowlist equals the entrypoints in hooks.json', () => {
  const allow = [...launcher.matchAll(/^ {2}'(claude-[a-z-]+)',$/gm)].map((m) => m[1]).sort();
  const used = [...new Set(Object.values(EXPECTED).map((v) => v.entry))].sort();
  assert.deepStrictEqual(allow, used);
});

check('no unpinned or latest package spec, no npx in hook or MCP config', () => {
  const commands = [];
  const collect = (value, key) => {
    if (Array.isArray(value)) value.forEach((v) => collect(v, key));
    else if (value && typeof value === 'object') Object.entries(value).forEach(([k, v]) => collect(v, k));
    else if (typeof value === 'string' && ['command', 'args'].includes(key)) commands.push(value);
  };
  collect(hooks.hooks, '');
  collect(mcp.mcpServers, '');
  assert.ok(commands.length >= 9);
  for (const text of commands) {
    assert.ok(!/@latest\b/.test(text), `${text} names @latest`);
    assert.ok(!/\bnpx\b/.test(text), `${text} runs npx`);
  }
  assert.ok(!/@latest\b/.test(launcher) && !/@latest\b/.test(sessionCheck), 'a script names @latest');
  // The launcher never resolves a package by name at run time; the session check only prints text.
  const code = launcher.replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/\bnpx\b|--package=|['"](?:exec|install|i)['"]/.test(code), 'launcher resolves a package at run time');
});

check('launcher runs only a manifest-verified copy and fails closed for the pre-action hook', () => {
  assert.ok(/manifest\.files\.includes\(manifest\.bin\)/.test(launcher), 'bin must be one of the hashed files');
  assert.ok(/'ci', '--ignore-scripts'/.test(launcher), 'data-dir copy comes from the lockfile with scripts off');
  assert.ok(/cwd: stage/.test(launcher), 'npm runs in the private staging directory, not the project');
  assert.ok(!/shell:/.test(launcher), 'no shell');
  assert.ok(/verifiedEntry\(manifest, path\.join\(stage, 'node_modules'\)\)/.test(launcher), 'staged copy verified before use');
  assert.ok(/permissionDecision: 'deny'/.test(launcher), 'pre-action hook holds the call when no verified copy loads');
  const requires = [...launcher.matchAll(/require\(([^)]+)\)/g)].map((m) => m[1]).sort();
  assert.deepStrictEqual(requires, ["'child_process'", "'crypto'", "'fs'", "'path'", 'entry']);
});

check('session check only reads files and prints fixed text', () => {
  for (const call of ['writeFile', 'appendFile', 'writeSync', 'rename', 'unlink', 'rmSync', 'mkdir', 'copyFile', 'chmod', 'spawn', 'exec', 'child_process', 'fetch', 'http']) {
    assert.ok(!sessionCheck.includes(call), `session check uses ${call}`);
  }
});

check('plugin sets no Claude Code settings and no permission or hook switches', () => {
  assert.strictEqual(manifest.settings, undefined);
  assert.strictEqual(manifest.userConfig, undefined);
  assert.ok(!fs.existsSync(path.join(plugin, 'settings.json')));
  assert.ok(!fs.existsSync(path.join(plugin, 'bin')), 'no executables on the Bash PATH');
  const files = listRepo(plugin).filter((f) => !f.endsWith('package-lock.json'));
  const all = files.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  for (const word of ['disableAllHooks', 'allowManagedHooksOnly', 'bypassPermissions', 'dangerously', 'permissions.allow']) {
    assert.ok(!all.includes(word), `plugin mentions ${word}`);
  }
  // The session check reads enabledPlugins to warn about a second plugin named marrow; nothing else names it.
  const others = files.filter((f) => !f.endsWith('marrow-session-check.cjs')).map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  assert.ok(!others.includes('enabledPlugins'), 'only the read-only session check names enabledPlugins');
});

check('no secret-looking values in the repository', () => {
  const patterns = [/mrw_(?:live|test)_[A-Za-z0-9]{6,}/, /\bsk-[A-Za-z0-9_-]{20,}/, /\bgh[pousr]_[A-Za-z0-9]{20,}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\bAKIA[0-9A-Z]{16}\b/, /\bxox[abpr]-[A-Za-z0-9-]{10,}/];
  for (const file of listRepo(repo)) {
    const text = fs.readFileSync(file, 'utf8');
    for (const pattern of patterns) assert.ok(!pattern.test(text), `${path.relative(repo, file)} matches ${pattern}`);
  }
});

// Collision table for the hook matcher, which decides which tool calls Marrow sees.
const OWN = OWN_TOOLS.map((t) => `mcp__plugin_marrow_marrow__${t}`);
const TOOLS = [
  ...OWN.map((t) => [t, false]),
  ['Bash', true], ['Edit', true], ['Write', true], ['MultiEdit', true], ['NotebookEdit', true], ['Read', true],
  ['Glob', true], ['Grep', true], ['WebSearch', true], ['Task', true],
  ['mcp__github__create_pull_request', true], ['mcp__plugin_other_db__query', true],
  // Marrow-looking names outside the 17 exact plugin names are all sent to the hook.
  ['mcp__marrow__marrow_agent_runtime', true], ['mcp__marrow__marrow_delete_all', true],
  ['mcp__MARROW__marrow_delete_all', true], ['mcp__Marrow__marrow_exec', true],
  ['functions.mcp__marrow__marrow_think', true], ['functions.mcp__plugin_marrow_marrow__marrow_commit', true],
  ['functions.mcp__github__push', true],
  ['mcp__plugin_marrow_marrow__marrow_x__deploy_prod', true], ['mcp__plugin_marrow_marrow__marrow_commit\n', true],
  ['mcp__plugin_marrow_marrow__marrow_commitx', true], ['mcp__plugin_marrow_marrow__marrow_commit ', true],
  ['mcp__plugin_marrow_marrow__marrow_auto', true], ['mcp__plugin_marrow_marrow__marrow_create_key', true],
  ['mcp__plugin_marrow_marrow__marrow_run', true], ['mcp__plugin_marrow_marrow__MARROW_COMMIT', true],
  ['mcp__plugin_Marrow_marrow__marrow_commit', true], ['mcp__plugin_marrow_Marrow__marrow_commit', true],
  ['mcp__plugin_marrow_marrow__evil', true], ['mcp__plugin_marrow_marrow__Marrow_x', true],
  ['mcp__plugin_marrow_marrow___marrow_commit', true], ['mcp__plugin_marrow_marrowx__marrow_commit', true],
  ['mcp__plugin_marrow-evil_marrow__marrow_commit', true], ['mcp__plugin_evil_marrow__marrow_commit', true],
  ['mcp__plugin_marrow_marrow2__marrow_commit', true], ['mcp__plugin_xmarrow_marrow__marrow_commit', true],
  ['mcp__plugin_marrow_marrow__marrow_x__mcp__github__push', true], ['mcp__evil__plugin_marrow_marrow__marrow_commit', true],
  ['xmcp__plugin_marrow_marrow__marrow_commit', true], [' mcp__plugin_marrow_marrow__marrow_commit', true],
  ['mcp__plugin_marrow_marrow__marrow_commit\nBash', true], ['\nmcp__plugin_marrow_marrow__marrow_commit', true],
];
check('matcher collision table: only the 17 exact plugin tool names are skipped', () => {
  const re = new RegExp(PLUGIN_MATCHER);
  for (const [tool, gated] of TOOLS) assert.strictEqual(re.test(tool), gated, JSON.stringify(tool));
});
check('matcher is never looser than the installer\'s, except the 17 exact plugin tool names', () => {
  const plugin = new RegExp(PLUGIN_MATCHER);
  const master = new RegExp(MASTER_MATCHER);
  // Fixed cases plus every combination of prefix, server, tool and suffix fragments.
  const prefixes = ['', 'x', ' ', '\n', 'functions.', 'mcp__', 'Bash'];
  const servers = ['mcp__marrow__', 'mcp__plugin_marrow_marrow__', 'mcp__Marrow__', 'mcp__plugin_marrow_marrow2__', 'mcp__evil__', 'MCP:marrow:', ''];
  const tools = ['marrow_commit', 'marrow_agent_runtime', 'marrow_auto', 'MARROW_COMMIT', 'evil', 'Bash', 'Read', 'marrow_x__mcp__a__b'];
  const suffixes = ['', '\n', ' ', 'x', '$', '__mcp__a__b'];
  const corpus = TOOLS.map(([t]) => t);
  for (const a of prefixes) for (const b of servers) for (const c of tools) for (const d of suffixes) corpus.push(a + b + c + d);
  let skippedByPlugin = 0;
  for (const tool of corpus) {
    if (master.test(tool) && !plugin.test(tool)) {
      assert.ok(OWN.includes(tool), `${JSON.stringify(tool)} is skipped by the plugin but gated by the installer`);
      skippedByPlugin += 1;
    }
  }
  assert.ok(skippedByPlugin >= OWN.length, 'the corpus covers every exempt name');
});
check('exempt tool names equal the pinned release\'s default tool set', () => {
  const cli = process.argv[3];
  if (!cli) return;
  const source = fs.readFileSync(cli, 'utf8');
  const block = source.slice(source.indexOf('const PRIMARY_TOOL_NAMES = new Set(['));
  const names = [...block.slice(0, block.indexOf(']);')).matchAll(/'(marrow_[a-z_]+)'/g)].map((m) => m[1]).sort();
  assert.deepStrictEqual(names, [...OWN_TOOLS].sort());
});

function listRepo(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['.git', 'node_modules'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listRepo(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

process.stdout.write(failures ? `${failures} FAILED\n` : 'ALL PASS\n');
process.exit(failures ? 1 : 0);
