'use strict';
// WIN26 hook smoke: runs the Cursor and Claude Code pre-action hooks, and the Cursor plugin's own launcher, on a clean HOME with no
// Marrow key, on the runner's real platform (GitHub Actions: windows-latest, macos-latest, ubuntu-latest). Port of the 962b7d9 harness
// (candidate mode) with these changes: output is row id + PASS|FAIL (+ a tag) only, never a command, path or deny text; a FAIL row that
// is not tagged expected-on-old-MCP fails the job; the published package is a first-class candidate; Cursor rows live in
// tools/hook-smoke-cursor.cjs.
//
//   node tools/hook-smoke.cjs [out.json] --candidate <mcp.tgz> [--published]
//        The `npm pack` tarball of @getmarrow/mcp is installed into a temp prefix and its cursor-pre-action-hook /
//        claude-pre-action-hook entries run directly with the same stdin payloads (the launcher's integrity check is not touched, so
//        an unpublished candidate can be tested). --published says the tarball is the published package the plugin pins (the workflow
//        passes it when tools/candidate/mcp-candidate.tgz is not committed): its integrity is compared with the plugin's manifest,
//        and a FAIL of an MCP-lane row on Windows is tagged expected-on-old-MCP (the published package has the POSIX-mode-bit loop
//        guard that denies everything on Windows). Plugin-lane rows (CUR-*, W32-*, PACK-*) are never tagged.
//   node tools/hook-smoke.cjs --check-ci-commit
//        Passes when the last commit (HEAD~1..HEAD) changes only the CI files (the workflow, the two harness files, the candidate slots).
//   node tools/hook-smoke.cjs --compare <linux.json> <other.json>
//        Prints the ids whose decision on the other OS is looser than on Linux (and nothing else); exit 1 when there is one.
//
// Keyless only: every child env is built from a small allowlist, never from process.env as a whole, and no env value is ever printed.
// Negative rows prepare ACLs, links and a local user in THIS harness only (the runner is admin); the product never runs icacls, mklink
// or net user. Test seams (unset in CI): HOOK_SMOKE_GUARD (a --require preload for hook children), HOOK_SMOKE_NPM_CACHE and
// HOOK_SMOKE_REGISTRY (an offline npm cache for the installs).
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const childProcess = require('child_process');

const REPO = path.resolve(__dirname, '..');
const LAUNCHER_TIMEOUT_MS = 240000;
const CANDIDATE_TIMEOUT_MS = 60000;
const L2_P95_LIMIT_MS = 1500;
const L3_LIMIT_MS = 5000;
// The only files the Windows CI commit may add or change (SPEC-WIN26 CI): the workflow, the two harness files and the candidate tarball slots.
const CI_FILES = ['.github/workflows/win26-hook-smoke.yml', 'tools/hook-smoke.cjs', 'tools/hook-smoke-cursor.cjs', 'tools/candidate/mcp-candidate.tgz', 'tools/candidate/mcp-candidate.sha256'];
// Candidate mode stops issuing hook calls after this long, so a hung host still leaves a JSON behind (job timeout is 40 min).
const CANDIDATE_BUDGET_MS = 30 * 60 * 1000;

// Verbatim product texts. The loop guard text is the 3.9.105 deny text (G7: it must not change).
const UNSAFE_TEXT = 'Marrow local loop guard state is unsafe. Repair the private owner-only state before retrying.';
const SEATBELT_HEAD = 'MARROW SEATBELT stopped this action';
// The control-state check runs before the loop guard and also refuses a linked ~/.marrow (3.9.105 behaviour).
const CONTROL_UNSAFE_PREFIX = 'Marrow local control state is unsafe.';
const HOLD_RE = /Marrow is linked to an account but has no working key|Marrow has no working key on this machine|Marrow has no API key on this machine/;

const CMDS = [
  { cmd: 'git status', expect: 'allow' },
  { cmd: 'git push --force origin main', expect: 'deny' },
  { cmd: 'ls', expect: 'allow' },
  { cmd: 'npm test', expect: 'allow' },
];
// Non-shell case: a Read of a file in the temp repo. Cursor uses its preToolUse hook, Claude PreToolUse.
const READ_CASE = { cmd: 'Read README.md', expect: 'allow', tool: 'Read' };

