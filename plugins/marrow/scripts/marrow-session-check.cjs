'use strict';
// SessionStart, warn-only: says when Marrow is also configured outside this plugin (hooks that
// `npx @getmarrow/install` or `marrow-mcp setup` wrote into Claude Code settings, or a `marrow` MCP
// server in the project's .mcp.json or Claude Code's user config), or when another plugin named
// marrow is enabled. Both copies would run, doubling Marrow's checks and records.
// It reads those files in-process, prints only fixed labels for which places matched, and never
// changes anything.
// When nothing is duplicated it also says, in one fixed line, that the keyless seatbelt is on, but
// only while no Marrow key can be set (see noKeyIsSet) AND the pinned hook is in its keyless seatbelt
// mode right now (see hookModeIsSeatbelt). In every other state it says nothing: the hook prints its own
// text when it holds something, and this line never claims more protection than the hook gives.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

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

// The one line shown while no key is set. Fixed text: nothing from the environment or the files below
// is ever put in it.
const KEYLESS_NOTICE = 'Marrow seatbelt is on (no key yet): it stops actions like force-push to main, production deploys, package publishes and secret files. For approval prompts instead, add a key: getmarrow.ai/docs#start-here';

// ---- owner files, lstat only (begin) ---------------------------------------------------------------
// True only when the file is certainly not there. Any other answer (permission denied, not a directory,
// I/O error) is doubt, and doubt means a key may be set.
function certainlyAbsent(file) {
  try {
    fs.lstatSync(file);
    return false;
  } catch (error) {
    return Boolean(error) && error.code === 'ENOENT';
  }
}

// True only when neither owner key file can exist under this home. The owner files hold secrets: they are
// checked with lstat alone, never opened, read, hashed or printed, so a FIFO or a mode 000 file cannot
// block or fail this. A folder that is not a plain directory, or any other answer, is doubt.
function ownerFilesAbsent(ownerHome) {
  if (typeof ownerHome !== 'string' || !path.isAbsolute(ownerHome)) return false;
  fs.lstatSync(ownerHome);
  const marrowDir = path.join(ownerHome, '.marrow');
  if (certainlyAbsent(marrowDir)) return true;
  if (!fs.lstatSync(marrowDir).isDirectory()) return false;
  return certainlyAbsent(path.join(marrowDir, 'env.local')) && certainlyAbsent(path.join(marrowDir, 'env'));
}

// True only when no Marrow key can be set. The sources are the ones the key resolver of @getmarrow/mcp
// reads (src/env.ts): MARROW_API_KEY, MARROW_KEY, then ~/.marrow/env.local and ~/.marrow/env, from the
// same home (HOME, then USERPROFILE, then os.homedir()). The hook's mode check also looks for a key in the
// passwd home (os.userInfo), so that home is checked the same way. The plugin declares no options, so any
// CLAUDE_PLUGIN_OPTION_* variable is unexpected and counts as doubt. Because both homes are certainly free of owner key
// files before the pinned resolver runs (hookModeIsSeatbelt), that resolver has no key file to open here.
function noKeyIsSet() {
  try {
    const env = process.env;
    if (env.MARROW_API_KEY || env.MARROW_KEY) return false;
    if (Object.keys(env).some((name) => name.startsWith('CLAUDE_PLUGIN_OPTION_'))) return false;
    return ownerFilesAbsent(env.HOME || env.USERPROFILE || os.homedir()) && ownerFilesAbsent(os.userInfo().homedir);
  } catch {
    return false;
  }
}
// ---- owner files, lstat only (end) -----------------------------------------------------------------

// ---- the hook's mode, asked of the verified pinned copy (begin) ------------------------------------
// Only a copy of @getmarrow/mcp whose files match mcp-manifest.json byte for byte is ever loaded here, found the
// way the launcher finds it and never installed (no copy yet means no answer). The functions up to hookModeIsSeatbelt are
// the launcher's own (scripts/marrow-launch.cjs), repeated word for word; tools/check.cjs fails when they differ.
const VERSION_RE = /^\d+\.\d+\.\d+$/;
const POSIX = process.platform !== 'win32';
const ROOT = path.resolve(__dirname, '..');

function loadManifest() {
  try {
    const pin = readJson(path.join(ROOT, 'package.json')).dependencies['@getmarrow/mcp'];
    const manifest = readJson(path.join(__dirname, 'mcp-manifest.json'));
    const ok = VERSION_RE.test(String(pin))
      && manifest.schema === 'marrow-plugin-mcp-manifest.v1'
      && manifest.mcp && manifest.mcp.version === pin
      && /^[0-9a-f]{64}$/.test(String(manifest.sha256))
      && Array.isArray(manifest.files)
      && typeof manifest.bin === 'string'
      && manifest.files.includes(manifest.bin);
    return ok ? manifest : null;
  } catch {
    return null;
  }
}

function owned(stat) {
  return !POSIX || typeof process.getuid !== 'function' || stat.uid === process.getuid();
}

