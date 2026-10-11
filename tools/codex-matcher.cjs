'use strict';
// The Codex hook matcher for codex/marrow, generated from the exact names Codex gives this plugin's
// own Marrow tools. Codex compiles hook matchers with Rust's `regex` crate, which has no lookaround
// and no backreferences, so "everything except these names" is written as the complement of a trie:
// a name is gated when it leaves the trie at any character, stops at a node that is not a whole own
// name, or goes on past a whole own name. `^` and `$` (no m flag) are the start and end of the whole
// name in both Rust and JavaScript, so padding, newlines and suffixes are gated wherever they sit.
//   node tools/codex-matcher.cjs          prints the matcher
const OWN_TOOLS = ['marrow_agent_runtime', 'marrow_agent_status', 'marrow_arbitrate', 'marrow_buyer_proof',
  'marrow_commit', 'marrow_completion_contracts', 'marrow_coordinate', 'marrow_decision_brief',
  'marrow_decision_trace', 'marrow_evaluate_completion_contract', 'marrow_fleet_lessons',
  'marrow_governance_timeline', 'marrow_model_usage', 'marrow_replay_compare', 'marrow_think',
  'marrow_value_report', 'marrow_workflow_gate'];
// Codex names an MCP tool mcp__<server>__<tool>, and this plugin's server is `marrow`.
const OWN_NAMES = OWN_TOOLS.map((tool) => `mcp__marrow__${tool}`);

const ANY = '[\\s\\S]';

function escapeChar(ch) {
  return /[a-z0-9_]/.test(ch) ? ch : `\\${ch}`;
}

function complement(names) {
  const root = { kids: new Map(), end: false };
  for (const name of names) {
    if (!/^[a-z0-9_]+$/.test(name)) throw new Error(`unsupported character in ${name}`);
    let node = root;
    for (const ch of name) {
      if (!node.kids.has(ch)) node.kids.set(ch, { kids: new Map(), end: false });
      node = node.kids.get(ch);
    }
    node.end = true;
  }
  const walk = (node) => {
    const keys = [...node.kids.keys()].sort();
    if (keys.length === 0) return `${ANY}+`;
    const parts = [`[^${keys.map(escapeChar).join('')}]${ANY}*`];
    for (const key of keys) parts.push(`${escapeChar(key)}${walk(node.kids.get(key))}`);
    if (!node.end) parts.push('');
    return `(?:${parts.join('|')})`;
  };
  return `^${walk(root)}$`;
}

const MATCHER = complement(OWN_NAMES);

module.exports = { OWN_TOOLS, OWN_NAMES, MATCHER, complement };

if (require.main === module) process.stdout.write(`${MATCHER}\n`);