function sh(cmd, args, opts) {
  const r = childProcess.spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed: ${(r.stderr || '').slice(0, 200)}`);
}

function makeRepo(base) {
  const origin = path.join(base, 'origin.git');
  const work = path.join(base, 'work');
  fs.mkdirSync(work, { recursive: true });
  const g = (a, cwd) => sh('git', ['-c', 'user.name=smoke', '-c', 'user.email=smoke@example.invalid', ...a], { cwd });
  g(['init', '-q', '--bare', origin], base);
  g(['init', '-q', '-b', 'main'], work);
  fs.writeFileSync(path.join(work, 'README.md'), 'smoke\n');
  fs.writeFileSync(path.join(work, 'package.json'), '{"name":"smoke","version":"1.0.0","scripts":{"test":"node -e 0"}}\n');
  g(['add', '.'], work);
  g(['commit', '-q', '-m', 'init'], work);
  g(['remote', 'add', 'origin', origin], work);
  g(['push', '-q', 'origin', 'main'], work);
  return work;
}

// ---- environment ------------------------------------------------------------------------------------

// Case-insensitive set/delete (Windows env names are case-insensitive but the object is not).
function setEnvCI(env, name, value) {
  const lower = name.toLowerCase();
  for (const k of Object.keys(env)) if (k.toLowerCase() === lower) delete env[k];
  if (value !== null && value !== undefined) env[name] = String(value);
}

// Defense in depth on top of the allowlist: nothing credential-shaped ever reaches a child.
function scrubEnv(env) {
  for (const k of Object.keys(env)) {
    if (/^MARROW_(API_)?KEY$/i.test(k) || /(token|secret|passw|credential|api_?key)/i.test(k)) delete env[k];
  }
  return env;
}

// Minimal env for harness tooling children (icacls, cmd, net, pwsh probe): the same allowlist, nothing else.
function baseEnv() {
  const env = {};
  for (const k of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'ComSpec', 'COMSPEC', 'PATHEXT', 'windir', 'TEMP', 'TMP']) if (process.env[k] !== undefined) env[k] = process.env[k];
  return scrubEnv(env);
}

function cleanEnv(home, extra) {
  const keep = ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'ComSpec', 'COMSPEC', 'PATHEXT', 'windir', 'TERM', 'LANG'];
  const env = {};
  for (const k of keep) if (process.env[k] !== undefined) env[k] = process.env[k];
  const tmp = path.join(home, 'tmp');
  fs.mkdirSync(tmp, { recursive: true });
  Object.assign(env, {
    HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(home, 'AppData', 'Local'), TMPDIR: tmp, TEMP: tmp, TMP: tmp,
    npm_config_cache: path.join(home, '.npm'), GIT_CONFIG_NOSYSTEM: '1',
  }, extra);
  delete env.MARROW_API_KEY;
  if (process.env.HOOK_SMOKE_GUARD) env.NODE_OPTIONS = `--require=${process.env.HOOK_SMOKE_GUARD}`;
  if (process.env.HOOK_SMOKE_NPM_CACHE) { env.npm_config_cache = process.env.HOOK_SMOKE_NPM_CACHE; env.npm_config_prefer_offline = 'true'; }
  if (process.env.HOOK_SMOKE_REGISTRY) env.npm_config_registry = process.env.HOOK_SMOKE_REGISTRY;
  return scrubEnv(env);
}

// ---- output classification --------------------------------------------------------------------------

function parseJson(s) {
  const t = (s || '').trim();
  if (!t) return null;
  try { return JSON.parse(t); } catch { /* fall through */ }
  const line = t.split(/\r?\n/).filter(Boolean).pop();
  try { return JSON.parse(line); } catch { return { _unparsed: t.slice(0, 200) }; }
}

function decisionOf(host, j, code) {
  let d = 'none';
  if (j && j.permission) d = j.permission;
  if (j && j.hookSpecificOutput && j.hookSpecificOutput.permissionDecision) d = j.hookSpecificOutput.permissionDecision;
  if (j && j.decision) d = j.decision;
  return { d, blocked: d === 'deny' || d === 'block' || code === 2 };
}

// unsafe = loop guard deny text, seatbelt = a SEATBELT stop, hold = the claimed_no_key protected hold.
function textClass(msg) {
  const s = String(msg || '');
  if (s.includes(UNSAFE_TEXT)) return 'unsafe';
  if (s.includes(CONTROL_UNSAFE_PREFIX)) return 'control';
  if (s.includes(SEATBELT_HEAD)) return 'seatbelt';
  if (HOLD_RE.test(s)) return 'hold';
  return s ? 'other' : 'none';
}

// 3.9.106 and earlier end the stop text with "(RULE, ...)"; 3.9.107 ends it with "Code: RULE/detail."
function ruleOf(msg) {
  const text = String(msg || '');
  const m = /Code: ([A-Za-z0-9_.:-]{1,64})\//.exec(text) || /stopped this action: [^()]*\(([A-Za-z0-9_.:-]{1,64}),/.exec(text);
  return m ? m[1] : '';
}

function classify(hostName, r) {
  const stdout = (r && r.stdout) || '';
  const j = parseJson(stdout);
  const { d, blocked } = decisionOf(hostName, j, r ? r.status : null);
  const msg = (j && (j.user_message || (j.hookSpecificOutput && j.hookSpecificOutput.permissionDecisionReason))) || '';
  return { j, d, blocked, msg, seatbelt: /SEATBELT/.test(stdout), text: textClass(msg), rule: ruleOf(msg), exit0: !!r && r.status === 0 && !r.error };
}

const ALLOW = { decision: 'allow' };
const INFO = { decision: 'info' };
const DENY_UNSAFE = { decision: 'deny', text: 'unsafe' };
const DENY_ANY = { decision: 'deny', text: 'any' };
const DENY_UNSAFE_STATE = { decision: 'deny', text: ['unsafe', 'control'] };
const denyStop = (rule) => ({ decision: 'deny', text: 'seatbelt', rule });
const DENY_HOLD = { decision: 'deny', text: 'hold' };

function expectLabel(exp) {
  if (exp.decision !== 'deny') return exp.decision;
  return `deny:${[].concat(exp.text || 'any').join('|')}${exp.rule ? `:${exp.rule.source}` : ''}`;
}

// allow = a clean exit that is neither blocked nor the loop-guard deny; deny = blocked with the stated text/rule.
function judge(exp, cls) {
  if (exp.decision === 'info') return 'INFO';
  if (exp.decision === 'allow' || exp.decision === 'post') return (cls.exit0 && !cls.blocked && cls.text !== 'unsafe') ? 'PASS' : 'FAIL';
  if (!cls.blocked) return 'FAIL';
  if (exp.text && exp.text !== 'any' && ![].concat(exp.text).includes(cls.text)) return 'FAIL';
  if (exp.rule && !exp.rule.test(cls.rule || '')) return 'FAIL';
  return 'PASS';
}

// ---- latency ----------------------------------------------------------------------------------------

function pct(values, p) {
  if (!values.length) return null;
  const v = values.slice().sort((a, b) => a - b);
  return v[Math.max(0, Math.ceil((p / 100) * v.length) - 1)];
}

function stat(values) {
  return { n: values.length, p50: pct(values, 50), p95: pct(values, 95), max: values.length ? Math.max(...values) : null };
}

// Only healthy-path hook calls (flagged lat) count; negative rows are fast-deny by design. run1/run2 cover every
// counted hook call (pre and post: the L-2 gate basis); pre, post and pair (pre+post of one tool call) are reported too.
function latencyStats(rows, pairs = []) {
  const acc = {};
  const slot = (h) => (acc[h] = acc[h] || { all: [[], []], pre: [[], []], post: [[], []], pair: [[], []] });
  for (const r of rows) {
    if (!r.lat || !Number.isFinite(r.ms) || (r.run !== 1 && r.run !== 2)) continue;
    const s2 = slot(r.host);
    const k = r.run - 1;
    s2.all[k].push(r.ms);
    (r.phase === 'post' ? s2.post : s2.pre)[k].push(r.ms);
  }
  for (const p of pairs) if ((p.run === 1 || p.run === 2) && Number.isFinite(p.ms)) slot(p.host).pair[p.run - 1].push(p.ms);
  const two = (v) => ({ run1: stat(v[0]), run2: stat(v[1]) });
  const res = {};
  for (const [h, v] of Object.entries(acc)) res[h] = { ...two(v.all), pre: two(v.pre), post: two(v.post), pair: two(v.pair) };
  return res;
}

function computeGates(platform, latency, firstCall, install) {
  const L2 = { limit_ms: L2_P95_LIMIT_MS, applies: platform === 'win32', status: 'N/A', per_host: {} };
  if (L2.applies) {
    let any = false;
    let fail = false;
    for (const [h, v] of Object.entries(latency)) {
      L2.per_host[h] = { n: v.run2.n, p95_ms: v.run2.p95 };
      if (v.run2.n > 0) { any = true; if (v.run2.p95 > L2_P95_LIMIT_MS) fail = true; }
    }
    L2.status = !any ? 'NO_DATA' : fail ? 'FAIL' : 'PASS';
  }
  const L3 = { limit_ms: L3_LIMIT_MS, status: 'REPORT', per_host: {}, install_cold_cache_ms: install ? install.cold_cache_ms : null, install_warm_cache_ms: install ? install.warm_cache_ms : null };
  for (const [h, ms] of Object.entries(firstCall)) {
    L3.per_host[h] = { first_call_ms: ms, run1_p95_ms: latency[h] ? latency[h].run1.p95 : null, under_limit: ms !== null && ms < L3_LIMIT_MS };
  }
  return { L2, L3 };
}

// ---- hosts ------------------------------------------------------------------------------------------

const HOSTS = [
  {
    name: 'cursor', dir: 'plugins/marrow-cursor', rootVar: 'CURSOR_PLUGIN_ROOT', candidateEntry: 'cursor-pre-action-hook', candidatePostEntry: 'cursor-hook',
    // ASSUMPTION: Cursor beforeShellExecution stdin shape (conversation_id, hook_event_name, command, cwd, workspace_roots).
    entry: (h) => h.hooks.beforeShellExecution[0].command,
    // ASSUMPTION: Cursor preToolUse Read stdin: tool_name Read, tool_input.file_path.
    readEntry: (h) => h.hooks.preToolUse[0].command,
    postEntry: (h) => h.hooks.afterShellExecution[0].command,
    postReadEntry: (h) => h.hooks.postToolUse[0].command,
    // Every call gets its own conversation id: the loop guard refuses an unchanged repeat inside one session once a post hook recorded it.
    readPayload: (cwd, i) => ({ conversation_id: `smoke-${i}`, generation_id: `g${i}`, hook_event_name: 'preToolUse', tool_name: 'Read', tool_input: { file_path: path.join(cwd, 'README.md') }, cwd, workspace_roots: [cwd] }),
    payload: (cmd, cwd, i) => ({ conversation_id: `smoke-${i}`, generation_id: `g${i}`, hook_event_name: 'beforeShellExecution', command: cmd, cwd, workspace_roots: [cwd] }),
    // ASSUMPTION: afterShellExecution carries the same fields plus output and duration; postToolUse adds tool_output.
    postPayload: (cmd, cwd, i) => ({ conversation_id: `smoke-${i}`, generation_id: `g${i}`, hook_event_name: 'afterShellExecution', command: cmd, output: 'smoke output', duration: 5, cwd, workspace_roots: [cwd] }),
    postReadPayload: (cwd, i) => ({ conversation_id: `smoke-${i}`, generation_id: `g${i}`, hook_event_name: 'postToolUse', tool_name: 'Read', tool_input: { file_path: path.join(cwd, 'README.md') }, tool_output: 'smoke output', cwd, workspace_roots: [cwd] }),
    // ASSUMPTION: Cursor edits arrive as preToolUse Write with tool_input.file_path and contents (there is no separate Edit tool name).
    writePayload: (cwd, i, tool, file, o = {}) => ({ conversation_id: `smoke-${i}`, generation_id: `g${i}`, hook_event_name: 'preToolUse', tool_name: 'Write', tool_input: { file_path: file, contents: o.text || '' }, cwd, workspace_roots: [cwd] }),
    forgeCwd: (p, cwd) => { p.cwd = cwd; p.workspace_roots = [cwd]; },
    extraEnv: () => ({}),
  },
  {
    name: 'claude-code', dir: 'plugins/marrow', rootVar: 'CLAUDE_PLUGIN_ROOT', candidateEntry: 'claude-pre-action-hook', candidatePostEntry: 'claude-hook',
    // ASSUMPTION: Claude Code PreToolUse stdin shape for Bash (session_id, hook_event_name, tool_name, tool_input.command, tool_use_id, cwd).
    entry: (h) => h.hooks.PreToolUse[0].hooks[0].command,
    readEntry: (h) => h.hooks.PreToolUse[0].hooks[0].command,
    postEntry: (h) => h.hooks.PostToolUse[0].hooks[0].command,
    postReadEntry: (h) => h.hooks.PostToolUse[0].hooks[0].command,
    readPayload: (cwd, i) => ({ session_id: `smoke-${i}`, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: path.join(cwd, 'README.md') }, tool_use_id: `t${i}`, cwd }),
    payload: (cmd, cwd, i) => ({ session_id: `smoke-${i}`, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: cmd }, tool_use_id: `t${i}`, cwd }),
    // ASSUMPTION: PostToolUse is the Pre shape plus tool_response (stdout, stderr, exit_code for Bash).
    postPayload: (cmd, cwd, i) => ({ session_id: `smoke-${i}`, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: cmd }, tool_response: { stdout: 'smoke output', stderr: '', exit_code: 0 }, tool_use_id: `t${i}`, cwd }),
    postReadPayload: (cwd, i) => ({ session_id: `smoke-${i}`, hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: path.join(cwd, 'README.md') }, tool_response: { type: 'text', file: { filePath: path.join(cwd, 'README.md'), content: 'smoke' } }, tool_use_id: `t${i}`, cwd }),
    // Claude Code Write {file_path, content} and Edit {file_path, old_string, new_string}.
    writePayload: (cwd, i, tool, file, o = {}) => ({
      session_id: `smoke-${i}`, hook_event_name: 'PreToolUse', tool_name: tool === 'Edit' ? 'Edit' : 'Write', tool_use_id: `t${i}`, cwd,
      tool_input: tool === 'Edit' ? { file_path: file, old_string: o.old || 'old', new_string: o.text || '' } : { file_path: file, content: o.text || '' },
    }),
    forgeCwd: (p, cwd) => { p.cwd = cwd; },
    extraEnv: (home) => ({ CLAUDE_PLUGIN_DATA: path.join(home, '.claude', 'plugins', 'data', 'marrow-getmarrow') }),
  },
];

// ---- scrubbing and small helpers --------------------------------------------------------------------

function makeSanitizer(ctx) {
  return (s) => {
    let t = String(s === undefined || s === null ? '' : s).replace(/\s+/g, ' ');
    for (const secret of ctx.secrets) if (secret) t = t.split(secret).join('[redacted]');
    return t.slice(0, 300);
  };
}

function sysExe(ctx, rel) {
  const root = ctx.systemRoot || process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  return `${root}\\System32\\${rel}`;
}

function removeLink(p) {
  try { fs.rmdirSync(p); return; } catch { /* not a directory link */ }
  try { fs.unlinkSync(p); } catch { /* already gone */ }
}

function safeRemove(ctx, p) {
  const base = ctx.baseTmp + path.sep;
  if (!p || !String(p).startsWith(base)) return; // never delete outside our own temp base
  try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* best effort */ }
}

// Homes reached through odd spellings of the same temp home (Windows only; null when not a drive path).
function winForms(home) {
  const m = /^([A-Za-z]):\\(.+)$/.exec(home);
  if (!m) return null;
  return {
    unc: `\\\\localhost\\${m[1]}$\\${m[2]}`, // \\localhost\C$\...
    device: `\\\\?\\${home}`, // \\?\C:\...
    driveRelative: `${m[1]}:${m[2]}`, // C:Users\... (no backslash after the colon)
  };
}

// ---- OS tooling used by the rows (harness only; every call goes through ctx.run so tests can record) ---

function makeTools(ctx) {
  const win = ctx.platform === 'win32';
  const run = (file, args, opts) => ctx.run(file, args, { encoding: 'utf8', windowsHide: true, timeout: 60000, env: baseEnv(), ...opts });
  const fail = (what, r) => { throw new Error(ctx.sanitize(`${what} failed (exit ${r && r.status}${r && r.error ? ` ${r.error.code}` : ''}): ${(r && r.stderr) || (r && r.stdout) || ''}`)); };
  const t = {
    // icacls <path> <args...>; throws on a non-zero exit.
    icacls(target, ...args) {
      const r = run(sysExe(ctx, 'icacls.exe'), [target, ...args]);
      if (r.status !== 0) fail(`icacls ${args.join(' ')}`, r);
      return r;
    },
    aclText(target) {
      try { const r = run(sysExe(ctx, 'icacls.exe'), [target]); return String(r.stdout || '').replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').slice(0, 500); } catch { return ''; }
    },
    // kind: junction | symlink-file | symlink-dir | hard. cmd mklink first (what an attacker types), Node API as the fallback.
    link(kind, linkPath, target) {
      if (!win) {
        if (kind === 'hard') fs.linkSync(target, linkPath);
        else fs.symlinkSync(target, linkPath, kind === 'symlink-dir' ? 'dir' : 'file');
        return 'node';
      }
      const flag = kind === 'junction' ? '/J ' : kind === 'symlink-dir' ? '/D ' : kind === 'hard' ? '/H ' : '';
      const r = run('cmd.exe', ['/d', '/s', '/c', `"mklink ${flag}"${linkPath}" "${target}""`], { windowsVerbatimArguments: true });
      let ok = false;
      try { const st = fs.lstatSync(linkPath); ok = r.status === 0 && (kind === 'hard' ? st.nlink >= 2 || fs.statSync(target).nlink >= 2 : st.isSymbolicLink()); } catch { ok = false; }
      if (ok) return 'mklink';
      try { fs.unlinkSync(linkPath); } catch { /* nothing was created */ }
      if (kind === 'hard') fs.linkSync(target, linkPath);
      else fs.symlinkSync(target, linkPath, kind === 'junction' ? 'junction' : kind === 'symlink-dir' ? 'dir' : 'file');
      return 'node-api (mklink did not create it)';
    },
    // Short (8.3) spelling of an existing directory; null when the volume gave it no short name.
    shortPath(longPath) {
      const r = run('cmd.exe', ['/d', '/s', '/c', `"for %I in ("${longPath}") do @echo %~sI"`], { windowsVerbatimArguments: true, timeout: 20000 });
      if (r.status !== 0) fail('8.3 short name lookup', r);
      const s = String(r.stdout || '').trim().split(/\r?\n/).pop().trim();
      if (!/^[A-Za-z]:\\/.test(s) || s.toLowerCase() === longPath.toLowerCase() || !s.includes('~')) return null;
      return s;
    },
    createUser(name) {
      // The password exists only in this process and in the child env of the creating PowerShell; never in argv or output.
      const pw = `Aa1!${crypto.randomBytes(18).toString('base64url')}`;
      ctx.secrets.push(pw);
      run(sysExe(ctx, 'net.exe'), ['user', name, '/delete']); // a leftover from an aborted run; failure is expected
      const env = baseEnv();
      env.SMOKE_LOCALUSER_PW = pw; // not credential-shaped by name on purpose: it must reach exactly one child
      const script = `$ErrorActionPreference='Stop'; $p = ConvertTo-SecureString $env:SMOKE_LOCALUSER_PW -AsPlainText -Force; New-LocalUser -Name '${name}' -Password $p -AccountNeverExpires -PasswordNeverExpires | Out-Null`;
      const r = run(sysExe(ctx, 'WindowsPowerShell\\v1.0\\powershell.exe'), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { env });
      if (r.status !== 0) fail('local user creation', r);
    },
    deleteUser(name) {
      return run(sysExe(ctx, 'net.exe'), ['user', name, '/delete']);
    },
  };
  return t;
}

// ---- one tool call: the pre hook and, on the healthy path, the post hook ---------------------------------

const POST = { decision: 'post' };

// o: { id, label, exp, run, payload, postPayload (null = no post call), env, cwd, lat, setup, note, needs }.
// The post hook runs only after an allowed pre hook (a denied tool call never runs, so it has no post phase) and
// carries the same payload shape plus a result; pre and post both count for the latency numbers when lat is set.
function hookCall(ctx, host, hostInfo, o) {
  const pre = ctx.invoke(host, hostInfo, o.payload, o.env, o.cwd, 'pre');
  const cls = classify(host.name, pre.r);
  const result = judge(o.exp, cls);
  ctx.addRow({
    host: host.name, id: o.id, command: o.label, run: o.run, r: pre.r, ms: pre.ms, cls, expected: expectLabel(o.exp), result,
    lat: !!o.lat, setup: o.setup || [], note: o.note || '', needs: o.needs || '', phase: 'pre',
  });
  if (o.postPayload && !cls.blocked && cls.exit0) {
    const post = ctx.invoke(host, hostInfo, o.postPayload, o.env, o.cwd, 'post');
    const pcls = classify(host.name, post.r);
    ctx.addRow({
      host: host.name, id: o.id, command: o.label, run: o.run, r: post.r, ms: post.ms, cls: pcls, expected: expectLabel(POST), result: judge(POST, pcls),
      lat: !!o.lat, setup: [], note: '', needs: '', phase: 'post',
    });
    if (o.lat) ctx.pairs.push({ host: host.name, run: o.run, ms: pre.ms + post.ms });
  }
  return { cls, result, ms: pre.ms };
}

// ---- scenario (one fresh home per row) --------------------------------------------------------------

function newScenario(ctx, host, hostInfo, def) {
  const label = def.id.toLowerCase().replace(/[^a-z0-9]/g, '');
  const home = fs.mkdtempSync(path.join(hostInfo.hostBase, `${label}-`));
  try { fs.chmodSync(home, 0o700); } catch { /* windows */ }
  const sc = {
    ctx, host, hostInfo, def, home, work: hostInfo.work, hostBase: hostInfo.hostBase, root: hostInfo.root,
    envOver: {}, spawnCwd: null, n: 0, setup: [], cleanups: [], t: ctx.tools,
    log(msg) { sc.setup.push(ctx.sanitize(String(msg).split(home).join('<home>'))); },
    env() {
      const env = cleanEnv(home, { [host.rootVar]: hostInfo.root, ...host.extraEnv(home) });
      for (const [k, v] of Object.entries(sc.envOver)) setEnvCI(env, k, v);
      return scrubEnv(env);
    },
    skip(reason) { sc.skipped = reason; },
    // One shell/Read hook call (runs times). exp is judged; the row is recorded either way.
    call(cmd, exp, opts = {}) {
      let last = null;
      const runs = opts.runs || 1;
      for (let run = 1; run <= runs; run += 1) {
        sc.n += 1;
        const payload = opts.tool ? host.readPayload(sc.work, sc.n) : host.payload(cmd, sc.work, sc.n);
        if (opts.eventCwd) host.forgeCwd(payload, opts.eventCwd);
        const postPayload = opts.lat ? (opts.tool ? host.postReadPayload(sc.work, sc.n) : host.postPayload(cmd, sc.work, sc.n)) : null;
        last = hookCall(ctx, host, hostInfo, {
          id: opts.id || def.id, label: cmd, exp, run, payload, postPayload, env: sc.env(), cwd: sc.spawnCwd || sc.work,
          lat: !!opts.lat, setup: sc.setup.slice(), note: opts.note || '', needs: opts.needs !== undefined ? opts.needs : (def.needs || ''),
        });
      }
      return last;
    },
    // One Write/Edit tool call on a file (the pre hook only; nothing is written).
    write(tool, file, exp, opts = {}) {
      sc.n += 1;
      const payload = host.writePayload(sc.work, sc.n, tool, file, opts);
      return hookCall(ctx, host, hostInfo, {
        id: opts.id || def.id, label: `${tool} ${String(file).split(sc.home).join('<home>')}`, exp, run: 1, payload, postPayload: null, env: sc.env(), cwd: sc.spawnCwd || sc.work,
        lat: false, setup: sc.setup.slice(), note: opts.note || '', needs: opts.needs !== undefined ? opts.needs : (def.needs || ''),
      });
    },
    // A healthy call before the damage: proves the denial that follows is caused by the damage.
    prime(cmd = 'git status') {
      const c = sc.call(cmd, ALLOW, { id: `${def.id}/control`, needs: '' });
      if (c.result !== 'PASS') throw new Error('control call on the healthy home was not allowed (row inconclusive)');
      return c;
    },
    assertExists(p, what) {
      const ok = fs.existsSync(p);
      ctx.addRow({ host: host.name, id: `${def.id}/assert`, command: `(assert ${what})`, run: 0, r: null, ms: 0, cls: null, expected: 'exists', result: ok ? 'PASS' : 'FAIL', lat: false, setup: [], note: ok ? '' : `${what} is missing`, needs: '' });
    },
  };
  return sc;
}

// ---- row definitions (SPEC 7.3) ---------------------------------------------------------------------

const BOTH = ['cursor', 'claude-code'];

function buildRows(ctx) {
  const win = ctx.platform === 'win32';
  const marrow = (sc) => path.join(sc.home, '.marrow');
  const guardDir = (sc) => path.join(sc.home, '.marrow', 'session-loop-guard');
  const stateFile = (sc) => path.join(sc.home, '.marrow', 'session-loop-guard', 'state.json');
  const pwshCmd = 'pwsh -c "git push -f origin main"';
  return [
    {
      id: 'W-P1', os: 'both', hosts: BOTH, run(sc) {
        if (win) {
          const short = sc.t.shortPath(sc.home);
          if (!short) return sc.skip('no 8.3 short name exists for the temp home on this volume');
          sc.log(`USERPROFILE and HOME use the 8.3 spelling ${short.split(sc.home).join('<home>')}`);
          sc.envOver = { USERPROFILE: short, HOME: short };
        }
        sc.call('git status', ALLOW, { runs: 2, lat: true });
        sc.call('ls', ALLOW, { runs: 2, lat: true });
        sc.call('Read README.md', ALLOW, { runs: 2, lat: true, tool: true });
        sc.call(`Get-ChildItem ${sc.work}`, ALLOW, { runs: 2, lat: true });
        sc.call('npm test', ALLOW, { runs: 2, lat: true });
        return sc.assertExists(guardDir(sc), '.marrow/session-loop-guard created');
      },
    },
    {
      id: 'W-P2', os: 'both', hosts: ['cursor'], run(sc) {
        // The Cursor launcher does mkdirSync(~/.marrow/cursor-plugin, recursive) before the hook runs.
        fs.mkdirSync(path.join(marrow(sc), 'cursor-plugin'), { recursive: true, mode: 0o700 });
        sc.log('created .marrow/cursor-plugin (as the launcher does) before the first hook call');
        sc.call('git status', ALLOW, { runs: 2, lat: true });
        sc.assertExists(guardDir(sc), '.marrow/session-loop-guard created');
        return sc.assertExists(path.join(marrow(sc), 'cursor-plugin'), '.marrow/cursor-plugin kept');
      },
    },
    { id: 'W-P3', os: 'both', hosts: BOTH, run(sc) { sc.call('git push --force origin main', denyStop(/^S1\./), { runs: 2, lat: true }); } },
    { id: 'W-P4', os: 'both', hosts: BOTH, run(sc) { sc.call('git commit -m wip', DENY_HOLD, { runs: 2, lat: true }); } },
    {
      id: 'W-P5', os: 'both', hosts: BOTH, needs: 'J2', run(sc) {
        const victim = path.join(sc.hostBase, `victim-${crypto.randomBytes(3).toString('hex')}`);
        fs.mkdirSync(victim, { recursive: true });
        fs.writeFileSync(path.join(victim, 'f.txt'), 'x');
        sc.cleanups.push(() => safeRemove(ctx, victim));
        const exp = denyStop(/^S5\.windows_shell_delete_unparsed$/);
        const encoded = Buffer.from(`Remove-Item -Recurse ${victim}`, 'utf16le').toString('base64');
        sc.call(`Remove-Item -Recurse -Force ${victim}`, exp, { lat: true });
        sc.call(`powershell -NoProfile -Command "Remove-Item -Recurse -Force '${victim}'"`, exp, { lat: true });
        sc.call(`cmd /c rd /s /q ${victim}`, exp, { lat: true });
        sc.call(`Re${String.fromCharCode(96)}move-Item -Recurse ${victim}`, exp, { lat: true });
        sc.call(`powershell -NoProfile -EncodedCommand ${encoded}`, exp, { lat: true });
        return sc.assertExists(victim, 'victim dir still exists');
      },
    },
    {
      id: 'W-P6', os: 'both', hosts: BOTH, candidateOnly: true, run(sc) {
        const r0 = Date.now();
        const r = ctx.invokeSelfTest(sc.host, sc.root, sc.env(), sc.work);
        const ms = Date.now() - r0;
        const j = parseJson(r.stdout);
        const pass = r.status === 0 && !r.error && !!j && j.pass === true;
        ctx.selftestMs[sc.host.name] = ms;
        ctx.addRow({ host: sc.host.name, id: 'W-P6', command: 'loop-guard-self-test', run: 1, r, ms, cls: classify(sc.host.name, r), expected: 'pass', result: pass ? 'PASS' : 'FAIL', lat: false, setup: [], note: 'proof cost' });
      },
    },
    {
      id: 'W-P7', os: 'win32', hosts: BOTH, run(sc) {
        sc.prime();
        // Owner = Administrators (BA). The SID spelling first; the (English) group name only if icacls rejects the SID form.
        try {
          sc.t.icacls(marrow(sc), '/setowner', '*S-1-5-32-544');
          sc.log(`icacls .marrow /setowner *S-1-5-32-544 => ${sc.t.aclText(marrow(sc))}`);
        } catch (e) {
          sc.log(`/setowner with the SID spelling failed (${ctx.sanitize(e.message)})`);
          sc.t.icacls(marrow(sc), '/setowner', 'Administrators');
          sc.log(`icacls .marrow /setowner Administrators => ${sc.t.aclText(marrow(sc))}`);
        }
        sc.call('git status', ALLOW);
      },
    },
    {
      id: 'W-N1', os: 'both', hosts: BOTH, run(sc) {
        sc.prime();
        if (win) { sc.t.icacls(marrow(sc), '/grant', '*S-1-5-32-545:(OI)(CI)M'); sc.log(`icacls .marrow /grant *S-1-5-32-545:(OI)(CI)M => ${sc.t.aclText(marrow(sc))}`); } else { fs.chmodSync(marrow(sc), 0o777); sc.log('chmod 0777 .marrow'); }
        sc.call('git status', DENY_UNSAFE);
      },
    },
    {
      id: 'W-N2', os: 'both', hosts: BOTH, run(sc) {
        sc.prime();
        if (win) { sc.t.icacls(guardDir(sc), '/grant', '*S-1-1-0:(OI)(CI)R'); sc.log(`icacls session-loop-guard /grant *S-1-1-0:(OI)(CI)R => ${sc.t.aclText(guardDir(sc))}`); } else { fs.chmodSync(guardDir(sc), 0o750); sc.log('chmod 0750 session-loop-guard'); }
        sc.call('git status', DENY_UNSAFE);
      },
    },
    {
      id: 'W-N3', os: 'both', hosts: BOTH, run(sc) {
        sc.prime();
        // The healthy tree is moved and linked back, so the link is the only defect.
        const moved = path.join(sc.home, 'moved');
        fs.renameSync(marrow(sc), moved);
        const how = sc.t.link(win ? 'junction' : 'symlink-dir', marrow(sc), moved);
        sc.cleanups.push(() => removeLink(marrow(sc)));
        sc.log(`${win ? 'junction' : 'symlink'} .marrow -> <home>/moved (${how})`);
        // The control-state check also refuses a linked .marrow and runs first: either deny text is the unsafe-state denial.
        sc.call('git status', DENY_UNSAFE_STATE);
      },
    },
    {
      id: 'W-N4', os: 'win32', hosts: BOTH, run(sc) {
        sc.prime();
        const junction = path.join(sc.hostBase, `${path.basename(sc.home)}-j`);
        const how = sc.t.link('junction', junction, sc.home);
        sc.cleanups.push(() => removeLink(junction));
        sc.log(`USERPROFILE and HOME reached through a junction to the temp home (${how})`);
        sc.envOver = { USERPROFILE: junction, HOME: junction };
        sc.call('git status', DENY_UNSAFE);
      },
    },
    {
      id: 'W-N5', os: 'both', hosts: BOTH, run(sc) {
        sc.prime();
        if (!fs.existsSync(stateFile(sc))) throw new Error('state.json was not created by the healthy control call');
        const real = path.join(guardDir(sc), 'state.real');
        fs.renameSync(stateFile(sc), real);
        const how = sc.t.link('symlink-file', stateFile(sc), real);
        sc.log(`state.json is a symlink to a healthy private copy (${how})`);
        sc.call('git status', DENY_UNSAFE, { id: 'W-N5a' });
        removeLink(stateFile(sc));
        fs.renameSync(real, stateFile(sc));
        if (!win) return undefined; // POSIX control column: symlink only
        const hl = path.join(guardDir(sc), 'state.hl');
        sc.t.link('hard', hl, stateFile(sc));
        sc.cleanups.push(() => removeLink(hl));
        sc.log('state.json now has a second hard link (nlink 2)');
        return sc.call('git status', DENY_UNSAFE, { id: 'W-N5b' });
      },
    },
    {
      id: 'W-N6', os: 'win32', hosts: BOTH, run(sc) {
        const f = ctx.forms(sc.home);
        if (!f) throw new Error('home is not a drive path; cannot derive the UNC spelling');
        sc.envOver = { USERPROFILE: f.unc };
        sc.log(`USERPROFILE is the UNC spelling ${f.unc.split(sc.home).join('<home>')}`);
        sc.call('git status', DENY_UNSAFE);
      },
    },
    {
      id: 'W-N7', os: 'win32', hosts: BOTH, run(sc) {
        const f = ctx.forms(sc.home);
        if (!f) throw new Error('home is not a drive path; cannot derive the device spelling');
        sc.envOver = { USERPROFILE: f.device };
        sc.log('USERPROFILE is the \\\\?\\ device spelling of the temp home');
        sc.call('git status', DENY_UNSAFE);
      },
    },
    {
      id: 'W-N8', os: 'win32', hosts: BOTH, run(sc) {
        const f = ctx.forms(sc.home);
        if (!f) throw new Error('home is not a drive path; cannot derive the drive-relative spelling');
        sc.envOver = { USERPROFILE: f.driveRelative };
        sc.log('USERPROFILE is the drive-relative spelling (C:Users\\...)');
        sc.call('git status', DENY_UNSAFE);
      },
    },
    {
      id: 'W-N9', os: 'win32', hosts: BOTH, run(sc) {
        const fakes = path.join(sc.hostBase, `fakebin-${crypto.randomBytes(3).toString('hex')}`);
        fs.mkdirSync(fakes, { recursive: true });
        sc.cleanups.push(() => safeRemove(ctx, fakes));
        const decoy = sysExe(ctx, 'find.exe');
        for (const name of ['powershell.exe', 'pwsh.exe', 'icacls.exe', 'whoami.exe']) fs.copyFileSync(decoy, path.join(fakes, name));
        const orig = process.env.Path || process.env.PATH || '';
        sc.envOver = { Path: `${fakes};${orig}` };
        sc.spawnCwd = fakes; // the fakes are also in the hook's cwd
        sc.log('fake powershell.exe, pwsh.exe, icacls.exe, whoami.exe (copies of find.exe) first in PATH and in the cwd');
        sc.call('git status', ALLOW);
      },
    },
    {
      id: 'W-N10', os: 'win32', hosts: BOTH, run(sc) {
        const fake = path.join(sc.hostBase, `fakeroot-${crypto.randomBytes(3).toString('hex')}`);
        const ps = path.join(fake, 'System32', 'WindowsPowerShell', 'v1.0');
        fs.mkdirSync(ps, { recursive: true });
        sc.cleanups.push(() => safeRemove(ctx, fake));
        const decoy = sysExe(ctx, 'find.exe');
        fs.copyFileSync(decoy, path.join(ps, 'powershell.exe'));
        fs.copyFileSync(decoy, path.join(fake, 'System32', 'whoami.exe'));
        sc.envOver = { SystemRoot: fake };
        sc.log('SystemRoot points at a temp tree holding fake powershell.exe/whoami.exe; windir is unchanged');
        sc.call('git status', DENY_UNSAFE);
      },
    },
    {
      id: 'W-N11', os: 'both', hosts: BOTH, run(sc) {
        if (win) {
          sc.t.icacls(sc.home, '/grant', '*S-1-5-32-545:(OI)(CI)M');
          sc.log(`icacls <home> /grant *S-1-5-32-545:(OI)(CI)M (inheritable) before .marrow exists => ${sc.t.aclText(sc.home)}`);
        } else {
          sc.prime();
          fs.chmodSync(marrow(sc), 0o757);
          sc.log('chmod 0757 .marrow');
        }
        sc.call('git status', DENY_UNSAFE);
      },
    },
    {
      id: 'W-N12', os: 'win32', hosts: BOTH, run(sc) {
        sc.prime();
        sc.t.createUser('marrowsmoke');
        sc.cleanups.push(() => { try { sc.t.deleteUser('marrowsmoke'); } catch { /* best effort */ } });
        sc.t.icacls(marrow(sc), '/setowner', 'marrowsmoke');
        sc.log(`icacls .marrow /setowner marrowsmoke => ${sc.t.aclText(marrow(sc))}`);
        sc.call('git status', DENY_UNSAFE);
      },
    },
    {
      id: 'W-N13', os: 'both', hosts: BOTH, run(sc) {
        sc.prime();
        const body = { version: 1, enabled: false, changed_by: 'owner_cli', changed_at: new Date().toISOString(), change_id: `ctl_${crypto.randomBytes(16).toString('hex')}` };
        fs.writeFileSync(path.join(marrow(sc), 'control.json'), `${JSON.stringify(body)}\n`, { mode: 0o600 });
        sc.log('control.json with a valid enabled:false shape written to .marrow');
        // Windows: control unsafe, never a bypass. POSIX: unchanged from 3.9.105 (a valid private file IS the owner bypass); measured only.
        sc.call('git push --force origin main', win ? DENY_ANY : INFO);
      },
    },
    {
      id: 'W-N14', os: 'win32', hosts: BOTH, run(sc) {
        sc.call('rm -rf ./x', denyStop(/^S5\./), { eventCwd: '/tmp/ws' });
      },
    },
    {
      id: 'W-N15', os: 'both', hosts: BOTH, run(sc) {
        sc.call('cmd /c git push --force origin main', denyStop(/^S1\./));
        if (ctx.hasPwsh) sc.call(pwshCmd, denyStop(/^S1\./), { id: 'W-N15b' });
        else ctx.addRow({ host: sc.host.name, id: 'W-N15b', command: pwshCmd, run: 0, r: null, ms: 0, cls: null, expected: 'skip', result: 'SKIP', lat: false, setup: [], note: 'pwsh is not on this runner' });
      },
    },
    { id: 'W-N16', os: 'both', hosts: BOTH, run(sc) { sc.call('cmd /c "vercel deploy --prod"', DENY_ANY); } },
    // ---- stage-1 rulings (RULINGS-STAGE1.md, AUDIT-STAGE1.md RC-7). Hook evaluation only: nothing below is ever executed
    // except the shim probe, which runs two harness-made .cmd files that only write a marker and print an allow.
    {
      id: 'W-N17', os: 'win32', hosts: BOTH, needs: 'J3', run(sc) {
        sc.prime();
        const dir = path.join(sc.hostBase, `shimcwd-${crypto.randomBytes(3).toString('hex')}`);
        fs.mkdirSync(dir, { recursive: true });
        sc.cleanups.push(() => safeRemove(ctx, dir));
        const allow = sc.host.name === 'cursor' ? '{"permission":"allow"}' : '{}';
        for (const n of ['node', 'npx']) fs.writeFileSync(path.join(dir, `${n}.cmd`), `@echo off\r\necho ran> "%~dp0${n}.ran"\r\necho ${allow}\r\n`);
        const entry = sc.host.candidateEntry;
        const forms = [
          ['a', 'plugin hooks.json line', sc.host.entry(sc.hostInfo.hooksJson).split('${' + sc.host.rootVar + '}').join(sc.root)],
          ['b', 'installer win32 form', `node -e "process.stdout.write('REAL_NODE_RAN')" -- --package=@getmarrow/mcp@0.0.0 marrow-mcp ${entry}`],
          ['c', 'canonical npx form', `npx -y --package=@getmarrow/mcp@0.0.0 marrow-mcp ${entry}`],
        ];
        for (const [k, name, form] of forms) {
          sc.n += 1;
          const payload = sc.host.payload('git status', sc.work, sc.n);
          const env = sc.env();
          setEnvCI(env, 'npm_config_offline', 'true'); // a real npx must not touch the network for the made-up version
          const t0 = Date.now();
          const r = ctx.spawn(form, { shell: true, input: JSON.stringify(payload), cwd: dir, env, encoding: 'utf8', timeout: CANDIDATE_TIMEOUT_MS });
          const ms = Date.now() - t0;
          const ran = { node: fs.existsSync(path.join(dir, 'node.ran')), npx: fs.existsSync(path.join(dir, 'npx.ran')) };
          for (const n of ['node', 'npx']) { try { fs.unlinkSync(path.join(dir, `${n}.ran`)); } catch { /* not run */ } }
          ctx.addRow({
            host: sc.host.name, id: `W-N17${k}`, command: `[${name}] ${form}`.slice(0, 200), run: 1, r, ms, cls: classify(sc.host.name, r), expected: 'info', result: 'INFO', lat: false, setup: sc.setup.slice(),
            note: `evidence for RC-1d: shim ran node.cmd=${ran.node} npx.cmd=${ran.npx}`, needs: '', extra: { shim_node_ran: ran.node, shim_npx_ran: ran.npx },
          });
        }
        const stop = denyStop(/^S0\./);
        sc.write('Write', path.join(dir, 'node.cmd'), stop, { id: 'W-N17d', text: '@echo off' });
        sc.write('Write', path.join(dir, 'npx.cmd'), stop, { id: 'W-N17e', text: '@echo off' });
        if (sc.host.name === 'claude-code') sc.write('Edit', path.join(dir, 'node.cmd'), stop, { id: 'W-N17f', old: 'echo ran', text: 'echo pwned' });
      },
    },
    {
      id: 'W-N18', os: 'win32', hosts: BOTH, needs: 'J3', run(sc) {
        sc.prime();
        const claude = path.join(sc.home, '.claude', 'settings.json');
        const cursor = path.join(sc.home, '.cursor', 'hooks.json');
        const hookCmd = 'npx -y --package=@getmarrow/mcp@0.0.0 marrow-mcp claude-pre-action-hook';
        fs.mkdirSync(path.dirname(claude), { recursive: true });
        fs.mkdirSync(path.dirname(cursor), { recursive: true });
        fs.writeFileSync(claude, JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: hookCmd }] }] } }));
        fs.writeFileSync(cursor, JSON.stringify({ version: 1, hooks: { beforeShellExecution: [{ command: hookCmd.replace('claude-', 'cursor-') }] } }));
        const tool = sc.host.name === 'claude-code' ? 'Edit' : 'Write';
        const stop = denyStop(/^S0\./);
        sc.write(tool, claude, stop, { id: 'W-N18a', old: hookCmd, text: '' });
        sc.write(tool, cursor, stop, { id: 'W-N18b', old: hookCmd.replace('claude-', 'cursor-'), text: '{"version":1,"hooks":{}}' });
      },
    },
    {
      id: 'W-N19', os: 'win32', hosts: BOTH, needs: 'J3', run(sc) {
        sc.prime();
        const stop = denyStop(/^S0\./);
        sc.call('setx NODE_OPTIONS --require=x', stop, { id: 'W-N19a' });
        sc.call('reg add HKCU\\Environment /v MARROW_SMOKE_X /d x /f', stop, { id: 'W-N19b' });
      },
    },
    {
      id: 'W-N20', os: 'win32', hosts: BOTH, needs: 'J3', run(sc) {
        sc.prime();
        const aws = path.join(sc.home, '.aws');
        fs.mkdirSync(aws, { recursive: true });
        fs.writeFileSync(path.join(aws, 'credentials'), `[default]\nsmoke_placeholder = ${crypto.randomBytes(8).toString('hex')}\n`); // dummy, made at runtime
        sc.call(`type ${path.join(aws, 'credentials')}`, denyStop(/^S4\./));
      },
    },
    {
      id: 'W-N21', os: 'win32', hosts: BOTH, needs: 'J3', run(sc) {
        sc.prime();
        sc.call('gci env:', denyStop(/^S4\./), { id: 'W-N21a' });
        sc.call('set', denyStop(/^S4\./), { id: 'W-N21b' });
      },
    },
    {
      id: 'W-N22', os: 'win32', hosts: BOTH, needs: 'J2', run(sc) {
        sc.prime();
        const target = path.join(sc.hostBase, `robotmp-${crypto.randomBytes(3).toString('hex')}`);
        const empty = path.join(sc.hostBase, `robosrc-${crypto.randomBytes(3).toString('hex')}`);
        fs.mkdirSync(target, { recursive: true });
        fs.mkdirSync(empty, { recursive: true });
        fs.writeFileSync(path.join(target, 'f.txt'), 'x');
        sc.cleanups.push(() => { safeRemove(ctx, target); safeRemove(ctx, empty); });
        sc.call(`robocopy ${empty} ${target} /MIR`, denyStop(/^S5\./));
        sc.assertExists(path.join(target, 'f.txt'), 'robocopy target still has its file');
        sc.assertExists(target, 'robocopy target dir still exists');
      },
    },
    {
      id: 'W-P8', os: 'both', hosts: BOTH, run(sc) {
        // RC-3: 4 hook processes started at once, twice. The first round races on a home with no .marrow yet. All must allow.
        const cmds = [{ cmd: 'git status' }, { cmd: 'ls' }, { cmd: 'Read README.md', tool: true }, { cmd: 'npm test' }];
        for (const round of [1, 2]) {
          const env = sc.env();
          const jobs = cmds.map((c) => {
            sc.n += 1;
            const payload = c.tool ? sc.host.readPayload(sc.work, sc.n) : sc.host.payload(c.cmd, sc.work, sc.n);
            return { file: process.execPath, args: [ctx.candidate.cli, sc.host.candidateEntry], cwd: sc.work, env, input: JSON.stringify(payload), timeout: CANDIDATE_TIMEOUT_MS };
          });
          const results = ctx.parallel(jobs);
          results.forEach((r, k) => {
            const cls = classify(sc.host.name, r);
            ctx.addRow({ host: sc.host.name, id: 'W-P8', command: cmds[k].cmd, run: round, r, ms: r.ms || 0, cls, expected: 'allow', result: judge(ALLOW, cls), lat: false, setup: [], note: `round ${round}, 4 hook processes started at once`, needs: '' });
          });
        }
        sc.assertExists(guardDir(sc), '.marrow/session-loop-guard created');
      },
    },
  ];
}

// Runs every row for one host. A setup failure is a FAIL row with a short message, never a crash.
function runRows(ctx, host, hostInfo) {
  for (const def of buildRows(ctx)) {
    if (!def.hosts.includes(host.name)) continue;
    if (def.candidateOnly && !ctx.candidate) continue;
    if (def.os === 'win32' && ctx.platform !== 'win32') {
      ctx.addRow({ host: host.name, id: def.id, command: '(row)', run: 0, r: null, ms: 0, cls: null, expected: 'skip', result: 'SKIP', lat: false, setup: [], note: 'windows-only row (no POSIX control column)' });
      continue;
    }
    let sc = null;
    try {
      sc = newScenario(ctx, host, hostInfo, def);
      def.run(sc);
      if (sc.skipped) ctx.addRow({ host: host.name, id: def.id, command: '(row)', run: 0, r: null, ms: 0, cls: null, expected: 'skip', result: 'SKIP', lat: false, setup: sc.setup.slice(), note: sc.skipped });
    } catch (e) {
      ctx.addRow({ host: host.name, id: def.id, command: '(setup)', run: 0, r: null, ms: 0, cls: null, expected: '-', result: 'FAIL', lat: false, setup: sc ? sc.setup.slice() : [], note: `setup: ${ctx.sanitize(e && e.message)}` });
    } finally {
      if (sc) {
        for (const fn of sc.cleanups.reverse()) { try { fn(); } catch { /* teardown is best effort */ } }
        safeRemove(ctx, sc.home);
      }
    }
  }
}

// ---- candidate install ------------------------------------------------------------------------------

function npmCommand(ctx) {
  const bin = path.dirname(process.execPath);
  const posix = ctx.platform !== 'win32';
  const candidates = posix
    ? [path.join(bin, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'), '/usr/share/nodejs/npm/bin/npm-cli.js']
    : [path.join(bin, 'node_modules', 'npm', 'bin', 'npm-cli.js')];
  for (const cli of candidates) {
    try { if (fs.statSync(cli).isFile()) return { file: process.execPath, prefix: [cli] }; } catch { /* next */ }
  }
  return posix ? { file: 'npm', prefix: [] } : null;
}

// Installs the tarball twice (cold npm cache, then warm) and returns the second prefix for the rows.
function installCandidate(ctx, tgz) {
  const abs = path.resolve(tgz); // npm treats a bare relative name as a git shorthand, so it must be absolute
  if (!fs.statSync(abs).isFile()) throw new Error('candidate tarball is not a file');
  const npm = npmCommand(ctx);
  if (!npm) throw new Error('npm-cli.js was not found next to this node');
  const npmHome = path.join(ctx.baseTmp, 'npm-home');
  fs.mkdirSync(npmHome, { recursive: true });
  const env = cleanEnv(npmHome, {
    npm_config_cache: path.join(ctx.baseTmp, 'npm-cache'), npm_config_update_notifier: 'false', npm_config_fund: 'false',
    npm_config_userconfig: path.join(npmHome, 'userrc'), npm_config_globalconfig: path.join(npmHome, 'globalrc'),
  });
  const timings = [];
  let prefix = null;
  for (const label of ['cold_cache_ms', 'warm_cache_ms']) {
    prefix = path.join(ctx.baseTmp, `prefix-${label.split('_')[0]}`);
    const t0 = Date.now();
    const r = ctx.run(npm.file, [...npm.prefix, 'install', '--prefix', prefix, '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error', abs],
      { env, encoding: 'utf8', timeout: 180000, windowsHide: true });
    timings.push(Date.now() - t0);
    if (r.status !== 0) throw new Error(ctx.sanitize(`npm install of the candidate failed (exit ${r.status}${r.error ? ` ${r.error.code}` : ''}): ${r.stderr || ''}`));
  }
  const pkgDir = path.join(prefix, 'node_modules', '@getmarrow', 'mcp');
  const cli = path.join(pkgDir, 'dist', 'cli.js');
  if (!fs.statSync(cli).isFile()) throw new Error('installed candidate has no dist/cli.js');
  const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
  const sha = crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
  return { cli, version: String(pkg.version), tgz_name: path.basename(abs), tgz_sha256: sha, tgz_bytes: fs.statSync(abs).size, cold_cache_ms: timings[0], warm_cache_ms: timings[1] };
}

// ---- PowerShell ACL proof spawn timing (Windows, candidate mode, before any hook row) ---------------------

const PROOF_COLD_WARN_MS = 4000;
const PROOF_TIMEOUT_MS = 10000;
const PROOF_WARM_CALLS = 10;
const LOAD_PROOF_CONSTANTS = 'const m=require(process.argv[1]);process.stdout.write(JSON.stringify({e:m.WIN_ACL_ENCODED,s:m.WIN_ACL_SCRIPT,t:m.WIN_PROOF_TIMEOUT_MS}))';

// The output the proof script must print: BEGIN <nonce>, SID <sid>, ACL <i> <value> for i = 1..n, END <nonce>.
// Only shape, counts and lengths come back; the ACL values themselves are never kept.
function checkProofShape(stdout, nonce, n) {
  const lines = String(stdout || '').split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const lens = [];
  let ok = lines.length === n + 3;
  if (ok) {
    ok = lines[0] === `BEGIN ${nonce}` && /^SID S-1-\d{1,3}(-\d{1,10}){1,14}$/.test(lines[1]) && lines[n + 2] === `END ${nonce}`;
    for (let i = 1; i <= n && ok; i += 1) {
      const m = new RegExp(`^ACL ${i} (\\S+)$`).exec(lines[i + 1]);
      if (m) lens.push(m[1].length); else ok = false;
    }
  }
  return { ok, lines: lines.length, acl_value_lengths: ok ? lens : [] };
}

// Times the exact spawn the product makes for its ACL proof, using the installed candidate's own constants.
function measureProofSpawn(ctx) {
  if (ctx.platform !== 'win32') return { available: false, reason: 'not win32' };
  const mod = path.join(path.dirname(path.dirname(ctx.candidate.cli)), 'dist', 'win-private-state.js');
  if (!fs.existsSync(mod)) return { available: false, reason: 'dist/win-private-state.js is not in this candidate' };
  const load = ctx.run(process.execPath, ['-e', LOAD_PROOF_CONSTANTS, mod], { env: baseEnv(), encoding: 'utf8', timeout: 20000, windowsHide: true });
  let c = null;
  try { c = JSON.parse(load.stdout); } catch { /* reported below */ }
  if (load.status !== 0 || !c || typeof c.e !== 'string' || !c.e) return { available: false, reason: 'the candidate does not export WIN_ACL_ENCODED' };
  const sr = ctx.systemRoot;
  const exe = `${sr}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
  const dir = path.join(ctx.baseTmp, 'proofdir');
  const a = path.join(dir, 'a');
  const b = path.join(dir, 'b');
  const tmp = path.join(dir, 'tmp');
  for (const d of [a, b, tmp]) fs.mkdirSync(d, { recursive: true });
  const canon = (p2) => { try { return fs.realpathSync.native(p2); } catch { return p2; } };
  const calls = [];
  for (let i = 0; i < 1 + PROOF_WARM_CALLS; i += 1) {
    const nonce = crypto.randomBytes(16).toString('hex');
    // The product's stripped env and nothing else.
    const env = {
      SystemRoot: sr, windir: process.env.windir || sr, PSModulePath: `${sr}\\System32\\WindowsPowerShell\\v1.0\\Modules`,
      TEMP: canon(tmp), TMP: canon(tmp), MARROW_WINACL_NONCE: nonce, MARROW_WINACL_N: '2', MARROW_WINACL_P1: canon(a), MARROW_WINACL_P2: canon(b),
    };
    const t0 = process.hrtime.bigint();
    const r = ctx.run(exe, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', c.e], {
      env, cwd: `${sr}\\System32`, stdio: ['ignore', 'pipe', 'pipe'], timeout: PROOF_TIMEOUT_MS, encoding: 'utf8', windowsHide: true, shell: false, maxBuffer: 1024 * 1024,
    });
    const ms = Math.round(Number(process.hrtime.bigint() - t0) / 1e6);
    const shape = checkProofShape(r.stdout, nonce, 2);
    calls.push({ ms, status: r.status === null ? `signal:${r.signal || (r.error && r.error.code) || 'timeout'}` : r.status, shape_ok: shape.ok, lines: shape.lines, acl_value_lengths: shape.acl_value_lengths, stderr_len: String(r.stderr || '').length });
  }
  const warm = calls.slice(1);
  const warmMs = warm.map((x) => x.ms);
  return {
    available: true, timeout_ms_used: PROOF_TIMEOUT_MS, product_timeout_ms: Number.isFinite(c.t) ? c.t : null, encoded_length: c.e.length, script_length: typeof c.s === 'string' ? c.s.length : null,
    cold_ms: calls[0].ms, cold_over_4000: calls[0].ms > PROOF_COLD_WARN_MS, cold: calls[0], warm: stat(warmMs), warm_ms: warmMs,
    warm_all_exit0: warm.every((x) => x.status === 0), warm_all_shape_ok: warm.every((x) => x.shape_ok), calls,
  };
}

