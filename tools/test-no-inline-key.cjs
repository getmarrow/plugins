#!/usr/bin/env node
'use strict';
// Fails when a Markdown file shows or tells the owner to type a Marrow key into a command:
// a MARROW_API_KEY=<value> or MARROW_KEY=<value> prefix before a command (any quoting, HTML escapes,
// other variables first, a backslash continuation, chained with ; && || |), export, setenv,
// echo/printf/tee or a heredoc that writes the key line, or --key <value>. The key belongs in the
// owner-only ~/.marrow/env, written with an editor. A key-file comment, the bare variable name and
// prose pass. Before scanning, a built-in corpus is written to a private temporary folder and scanned
// the same way, so the check cannot pass without looking. Hits print as file:line only, never the text.
//   node tools/test-no-inline-key.cjs [checkout]   (default: this repository; node_modules and .git skipped)
// Exit 0 = no hit, 1 = hits, 2 = the corpus self-test failed.
const fs = require('fs');
const os = require('os');
const path = require('path');

const NAME = String.raw`(?<![A-Za-z0-9_])MARROW_(?:API_)?KEY`;
// One value: a quoted string, a <placeholder> or plain characters. The alternatives start with
// different characters, so matching stays linear.
const VALUE = String.raw`(?:"[^"\n]*"|'[^'\n]*'|<[^<>\n]*>|[^\s\x60'"<>;|&])+`;
// A command follows the assignment: another word or assignment, a line continuation or a chain.
// "in"/"into" after the value is prose ("put MARROW_API_KEY=<your_key> in ~/.marrow/env").
const PREFIX = new RegExp(NAME + '=' + VALUE + String.raw`(?:[ \t]*(?:\\[ \t]*$|;|&&|\|)|[ \t]+(?!(?:in|into)(?![\w./~-]))[A-Za-z0-9_.\/~$-])`);
const EXPORT = new RegExp(String.raw`(?:^|[\s\x60;&|(])(?:(?:export|declare[ \t]+-x|typeset[ \t]+-x)[ \t]+(?:[A-Za-z_][A-Za-z0-9_]*=\S*[ \t]+)*MARROW_(?:API_)?KEY=|setenv[ \t]+MARROW_(?:API_)?KEY[ \t]+)\S`);
const WRITER = /(?<![\w-])(?:echo|printf|tee)(?![\w-])/;
const ASSIGN = new RegExp(NAME + String.raw`[ \t]*=`);
const HERESTRING = /<<</;
const HEREDOC = /<<-?[ \t]*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/;
const KEYFLAG = /(?:npx|marrow-install|marrow-mcp|@getmarrow\/install\S*|node)\b[^\n]*?--key(?![\w-])(?:=|[ \t]+)(?![-\x60,.;)])\S/;

function decode(line) {
  return line.replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&#x0*27;|&apos;/gi, "'").replace(/&amp;/gi, '&');
}

// Returns [{line, rule}] for one file's text.
function scanText(text) {
  const hits = [];
  let heredocEnd = null;
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = decode(raw);
    const n = i + 1;
    if (heredocEnd !== null) {
      if (line.trim() === heredocEnd) heredocEnd = null;
      else if (ASSIGN.test(line)) hits.push({ line: n, rule: 'heredoc writes the key line' });
      return;
    }
    if (PREFIX.test(line)) hits.push({ line: n, rule: 'key assigned before a command' });
    else if (EXPORT.test(line)) hits.push({ line: n, rule: 'key exported in the shell' });
    else if (ASSIGN.test(line) && (WRITER.test(line) || HERESTRING.test(line))) hits.push({ line: n, rule: 'command writes the key line' });
    else if (KEYFLAG.test(line)) hits.push({ line: n, rule: '--key with a value' });
    const hd = HEREDOC.exec(line);
    if (hd && !HERESTRING.test(line)) heredocEnd = hd[1];
  });
  return hits;
}

// Every *.md file under root; node_modules, .git and symbolic links are skipped.
function scanTree(root) {
  const out = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (ent.isSymbolicLink()) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name !== 'node_modules' && ent.name !== '.git') walk(full);
      } else if (ent.isFile() && /\.md$/i.test(ent.name)) {
        for (const h of scanText(fs.readFileSync(full, 'utf8'))) out.push({ file: path.relative(root, full).split(path.sep).join('/'), ...h });
      }
    }
  };
  walk(root);
  return out;
}

