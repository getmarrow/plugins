'use strict';
// Consistency and safety checks for the marrow plugin. No network, no writes.
//   node tools/check.cjs [marrow-install/src/pins.js] [marrow-mcp/src/cli.ts or src/tool-catalog.ts] [marrow-mcp/dist/hook-contract.js ...]
// With pins.js, the plugin's pins must equal the @getmarrow/install release's pins. With cli.ts (3.9.101)
// or tool-catalog.ts (3.9.102 on), the matcher's exempt tool names must equal that release's default
// (primary) tool set. Each built hook-contract.js adds that release's NATIVE_HOOK_MATCHER to the
// never-looser comparison.
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const repo = path.resolve(__dirname, '..');
// --installer-cursor-hooks <file>: the .cursor/hooks.json that @getmarrow/install writes (generated
// offline from the release), compared field by field with the Cursor plugin's hooks.
const argv = process.argv.slice(2);
const flag = argv.indexOf('--installer-cursor-hooks');
const installerCursorHooks = flag >= 0 ? argv.splice(flag, 2)[1] : null;
// --installer-own-tools <file>: the installer's src/marrow-own-tools.js; the Cursor matchers must equal
// the ones it builds.
const ownFlag = argv.indexOf('--installer-own-tools');
const installerOwnTools = ownFlag >= 0 ? argv.splice(ownFlag, 2)[1] : null;
process.argv = [process.argv[0], process.argv[1], ...argv];
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
const cursorManifest = json('plugins/marrow-cursor/.cursor-plugin/plugin.json');
const cursorMarket = json('.cursor-plugin/marketplace.json');
const cursorHooks = json('plugins/marrow-cursor/hooks/hooks.json');
const cursorMcp = json('plugins/marrow-cursor/mcp.json');
const sessionCheck = read('plugins/marrow/scripts/marrow-session-check.cjs');

const LAUNCH = '${CLAUDE_PLUGIN_ROOT}/scripts/marrow-launch.cjs';
const CHECK = '${CLAUDE_PLUGIN_ROOT}/scripts/marrow-session-check.cjs';
// @getmarrow/mcp 3.9.100 and 3.9.101 NATIVE_HOOK_MATCHER, as `npx @getmarrow/install` writes it.
const MASTER_MATCHER = 'Bash|Edit|Write|MultiEdit|Read|Glob|Grep|Search|WebSearch|Task|functions\\.(?!mcp__marrow__marrow_).*|mcp__(?!marrow__marrow_).*';
// The 17 tools @getmarrow/mcp 3.9.100 and 3.9.101 serve by default (PRIMARY_TOOL_NAMES in src/cli.ts). In this
// plugin they are named mcp__plugin_marrow_marrow__<tool>.
const OWN_TOOLS = ['marrow_agent_runtime', 'marrow_agent_status', 'marrow_arbitrate', 'marrow_buyer_proof',
  'marrow_commit', 'marrow_completion_contracts', 'marrow_coordinate', 'marrow_decision_brief',
  'marrow_decision_trace', 'marrow_evaluate_completion_contract', 'marrow_fleet_lessons',
  'marrow_governance_timeline', 'marrow_model_usage', 'marrow_replay_compare', 'marrow_think',
  'marrow_value_report', 'marrow_workflow_gate'];
// Read-only Claude Code tools no released matcher hooked (the installer's CLAUDE_UNHOOKED_READ_ONLY_TOOLS).
const UNHOOKED_READ_ONLY = ['LS', 'ListMcpResourcesTool'];
// Every tool call except exactly those 17 whole names and the read-only names above: built-ins outside any
// fixed list (Monitor and PowerShell run shell commands) and future tools reach the hook. Tested by Claude
// Code with RegExp.prototype.test (unanchored), so ^ and $ pin the exemption to the whole name.
const PLUGIN_MATCHER = `^(?!(?:mcp__plugin_marrow_marrow__(?:${OWN_TOOLS.join('|')})|${UNHOOKED_READ_ONLY.join('|')})$)[\\s\\S]*`;
// The matcher this plugin shipped at 9b56d909 (a fixed list of tool words): the new one never skips a name it gated.
const PLUGIN_LIST_MATCHER = `^(?!mcp__plugin_marrow_marrow__(?:${OWN_TOOLS.join('|')})$)[\\s\\S]*`
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
  // The re-pin records the marrow-mcp commit the pinned tarball was packed from (optional; the launcher ignores it).
  if (pins.source !== undefined) {
    assert.deepStrictEqual(Object.keys(pins.source).sort(), ['commit', 'repository']);
    assert.strictEqual(pins.source.repository, 'getmarrow/marrow-mcp');
    assert.match(pins.source.commit, /^[0-9a-f]{40}$/);
  }
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
  // The one field the plugin adds to the installer's shape: an explicit host timeout (PKG-L2). The pinned
  // pre-action hook allows itself 14 s for Claude Code (marrow-mcp src/host-approval.ts preToolBudgetMs), so the host
  // gives up only after the hook has decided.
  PreToolUse: { matcher: PLUGIN_MATCHER, entry: 'claude-pre-action-hook', timeout: 20 },
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
    // One command string with the entrypoint inline (the installer's shape), so a host that drops
    // exec-form args can never start the launcher without an entrypoint.
    const expected = { type: 'command', command: `node "${LAUNCH}" ${want.entry}` };
    if (want.async) expected.async = true;
    if (want.timeout) expected.timeout = want.timeout;
    assert.deepStrictEqual(handler, expected, event);
  }
  const start = hooks.hooks.SessionStart;
  assert.deepStrictEqual(start, [{ matcher: 'startup|resume', hooks: [{ type: 'command', command: `node "${CHECK}"`, timeout: 5 }] }]);
});