// ---- reporting --------------------------------------------------------------------------------------
// Public output: the step summary, stdout and the artifact carry only a row id, PASS|FAIL|SKIP, a tag and closed-vocabulary classes
// (decision word, text class, rule id, got). Never a command, a path, a deny text, a stderr line or an env value.

const TAG_OLD_MCP = 'expected-on-old-MCP';

// A FAIL is tagged only for a published-package run, and only for an MCP-lane row: on Windows any of them (the loop guard, ACL and RC-1
// rows the Windows-lane MCP exists to fix), on other systems only the rows marked needs (they wait on a lane item). Plugin-lane rows are never tagged.
function tagOf(source, platform, row) {
  if (row.result !== 'FAIL' || source !== 'published' || row.lane !== 'mcp') return '';
  return platform === 'win32' || row.needs ? TAG_OLD_MCP : ''; // a row that waits on another lane item (J2, J3) is expected to fail on any OS
}

// One public row per (host, id): FAIL beats PASS beats SKIP; INFO rows are measurements and are not public rows.
function publicRows(rows, source, platform) {
  const map = new Map();
  for (const r of rows) {
    if (r.result === 'INFO') continue;
    const key = `${r.host}/${r.id}`;
    let p = map.get(key);
    if (!p) { p = { id: r.host === '-' ? r.id : key, host: r.host, lane: r.lane || 'mcp', result: r.result, untagged: false, decisions: new Set(), text: new Set(), rules: new Set(), got: new Set(), ms: 0 }; map.set(key, p); }
    if (r.result === 'FAIL') { p.result = 'FAIL'; p.untagged = p.untagged || !tagOf(source, platform, r); }
    else if (r.result === 'PASS' && p.result === 'SKIP') p.result = 'PASS';
    if (r.decision && r.decision !== '-') p.decisions.add(r.decision);
    if (r.text_class && r.text_class !== '-' && r.text_class !== 'none') p.text.add(r.text_class);
    if (r.rule) p.rules.add(r.rule);
    if (r.got) p.got.add(r.got);
    if (Number.isFinite(r.ms)) p.ms = Math.max(p.ms, r.ms);
  }
  return [...map.values()].map((p) => ({
    id: p.id, host: p.host, lane: p.lane, result: p.result, tag: p.result === 'FAIL' && !p.untagged ? TAG_OLD_MCP : '',
    decisions: [...p.decisions].sort(), text: [...p.text].sort(), rules: [...p.rules].sort(), got: [...p.got].sort(), ms: p.ms,
  }));
}

