'use strict';
// Maintainer tool: hook latency of the marrow plugin, without a key and without network.
//   node tools/bench-hooks.cjs [runs]
// Installs the pinned packages into a temporary copy of the plugin the way Claude Code does
// (npm ci --ignore-scripts from package-lock.json), checks that hooks start without npx, then
// measures wall time per hook call: the plugin launcher, the entrypoint started directly, and the
// npx command that `npx @getmarrow/install` writes. Uses a temporary HOME; nothing else is written.
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const runs = Number(process.argv[2] || 40);
const repo = path.resolve(__dirname, '..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-plugin-bench-'));
const plugin = path.join(work, 'marrow');
const home = path.join(work, 'home');
fs.cpSync(path.join(repo, 'plugins', 'marrow'), plugin, { recursive: true });
fs.mkdirSync(path.join(home, 'project'), { recursive: true });
const ci = spawnSync('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: plugin, stdio: 'inherit' });
if (ci.status !== 0) throw new Error('npm ci failed');

const env = { ...process.env, HOME: home, CLAUDE_PLUGIN_ROOT: plugin, CLAUDE_PROJECT_DIR: path.join(home, 'project') };
delete env.MARROW_API_KEY;
delete env.MARROW_KEY;
const cwd = path.join(home, 'project');
const event = (name, tool, input, extra = {}) => JSON.stringify({ session_id: 'bench', cwd, hook_event_name: name, tool_name: tool, tool_input: input, tool_use_id: `b-${tool}`, ...extra });
const events = {
  read: ['claude-pre-action-hook', event('PreToolUse', 'Read', { file_path: '/etc/hostname' })],
  push: ['claude-pre-action-hook', event('PreToolUse', 'Bash', { command: 'git push --force origin main' })], // answered with a deny on 3.9.102 (no key) and 3.9.103 (seatbelt)
  post: ['claude-hook', event('PostToolUse', 'Read', { file_path: '/etc/hostname' }, { tool_response: { ok: true } })],
};
const launcher = path.join(plugin, 'scripts', 'marrow-launch.cjs');
const direct = path.join(plugin, 'node_modules', '@getmarrow', 'mcp', 'dist', 'cli.js');
const version = JSON.parse(fs.readFileSync(path.join(plugin, 'package.json'), 'utf8')).dependencies['@getmarrow/mcp'];

// Fast path check: with only node on PATH, a hook that needed npx could not start.
const nodeOnly = path.join(work, 'node-only');
fs.mkdirSync(nodeOnly);
fs.symlinkSync(process.execPath, path.join(nodeOnly, 'node'));
const probe = spawnSync('node', [launcher, 'claude-pre-action-hook'], { input: events.push[1], env: { ...env, PATH: nodeOnly }, cwd, encoding: 'utf8' });
const fast = probe.status === 0 && /permissionDecision/.test(probe.stdout);
process.stdout.write(`fast path without npx on PATH: ${fast ? 'yes' : 'NO'}\n`);

function bench(label, n, cmd, args, input) {
  const times = [];
  for (let i = 0; i < n; i += 1) {
    const start = process.hrtime.bigint();
    spawnSync(cmd, args, { input, env, cwd });
    times.push(Number(process.hrtime.bigint() - start) / 1e6);
  }
  times.sort((a, b) => a - b);
  const q = (p) => times[Math.min(times.length - 1, Math.ceil(p * times.length) - 1)].toFixed(0);
  process.stdout.write(`${label.padEnd(44)} n=${n} p50=${q(0.5)}ms p95=${q(0.95)}ms max=${times[times.length - 1].toFixed(0)}ms\n`);
}

process.stdout.write(`node ${process.version}, ${os.cpus().length} CPUs, load ${os.loadavg().map((l) => l.toFixed(2)).join(' ')}\n`);
bench('node -e 0 (process start floor)', runs, 'node', ['-e', '0'], '');
for (const [name, [entry, input]] of Object.entries(events)) {
  bench(`${name}: plugin launcher`, runs, 'node', [launcher, entry], input);
  bench(`${name}: entrypoint started directly`, runs, 'node', [direct, entry], input);
  bench(`${name}: npx (as installed today)`, Math.max(5, Math.floor(runs / 3)), 'npx', ['-y', `--package=@getmarrow/mcp@${version}`, 'marrow-mcp', entry], input);
}
fs.rmSync(work, { recursive: true, force: true });
process.exit(fast ? 0 : 1);
