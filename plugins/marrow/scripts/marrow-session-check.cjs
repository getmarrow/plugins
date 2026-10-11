'use strict';
// SessionStart, warn-only: says when Marrow is also configured outside this plugin (hooks that
// `npx @getmarrow/install` or `marrow-mcp setup` wrote into Claude Code settings, or a `marrow` MCP
// server in the project's .mcp.json or Claude Code's user config), or when another plugin named
// marrow is enabled. Both copies would run, doubling Marrow's checks and records.
// It reads those files in-process, prints only fixed labels for which places matched, and never
// changes anything.
const fs = require('fs');
const os = require('os');
const path = require('path');

function readJson(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function hasMarrowHook(settings) {
  const hooks = settings && settings.hooks;
  if (!hooks || typeof hooks !== 'object') return false;
  return Object.values(hooks).some((entries) => Array.isArray(entries) && entries.some((entry) => (
    entry && Array.isArray(entry.hooks) && entry.hooks.some((hook) => hook && [hook.command]
      .concat(Array.isArray(hook.args) ? hook.args : [])
      .some((part) => typeof part === 'string' && /\bmarrow-mcp\b|@getmarrow\/mcp\b/.test(part)))
  )));
}

const home = os.homedir();
const userDir = process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
const project = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const found = [];
const seen = new Set();
for (const [label, file] of [
  ['user settings', path.join(userDir, 'settings.json')],
  ['project settings', path.join(project, '.claude', 'settings.json')],
  ['project local settings', path.join(project, '.claude', 'settings.local.json')],
]) {
  const resolved = path.resolve(file);
  if (seen.has(resolved)) continue;
  seen.add(resolved);
  const settings = readJson(resolved);
  if (hasMarrowHook(settings)) found.push(`hooks in ${label}`);
  const plugins = settings && settings.enabledPlugins;
  if (plugins && typeof plugins === 'object'
    && Object.keys(plugins).some((key) => key.startsWith('marrow@') && key !== 'marrow@getmarrow' && plugins[key] === true)) {
    found.push(`another plugin named marrow enabled in ${label}`);
  }
}
const mcp = readJson(path.join(project, '.mcp.json'));
if (mcp && mcp.mcpServers && typeof mcp.mcpServers === 'object' && mcp.mcpServers.marrow) {
  found.push('a marrow MCP server in the project .mcp.json');
}
// User- and local-scope MCP servers live in Claude Code's user config. Only the presence of a
// `marrow` server name is checked; nothing from the file is printed.
const userConfig = process.env.CLAUDE_CONFIG_DIR
  ? path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json')
  : path.join(home, '.claude.json');
let config = null;
try {
  if (fs.statSync(userConfig).size <= 20 * 1024 * 1024) config = readJson(userConfig);
} catch {
  config = null;
}
const serverIn = (scope) => Boolean(scope && typeof scope === 'object' && scope.mcpServers
  && typeof scope.mcpServers === 'object' && Object.prototype.hasOwnProperty.call(scope.mcpServers, 'marrow'));
if (config && (serverIn(config)
  || (config.projects && typeof config.projects === 'object'
    && Object.prototype.hasOwnProperty.call(config.projects, project) && serverIn(config.projects[project])))) {
  found.push('a marrow MCP server in the Claude Code user config');
}

if (found.length > 0) {
  const where = found.join(', ');
  process.stdout.write(JSON.stringify({
    systemMessage: `Marrow is also set up outside the marrow plugin (${where}). Both copies run, so Marrow checks and records each action twice. Keep one. To keep this plugin: remove installer hooks or servers by previewing \`npx -y @getmarrow/install@0.1.68 uninstall\` in this project's terminal (it lists Marrow entries for every host here; add --yes to apply), disable any other plugin named marrow in /plugin, then restart Claude Code. To keep the other copy instead, run \`claude plugin uninstall marrow@getmarrow\`.`,
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: `Marrow is configured twice in this session (the marrow plugin and ${where}). Tell the user once. Do not edit settings, hooks or plugin files yourself; the user chooses which copy to keep.`,
    },
  }));
}
