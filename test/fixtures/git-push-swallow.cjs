// A scratch test that pushes to a public-looking address and swallows the refusal. Only test/child-isolation.test.cjs runs it,
// in a nested `node --test`, and expects that run to be red anyway. The address never resolves (.invalid) and the guard
// refuses the push before any process starts.
require('../isolate.cjs');
const cp = require('node:child_process');
const test = require('node:test');

test('pushes to a public-looking remote and swallows the refusal', () => {
  try {
    cp.spawnSync('git', ['push', 'https://example.invalid/acme/proj.git', 'HEAD:main']);
  } catch {
    // swallowed on purpose
  }
});