function summarize(pub) {
  const count = (f) => pub.filter(f).length;
  return {
    pass: count((r) => r.result === 'PASS'), fail: count((r) => r.result === 'FAIL'), skip: count((r) => r.result === 'SKIP'),
    fail_tagged: count((r) => r.result === 'FAIL' && r.tag), fail_untagged: count((r) => r.result === 'FAIL' && !r.tag),
  };
}

function printPublic(out) {
  console.log(`### win26 hook smoke: ${out.os}, node ${out.node}, source ${out.source}\n`);
  console.log('| id | result | tag |\n|---|---|---|');
  for (const r of out.rows) console.log(`| ${r.id} | ${r.result} | ${r.tag} |`);
  const g = out.gates;
  console.log(`\nL-2 (Windows warm p95 <= ${g.L2.limit_ms} ms per hook call): ${g.L2.status}`);
  const m = out.summary;
  console.log(`\nPASS ${m.pass}; FAIL ${m.fail} (${TAG_OLD_MCP} ${m.fail_tagged}, other ${m.fail_untagged}); SKIP ${m.skip}`);
  console.log(m.fail_untagged ? 'JOB RESULT: FAIL' : 'JOB RESULT: PASS');
}

// Rank of the loosest decision a row produced: deny 3, ask 2, allow 1, anything else 0 (no decision).
const STRICT = { deny: 3, block: 3, ask: 2, allow: 1 };
const loosest = (r) => (r.decisions && r.decisions.length ? Math.min(...r.decisions.map((d) => STRICT[d] || 0)) : null);
function compareRows(base, other) {
  const byId = new Map(base.rows.map((r) => [r.id, r]));
  const looser = [];
  for (const r of other.rows) {
    const b = byId.get(r.id);
    if (!b || r.result === 'SKIP' || b.result === 'SKIP') continue;
    const x = loosest(r);
    const y = loosest(b);
    if (x !== null && y !== null && x < y) looser.push(r.id);
  }
  return looser;
}