// Cursor: the hooks @getmarrow/install 0.1.70 writes with host approvals (MCP 3.9.99 and later), with
// the npx command swapped for the plugin's launcher. The matchers are the installer's bytes
// (OWN_TOOL_MATCHERS.cursor and .cursorPreToolUseHostApproval in src/marrow-own-tools.js): no MCP
// label is skipped by name, because Cursor's preToolUse names an MCP tool `MCP:<tool>` without its
// server. beforeMCPExecution has no own-tool fast path here: every MCP call goes to the pinned
// hook, which allows Marrow's own tools only for the server exactly `marrow` and an exact name.
const CURSOR_PRE_MATCHER = 'Write|Delete|Task|Read|Glob|Grep|Search|WebSearch|List|[\\s\\S]*MCP:[\\s\\S]*';
const CURSOR_MATCHER = 'Shell|Write|Delete|Task|Read|Glob|Grep|Search|WebSearch|List|[\\s\\S]*MCP:[\\s\\S]*';
// The plugin root, never a path relative to the project the agent works in (audit H1).
const CURSOR_LAUNCH = 'node "${CURSOR_PLUGIN_ROOT}/scripts/marrow-launch.cjs"';
const GATE = { timeout: 15, failClosed: true, async: false };
const CURSOR_EXPECTED = {
  preToolUse: { entry: 'cursor-pre-action-hook', matcher: CURSOR_PRE_MATCHER, ...GATE },
  postToolUse: { entry: 'cursor-hook', matcher: CURSOR_MATCHER, timeout: 5 },
  postToolUseFailure: { entry: 'cursor-hook', matcher: CURSOR_MATCHER, timeout: 5 },
  stop: { entry: 'cursor-session-hook', timeout: 3 },
  beforeShellExecution: { entry: 'cursor-pre-action-hook', ...GATE },
  beforeMCPExecution: { entry: 'cursor-pre-action-hook', ...GATE },
  afterShellExecution: { entry: 'cursor-hook', timeout: 5 },
  afterMCPExecution: { entry: 'cursor-hook', timeout: 5 },
  sessionStart: { entry: 'cursor-session-hook', timeout: 5 },
  beforeSubmitPrompt: { entry: 'cursor-context-hook', timeout: 5 },
};
check('Cursor marketplace and manifest name the plugin "marrow" with a pinned version', () => {
  assert.strictEqual(cursorMarket.name, 'getmarrow');
  assert.deepStrictEqual(cursorMarket.plugins.map((p) => [p.name, p.source]), [['marrow', './plugins/marrow-cursor']]);
  assert.strictEqual(cursorManifest.name, 'marrow');
  assert.match(cursorManifest.version, /^\d+\.\d+\.\d+$/);
  assert.strictEqual(cursorManifest.license, 'MIT');
  for (const key of ['variables', 'hooks', 'mcpServers', 'skills', 'rules']) assert.strictEqual(cursorManifest[key], undefined, `${key}: default discovery only`);
});
check('Cursor hooks are exactly the installer\'s events, matchers, timeouts and failClosed fields', () => {
  assert.strictEqual(cursorHooks.version, 1);
  assert.deepStrictEqual(Object.keys(cursorHooks.hooks).sort(), Object.keys(CURSOR_EXPECTED).sort());
  for (const [event, want] of Object.entries(CURSOR_EXPECTED)) {
    const { entry, ...fields } = want;
    assert.deepStrictEqual(cursorHooks.hooks[event], [{ command: `${CURSOR_LAUNCH} ${entry}`, ...fields }], event);
  }
  if (!installerCursorHooks) return;
  const installer = JSON.parse(fs.readFileSync(installerCursorHooks, 'utf8'));
  assert.strictEqual(installer.version, 1);
  assert.deepStrictEqual(Object.keys(installer.hooks).sort(), Object.keys(CURSOR_EXPECTED).sort(), 'same events as the installer');
  for (const [event, entries] of Object.entries(installer.hooks)) {
    assert.strictEqual(entries.length, 1, event);
    const { command, ...fields } = entries[0];
    const { command: ours, ...ourFields } = cursorHooks.hooks[event][0];
    assert.deepStrictEqual(ourFields, fields, `${event} fields`);
    const sub = event === 'beforeMCPExecution' ? 'cursor-pre-action-hook'
      : command.match(/marrow-mcp (cursor-[a-z-]+)$/)[1];
    assert.strictEqual(ours, `${CURSOR_LAUNCH} ${sub}`, `${event} entrypoint`);
  }
});
check('Cursor MCP server runs the same launcher, with no key or env in the config', () => {
  assert.deepStrictEqual(cursorMcp, { mcpServers: { marrow: { command: 'node', args: ['${CURSOR_PLUGIN_ROOT}/scripts/marrow-launch.cjs', 'mcp'] } } });
});
check('Cursor plugin ships the same pinned runtime files byte for byte', () => {
  for (const file of ['package.json', 'package-lock.json', 'LICENSE', 'scripts/marrow-launch.cjs', 'scripts/mcp-manifest.json']) {
    assert.ok(read(`plugins/marrow/${file}`) === read(`plugins/marrow-cursor/${file}`), file);
  }
  if (process.platform !== 'win32') {
    for (const dir of ['marrow', 'marrow-cursor']) {
      assert.ok(fs.statSync(path.join(repo, 'plugins', dir, 'scripts', 'marrow-launch.cjs')).mode & 0o100, `${dir} launcher is executable`);
    }
  }
  assert.ok(launcher.startsWith('#!/usr/bin/env node\n'));
  assert.ok(!fs.existsSync(path.join(repo, 'plugins', 'marrow', '.cursor-plugin')) && !fs.existsSync(path.join(repo, 'plugins', 'marrow-cursor', '.claude-plugin')), 'one host per plugin folder');
});
check('Cursor launcher allowlist equals the entrypoints in the Cursor hooks', () => {
  const block = launcher.slice(launcher.indexOf('CURSOR ? ['), launcher.indexOf('] : ['));
  const allow = [...block.matchAll(/'(cursor-[a-z-]+)'/g)].map((m) => m[1]).sort();
  assert.deepStrictEqual(allow, [...new Set(Object.values(CURSOR_EXPECTED).map((v) => v.entry))].sort());
});

