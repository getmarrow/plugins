'use strict';
// Checks the /marrow:update skill, the plugin versions and the files shared by the Claude Code and Cursor plugins.
//   node tools/test-update-path.cjs [<repo root>]
// No dependencies, no network. Every code span and fenced block of the update skill must be the one installer
// update command or a plain slash word; anything else (another command, a flag, a key file, a hidden character) fails.
const fs = require('fs');
const path = require('path');

const repo = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const UPDATE_COMMAND = 'npx @getmarrow/install@latest update';
const SLASH_WORDS = ['/reload-plugins', '/marrow:update'];
const PLUGIN_VERSION = '0.2.8';
const CURSOR_VERSION = '0.1.8';
const MCP_VERSION = '3.9.113';
const SDK_VERSION = '3.7.67';
const SHARED_FILES = ['package.json', 'package-lock.json', 'scripts/marrow-launch.cjs', 'scripts/mcp-manifest.json'];

let pass = 0;
let fail = 0;
function check(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    fail += 1;
    console.log(`FAIL ${name}: ${error.message}`);
  }
}
function assert(ok, message) {
  if (!ok) throw new Error(message);
}
const read = (rel) => fs.readFileSync(path.join(repo, rel));
const json = (rel) => JSON.parse(read(rel).toString('utf8'));

const skillDir = 'plugins/marrow/skills/update';
const skillRel = `${skillDir}/SKILL.md`;
let skill = null;

check('UP-14 the update skill exists at plugins/marrow/skills/update/SKILL.md (slash name /marrow:update) and is the only file there', () => {
  assert(fs.existsSync(path.join(repo, skillRel)), 'missing');
  const entries = fs.readdirSync(path.join(repo, skillDir));
  assert(entries.length === 1 && entries[0] === 'SKILL.md', `folder holds ${entries.join(', ')}`);
  assert(fs.lstatSync(path.join(repo, skillRel)).isFile(), 'not a regular file');
  skill = read(skillRel).toString('utf8');
});

check('UP-14 the skill is printable ASCII only (no zero-width, fullwidth, look-alike or control character)', () => {
  assert(skill !== null, 'no skill');
  const bad = [...skill].filter((c) => c !== '\n' && (c < ' ' || c > '~'));
  assert(bad.length === 0, `${bad.length} character(s) outside printable ASCII`);
});

let body = '';
check('UP-14 frontmatter is exactly name: update and a one-line description', () => {
  assert(skill !== null, 'no skill');
  const m = /^---\n([\s\S]*?)\n---\n/.exec(skill);
  assert(m, 'no frontmatter');
  const lines = m[1].split('\n');
  assert(lines.length === 2, `${lines.length} frontmatter lines`);
  assert(lines[0] === 'name: update', 'name is not update');
  assert(/^description: [^`<>]+$/.test(lines[1]), 'description is not one plain line');
  body = skill.slice(m[0].length);
});

const fenced = [];
const spans = [];
check('UP-14 the body has no HTML, link, image, indented code or stray backtick', () => {
  assert(skill !== null, 'no skill');
  assert(!body.includes('<'), 'HTML or a comment');
  assert(!/\]\(|\]\[|^\s*\[[^\]]*\]:/m.test(body), 'a markdown link or link reference');
  const prose = [];
  let fence = null;
  for (const line of body.split('\n')) {
    if (fence) {
      if (line === fence) fence = null;
      else fenced.push(line);
      continue;
    }
    const open = /^(```|~~~)(.*)$/.exec(line);
    if (open) {
      assert(['', 'bash', 'sh'].includes(open[2]), `fence info ${JSON.stringify(open[2])}`);
      fence = open[1];
      continue;
    }
    assert(!/^(\t| {4})/.test(line), 'an indented line (indented code)');
    prose.push(line);
  }
  assert(fence === null, 'an unclosed fence');
  const rest = prose.join('\n').replace(/(`+)([^`]*?)\1/g, (all, ticks, inner) => {
    spans.push(inner);
    return '';
  });
  assert(!rest.includes('`'), 'a stray or split backtick');
});

check(`UP-14 every fenced line is exactly \`${UPDATE_COMMAND}\` and there is at least one`, () => {
  assert(skill !== null, 'no skill');
  assert(fenced.length >= 1, 'no fenced command');
  fenced.forEach((line) => assert(line === UPDATE_COMMAND, `fenced line ${JSON.stringify(line)}`));
});

