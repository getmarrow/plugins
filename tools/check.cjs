'use strict';
// Consistency and safety checks for the marrow plugin. No network, no writes.
//   node tools/check.cjs [path/to/marrow-install/src/pins.js]
// With pins.js, the plugin's pins must equal the @getmarrow/install release's pins.
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

const LAUNCH = '${CLAUDE_PLUGIN_ROOT}/scripts/marrow-launch.cjs';
const CHECK = '${CLAUDE_PLUGIN_ROOT}/scripts/marrow-session-check.cjs';
// @getmarrow/mcp 3.9.100 NATIVE_HOOK_MATCHER, as `npx @getmarrow/install` writes it.
const MASTER_MATCHER = 'Bash|Edit|Write|MultiEdit|Read|Glob|Grep|Search|WebSearch|Task|functions\\.(?!mcp__marrow__marrow_).*|mcp__(?!marrow__marrow_).*';
// The same, plus the plugin-scoped name of Marrow's own MCP tools (server `marrow` in plugin `marrow`).
const PLUGIN_MATCHER = 'Bash|Edit|Write|MultiEdit|Read|Glob|Grep|Search|WebSearch|Task|functions\\.(?!mcp__marrow__marrow_).*|mcp__(?!marrow__marrow_|plugin_marrow_marrow__marrow_).*';

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
  assert.ok(!/@latest\b/.test(launcher));
  assert.ok(/`--package=@getmarrow\/mcp@\$\{version\}`/.test(launcher), 'npx fallback uses the pinned version');
});

check('plugin sets no Claude Code settings and no permission or hook switches', () => {
  assert.strictEqual(manifest.settings, undefined);
  assert.strictEqual(manifest.userConfig, undefined);
  assert.ok(!fs.existsSync(path.join(plugin, 'settings.json')));
  assert.ok(!fs.existsSync(path.join(plugin, 'bin')), 'no executables on the Bash PATH');
  const all = listRepo(plugin).filter((f) => !f.endsWith('package-lock.json')).map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  for (const word of ['disableAllHooks', 'allowManagedHooksOnly', 'bypassPermissions', 'dangerously', 'permissions.allow', 'enabledPlugins']) {
    assert.ok(!all.includes(word), `plugin mentions ${word}`);
  }
});

check('no secret-looking values in the repository', () => {
  const patterns = [/mrw_(?:live|test)_[A-Za-z0-9]{6,}/, /\bsk-[A-Za-z0-9_-]{20,}/, /\bgh[pousr]_[A-Za-z0-9]{20,}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\bAKIA[0-9A-Z]{16}\b/, /\bxox[abpr]-[A-Za-z0-9-]{10,}/];
  for (const file of listRepo(repo)) {
    const text = fs.readFileSync(file, 'utf8');
    for (const pattern of patterns) assert.ok(!pattern.test(text), `${path.relative(repo, file)} matches ${pattern}`);
  }
});

// Collision table for the hook matcher, which decides which tool calls Marrow sees.
const TOOLS = [
  ['Bash', true], ['Edit', true], ['Write', true], ['MultiEdit', true], ['NotebookEdit', true], ['Read', true],
  ['Glob', true], ['Grep', true], ['WebSearch', true], ['Task', true],
  ['mcp__github__create_pull_request', true], ['mcp__plugin_other_db__query', true],
  ['mcp__marrow__marrow_agent_runtime', false], ['mcp__plugin_marrow_marrow__marrow_agent_runtime', false],
  ['mcp__plugin_marrow_marrow__marrow_commit', false],
  ['mcp__plugin_marrow_marrow__evil', true], ['mcp__plugin_marrow_marrow__Marrow_x', true],
  ['mcp__plugin_marrow_marrow___marrow_x', true], ['mcp__plugin_marrow_marrowx__marrow_x', true],
  ['mcp__plugin_marrow-evil_marrow__marrow_x', true], ['mcp__plugin_evil_marrow__marrow_x', true],
  ['mcp__plugin_marrow_marrow2__marrow_x', true], ['mcp__plugin_xmarrow_marrow__marrow_x', true],
  ['mcp__plugin_marrow_marrow__marrow_x__mcp__github__push', true],
  ['functions.mcp__marrow__marrow_think', false], ['functions.mcp__github__push', true],
];
check('matcher collision table: only Marrow\'s own MCP tools are skipped', () => {
  const plugin = new RegExp(PLUGIN_MATCHER);
  for (const [tool, gated] of TOOLS) assert.strictEqual(plugin.test(tool), gated, tool);
});
check('matcher is never looser than the installer\'s, except Marrow\'s own plugin-scoped tools', () => {
  const plugin = new RegExp(PLUGIN_MATCHER);
  const master = new RegExp(MASTER_MATCHER);
  for (const [tool] of TOOLS) {
    if (master.test(tool) && !plugin.test(tool)) {
      assert.match(tool, /^mcp__plugin_marrow_marrow__marrow_[a-z0-9_]+$/, `${tool} is skipped by the plugin but gated by the installer`);
    }
    if (plugin.test(tool)) assert.ok(master.test(tool) || /^mcp__plugin_/.test(tool), tool);
  }
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