// Corpus: must flag (the published inline-key spellings) and must pass (the key-file forms and prose).
const MUST_FLAG = [
  'MARROW_API_KEY=<your_key> npx -y @getmarrow/install@latest activate',
  'In the terminal: `MARROW_API_KEY=&lt;your_key&gt; npx -y @getmarrow/install@latest activate`.',
  '<code>MARROW_API_KEY=&lt;your_key&gt; npx @getmarrow/install run -- codex</code>',
  'MARROW_FLEET_AGENT_ID=ci-release MARROW_API_KEY=<your_key> npx -y @getmarrow/install@latest run -- make release',
  'CI=1 MARROW_API_KEY=<your_key> npx @getmarrow/install run -- codex',
  'MARROW_API_KEY=<your_key> \\\n  npx -y @getmarrow/install@latest activate',
  'MARROW_API_KEY="<your_key>" npx -y --package=@getmarrow/mcp@latest marrow-mcp setup',
  "MARROW_API_KEY='<your_key>' marrow-install activate",
  'MARROW_KEY=<your_key> npx -y @getmarrow/install@latest activate',
  'export MARROW_API_KEY=<your_key>',
  'env MARROW_API_KEY=<your_key> codex',
  'echo MARROW_API_KEY=<your_key> >> ~/.marrow/env',
  "printf 'MARROW_API_KEY=%s' <your_key> > ~/.marrow/env",
  'npx @getmarrow/install run --key <your_key> -- make',
  'MARROW_API_KEY=<your key> npx -y @getmarrow/install@latest activate',
  'MARROW_API_KEY=<your_key>; npx -y @getmarrow/install@latest activate',
  'MARROW_API_KEY=<your_key> && npx -y @getmarrow/install@latest activate',
  "cat > ~/.marrow/env <<'EOF'\nMARROW_API_KEY=<your_key>\nEOF",
  'npx -y @getmarrow/install@latest activate --key=<your_key>',
];
const MUST_PASS = [
  '# put MARROW_API_KEY=<your_key> in ~/.marrow/env',
  '${EDITOR:-nano} ~/.marrow/env          # one line: MARROW_API_KEY=<your_key>',
  'MARROW_API_KEY',
  'Or set `MARROW_API_KEY` in the environment that starts the host.',
  '"env_vars": ["MARROW_API_KEY"]',
  'put `MARROW_API_KEY=<your key>` in `~/.marrow/env`',
  'The installer also accepts `--key`, which is visible in process listings; do not use it.',
  'npx -y @getmarrow/install@latest activate',
];

function selfTest() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'no-inline-key-'));
  const bad = [];
  try {
    MUST_FLAG.forEach((t, i) => fs.writeFileSync(path.join(dir, `flag-${String(i).padStart(2, '0')}.md`), t + '\n'));
    MUST_PASS.forEach((t, i) => fs.writeFileSync(path.join(dir, `pass-${String(i).padStart(2, '0')}.md`), t + '\n'));
    fs.mkdirSync(path.join(dir, 'node_modules'));
    fs.writeFileSync(path.join(dir, 'node_modules', 'skip.md'), MUST_FLAG[0] + '\n');
    const files = new Set(scanTree(dir).map((h) => h.file));
    MUST_FLAG.forEach((_, i) => { const f = `flag-${String(i).padStart(2, '0')}.md`; if (!files.has(f)) bad.push(`not flagged: must-flag line ${i}`); });
    MUST_PASS.forEach((_, i) => { const f = `pass-${String(i).padStart(2, '0')}.md`; if (files.has(f)) bad.push(`flagged: must-pass line ${i}`); });
    if (files.has('node_modules/skip.md')) bad.push('node_modules was scanned');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return bad;
}

if (require.main === module) {
  const bad = selfTest();
  if (bad.length) {
    for (const b of bad) console.log(`FAIL corpus self-test: ${b}`);
    console.log('FAIL corpus self-test');
    process.exit(2);
  }
  console.log(`PASS corpus self-test (${MUST_FLAG.length} must flag, ${MUST_PASS.length} must pass)`);
  const root = path.resolve(process.argv[2] || path.join(__dirname, '..'));
  const hits = scanTree(root);
  for (const h of hits) console.log(`FAIL ${h.file}:${h.line}: ${h.rule}; keep the key in ~/.marrow/env instead`);
  console.log(hits.length ? `${hits.length} FAILED` : 'PASS no key on a command line in any Markdown file');
  process.exit(hits.length ? 1 : 0);
}

module.exports = { scanText, scanTree, selfTest };