// ---- main -------------------------------------------------------------------------------------------

function parseArgs(argv) {
  const o = { out: null, candidate: null, candidateMissing: false, published: false, compare: null, checkCiCommit: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--published') o.published = true;
    else if (a === '--check-ci-commit') o.checkCiCommit = true;
    else if (a === '--compare') { o.compare = argv.slice(i + 1, i + 3); i += 2; } else if (a === '--candidate') { if (i + 1 < argv.length) { o.candidate = argv[i + 1]; i += 1; } else o.candidateMissing = true; } else if (a.startsWith('--candidate=')) o.candidate = a.slice('--candidate='.length);
    else if (!o.out) o.out = a;
  }
  if (o.candidate === '') o.candidateMissing = true;
  return o;
}

// Started with `node -e`: reads the job list on stdin, starts every job at once, prints the results as JSON.
const PARALLEL_HELPER = `
const { spawn } = require('child_process');
const jobs = JSON.parse(require('fs').readFileSync(0, 'utf8'));
const out = new Array(jobs.length);
let left = jobs.length;
const done = (i, value) => { if (out[i]) return; out[i] = value; left -= 1; if (left === 0) process.stdout.write(JSON.stringify(out)); };
jobs.forEach((j, i) => {
  const t0 = Date.now();
  let o = '';
  let e = '';
  let child;
  try { child = spawn(j.file, j.args, { cwd: j.cwd, env: j.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); } catch (err) { done(i, { status: null, signal: null, error: { code: err.code || 'SPAWN' }, stdout: '', stderr: '', ms: 0 }); return; }
  child.stdout.on('data', (d) => { o += d; });
  child.stderr.on('data', (d) => { e += d; });
  const timer = setTimeout(() => { child.kill(); }, j.timeout);
  child.on('error', (err) => { clearTimeout(timer); done(i, { status: null, signal: null, error: { code: err.code || 'ERROR' }, stdout: o, stderr: e, ms: Date.now() - t0 }); });
  child.on('close', (code, signal) => { clearTimeout(timer); done(i, { status: code, signal, stdout: o, stderr: e, ms: Date.now() - t0 }); });
  child.stdin.on('error', () => {});
  child.stdin.end(j.input);
});
`;