check('MCP server runs the same launcher with the explicit mcp argument', () => {
  assert.deepStrictEqual(mcp, { mcpServers: { marrow: { command: 'node', args: [LAUNCH, 'mcp'] } } });
});

// H1 / M3 static proof: every hook command of every plugin is `node "<plugin root variable>/scripts/..."`
// plus one entrypoint word, with no exec-form args and no path that resolves against the project. A
// project holding its own scripts/marrow-launch.cjs, resolved as each host would (variable -> plugin
// folder, cwd -> project), is never what a hook command runs.
check('no hook command can reference a project\'s own scripts/marrow-launch.cjs', () => {
  const os = require('os');
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-planted-'));
  fs.mkdirSync(path.join(project, 'scripts'));
  const planted = path.join(project, 'scripts', 'marrow-launch.cjs');
  fs.writeFileSync(planted, "require('fs').writeFileSync('PLANTED_MARKER', 'ran');\n");
  const plugins = [
    ['claude', hooks, 'CLAUDE_PLUGIN_ROOT', path.join(repo, 'plugins', 'marrow'), 8],
    ['cursor', cursorHooks, 'CURSOR_PLUGIN_ROOT', path.join(repo, 'plugins', 'marrow-cursor'), 10],
    ['codex', json('codex/marrow/hooks/hooks.json'), 'PLUGIN_ROOT', path.join(repo, 'codex', 'marrow'), 5],
  ];
  let seen = 0;
  try {
    for (const [host, file, variable, root, count] of plugins) {
      const commands = [];
      JSON.stringify(file.hooks, (key, value) => {
        if (key === 'args') throw new Error(`${host}: exec-form args are lost by hosts that import the plugin`);
        if (key === 'command' && typeof value === 'string') commands.push(value);
        return value;
      });
      assert.strictEqual(commands.length, count, `${host}: every hook command is checked`);
      for (const command of commands) {
        const m = new RegExp('^node "\\$\\{' + variable + '\\}/scripts/(marrow-launch|marrow-session-check)\\.cjs"(?: [a-z-]+)?$').exec(command);
        assert.ok(m, `${host}: ${command} is not node "\${${variable}}/scripts/<script>" <entrypoint>`);
        const script = path.resolve(project, command.match(/"([^"]+)"/)[1].replace('${' + variable + '}', root));
        assert.ok(script.startsWith(root + path.sep), `${host}: ${command} resolves outside the plugin`);
        assert.notStrictEqual(script, planted, `${host}: ${command} runs the project's script`);
        assert.ok(fs.existsSync(script), `${host}: ${script} does not exist`);
        seen += 1;
      }
    }
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
  assert.strictEqual(seen, 23, 'all hook commands checked');
});

check('launcher allowlist equals the entrypoints in hooks.json', () => {
  const allow = [...launcher.matchAll(/^ {2}'(claude-[a-z-]+)',$/gm)].map((m) => m[1]).sort();
  assert.ok(/new Set\(CURSOR === CLAUDE \? \[\]/.test(launcher), 'no entrypoint when the host is ambiguous');
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
  collect(cursorHooks.hooks, '');
  collect(cursorMcp.mcpServers, '');
  assert.ok(commands.length >= 20);
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
  // envFile: the pinned server's own dist/env.js, asked whether a key exists (see the keyless stub check below).
  assert.deepStrictEqual(requires, ["'child_process'", "'crypto'", "'fs'", "'os'", "'path'", 'entry', 'envFile']);
  assert.ok(/permission: 'deny'/.test(launcher) && /process\.exitCode = 2/.test(launcher), 'Cursor pre-action hook blocks (exit 2) when no verified copy loads');
});

check('keyless MCP stub: runs only for mcp, only after the verified copy and the server\'s own key test, and touches nothing', () => {
  const begin = launcher.indexOf('// ---- keyless MCP stub (begin)');
  const end = launcher.indexOf('// ---- keyless MCP stub (end)');
  assert.ok(begin > 0 && end > begin, 'stub markers');
  const stub = launcher.slice(begin, end).replace(/^\s*\/\/.*$/gm, '');
  // The decision: the server's own call (no options), a strict empty-string test, any doubt -> the real server.
  assert.ok(/require\(envFile\)\.resolveMarrowEnv\(\)/.test(stub), 'asks the verified copy\'s own resolver with no options');
  assert.ok(/resolved\.apiKey !== ''\) return false/.test(stub), 'strict empty-string key test');
  assert.ok(/url\.protocol === 'https:' && !url\.username && !url\.password/.test(stub), 'the server\'s own base URL test');
  assert.ok(/catch \{\s*return false;/.test(stub), 'a throw runs the real server');
  assert.ok(/args\[0\] === MCP_MODE && keyless\(entry\)\) return serveKeyless\(/.test(launcher), 'only for the mcp argument');
  assert.ok(launcher.indexOf('keyless(entry)') > launcher.indexOf('dataCopy(manifest, install)'), 'after the verified copy is chosen');
  // serveKeyless: no module loading, child process, network, file or timer API.
  const serve = stub.slice(stub.indexOf('function serveKeyless'));
  for (const word of ['require', 'child_process', 'spawn', 'exec', 'fork', 'net', 'http', 'tls', 'dns', 'dgram', 'fetch', 'WebSocket', 'readFile', 'writeFile', 'appendFile', 'mkdir', 'rename', 'unlink', 'rmSync', 'fs.', 'process.env', 'process.argv', 'setTimeout', 'setInterval']) {
    assert.ok(!new RegExp('\\b' + word.replace('.', '\\.') + '\\b').test(serve), 'stub uses ' + word);
  }
  // Nothing selects the stub: the launcher reads no env variable of its own for it.
  assert.ok(!/process\.env\.(?!CLAUDE_PLUGIN_DATA)/.test(launcher.replace(/\.\.\.process\.env/g, '')), 'launcher reads an env variable besides CLAUDE_PLUGIN_DATA');
  assert.ok(!/allow|approv|permit|grant|authori[sz]|proceed|decision|safe to/i.test(stub.slice(stub.indexOf('const STUB_INSTRUCTIONS'), stub.indexOf('function keyless'))), 'instructions carry a decision-like word');
});

check('session check only reads files and prints fixed text', () => {
  for (const call of ['writeFile', 'appendFile', 'writeSync', 'rename', 'unlink', 'rmSync', 'mkdir', 'copyFile', 'chmod', 'spawn', 'exec', 'child_process', 'fetch', 'http']) {
    assert.ok(!sessionCheck.includes(call), `session check uses ${call}`);
  }
});

// The keyless line is shown only while the pinned hook is in its keyless seatbelt mode. The session check asks the verified pinned copy
// (the one the launcher would run) with the hook's own calls, using copies of the launcher's verification functions.
const fnText = (source, name) => {
  const start = source.indexOf('\nfunction ' + name + '(');
  assert.ok(start >= 0, 'function ' + name + ' not found');
  const end = source.indexOf('\n}\n', start);
  assert.ok(end > start, 'function ' + name + ' has no end');
  return source.slice(start, end + 3);
};
const constLine = (source, name) => {
  const match = new RegExp('^const ' + name + ' = .*;$', 'm').exec(source);
  assert.ok(match, 'const ' + name + ' not found');
  return match[0];
};

check('session check: the pinned-copy verification is the launcher\'s own, word for word', () => {
  for (const name of ['loadManifest', 'owned', 'listFiles', 'verifiedEntry', 'privateDir']) {
    assert.strictEqual(fnText(sessionCheck, name), fnText(launcher, name), name + ' differs from the launcher');
  }
  for (const name of ['VERSION_RE', 'POSIX', 'ROOT']) {
    assert.strictEqual(constLine(sessionCheck, name), constLine(launcher, name), name + ' differs from the launcher');
  }
});

check('session check: the keyless line needs the hook\'s mode, the lstat check first, and fails closed', () => {
  const begin = sessionCheck.indexOf("// ---- the hook's mode, asked of the verified pinned copy (begin)");
  const end = sessionCheck.indexOf("// ---- the hook's mode, asked of the verified pinned copy (end)");
  assert.ok(begin > 0 && end > begin, 'markers');
  const block = sessionCheck.slice(begin, end).replace(/^\s*\/\/.*$/gm, '');
  const mode = fnText(block, 'hookModeIsSeatbelt');
  assert.ok(/resolveMarrowEnv\(\{ trustedOnly: true \}\)/.test(mode), 'the key lookup of the hook identity');
  assert.ok(/resolved\.apiKey !== ''\) return false/.test(mode), 'strict empty-string key test');
  assert.ok(/resolveSeatbeltModeOnHost\(\)/.test(mode), 'the mode resolver, with its defaults');
  assert.ok(/resolution\.mode !== 'seatbelt'\) return false/.test(mode), 'only seatbelt');
  assert.ok(/SEATBELT_ROLLOUT\.keyless === 'on'/.test(mode), 'the rollout switch');
  assert.ok(/catch \{\s*return false;\s*\}/.test(mode), 'a throw is false');
  assert.ok(/if \(!entry\) return false;/.test(mode), 'no verified copy is false');
  // Every load of the pinned copy goes through its dist folder; the rest of the script requires only core modules.
  const requires = [...block.matchAll(/\brequire\(([^)]*\)?)\)/g)].map((m) => m[1]);
  assert.strictEqual(requires.length, 4);
  for (const arg of requires) assert.ok(/^path\.join\(dist, '/.test(arg), 'require of ' + arg);
  // The 4th load is the owner's control state, asked of the same verified copy with the hook's own call (no argument: the hook's home).
  assert.ok(requires.includes("path.join(dist, 'control-state.js')"), 'the control-state load');
  assert.ok(/require\(path\.join\(dist, 'control-state\.js'\)\)\.readLocalControlState\(\)/.test(mode), 'the control state is read with no argument');
  assert.ok(!/readLocalControlState\([^)]/.test(block), 'readLocalControlState takes an argument');
  assert.ok(/process\.env\.MARROW_AUTO_HOOK === 'false'\) return false/.test(mode), 'the hook\'s exact off value');
  // Nothing hides a load from the counter above.
  const code = sessionCheck.replace(/^\s*\/\/.*$/gm, '');
  for (const hide of [/\bmodule\.require\b/, /\bcreateRequire\b/, /\bimport\s*\(/, /\b_load\b/, /\beval\s*\(/, /\bnew Function\b/]) assert.ok(!hide.test(code), 'the session check uses ' + hide);
  const outside = [...sessionCheck.replace(/^\s*\/\/.*$/gm, '').replace(block, '').matchAll(/\brequire\(([^)]*)\)/g)].map((m) => m[1]);
  assert.deepStrictEqual(outside.sort(), ["'crypto'", "'fs'", "'os'", "'path'"]);
  // The write is the fixed notice, after both checks, in the keyless branch only.
  assert.ok(/\} else if \(noKeyIsSet\(\) && hookModeIsSeatbelt\(\)\) \{\n  process\.stdout\.write\(JSON\.stringify\(\{ systemMessage: KEYLESS_NOTICE \}\)\);\n\}\n$/.test(sessionCheck), 'tail');
  assert.ok(sessionCheck.indexOf('noKeyIsSet() && hookModeIsSeatbelt()') > sessionCheck.indexOf('function hookModeIsSeatbelt'), 'order');
  assert.ok(sessionCheck.indexOf('lstat only (end)') > 0 && sessionCheck.indexOf('lstat only (end)') < sessionCheck.indexOf('function pinnedEntry'), 'the lstat block comes first');
  // No call that installs, writes, spawns or reaches the network (the pinned-copy code only reads).
  for (const word of ['spawn', 'exec', 'child_process', 'npm', 'fetch', 'http', 'writeFile', 'mkdir', 'rename', 'unlink', 'rmSync', 'chmod', '@latest']) {
    assert.ok(!block.includes(word), 'pinned-copy code uses ' + word);
  }
});