check('UP-14 every inline code span is the update command or a plain slash word', () => {
  assert(skill !== null, 'no skill');
  spans.forEach((span) => assert(span === UPDATE_COMMAND || SLASH_WORDS.includes(span), `span ${JSON.stringify(span)}`));
  assert(spans.includes('/reload-plugins'), 'the skill does not name /reload-plugins');
});

check('UP-14 the skill names no key file, environment variable or key-shaped value', () => {
  assert(skill !== null, 'no skill');
  for (const word of ['.marrow', 'MARROW_', 'API_KEY', '.env', '~/', '$', 'process.env']) {
    assert(!skill.includes(word), `names ${JSON.stringify(word)}`);
  }
  assert(!/\b(sk|pk|rk|ghp|gho|xox[a-z])[_-][A-Za-z0-9]/.test(skill), 'a key-shaped word');
  assert(!/[A-Za-z0-9+/=_-]{32,}/.test(skill), 'a long token-shaped word');
});

check('UP-14 the whole skill text (frontmatter, prose, spans, fences) holds no setup, activate, repair, marrow-mcp or npx outside the one command', () => {
  assert(skill !== null, 'no skill');
  const NEVER_RUNS = "This skill never runs Marrow's setup, activate or repair commands directly.";
  const rest = skill.replace(NEVER_RUNS, '').split(UPDATE_COMMAND).join('');
  const hit = /setup|activate|repair|marrow-mcp|npx/i.exec(rest);
  assert(!hit, `the skill text holds ${JSON.stringify(hit && hit[0])} outside the one allowed command`);
});

check(`VER Claude Code plugin.json version is ${PLUGIN_VERSION} and metadata.pins is ${MCP_VERSION} and ${SDK_VERSION}`, () => {
  const plugin = json('plugins/marrow/.claude-plugin/plugin.json');
  assert(plugin.version === PLUGIN_VERSION, `version ${plugin.version}`);
  assert(plugin.metadata.pins['@getmarrow/mcp'] === MCP_VERSION, 'mcp pin');
  assert(plugin.metadata.pins['@getmarrow/sdk'] === SDK_VERSION, 'sdk pin');
  assert(plugin.description.includes(`@getmarrow/mcp ${MCP_VERSION}`), 'description does not name the pin');
});

check(`VER Cursor plugin.json version is ${CURSOR_VERSION} and its description names ${MCP_VERSION}`, () => {
  const plugin = json('plugins/marrow-cursor/.cursor-plugin/plugin.json');
  assert(plugin.version === CURSOR_VERSION, `version ${plugin.version}`);
  assert(plugin.description.includes(`@getmarrow/mcp ${MCP_VERSION}`), 'description does not name the pin');
});

check(`VER both marketplace descriptions name ${MCP_VERSION}`, () => {
  for (const rel of ['.claude-plugin/marketplace.json', '.cursor-plugin/marketplace.json']) {
    const entry = json(rel).plugins[0];
    assert(entry.description.includes(`@getmarrow/mcp ${MCP_VERSION}`), rel);
  }
});

check(`VER package.json pins exactly @getmarrow/mcp ${MCP_VERSION} and @getmarrow/sdk ${SDK_VERSION}`, () => {
  const deps = json('plugins/marrow/package.json').dependencies;
  assert(Object.keys(deps).length === 2, 'other dependencies');
  assert(deps['@getmarrow/mcp'] === MCP_VERSION && deps['@getmarrow/sdk'] === SDK_VERSION, 'pins differ');
});

check('VER no tag, range or latest in the hooks, MCP config, package.json or scripts of either plugin', () => {
  const files = [];
  for (const plugin of ['plugins/marrow', 'plugins/marrow-cursor']) {
    for (const rel of ['hooks/hooks.json', '.mcp.json', 'mcp.json', 'package.json']) {
      if (fs.existsSync(path.join(repo, plugin, rel))) files.push(`${plugin}/${rel}`);
    }
    for (const name of fs.readdirSync(path.join(repo, plugin, 'scripts'))) files.push(`${plugin}/scripts/${name}`);
  }
  for (const rel of files) assert(!/@latest|\^[0-9]|~[0-9]/.test(read(rel).toString('utf8')), rel);
});

for (const rel of SHARED_FILES) {
  check(`CUR plugins/marrow-cursor/${rel} is byte-identical to plugins/marrow/${rel}`, () => {
    assert(read(`plugins/marrow/${rel}`).equals(read(`plugins/marrow-cursor/${rel}`)), 'bytes differ');
  });
}

console.log(`RESULT pass=${pass} fail=${fail}`);
process.exitCode = fail === 0 ? 0 : 1;