function makeCtx(args, over = {}) {
  const platform = over.platform || process.platform;
  const ctx = {
    platform, args, rows: [], pairs: [], modes: [], secrets: [], selftestMs: {}, firstCall: {}, candidate: null, install: null, hasPwsh: false, proofSpawn: null,
    systemRoot: process.env.SystemRoot || process.env.windir || 'C:\\Windows',
    osName: `${platform}-${os.arch()}`,
    run: over.run || ((file, a, opts) => childProcess.spawnSync(file, a, opts)),
    spawn: over.spawn || ((file, a, opts) => childProcess.spawnSync(file, a, opts)),
    baseTmp: null, deadline: 0,
  };
  ctx.forms = winForms;
  ctx.sanitize = makeSanitizer(ctx);
  ctx.tools = makeTools(ctx);
  ctx.addRow = (f) => {
    const c = f.cls;
    ctx.rows.push({
      os: ctx.osName, host: f.host, id: f.id, phase: f.phase || 'pre', command: f.command, run: f.run,
      exit: !f.r ? '-' : f.r.status === null ? `signal:${f.r.signal || (f.r.error && f.r.error.code) || 'timeout'}` : f.r.status,
      decision: c ? c.d : '-', seatbelt: c ? c.seatbelt : false, stdout: c ? c.j : null, deny_message: c ? c.msg : '',
      text_class: c ? c.text : '-', rule: c ? c.rule : '', stderr300: f.r ? ctx.sanitize(String(f.r.stderr || '').slice(0, 300)) : '',
      ms: f.ms, expected: f.expected, result: f.result, lat: !!f.lat, needs: f.needs || '', setup: f.setup || [], note: f.note || '', lane: f.lane || 'mcp', got: f.got || '', ...(f.extra || {}),
    });
  };
  const overBudget = () => !!ctx.deadline && Date.now() > ctx.deadline;
  const deadlineResult = () => ({ status: null, signal: null, error: { code: 'HARNESS_DEADLINE' }, stdout: '', stderr: 'harness time budget used up; hook call not made' });
  // One hook call: the launcher command string (launcher mode) or the candidate cli.js entry. phase: pre | post.
  ctx.invoke = (host, hostInfo, payload, env, cwd, phase = 'pre') => {
    const input = JSON.stringify(payload);
    const t0 = Date.now();
    let r;
    if (overBudget()) return { r: deadlineResult(), ms: 0 };
    if (ctx.candidate) {
      r = ctx.spawn(process.execPath, [ctx.candidate.cli, phase === 'post' ? host.candidatePostEntry : host.candidateEntry], { input, cwd, env, encoding: 'utf8', timeout: CANDIDATE_TIMEOUT_MS, windowsHide: true });
    } else {
      const read = payload.tool_name === 'Read';
      const template = phase === 'post' ? (read ? host.postReadEntry : host.postEntry)(hostInfo.hooksJson) : (read ? host.readEntry : host.entry)(hostInfo.hooksJson);
      const command = template.split('${' + host.rootVar + '}').join(hostInfo.root);
      r = ctx.spawn(command, { shell: true, input, cwd, env, encoding: 'utf8', timeout: LAUNCHER_TIMEOUT_MS });
    }
    const ms = Date.now() - t0;
    if (phase === 'pre' && ctx.firstCall[host.name] === undefined) ctx.firstCall[host.name] = ms;
    return { r, ms };
  };
  ctx.invokeSelfTest = (host, root, env, cwd) => (overBudget() ? deadlineResult() : ctx.spawn(process.execPath, [ctx.candidate.cli, 'loop-guard-self-test'], { cwd, env, encoding: 'utf8', timeout: CANDIDATE_TIMEOUT_MS, windowsHide: true }));
  // Several hook processes started at once (W-P8). A tiny node helper starts them together and reports each one's
  // own wall time; jobs: [{ file, args, cwd, env, input, timeout }] -> [{ status, signal, error, stdout, stderr, ms }].
  ctx.parallel = (jobs) => {
    if (overBudget()) return jobs.map(deadlineResult);
    const r = ctx.spawn(process.execPath, ['-e', PARALLEL_HELPER], { input: JSON.stringify(jobs), env: baseEnv(), encoding: 'utf8', timeout: CANDIDATE_TIMEOUT_MS * 2, windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
    let out = null;
    try { out = JSON.parse(r.stdout); } catch { /* handled below */ }
    if (!Array.isArray(out) || out.length !== jobs.length) return jobs.map(() => ({ status: null, signal: null, error: { code: 'PARALLEL_HELPER_FAILED' }, stdout: '', stderr: '' }));
    return out;
  };
  return ctx;
}

function aclEvidence(ctx, p) {
  if (ctx.platform !== 'win32') return '';
  return ctx.tools.aclText(p);
}

function runMatrix(ctx, host, hostInfo) {
  const { hostBase, work, hooksJson, root } = hostInfo;
  const home = path.join(hostBase, 'home');
  fs.mkdirSync(home, { mode: 0o700 });
  try { fs.chmodSync(home, 0o700); } catch { /* windows */ }
  const env = cleanEnv(home, { [host.rootVar]: root, ...host.extraEnv(home) });
  let i = 0;
  const cases = [...CMDS, READ_CASE];
  if (ctx.platform === 'win32') {
    // Throwaway folder created here; never a real path.
    const victim = path.join(hostBase, 'x');
    fs.mkdirSync(victim, { recursive: true });
    fs.writeFileSync(path.join(victim, 'f.txt'), 'x');
    cases.push({ cmd: `Remove-Item -Recurse -Force ${victim}`, expect: 'info' });
    cases.push({ cmd: `powershell -NoProfile -Command "Remove-Item -Recurse -Force '${victim}'"`, expect: 'info' });
    cases.push({ cmd: `Get-ChildItem ${work}`, expect: 'allow' });
  }
  const modeOf = (p) => { try { return (fs.statSync(p).mode & 0o7777).toString(8); } catch (e) { return 'missing'; } };
  let ci = 0;
  for (const c of cases) {
    ci += 1;
    for (const run of [1, 2]) {
      i += 1;
      const payload = c.tool ? host.readPayload(work, i) : host.payload(c.cmd, work, i);
      const postPayload = c.tool ? host.postReadPayload(work, i) : host.postPayload(c.cmd, work, i);
      const exp = c.expect === 'info' ? INFO : c.expect === 'deny' ? { decision: 'deny', text: 'seatbelt' } : ALLOW;
      hookCall(ctx, host, hostInfo, { id: `SM-${ci}`, label: c.cmd, exp, run, payload, postPayload, env, cwd: work, lat: true });
    }
  }
  const m = path.join(home, '.marrow');
  ctx.modes.push({
    host: host.name, os: ctx.osName, marrow_dir: modeOf(m), loop_guard: modeOf(path.join(m, 'session-loop-guard')), home: modeOf(home),
    listing: (() => { try { return fs.readdirSync(m); } catch (e) { return []; } })(),
    acl: aclEvidence(ctx, m),
  });
}

function main(argv, over) {
  const args = parseArgs(argv);
  const ctx = makeCtx(args, over);
  const OUT = path.resolve(args.out || `hook-smoke-${ctx.platform}.json`);
  const mode = args.candidate || args.candidateMissing ? 'candidate' : 'launcher';
  ctx.source = args.published ? 'published' : 'candidate';
  let cursorRows = null;
  try { cursorRows = require('./hook-smoke-cursor.cjs'); } catch (e) {
    ctx.addRow({ host: '-', id: 'CUR-LOAD', command: '(module)', run: 0, r: null, ms: 0, cls: null, expected: 'loaded', result: 'FAIL', lat: false, setup: [], note: ctx.sanitize(e && e.message), lane: 'plugin' });
  }
  try {
    ctx.baseTmp = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'hooksmoke-'));
    if (mode === 'candidate') ctx.deadline = Date.now() + (over && over.budgetMs ? over.budgetMs : CANDIDATE_BUDGET_MS);
    if (mode === 'candidate') {
      try {
        if (args.candidateMissing) throw new Error('--candidate needs a path to the npm pack tarball');
        ctx.install = installCandidate(ctx, args.candidate);
        ctx.candidate = ctx.install;
        if (args.published) {
          // The published tarball must be the exact package the plugin pins (same integrity string as scripts/mcp-manifest.json).
          const manifest = JSON.parse(fs.readFileSync(path.join(REPO, 'plugins', 'marrow-cursor', 'scripts', 'mcp-manifest.json'), 'utf8'));
          const integrity = `sha512-${crypto.createHash('sha512').update(fs.readFileSync(path.resolve(args.candidate))).digest('base64')}`;
          const row = (id, ok) => ctx.addRow({ host: '-', id, command: '(pack)', run: 0, r: null, ms: 0, cls: null, expected: 'equal', result: ok ? 'PASS' : 'FAIL', lat: false, setup: [], lane: 'plugin' });
          row('PACK-INTEGRITY', integrity === manifest.mcp.integrity);
          row('PACK-VERSION', ctx.install.version === manifest.mcp.version);
        }
        // First thing after the install, before any hook row and before anything else touches PowerShell: the true cold call.
        try { ctx.proofSpawn = measureProofSpawn(ctx); } catch (e) { ctx.proofSpawn = { available: false, reason: `measurement failed: ${ctx.sanitize(e && e.message)}` }; }
        ctx.hasPwsh = (() => { try { return ctx.run('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', 'exit 0'], { encoding: 'utf8', timeout: 30000, windowsHide: true, env: baseEnv() }).status === 0; } catch { return false; } })();
      } catch (e) {
        ctx.addRow({ host: '-', id: 'INSTALL', command: '(candidate install)', run: 0, r: null, ms: 0, cls: null, expected: 'installed', result: 'FAIL', lat: false, setup: [], note: ctx.sanitize(e && e.message), lane: 'plugin' });
      }
    }
    if (mode === 'launcher' || ctx.candidate) {
      for (const host of HOSTS) {
        try {
          const hostBase = fs.mkdtempSync(path.join(ctx.baseTmp, host.name + '-'));
          const work = makeRepo(hostBase);
          const root = path.join(REPO, host.dir);
          const hooksJson = JSON.parse(fs.readFileSync(path.join(root, 'hooks', 'hooks.json'), 'utf8'));
          const hostInfo = { hostBase, work, root, hooksJson };
          runMatrix(ctx, host, hostInfo);
          if (ctx.candidate) runRows(ctx, host, hostInfo);
          if (ctx.candidate && host.name === 'cursor' && cursorRows) {
            cursorRows.run(ctx, host, hostInfo, { cleanEnv, baseEnv, scrubEnv, parseJson, classify, setEnvCI, REPO });
          }
        } catch (e) {
          ctx.addRow({ host: host.name, id: 'SETUP', command: '(setup)', run: 0, r: null, ms: 0, cls: null, expected: '-', result: 'FAIL', lat: false, setup: [], note: ctx.sanitize(e && e.message), lane: 'plugin' });
        }
      }
    }
  } catch (e) {
    ctx.addRow({ host: '-', id: 'HARNESS', command: '(harness)', run: 0, r: null, ms: 0, cls: null, expected: '-', result: 'FAIL', lat: false, setup: [], note: ctx.sanitize(e && e.message), lane: 'plugin' });
  }
  if (ctx.baseTmp) { try { fs.rmSync(ctx.baseTmp, { recursive: true, force: true }); } catch { /* ignore */ } }
  const latency = latencyStats(ctx.rows, ctx.pairs);
  const gates = computeGates(ctx.platform, latency, ctx.firstCall, ctx.install);
  const rows = publicRows(ctx.rows, ctx.source, ctx.platform);
  // L-2 is a row of its own so the job result has one rule: it is the loop-guard / ACL lane's latency gate (Windows only).
  if (gates.L2.applies && gates.L2.status !== 'NO_DATA') {
    const l2 = { id: 'GATE-L2', host: '-', lane: 'mcp', result: gates.L2.status === 'FAIL' ? 'FAIL' : 'PASS', decisions: [], text: [], rules: [], got: [], ms: 0 };
    l2.tag = tagOf(ctx.source, ctx.platform, l2);
    rows.push(l2);
  }
  const out = {
    os: ctx.osName, node: process.version, mode, source: ctx.source,
    candidate: ctx.candidate ? { version: ctx.candidate.version, tgz_sha256: ctx.candidate.tgz_sha256, tgz_bytes: ctx.candidate.tgz_bytes, cold_cache_ms: ctx.candidate.cold_cache_ms, warm_cache_ms: ctx.candidate.warm_cache_ms } : null,
    pwsh: ctx.hasPwsh, rows, gates: { L2: { limit_ms: gates.L2.limit_ms, status: gates.L2.status }, L3: gates.L3 }, selftest_ms: ctx.selftestMs,
  };
  out.summary = summarize(rows);
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  printPublic(out);
  return out;
}