check('launcher: a fleet key without MARROW_API_KEY gets a refusal with no unpinned command, and the other launcher is identical', () => {
  const refusal = /^const FLEET_KEY_REFUSAL = .*$/m.exec(launcher);
  assert.ok(refusal, 'FLEET_KEY_REFUSAL');
  const shared = launcher.slice(launcher.indexOf('const REFUSAL_HEAD'), launcher.indexOf('function noDirectKey')).replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/\bnpx\b|@latest|--package|install@/.test(shared), 'refusal text names an unpinned command');
  assert.ok(/MARROW_KEY_<NAME>/.test(refusal[0]) && !/process\.env/.test(shared), 'the refusal names the variable family, never a value');
  const fleet = fnText(launcher, 'fleetKeySet');
  assert.ok(/startsWith\('MARROW_KEY_'\)/.test(fleet) && /Boolean\(process\.env\[name\]\)/.test(fleet), 'a fleet key is a non-empty MARROW_KEY_ variable');
  assert.ok(/return noDirectKey\(entry\) && !fleetKeySet\(\);/.test(fnText(launcher, 'keyless')), 'the stub is only for no key at all');
  assert.ok(/return noDirectKey\(entry\) && fleetKeySet\(\);/.test(fnText(launcher, 'fleetKeyOnly')), 'fleet only');
  const branch = /if \(args\[0\] === MCP_MODE && fleetKeyOnly\(entry\)\) \{\n\s+process\.stderr\.write\(FLEET_KEY_REFUSAL\);\n\s+process\.exitCode = 1;\n\s+return;\n\s+\}/.exec(launcher);
  assert.ok(branch, 'the fleet branch refuses and exits 1');
  assert.ok(branch.index > launcher.indexOf('dataCopy(manifest, install)'), 'after the verified copy is chosen');
  assert.ok(branch.index < launcher.indexOf('require(entry);', branch.index), 'before the server is started');
  assert.strictEqual(launcher, read('plugins/marrow-cursor/scripts/marrow-launch.cjs'), 'the Claude and Cursor launchers must be identical');
});

