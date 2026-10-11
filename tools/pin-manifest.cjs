'use strict';
// Maintainer tool: writes plugins/marrow/scripts/mcp-manifest.json from a clean `npm ci --ignore-scripts`
// of plugins/marrow/package-lock.json. Run it after changing the pinned versions:
//   node tools/pin-manifest.cjs <dir-with-npm-ci-node_modules>
// The launcher hashes the same file list the same way on every start.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const repo = path.resolve(__dirname, '..');
const plugin = path.join(repo, 'plugins', 'marrow');
const stage = path.resolve(process.argv[2] || '');
const base = path.join(stage, 'node_modules');

function listFiles(dir, relative) {
  const out = [];
  const entries = fs.readdirSync(path.join(dir, relative), { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const rel = relative ? `${relative}/${entry.name}` : entry.name;
    if (rel === '.bin' || rel === '.package-lock.json') continue;
    if (entry.isSymbolicLink()) throw new Error(`unexpected link: ${rel}`);
    if (entry.isDirectory()) out.push(...listFiles(dir, rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

const lock = JSON.parse(fs.readFileSync(path.join(plugin, 'package-lock.json'), 'utf8'));
const stagedLock = JSON.parse(fs.readFileSync(path.join(stage, 'package-lock.json'), 'utf8'));
if (JSON.stringify(lock.packages) !== JSON.stringify(stagedLock.packages)) {
  throw new Error('the staged package-lock.json differs from plugins/marrow/package-lock.json');
}
const pkg = (name) => {
  const entry = lock.packages[`node_modules/${name}`];
  if (!entry || !/^sha512-/.test(entry.integrity || '')) throw new Error(`${name} has no sha512 integrity in the lockfile`);
  return { version: entry.version, integrity: entry.integrity };
};
const installed = JSON.parse(fs.readFileSync(path.join(base, '@getmarrow', 'mcp', 'package.json'), 'utf8'));
const files = listFiles(base, '');
const hash = crypto.createHash('sha256');
for (const file of files) {
  hash.update(file);
  hash.update('\0');
  hash.update(fs.readFileSync(path.join(base, file)));
  hash.update('\0');
}
const manifest = {
  schema: 'marrow-plugin-mcp-manifest.v1',
  mcp: pkg('@getmarrow/mcp'),
  sdk: pkg('@getmarrow/sdk'),
  bin: `@getmarrow/mcp/${String(installed.bin['marrow-mcp']).replace(/^\.\//, '')}`,
  files,
  sha256: hash.digest('hex'),
};
if (installed.version !== manifest.mcp.version) throw new Error('installed @getmarrow/mcp does not match the lockfile');
fs.writeFileSync(path.join(plugin, 'scripts', 'mcp-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write(`mcp-manifest.json: @getmarrow/mcp ${manifest.mcp.version}, ${files.length} files\n`);