module.exports = {
  checkProofShape, hookCall, PARALLEL_HELPER, printPublic, publicRows, summarize, tagOf, compareRows, main, DENY_UNSAFE_STATE, CONTROL_UNSAFE_PREFIX, parseArgs, makeCtx, buildRows, runRows,
  classify, judge, textClass, ruleOf, pct, latencyStats, computeGates, winForms, setEnvCI, scrubEnv, cleanEnv, baseEnv, makeSanitizer, HOSTS, UNSAFE_TEXT, SEATBELT_HEAD, ALLOW, DENY_UNSAFE,
};

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  if (args.checkCiCommit) {
    // The commit at HEAD changes only CI files: every candidate file is exactly what the parent commit has.
    const r = childProcess.spawnSync('git', ['diff', '--name-only', 'HEAD~1', 'HEAD'], { cwd: REPO, encoding: 'utf8' });
    const files = r.status === 0 ? r.stdout.split(/\r?\n/).filter(Boolean) : null;
    const ok = !!files && files.length > 0 && files.every((f) => CI_FILES.includes(f));
    console.log(`CI-DIFF ${ok ? 'PASS' : 'FAIL'} (${files ? files.length : 'unknown'} file(s) in the last commit)`);
    process.exitCode = ok ? 0 : 1;
  } else if (args.compare) {
    const [a, b] = args.compare.map((f) => JSON.parse(fs.readFileSync(f, 'utf8')));
    const looser = compareRows(a, b);
    for (const id of looser) console.log(`LOOSER ${id}`);
    console.log(`compare: ${looser.length} row(s) looser than the base OS`);
    process.exitCode = looser.length ? 1 : 0;
  } else {
    try {
      const out = main(process.argv.slice(2));
      process.exitCode = out.summary.fail_untagged ? 1 : 0;
    } catch (e) {
      console.log('harness error');
      process.exitCode = 1;
    }
  }
}
