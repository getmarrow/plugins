'use strict';
// The Codex hook matcher for codex/marrow is the wildcard `*`: every tool label Codex sends reaches
// Marrow's hook, this plugin's own Marrow tools included. The plugin skips no tool by name. Whether a
// call is Marrow's own is decided in the hook (@getmarrow/mcp), which sees the label and, in a
// release that can prove it, the host's MCP configuration; a matcher cannot prove a server, so an
// exemption written here would also exempt any look-alike server that gives the same label.
//   node tools/codex-matcher.cjs          prints the matcher
// OWN_TOOLS and OWN_NAMES are not a matcher: they are the plugin's default tool set and the labels
// Codex gives it (mcp__<server>__<tool>, the server is `marrow`), which tools/codex-check.cjs asserts
// reach the hook.
const OWN_TOOLS = ['marrow_agent_runtime', 'marrow_agent_status', 'marrow_arbitrate', 'marrow_buyer_proof',
  'marrow_commit', 'marrow_completion_contracts', 'marrow_coordinate', 'marrow_decision_brief',
  'marrow_decision_trace', 'marrow_evaluate_completion_contract', 'marrow_fleet_lessons',
  'marrow_governance_timeline', 'marrow_model_usage', 'marrow_replay_compare', 'marrow_think',
  'marrow_value_report', 'marrow_workflow_gate'];
const OWN_NAMES = OWN_TOOLS.map((tool) => `mcp__marrow__${tool}`);

const MATCHER = '*';

// Codex's rule for a hook matcher: absent, empty or `*` matches every name; anything else is a
// regular expression (Rust `regex`, searched unanchored). Any other value goes through the JavaScript
// engine here, which is a model only: it differs from Rust on lookaround, which Codex rejects.
function codexMatches(matcher, name) {
  if (matcher === undefined || matcher === '' || matcher === '*') return true;
  return new RegExp(matcher).test(name);
}

module.exports = { OWN_TOOLS, OWN_NAMES, MATCHER, codexMatches };

if (require.main === module) process.stdout.write(`${MATCHER}\n`);