// Package files as sorted relative paths. npm's own lock copy and .bin links are not package files.
// Anything that is not a plain file or directory (links, FIFOs, sockets, devices) and anything
// writable by every user rejects the whole copy.
function listFiles(base, relative) {
  const out = [];
  const entries = fs.readdirSync(path.join(base, relative))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const name of entries) {
    const rel = relative ? `${relative}/${name}` : name;
    if (rel === '.bin' || rel === '.package-lock.json') continue;
    const stat = fs.lstatSync(path.join(base, rel));
    if (POSIX && (stat.mode & 0o002) !== 0) throw new Error('writable');
    if (stat.isDirectory()) out.push(...listFiles(base, rel));
    else if (stat.isFile()) out.push(rel);
    else throw new Error('type');
  }
  return out;
}

// Returns the entry file when `base` (a node_modules directory) matches the manifest exactly.
function verifiedEntry(manifest, base) {
  try {
    const stat = fs.lstatSync(base);
    if (!stat.isDirectory() || !owned(stat) || (POSIX && (stat.mode & 0o002) !== 0)) return null;
    const files = listFiles(base, '');
    if (JSON.stringify(files) !== JSON.stringify(manifest.files)) return null;
    const hash = crypto.createHash('sha256');
    for (const file of files) {
      hash.update(file);
      hash.update('\0');
      hash.update(fs.readFileSync(path.join(base, file)));
      hash.update('\0');
    }
    return hash.digest('hex') === manifest.sha256 ? path.join(base, manifest.bin) : null;
  } catch {
    return null;
  }
}

// A directory this plugin owns: real directory, this user's, closed to group and others.
function privateDir(dir) {
  try {
    const stat = fs.lstatSync(dir);
    return stat.isDirectory() && owned(stat) && (!POSIX || (stat.mode & 0o077) === 0);
  } catch {
    return false;
  }
}

// The verified copy's entry file, or null: the plugin's own node_modules, else the private copy in ${CLAUDE_PLUGIN_DATA}
// that the launcher installs (the launcher's dataCopy, without its install step).
function pinnedEntry() {
  const manifest = loadManifest();
  if (!manifest) return null;
  const here = verifiedEntry(manifest, path.join(ROOT, 'node_modules'));
  if (here) return here;
  const data = process.env.CLAUDE_PLUGIN_DATA;
  if (!data || !path.isAbsolute(data)) return null;
  const dir = path.join(data, `mcp-${manifest.mcp.version}-${manifest.sha256.slice(0, 16)}`);
  return privateDir(dir) ? verifiedEntry(manifest, path.join(dir, 'node_modules')) : null;
}

// True only when the hook would answer in its keyless `seatbelt` mode right now. Same calls as the hook, from the same
// verified copy: the key lookup of the hook identity (dist/hook-contract.js resolveNativeHookIdentity: resolveMarrowEnv with
// trustedOnly) must find no key, then resolveSeatbeltModeOnHost() with its own defaults (this process's env and passwd home, as
// dist/seatbelt/hook.js keylessSeatbelt calls it) must say `seatbelt`, and the compiled-in rollout switch must be on. Every other
// answer, a throw, or no verified copy is false, and false means no keyless line: the hook's own text speaks for itself.
function hookModeIsSeatbelt() {
  try {
    const entry = pinnedEntry();
    if (!entry) return false;
    const dist = path.dirname(entry);
    const resolved = require(path.join(dist, 'env.js')).resolveMarrowEnv({ trustedOnly: true });
    if (resolved === null || typeof resolved !== 'object' || resolved.apiKey !== '') return false;
    const resolution = require(path.join(dist, 'seatbelt-mode.js')).resolveSeatbeltModeOnHost();
    if (resolution === null || typeof resolution !== 'object' || resolution.mode !== 'seatbelt') return false;
    return require(path.join(dist, 'seatbelt', 'hook.js')).SEATBELT_ROLLOUT.keyless === 'on';
  } catch {
    return false;
  }
}
// ---- the hook's mode, asked of the verified pinned copy (end) --------------------------------------

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
    systemMessage: `Marrow is also set up outside the marrow plugin (${where}). Both copies run, so Marrow checks and records each action twice. Keep one. To keep this plugin: remove installer hooks or servers by previewing \`npx -y @getmarrow/install@0.1.70 uninstall\` in this project's terminal (it lists Marrow entries for every host here; add --yes to apply), disable any other plugin named marrow in /plugin, then restart Claude Code. To keep the other copy instead, run \`claude plugin uninstall marrow@getmarrow\`.`,
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: `Marrow is configured twice in this session (the marrow plugin and ${where}). Tell the user once. Do not edit settings, hooks or plugin files yourself; the user chooses which copy to keep.`,
    },
  }));
} else if (noKeyIsSet() && hookModeIsSeatbelt()) {
  process.stdout.write(JSON.stringify({ systemMessage: KEYLESS_NOTICE }));
}
