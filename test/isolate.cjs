'use strict';
// First statement of every maintainer tool that can start a child process: `require('../test/isolate.cjs');`.
// It runs child-isolation.cjs's bootstrap once per process (a private 0700 temp root, HOME and scratch passwd home, then the spawn
// guard). Node caches the module, so tools that load each other (test-launcher.cjs loads the T2 and lock tools) share one root: a
// second bootstrap would move HOME and TMPDIR away from the root the guard checks. Test-only; nothing under plugins/ or codex/
// names or loads this file.
module.exports = require('./child-isolation.cjs').bootstrap('plugins-test');