check('plugin sets no Claude Code settings and no permission or hook switches', () => {
  assert.strictEqual(manifest.settings, undefined);
  assert.strictEqual(manifest.userConfig, undefined);
  assert.ok(!fs.existsSync(path.join(plugin, 'settings.json')));
  assert.ok(!fs.existsSync(path.join(plugin, 'bin')), 'no executables on the Bash PATH');
  const files = [...listRepo(plugin), ...listRepo(path.join(repo, 'plugins', 'marrow-cursor'))].filter((f) => !f.endsWith('package-lock.json'));
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
  // Built-ins outside the old fixed list, and unknown or future names: all sent to the hook.
  ['Monitor', true], ['PowerShell', true], ['WebFetch', true], ['Agent', true], ['Skill', true], ['SendMessage', true],
  ['EnterWorktree', true], ['ExitWorktree', true], ['KillShell', true], ['SlashCommand', true], ['CronCreate', true],
  ['ScheduleWakeup', true], ['AskUserQuestion', true], ['ExitPlanMode', true], ['FutureTool', true], ['', true],
  ['monitor', true], ['MONITOR', true], ['Monitor\n', true], [' LS', true], ['LS\0', true], ['LS ', true], ['LSX', true],
  ['ListMcpResourcesToolX', true], ['ls', true],
  // The two read-only names no released matcher hooked stay unhooked, by exact name only.
  ['LS', false], ['ListMcpResourcesTool', false],
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
check('matcher collision table: only the 17 exact plugin tool names and the two read-only names are skipped', () => {
  const re = new RegExp(PLUGIN_MATCHER);
  for (const [tool, gated] of TOOLS) assert.strictEqual(re.test(tool), gated, JSON.stringify(tool));
  // A full-match host decides the same way.
  const full = new RegExp(`^(?:${PLUGIN_MATCHER})$`);
  for (const [tool, gated] of TOOLS) assert.strictEqual(full.test(tool), gated, `full match ${JSON.stringify(tool)}`);
});
check('matcher never skips a name the 9b56d909 list matcher gated, and gates every other name', () => {
  const now = new RegExp(PLUGIN_MATCHER);
  const before = new RegExp(PLUGIN_LIST_MATCHER);
  const exempt = new Set([...OWN, ...UNHOOKED_READ_ONLY]);
  const words = ['Bash', 'Monitor', 'PowerShell', 'WebFetch', 'Agent', 'Task', 'LS', 'ListMcpResourcesTool', 'Read', 'mcp__x__y',
    'functions.x', ...OWN, 'mcp__marrow__marrow_think', 'Skill', 'FutureTool', ''];
  const pads = ['', ' ', '\n', '\0', 'X', 'x', ' '];
  let n = 0;
  for (const w of words) for (const a of pads) for (const b of pads) {
    const label = a + w + b;
    n += 1;
    if (before.test(label)) assert.ok(now.test(label), `${JSON.stringify(label)} was gated and is now skipped`);
    assert.strictEqual(now.test(label), !exempt.has(label), JSON.stringify(label));
  }
  process.stdout.write(`  ${n} labels: every gated name stays gated; only the 19 exact exempt names are skipped\n`);
});
// The installer's matcher, plus the matcher of every built marrow-mcp release passed after cli.ts.
const RELEASE_MATCHERS = [['installer 0.1.69 / mcp 3.9.101', MASTER_MATCHER],
  ...process.argv.slice(4).map((file) => {
    const contract = require(path.resolve(file));
    return [`${path.relative(process.cwd(), file)} (reports adapter version ${contract.MCP_ADAPTER_VERSION})`, contract.NATIVE_HOOK_MATCHER];
  })];
for (const [label, matcher] of RELEASE_MATCHERS) check(`matcher is never looser than ${label}, except the 17 exact plugin tool names`, () => {
  const plugin = new RegExp(PLUGIN_MATCHER);
  const master = new RegExp(matcher);
  // Fixed cases plus every combination of prefix, server, tool and suffix fragments.
  const prefixes = ['', 'x', ' ', '\n', '\r', '\0', '\u2028', 'functions.', 'mcp__', 'Bash'];
  const servers = ['mcp__marrow__', 'mcp__plugin_marrow_marrow__', 'mcp__Marrow__', 'mcp__PLUGIN_MARROW_MARROW__', 'mcp__plugin_marrow_marrow2__', 'mcp__evil__', 'MCP:marrow:', 'MCP:', ''];
  const tools = ['marrow_commit', 'marrow_agent_runtime', 'marrow_auto', 'MARROW_COMMIT', 'evil', 'Bash', 'Read', 'marrow_x__mcp__a__b'];
  const suffixes = ['', '\n', '\r', '\0', '\u2028', ' ', 'x', '$', '__mcp__a__b'];
  const corpus = TOOLS.map(([t]) => t);
  for (const a of prefixes) for (const b of servers) for (const c of tools) for (const d of suffixes) corpus.push(a + b + c + d);
  const skipped = new Set();
  for (const tool of corpus) {
    if (master.test(tool) && !plugin.test(tool)) {
      assert.ok(OWN.includes(tool), `${JSON.stringify(tool)} is skipped by the plugin but gated by the installer`);
      skipped.add(tool);
    }
  }
  assert.strictEqual(skipped.size, OWN.length, 'the corpus covers every exempt name, and only those');
  process.stdout.write(`  ${new Set(corpus).size} distinct names, ${skipped.size} distinct names skipped by the plugin and gated by ${label}, all exact plugin tool names\n`);
});
// Cursor names MCP tools `MCP:<tool>` in preToolUse and postToolUse, with no server. The plugin's
// matchers are the installer's bytes, so they gate and skip exactly the same names; the table below
// records which names that is (master behaviour, kept on purpose).
check('Cursor matchers gate exactly the names the installer\'s matchers gate', () => {
  const pairs = [[cursorHooks.hooks.preToolUse[0].matcher, CURSOR_PRE_MATCHER], [cursorHooks.hooks.postToolUse[0].matcher, CURSOR_MATCHER]];
  const tools = ['Shell', 'Write', 'Delete', 'Task', 'Read', 'Glob', 'Grep', 'List', 'WebSearch', 'Edit', 'MCP:marrow_think', 'MCP:marrow_delete_all',
    'MCP:Marrow_think', 'MCP:MARROW_THINK', 'MCP:marrow', 'MCP:marrowx', 'MCP:marrow:marrow_commit', 'MCP:marrow:evil', 'MCP:evil:marrow_commit',
    'MCP:github_push', 'MCP:marrow_think\n', 'MCP:marrow_think\nx', ' MCP:github_push', 'mcp__marrow__marrow_think', 'functions.marrow_think'];
  const parts = ['', 'MCP:', 'marrow', 'marrow_', 'Marrow_', 'marrow:', ':', 'think', '\n', ' ', 'x', 'Shell'];
  for (const a of parts) for (const b of parts) for (const c of parts) tools.push(a + b + c);
  for (const [ours, theirs] of pairs) {
    const mine = new RegExp(ours);
    const master = new RegExp(theirs);
    for (const tool of tools) assert.strictEqual(mine.test(tool), master.test(tool), JSON.stringify(tool));
  }
  process.stdout.write(`  ${tools.length} names, identical decisions on both Cursor matchers\n`);
});
// Exact-name rule (installer 0.1.70, MCP 3.9.102): the matcher skips no MCP label at all. A name
// that holds `MCP:` anywhere (a prefix, a look-alike server, a padded or re-cased name) reaches the
// hook, which tells Marrow's own tools apart by the server and the exact name.
check('Cursor matchers send every MCP label to the hook, look-alikes and padded names included', () => {
  const mcpLabels = ['MCP:marrow_think', 'MCP:marrow', 'MCP:marrow_', 'MCP:marrow_delete_all', 'MCP:marrow:marrow_think', 'MCP:Marrow', 'MCP: marrow_think',
    'MCP:MARROW', 'MCP:MARROW_THINK', 'MCP:Marrow_think', 'MCP:marrow_think ', 'MCP:marrow_think\n', 'MCP:marrow_think\0', ' MCP:marrow_think', 'MCP:marrowx',
    'MCP:github_push', 'MCP:'];
  for (const matcher of [cursorHooks.hooks.preToolUse[0].matcher, cursorHooks.hooks.postToolUse[0].matcher, cursorHooks.hooks.postToolUseFailure[0].matcher]) {
    const re = new RegExp(matcher);
    for (const label of mcpLabels) assert.ok(re.test(label), `${JSON.stringify(label)} must reach the hook`);
    assert.ok(new RegExp(`^(?:${matcher})$`).test('MCP:marrow_think'), 'a full-match host also sends it');
  }
  assert.ok(!new RegExp(CURSOR_PRE_MATCHER).test('Shell'), 'preToolUse leaves Shell to beforeShellExecution');
  assert.ok(new RegExp(CURSOR_MATCHER).test('Shell'));
  assert.ok(!cursorHooks.hooks.preToolUse[0].matcher.includes('(?!'), 'no exemption in the matcher');
});
check('Cursor matchers equal the installer\'s own-tool matchers', () => {
  if (!installerOwnTools) throw new Error('pass --installer-own-tools <marrow-install/src/marrow-own-tools.js>');
  const built = require(path.resolve(installerOwnTools)).buildOwnToolMatchers();
  assert.strictEqual(CURSOR_MATCHER, built.cursor);
  assert.strictEqual(CURSOR_PRE_MATCHER, built.cursorPreToolUseHostApproval);
  assert.strictEqual(cursorHooks.hooks.preToolUse[0].matcher, built.cursorPreToolUseHostApproval);
  assert.strictEqual(cursorHooks.hooks.postToolUse[0].matcher, built.cursor);
  assert.strictEqual(cursorHooks.hooks.postToolUseFailure[0].matcher, built.cursor);
});
check('exempt tool names equal the pinned release\'s default tool set', () => {
  const cli = process.argv[3];
  if (!cli) return;
  const source = fs.readFileSync(cli, 'utf8');
  const start = source.search(/const PRIMARY_TOOL_NAMES(?:: ReadonlySet<string>)? = new Set\(\[/);
  assert.ok(start >= 0, 'PRIMARY_TOOL_NAMES not found');
  const block = source.slice(start);
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

check('every config= deeplink in every markdown file pins the MCP version of package.json', () => {
  const want = pkg.dependencies['@getmarrow/mcp'];
  let seen = 0;
  for (const file of listRepo(repo).filter((f) => /\.(md|markdown)$/i.test(f))) {
    for (const match of fs.readFileSync(file, 'utf8').matchAll(/[?&]config=([A-Za-z0-9+\/_-]+={0,2})/g)) {
      seen += 1;
      const where = path.relative(repo, file);
      const config = JSON.parse(Buffer.from(match[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
      const specs = (config.args || []).filter((arg) => /@getmarrow\/mcp@/.test(arg));
      assert.strictEqual(specs.length, 1, where + ': deeplink must name @getmarrow/mcp exactly once');
      assert.ok(specs[0].endsWith('@getmarrow/mcp@' + want), where + ': deeplink pins ' + specs[0] + ', package.json pins ' + want);
    }
  }
  assert.ok(seen > 0, 'no config= deeplink found to check');
});

process.stdout.write(failures ? `${failures} FAILED\n` : 'ALL PASS\n');
process.exit(failures ? 1 : 0);
