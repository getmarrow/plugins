'use strict';
// Starts one pinned @getmarrow/mcp entrypoint for this plugin's hooks, or the MCP server when no
// entrypoint is given. It adds no policy: every decision comes from the same entrypoints that
// `npx @getmarrow/install` and `marrow-mcp setup` write into .claude/settings.json.
//
// Fast path: the copy Claude Code installed into this plugin's node_modules from package-lock.json
// (exact versions, sha512 integrity, install scripts disabled). Every start checks those files
// against mcp-manifest.json, as the installer's local runtime (launch.cjs) does. When the copy is
// missing or any file differs, the same entrypoint runs through npx at the same pinned version.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const VERSION_RE = /^\d+\.\d+\.\d+$/;
const ENTRYPOINTS = new Set([
  'claude-context-hook',
  'claude-pre-action-hook',
  'claude-hook',
  'claude-session-hook',
  'claude-permission-request-hook',
]);

const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && !ENTRYPOINTS.has(args[0]))) {
  process.stderr.write('Marrow plugin: unknown entrypoint.\n');
  process.exit(1);
}

function pinnedVersion() {
  try {
    const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).dependencies['@getmarrow/mcp'];
    return VERSION_RE.test(String(version)) ? version : null;
  } catch {
    return null;
  }
}

// Package files as relative paths, sorted; npm's own lock copy and .bin links are not package files.
function listFiles(base, relative) {
  const out = [];
  const entries = fs.readdirSync(path.join(base, relative), { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const rel = relative ? `${relative}/${entry.name}` : entry.name;
    if (rel === '.bin' || rel === '.package-lock.json') continue;
    if (entry.isSymbolicLink()) throw new Error('link');
    if (entry.isDirectory()) out.push(...listFiles(base, rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

function verifiedEntry(version) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'mcp-manifest.json'), 'utf8'));
    if (manifest.schema !== 'marrow-plugin-mcp-manifest.v1' || manifest.mcp.version !== version) return null;
    const base = path.join(ROOT, 'node_modules');
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

const version = pinnedVersion();
if (!version) {
  process.stderr.write('Marrow plugin: package.json does not pin @getmarrow/mcp to an exact version.\n');
  process.exit(1);
}

const entry = verifiedEntry(version);
if (entry) {
  process.argv = [process.argv[0], entry, ...args];
  require(entry);
} else {
  const { spawn } = require('child_process');
  const windows = process.platform === 'win32';
  // Fixed arguments only: an exact version and an allowlisted entrypoint, so the Windows shell sees no user input.
  const child = spawn(windows ? 'npx.cmd' : 'npx', ['-y', `--package=@getmarrow/mcp@${version}`, 'marrow-mcp', ...args], {
    stdio: 'inherit',
    shell: windows,
  });
  child.on('error', () => {
    process.stderr.write('Marrow plugin: could not start npx for the pinned @getmarrow/mcp.\n');
    process.exit(1);
  });
  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code === null ? 1 : code);
  });
}
