#!/usr/bin/env node
'use strict';
// CI gate: the official Codex plugins in this checkout must match the pins the deciding @getmarrow/mcp
// carries. No network, no secrets, no install.
//   node tools/pins-check-ci.cjs
// 1. The vendored MCP check and pins module equal tools/mcp-pins/SHA256SUMS.
// 2. The vendored check, run on this checkout, exits 0 and reports every pinned file of every
//    official plugin as ok (a check that verified nothing is a failure).
// 3. Self-test: a one-byte change to each pinned file, one file at a time, makes the same check exit 1
//    and report that file as FAIL. This proves on every run that the gate can fail.
require('../test/isolate.cjs'); // private HOME and spawn guard for every child this tool starts (test/child-isolation.cjs)
const { createHash } = require('node:crypto');
const { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { spawnSync } = require('node:child_process');

const repo = resolve(__dirname, '..');
const vendor = join(__dirname, 'mcp-pins');
const check = join(vendor, 'scripts', 'codex-plugin-pins-check.cjs');
let failed = 0;
const say = (ok, text) => { if (!ok) failed += 1; process.stdout.write(`${ok ? 'PASS' : 'FAIL'} ${text}\n`); };

// 1. vendored files: both must be listed, and both must match, before any vendored code is loaded or run
const VENDORED = ['scripts/codex-plugin-pins-check.cjs', 'dist/codex-plugin-pins.js'];
const sums = new Map(readFileSync(join(vendor, 'SHA256SUMS'), 'utf8').split('\n').filter(Boolean).map((line) => { const [digest, file] = line.split(/\s+/); return [file, digest]; }));
say(sums.size === VENDORED.length && VENDORED.every((file) => sums.has(file)), `SHA256SUMS lists exactly ${VENDORED.join(' and ')}`);
for (const file of VENDORED) {
  let actual = 'missing';
  try { actual = createHash('sha256').update(readFileSync(join(vendor, file))).digest('hex'); } catch { /* missing */ }
  say(actual === sums.get(file), `vendored ${file} equals SHA256SUMS`);
}
if (failed) {
  process.stdout.write(`${failed} FAILED (the vendored MCP files are not the recorded ones; nothing was run)\n`);
  process.exit(1);
}

const { OFFICIAL_CODEX_PLUGIN_PINS, OFFICIAL_CODEX_PLUGIN_DIRS } = require(join(vendor, 'dist', 'codex-plugin-pins.js'));
const run = (root) => {
  const r = spawnSync(process.execPath, [check, root], { encoding: 'utf8' });
  return { status: r.status, lines: (r.stdout || '').split('\n').filter(Boolean) };
};

// 2. this checkout
const expected = [];
for (const [name, rel] of Object.entries(OFFICIAL_CODEX_PLUGIN_DIRS)) {
  const manifest = JSON.parse(readFileSync(join(repo, rel, '.codex-plugin', 'plugin.json'), 'utf8'));
  for (const file of Object.keys(OFFICIAL_CODEX_PLUGIN_PINS[`${name}@${manifest.version}`] || {})) expected.push({ dir: rel, key: `${name}@${manifest.version}`, file });
}
const head = run(repo);
process.stdout.write(`${head.lines.join('\n')}\n`);
say(head.status === 0, `pins check on this checkout exits 0 (got ${head.status})`);
say(expected.length >= 12 && expected.every((e) => head.lines.includes(`ok   ${e.key} ${e.file}`)), `all ${expected.length} pinned files reported ok`);

// 3. one byte at a time: the first byte flipped (a manifest may then stop being JSON, which fails
// closed too), and one byte appended (still valid JSON, so the digest line names the file).
const scratch = mkdtempSync(join(tmpdir(), 'plugin-pins-'));
try {
  for (const e of expected) {
    for (const mode of ['flipped', 'appended']) {
      const copy = join(scratch, 'checkout');
      rmSync(copy, { recursive: true, force: true });
      cpSync(join(repo, e.dir), join(copy, e.dir), { recursive: true });
      const target = join(copy, e.dir, e.file);
      const bytes = readFileSync(target);
      if (mode === 'flipped') bytes[0] ^= 0x01;
      writeFileSync(target, mode === 'flipped' ? bytes : Buffer.concat([bytes, Buffer.from('\n')]));
      const r = run(copy);
      // The other plugin directory is absent from the copy, so only this plugin's lines are meaningful.
      const named = r.lines.some((l) => l.startsWith('FAIL') && (l.includes(`${e.key} ${e.file} `) || l.includes(`FAIL ${e.key.split('@')[0]}: no readable`)));
      say(r.status === 1 && named, `one byte ${mode} in ${e.dir}/${e.file}: check exits 1 and reports it (got ${r.status})`);
    }
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
process.stdout.write(failed ? `${failed} FAILED\n` : 'ALL PASS\n');
process.exit(failed ? 1 : 0);
