'use strict';
// Test-only loopback network guard, the ONE copy every maintainer test uses (tools/test-session-check.cjs, test-launcher.cjs,
// test-launcher-t2.cjs, test-launcher-lock.cjs). Nothing under plugins/ or codex/ names or loads this file.
//   * Preload:  node --require <this file> ...   (or NODE_OPTIONS=--require=<this file>; env() below builds it). A preloaded copy
//     installs itself. A test that only requires it gets the helpers and installs nothing until it calls install().
//   * Allowed, and nothing else: no host / '' (node's own localhost default), `localhost` (exact, lower case; answered locally as
//     127.0.0.1 / ::1, no DNS; LOCALHOST and `localhost.` stay refused, as on the old guard: nothing may be looser than it), a canonical
//     dotted quad in 127.0.0.0/8 (4 decimal octets, no leading zeros, nothing else in the string), `::1` and `[::1]`, and a unix
//     socket whose path is a real path inside NETGUARD_ROOT (no symlink).
//   * Refused AND logged: every other IPv4 / IPv6 literal (documentation, private, link-local, 0.0.0.0, ::, IPv4-mapped even when the
//     embedded address is loopback, decimal / hex / octal / short / mixed forms, zone ids), hostnames that merely start with 127. or
//     localhost., any other name (before any DNS packet), unparsable or odd option shapes (path null / '' / relative / outside the root,
//     array arguments that node did not build, a lookup function, a family without a host, a non-loopback localAddress).
//     RFC 6761 reserved names (.invalid .test .example .localhost, example.com / .net / .org) are answered ENOTFOUND locally and
//     logged as reserved-local (that is not an attempt).
//   * Covered: net.Socket#connect (so net.connect / createConnection, tls.connect, http / https / http2 request and get, an agent, and
//     global fetch), dgram send / connect, dns.lookup, dns.resolve* (all record types), dns.reverse, dns.lookupService, dns.Resolver
//     instances and dns.promises.* (including its Resolver). A child or worker thread that keeps NODE_OPTIONS has the guard too.
//   * Not covered (say so, never claim it): a program that is not node (curl, wget, ssh, git), a node child started with a scrubbed
//     environment, process.binding / native addons, a socket the program already holds. test/npm-env.cjs puts the preload on every npm
//     child, and the lint row in test/child-isolation.test.cjs fails a test tool that starts node or npm without it.
// A refusal is a real Error (code ECONNREFUSED or ENOTFOUND) delivered on the socket, the callback or the promise, never a synchronous
// throw a test could swallow into a pass. Every refusal appends one tab-separated line to the file named by NETGUARD_LOG (mode 0600):
// time, tag, kind (refused | reserved-local), api, target. NETGUARD_TAG=canary marks the lines of the canary rows.
const fs = require('node:fs');
const net = require('node:net');
const dns = require('node:dns');
const dgram = require('node:dgram');
const path = require('node:path');

const GUARD_PATH = __filename;
const ENV = Object.freeze({ log: 'NETGUARD_LOG', root: 'NETGUARD_ROOT', tag: 'NETGUARD_TAG' });
const MESSAGE = 'netguard: refused';

// ---- host classification (pure; used by the guard and by the self-test) ----------------------------------------------------
const asciiLower = (text) => text.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));

function canonicalLoopbackV4(host) {
  const m = /^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$/.exec(host);
  if (!m) return false;
  for (let i = 1; i <= 4; i += 1) {
    if (m[i].length > 1 && m[i][0] === '0') return false;
    if (Number(m[i]) > 255) return false;
  }
  return Number(m[1]) === 127;
}

const RESERVED_TLDS = ['invalid', 'test', 'example', 'localhost'];
const RESERVED_DOMAINS = ['example.com', 'example.net', 'example.org'];
function reservedName(host) {
  const name = asciiLower(host).replace(/\.$/, '');
  if (!/^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/.test(name)) return false;
  const labels = name.split('.');
  return RESERVED_TLDS.includes(labels[labels.length - 1]) || RESERVED_DOMAINS.includes(labels.slice(-2).join('.'));
}

// 'default' (no host), 'loopback' (canonical literal), 'localhost' (the name), 'reserved' (RFC 6761), or 'refuse'.
function judgeHost(host) {
  if (host === undefined || host === null || host === '') return 'default';
  if (typeof host !== 'string') return 'refuse';
  if (host === '::1' || host === '[::1]') return 'loopback';
  if (canonicalLoopbackV4(host)) return 'loopback';
  if (host === 'localhost') return 'localhost'; // exact and lower case only: the old guard refused every other spelling, and none may become looser
  // Other spellings of localhost and names that merely start with localhost. or 127. are attempts, even under a reserved suffix.
  if (asciiLower(host).replace(/\.$/, '') === 'localhost' || /^(?:localhost|127)\./i.test(host)) return 'refuse';
  if (reservedName(host)) return 'reserved';
  return 'refuse';
}

// ---- state taken once, when the guard installs -------------------------------------------------------------------------------
let installed = false;
let logPath = '';
let tag = '-';
let rootReal = '';
let normalizedSymbol;
let wroteMode = false;

const show = (value) => {
  try {
    return JSON.stringify(typeof value === 'string' ? value : `<${typeof value}:${String(value)}>`).slice(0, 200);
  } catch {
    return '"<unprintable>"';
  }
};

function record(kind, api, target) {
  const line = `${new Date().toISOString()}\t${tag}\t${kind}\t${api}\t${show(target)}\n`;
  if (!logPath) {
    try { fs.writeSync(2, line); } catch { /* nothing else to do */ }
    return;
  }
  try {
    const fd = fs.openSync(logPath, 'a', 0o600);
    try {
      if (!wroteMode) { fs.fchmodSync(fd, 0o600); wroteMode = true; }
      fs.writeSync(fd, line);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    try { fs.writeSync(2, line); } catch { /* nothing else to do */ }
  }
}

const text = (value) => {
  try { return String(value); } catch { return '<unprintable>'; }
};

const guardError = (code, syscall, what) => Object.assign(new Error(`${MESSAGE} ${what}`), { code, syscall });

function insideRoot(target) {
  if (!rootReal || typeof target !== 'string' || target === '' || target.includes('\0') || !path.isAbsolute(target)) return false;
  try {
    const resolved = path.resolve(target);
    const full = path.join(fs.realpathSync(path.dirname(resolved)), path.basename(resolved));
    if (full !== rootReal && !full.startsWith(rootReal + path.sep)) return false;
    try { if (fs.lstatSync(full).isSymbolicLink()) return false; } catch { /* not there yet: fine */ }
    return true;
  } catch {
    return false;
  }
}

// ---- connect ---------------------------------------------------------------------------------------------------------------
const OPTION_KEYS = ['host', 'port', 'path', 'family', 'lookup', 'localAddress', 'localPort'];

// Returns { options, callback } for the arguments node would act on, or { reason } when they are not understood.
function connectArguments(args) {
  try {
    const first = args[0];
    let options;
    let callback = null;
    if (Array.isArray(first)) {
      if (normalizedSymbol === undefined || first[normalizedSymbol] !== true || first.length !== 2) return { reason: 'array arguments' };
      options = first[0];
      callback = first[1];
    } else {
      const normalized = net._normalizeArgs(args);
      options = normalized[0];
      callback = normalized[1];
    }
    if (options === null || typeof options !== 'object' || Array.isArray(options)) return { reason: 'options' };
    const copy = { ...options }; // own values, each read once
    for (const key of OPTION_KEYS) if (!Object.prototype.hasOwnProperty.call(options, key) && key in options) copy[key] = options[key]; // inherited ones count too
    return { options: copy, callback };
  } catch {
    return { reason: 'unparsed' };
  }
}

// null = allowed (options may be rewritten in place); otherwise { kind, code, reason }.
function judgeConnect(options) {
  if (options.path !== undefined) {
    if (typeof options.path !== 'string' || options.path === '') return { kind: 'refused', code: 'ECONNREFUSED', reason: 'odd path' };
    return insideRoot(options.path) ? null : { kind: 'refused', code: 'ECONNREFUSED', reason: `path ${options.path}` };
  }
  if (options.lookup !== undefined) return { kind: 'refused', code: 'ECONNREFUSED', reason: 'lookup override' };
  if (options.family !== undefined && ![0, 4, 6].includes(options.family)) return { kind: 'refused', code: 'ECONNREFUSED', reason: 'family' };
  if (options.localAddress !== undefined && !['loopback', 'default'].includes(judgeHost(options.localAddress))) {
    return { kind: 'refused', code: 'ECONNREFUSED', reason: 'localAddress' };
  }
  const verdict = judgeHost(options.host);
  if (verdict === 'default') {
    if (options.family !== undefined && options.family !== 0) return { kind: 'refused', code: 'ECONNREFUSED', reason: 'family without a host' };
    return null;
  }
  if (verdict === 'loopback') return null;
  if (verdict === 'localhost') {
    options.host = options.family === 6 ? '::1' : '127.0.0.1';
    return null;
  }
  if (verdict === 'reserved') return { kind: 'reserved-local', code: 'ENOTFOUND', reason: `host ${options.host}` };
  return { kind: 'refused', code: 'ECONNREFUSED', reason: `host ${text(options.host)}` };
}

function patchConnect() {
  try { normalizedSymbol = Object.getOwnPropertySymbols(net._normalizeArgs([0])).find((s) => String(s).includes('normalizedArgs')); } catch { normalizedSymbol = undefined; }
  const realConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function guardedConnect(...args) {
    const parsed = connectArguments(args);
    const verdict = parsed.options ? judgeConnect(parsed.options) : { kind: 'refused', code: 'ECONNREFUSED', reason: parsed.reason };
    if (verdict === null) return realConnect.call(this, parsed.options, ...(parsed.callback ? [parsed.callback] : []));
    record(verdict.kind, 'net.Socket.connect', verdict.reason);
    const error = guardError(verdict.code, 'connect', verdict.kind === 'reserved-local' ? 'reserved name' : 'connect');
    this.connecting = true; // like a real connect in flight, so a caller (http2) waits for the socket's own outcome
    process.nextTick(() => this.destroy(error));
    return this;
  };
}

// ---- dns -------------------------------------------------------------------------------------------------------------------
function localAnswers(host, family) {
  const verdict = judgeHost(host);
  if (verdict === 'localhost') return [{ address: '127.0.0.1', family: 4 }, { address: '::1', family: 6 }].filter((a) => !family || a.family === family);
  if (host === '::1' || host === '[::1]') return [{ address: '::1', family: 6 }];
  return [{ address: host, family: 4 }];
}

function lookupArguments(options, callback) {
  if (typeof options === 'function') return { options: {}, callback: options };
  if (typeof options === 'number') return { options: { family: options }, callback };
  return { options: options && typeof options === 'object' ? options : {}, callback };
}

function lookupVerdict(api, host) {
  if (host === undefined || host === null || host === '') return { pass: true };
  if (typeof host !== 'string') return { pass: true }; // the real function throws a TypeError without touching the network
  const verdict = judgeHost(host);
  if (verdict === 'localhost' || verdict === 'loopback') return { local: true };
  const kind = verdict === 'reserved' ? 'reserved-local' : 'refused';
  record(kind, api, host);
  return { error: guardError('ENOTFOUND', 'getaddrinfo', verdict === 'reserved' ? 'reserved name' : 'lookup') };
}

function patchLookup() {
  const realLookup = dns.lookup;
  dns.lookup = function guardedLookup(host, options, callback) {
    const parsed = lookupArguments(options, callback);
    const verdict = lookupVerdict('dns.lookup', host);
    if (verdict.pass) return realLookup.call(this, host, options, callback);
    if (typeof parsed.callback !== 'function') throw new TypeError('The "callback" argument must be of type function');
    process.nextTick(() => {
      if (verdict.error) { parsed.callback(verdict.error); return; }
      const found = localAnswers(host, parsed.options.family);
      if (parsed.options.all) parsed.callback(null, found);
      else parsed.callback(null, found[0].address, found[0].family);
    });
    return {};
  };
  const realPromiseLookup = dns.promises.lookup;
  dns.promises.lookup = async function guardedPromiseLookup(host, options) {
    const parsed = lookupArguments(options, undefined);
    const verdict = lookupVerdict('dns.promises.lookup', host);
    if (verdict.pass) return realPromiseLookup.call(this, host, options);
    if (verdict.error) throw verdict.error;
    const found = localAnswers(host, parsed.options.family);
    return parsed.options.all ? found : found[0];
  };
}

const RESOLVE_NAMES = ['resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCaa', 'resolveCname', 'resolveMx', 'resolveNaptr', 'resolveNs', 'resolvePtr', 'resolveSoa', 'resolveSrv', 'resolveTxt', 'reverse'];

// What a resolver call gets: an answer made here (only for `localhost`, never from DNS) or an error.
function resolveVerdict(api, name, target, rrtype) {
  if (name === 'reverse') {
    if (typeof target === 'string' && (target === '::1' || canonicalLoopbackV4(target))) return { answer: ['localhost'] };
  } else if (typeof target === 'string' && judgeHost(target) === 'localhost') {
    const type = name === 'resolve' ? (rrtype || 'A') : name.slice('resolve'.length).toUpperCase();
    if (type === 'A' || name === 'resolve4') return { answer: ['127.0.0.1'] };
    if (type === 'AAAA' || name === 'resolve6') return { answer: ['::1'] };
    if (name === 'resolveAny') return { answer: [{ type: 'A', address: '127.0.0.1', ttl: 0 }, { type: 'AAAA', address: '::1', ttl: 0 }] };
    return { error: guardError('ENODATA', name, 'no data for localhost') };
  }
  const verdict = typeof target === 'string' ? judgeHost(target) : 'refuse';
  record(verdict === 'reserved' ? 'reserved-local' : 'refused', api, target);
  return { error: guardError('ENOTFOUND', name, verdict === 'reserved' ? 'reserved name' : 'resolve') };
}

function patchResolvers() {
  const callbackStyle = (api, name) => function guardedResolve(...args) {
    const callback = args[args.length - 1];
    if (typeof callback !== 'function') throw new TypeError('The "callback" argument must be of type function');
    const verdict = resolveVerdict(api, name, args[0], typeof args[1] === 'string' ? args[1] : undefined);
    process.nextTick(() => (verdict.error ? callback(verdict.error) : callback(null, verdict.answer)));
    return {};
  };
  const promiseStyle = (api, name) => async function guardedPromiseResolve(...args) {
    const verdict = resolveVerdict(api, name, args[0], typeof args[1] === 'string' ? args[1] : undefined);
    if (verdict.error) throw verdict.error;
    return verdict.answer;
  };
  for (const name of RESOLVE_NAMES) {
    if (typeof dns[name] === 'function') dns[name] = callbackStyle(`dns.${name}`, name);
    if (dns.Resolver && typeof dns.Resolver.prototype[name] === 'function') dns.Resolver.prototype[name] = callbackStyle(`dns.Resolver.${name}`, name);
    if (typeof dns.promises[name] === 'function') dns.promises[name] = promiseStyle(`dns.promises.${name}`, name);
    if (dns.promises.Resolver && typeof dns.promises.Resolver.prototype[name] === 'function') dns.promises.Resolver.prototype[name] = promiseStyle(`dns.promises.Resolver.${name}`, name);
  }
  const realService = dns.lookupService;
  dns.lookupService = function guardedLookupService(address, port, callback) {
    if (typeof address === 'string' && (address === '::1' || canonicalLoopbackV4(address))) return realService.call(this, address, port, callback);
    record('refused', 'dns.lookupService', address);
    if (typeof callback !== 'function') throw new TypeError('The "callback" argument must be of type function');
    const error = guardError('ENOTFOUND', 'getnameinfo', 'lookupService');
    process.nextTick(() => callback(error));
    return {};
  };
  const realPromiseService = dns.promises.lookupService;
  dns.promises.lookupService = async function guardedPromiseLookupService(address, port) {
    if (typeof address === 'string' && (address === '::1' || canonicalLoopbackV4(address))) return realPromiseService.call(this, address, port);
    record('refused', 'dns.promises.lookupService', address);
    throw guardError('ENOTFOUND', 'getnameinfo', 'lookupService');
  };
}

// ---- dgram -----------------------------------------------------------------------------------------------------------------
function patchDgram() {
  const dgramVerdict = (api, address) => {
    const verdict = judgeHost(address);
    if (verdict === 'default' || verdict === 'loopback') return null;
    if (verdict === 'localhost') return null; // resolved by the guarded dns.lookup, locally
    record(verdict === 'reserved' ? 'reserved-local' : 'refused', api, address);
    return guardError(verdict === 'reserved' ? 'ENOTFOUND' : 'ECONNREFUSED', 'send', verdict === 'reserved' ? 'reserved name' : 'dgram');
  };
  const realSend = dgram.Socket.prototype.send;
  dgram.Socket.prototype.send = function guardedSend(message, ...rest) {
    const callback = typeof rest[rest.length - 1] === 'function' ? rest[rest.length - 1] : null;
    const values = callback ? rest.slice(0, -1) : rest;
    const address = values.find((value) => typeof value === 'string');
    const nonString = values.some((value) => value !== undefined && typeof value !== 'string' && typeof value !== 'number');
    const error = nonString ? guardError('ECONNREFUSED', 'send', 'odd dgram arguments') : dgramVerdict('dgram.send', address);
    if (!error) return realSend.call(this, message, ...rest);
    if (nonString) record('refused', 'dgram.send', 'odd arguments');
    process.nextTick(() => (callback ? callback(error) : this.emit('error', error)));
    return undefined;
  };
  const realConnect = dgram.Socket.prototype.connect;
  dgram.Socket.prototype.connect = function guardedDgramConnect(port, address, callback) {
    const error = dgramVerdict('dgram.connect', typeof address === 'function' ? undefined : address);
    if (!error) return realConnect.call(this, port, address, callback);
    process.nextTick(() => this.emit('error', error));
    return undefined;
  };
}

// ---- install and helpers -----------------------------------------------------------------------------------------------------
function install() {
  if (installed) return;
  installed = true;
  logPath = process.env[ENV.log] || '';
  tag = process.env[ENV.tag] || '-';
  const root = process.env[ENV.root];
  try { rootReal = root && path.isAbsolute(root) ? fs.realpathSync(root) : ''; } catch { rootReal = ''; }
  patchConnect();
  patchLookup();
  patchResolvers();
  patchDgram();
}

// The environment names a test may add to a child so that it runs under the guard. `log` and `root` are paths inside the test's temp root.
function env({ log, root, tag: label, nodeOptions } = {}) {
  const quote = (file) => (/\s/.test(file) ? `"${file}"` : file);
  const options = [`--require=${quote(GUARD_PATH)}`];
  if (nodeOptions) options.push(nodeOptions);
  const out = { NODE_OPTIONS: options.join(' ') };
  if (log) out[ENV.log] = log;
  if (root) out[ENV.root] = root;
  if (label) out[ENV.tag] = label;
  return out;
}

function readLog(file) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  return text.split('\n').filter(Boolean).map((line) => {
    const [time, label, kind, api, target] = line.split('\t');
    return { time, tag: label, kind, api, target };
  });
}

// Attempts that are not canary rows and not RFC 6761 answers: the number every harness must assert to be 0.
const attemptsIn = (file) => readLog(file).filter((row) => row.kind === 'refused' && row.tag !== 'canary');

function assertNoAttempts(files) {
  let count = 0;
  for (const file of [].concat(files)) count += attemptsIn(file).length;
  if (count > 0) throw new Error(`${count} non-loopback attempt(s) in the network guard log`);
  return count;
}

// ---- self-test: node test/net-guard.cjs --selftest [--master <old guard preload>] [--json <file>] -----------------------------------
// Rows G-1 .. G-9 and the canary rows. Every probe is a child node process under the guard, so a refused target is never reached (the
// guard answers first, before any packet). With --master the same inputs run a second time with the OLD guard stacked UNDER this one
// (this guard loads first, so nothing can leave the machine even when the old guard lets an input through): a row is RED on the old guard
// when this guard, not the old one, had to refuse it. G-9 compares the two runs input by input.
const PROBE = String.raw`
'use strict';
const fs = require('fs'); const net = require('net'); const tls = require('tls'); const dns = require('dns'); const dgram = require('dgram');
const http = require('http'); const https = require('https'); const cp = require('child_process');
const { Worker } = require('worker_threads');
const plan = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const ports = plan.ports; const logFile = process.env.NETGUARD_LOG;
const lines = () => { try { return fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).length; } catch { return 0; } };
const byOf = (e) => { const m = String(e && e.message); return m.startsWith('netguard: refused') ? 'head' : m.includes('blocked by the test network guard') ? 'master' : 'os'; };
const err = (e) => ({ out: 'error', code: e && e.code, by: byOf(e), reserved: /reserved name/.test(String(e && e.message)) });
const settle = (start) => new Promise((resolve) => {
  let done = false; const fin = (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } };
  const timer = setTimeout(() => fin({ out: 'timeout' }), 3000);
  try { start(fin); } catch (e) { fin({ out: 'throw', code: e && e.code, by: byOf(e) }); }
});
const sock = (s, fin) => { s.on('connect', () => { s.destroy(); fin({ out: 'connect' }); }); s.on('error', (e) => fin(err(e))); };
const port = (o) => (o && o.port === '$v4' ? { ...o, port: ports.v4 } : o);
const answer = (fin) => (e, a) => fin(e ? err(e) : { out: 'local', a: JSON.stringify(a).slice(0, 60) });
const childCode = "const net=require('net');const s=net.connect({host:'192.0.2.1',port:80});s.on('error',e=>console.log(JSON.stringify({code:e.code,msg:String(e.message).slice(0,40)})));s.on('connect',()=>console.log('CONNECT'));setTimeout(()=>process.exit(0),2500)";
const fromChild = (text) => { const l = String(text).trim().split('\n').pop(); if (!l) return { out: 'silent' }; if (l === 'CONNECT') return { out: 'connect' }; try { const j = JSON.parse(l); return err({ code: j.code, message: j.msg }); } catch { return { out: 'garbled' }; } };
const KINDS = {
  connect: (a) => settle((fin) => sock(net.connect(port(a.options)), fin)),
  positional: (a) => settle((fin) => sock(net.connect(...a.args), fin)),
  socket: (a) => settle((fin) => sock(new net.Socket().connect(...a.args), fin)),
  forgedArray: (a) => settle((fin) => { const s = new net.Socket(); sock(s, fin); s.connect(a.shape === 'props' ? Object.assign([], { host: '192.0.2.1', port: 80 }) : [{ host: '192.0.2.1', port: 80 }, null]); }),
  lookupFn: () => settle((fin) => sock(net.connect({ host: '127.0.0.1', port: ports.v4, lookup: (h, o, cb) => cb(null, '192.0.2.1', 4) }), fin)),
  objectHost: () => settle((fin) => sock(net.connect({ host: { toString() { return '127.0.0.1'; } }, port: ports.v4 }), fin)),
  getter: () => settle((fin) => { let n = 0; const o = { port: ports.v4 }; Object.defineProperty(o, 'host', { enumerable: true, get() { n += 1; return n <= 2 ? '127.0.0.1' : '192.0.2.1'; } }); sock(net.connect(o), fin); }),
  inherited: () => settle((fin) => sock(net.connect(Object.create({ host: '192.0.2.1', port: 80 })), fin)),
  repeat: (a) => settle((fin) => { const s = new net.Socket(); s.on('error', (e) => fin(err(e))); s.once('connect', () => s.connect({ host: a.second, port: 80 })); s.connect({ host: '127.0.0.1', port: ports.v4 }); }),
  tls: (a) => settle((fin) => { const s = tls.connect(a.options); s.on('secureConnect', () => { s.destroy(); fin({ out: 'connect' }); }); s.on('error', (e) => fin(err(e))); }),
  http: (a) => settle((fin) => { const o = { ...a.options }; if (a.useAgent) o.agent = new (a.secure ? https : http).Agent({ keepAlive: true }); const r = (a.secure ? https : http).get(o); r.on('response', (x) => { x.resume(); fin({ out: 'connect' }); }); r.on('error', (e) => fin(err(e))); }),
  http2: (a) => settle((fin) => { const c = require('http2').connect(a.url); c.on('connect', () => setTimeout(() => { c.destroy(); fin({ out: 'connect' }); }, 600)); c.on('error', (e) => { c.destroy(); fin(err(e)); }); }),
  fetch: (a) => settle((fin) => { fetch(a.url).then(() => fin({ out: 'connect' }), (e) => fin(err(e.cause || e))); }),
  dgram: (a) => settle((fin) => { const s = dgram.createSocket(a.type || 'udp4'); const done = (e) => { s.close(); fin(e ? err(e) : { out: 'local' }); }; s.on('error', done); if (a.method === 'connect') s.connect(a.port, a.address, done); else s.send(Buffer.from('x'), a.port, a.address, done); }),
  lookup: (a) => settle((fin) => dns.lookup(a.host, a.opts || {}, answer(fin))),
  plookup: (a) => settle((fin) => dns.promises.lookup(a.host, a.opts || {}).then((v) => fin({ out: 'local', a: JSON.stringify(v).slice(0, 60) }), (e) => fin(err(e)))),
  resolve: (a) => settle((fin) => dns[a.fn](a.host, answer(fin))),
  presolve: (a) => settle((fin) => dns.promises[a.fn](a.host).then(() => fin({ out: 'local' }), (e) => fin(err(e)))),
  resolver: (a) => settle((fin) => new dns.Resolver()[a.fn](a.host, answer(fin))),
  presolver: (a) => settle((fin) => new dns.promises.Resolver()[a.fn](a.host).then(() => fin({ out: 'local' }), (e) => fin(err(e)))),
  service: (a) => settle((fin) => dns.lookupService(a.address, 80, (e) => fin(e ? err(e) : { out: 'local' }))),
  pservice: (a) => settle((fin) => dns.promises.lookupService(a.address, 80).then(() => fin({ out: 'local' }), (e) => fin(err(e)))),
  worker: () => settle((fin) => { const w = new Worker(childCode.replace(/console\.log/g, 'require("worker_threads").parentPort.postMessage').replace('process.exit(0)', 'process.exit()'), { eval: true }); w.on('message', (m) => { try { fin(m === 'CONNECT' ? { out: 'connect' } : err({ code: JSON.parse(m).code, message: JSON.parse(m).msg })); } catch { fin({ out: 'garbled' }); } }); w.on('error', (e) => fin(err(e))); }),
  child: () => settle((fin) => fin(fromChild(cp.spawnSync(process.execPath, ['-e', childCode], { encoding: 'utf8', timeout: 8000 }).stdout))),
  shell: (a) => settle((fin) => fin(fromChild(cp.spawnSync('bash', ['-c', a.script.replace(/NODE/g, '"$NODE_BIN"').replace(/CODE/g, '"$CODE_TXT"')], { encoding: 'utf8', timeout: 12000, env: { ...process.env, NODE_BIN: process.execPath, CODE_TXT: childCode } }).stdout))),
  guarded: () => settle((fin) => fin({ out: net.Socket.prototype.connect.name === 'guardedConnect' ? 'guarded' : 'unguarded' })),
};
(async () => {
  const results = [];
  for (const item of plan.cases) {
    const before = lines();
    let r;
    try { r = await KINDS[item.kind](item); } catch (e) { r = { out: 'throw', code: e && e.code, by: byOf(e) }; }
    results.push({ id: item.id, ...r, logged: lines() > before });
  }
  process.stdout.write(JSON.stringify(results));
  process.exit(0);
})();
`;

async function selftest(argv) {
  const cp = require('node:child_process');
  const os = require('node:os');
  const flag = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
  const masterPreload = flag('--master');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'netguard-selftest-')));
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'netguard-outside-')));
  fs.symlinkSync(outside, path.join(root, 'link-out'));
  fs.writeFileSync(path.join(root, 'probe.cjs'), PROBE);
  let pass = 0;
  let fail = 0;
  const row = (ok, name, detail) => {
    if (ok) pass += 1; else fail += 1;
    process.stdout.write(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}\n`);
  };
  const listen = (options) => new Promise((resolve) => {
    const server = net.createServer((socket) => socket.end());
    server.on('error', () => resolve(null));
    server.listen(options, () => resolve(server));
  });
  const v4 = await listen({ port: 0, host: '127.0.0.1' });
  const unix = await listen({ path: path.join(root, 'ok.sock') });
  const quote = (file) => (/\s/.test(file) ? `"${file}"` : file);
  const childEnv = (log, nodeOptions, label) => ({ PATH: process.env.PATH, HOME: root, NODE_OPTIONS: nodeOptions, [ENV.log]: log, [ENV.root]: root, ...(label ? { [ENV.tag]: label } : {}), TEST_NET_LOG: path.join(root, 'old-guard.tsv') });

  const cases = [];
  const add = (group, id, expect, spec) => cases.push({ group, id: `${group} ${id}`, expect, ...spec });
  const connects = (group, hosts, expect) => {
    for (const host of hosts) {
      add(group, `options.host ${JSON.stringify(host)} number port`, expect, { kind: 'connect', options: { host, port: 443 } });
      add(group, `options.host ${JSON.stringify(host)} string port`, expect, { kind: 'connect', options: { host, port: '443' } });
      add(group, `positional (port, host) ${JSON.stringify(host)}`, expect, { kind: 'positional', args: [443, host] });
    }
  };
  connects('G-1', ['192.0.2.1', '198.51.100.7', '203.0.113.9', '10.0.0.1', '192.168.1.1', '169.254.1.1', '0.0.0.0', '8.8.8.8'], 'refused');
  connects('G-2', ['2001:db8::1', 'fe80::1', 'fe80::1%lo', '::', '[2001:db8::1]', '::2', '::1:0', '::1%lo', '0:0:0:0:0:0:0:1'], 'refused');
  connects('G-3', ['::ffff:192.0.2.1', '::ffff:c000:201', '::ffff:127.0.0.1', '::ffff:7f00:1'], 'refused');
  for (const host of ['guard-canary.getmarrow.ai', '127.evil.example', 'localhost.evil.example']) {
    add('G-4', `connect ${host}`, 'refused', { kind: 'connect', options: { host, port: 443 } });
    add('G-4', `fetch ${host}`, 'refused', { kind: 'fetch', url: `https://${host}/` });
    add('G-4', `dns.lookup ${host}`, 'refused', { kind: 'lookup', host });
    add('G-4', `dns.promises.lookup ${host}`, 'refused', { kind: 'plookup', host });
  }
  for (const fn of RESOLVE_NAMES) {
    add('G-4', `dns.${fn} (public-looking name)`, 'refused', { kind: 'resolve', fn, host: 'guard-canary.getmarrow.ai' });
    add('G-4', `dns.promises.${fn} (public-looking name)`, 'refused', { kind: 'presolve', fn, host: 'guard-canary.getmarrow.ai' });
    add('G-4', `dns.Resolver#${fn} (public-looking name)`, 'refused', { kind: 'resolver', fn, host: 'guard-canary.getmarrow.ai' });
    add('G-4', `dns.promises.Resolver#${fn} (public-looking name)`, 'refused', { kind: 'presolver', fn, host: 'guard-canary.getmarrow.ai' });
  }
  add('G-4', 'dns.lookupService 8.8.8.8', 'refused', { kind: 'service', address: '8.8.8.8' });
  add('G-4', 'dns.promises.lookupService 8.8.8.8', 'refused', { kind: 'pservice', address: '8.8.8.8' });
  for (const host of ['foo.invalid', 'a.test', 'b.example', 'x.localhost', 'example.com', 'www.example.net', 'a.example.org']) {
    add('G-4r', `reserved connect ${host}`, 'reserved', { kind: 'connect', options: { host, port: 443 } });
    add('G-4r', `reserved dns.lookup ${host}`, 'reserved', { kind: 'lookup', host });
    add('G-4r', `reserved fetch ${host}`, 'reserved', { kind: 'fetch', url: `http://${host}/` });
  }
  for (const host of ['localhost']) {
    add('G-4l', `connect ${host}`, 'allowed', { kind: 'connect', options: { host, port: '$v4' } });
    add('G-4l', `dns.lookup ${host}`, 'allowed', { kind: 'lookup', host });
    add('G-4l', `dns.promises.lookup ${host} all`, 'allowed', { kind: 'plookup', host, opts: { all: true } });
  }
  add('G-4l', 'dns.resolve4 localhost (answered here, no DNS)', 'allowed', { kind: 'resolve', fn: 'resolve4', host: 'localhost' });
  for (const host of ['127.0.0.1', '127.0.0.2', '127.255.255.254', '::1', '[::1]']) add('G-5', `loopback ${host}`, 'allowed', { kind: 'connect', options: { host, port: '$v4' } });
  add('G-5', 'no host (node default localhost)', 'allowed', { kind: 'connect', options: { port: '$v4' } });
  add('G-5', "host '' (empty)", 'allowed', { kind: 'connect', options: { host: '', port: '$v4' } });
  connects('G-5', ['LOCALHOST', 'LocalHost', 'localhost.', 'LocalHost.', '127.1', '0177.0.0.1', '2130706433', '0x7f000001', '017700000001', '127.000.000.001', '127.0.0.1 ', ' 127.0.0.1', '127.0.0.1\n', '127.0.0.1​', '１２７.０.０.１', '127.0.0.1.', '127.0.0.256', '127.0.0.01', 'localhost​', 'localhost ', 'locаlhost', '127.0.0.1\u0000', '134744072', '0x08080808', '0x7f.1', '127.0.1'], 'refused');
  const unixCase = (id, expect, target) => add('G-6', id, expect, { kind: 'connect', options: { path: target } });
  add('G-6', 'path null + non-loopback host', 'refused', { kind: 'connect', options: { path: null, host: '192.0.2.1', port: 80 } });
  add('G-6', "path '' + non-loopback host", 'refused', { kind: 'connect', options: { path: '', host: '192.0.2.1', port: 80 } });
  unixCase('path relative', 'refused', 'rel.sock');
  unixCase('path outside the root', 'refused', path.join(outside, 'x.sock'));
  unixCase('path with .. leaving the root', 'refused', path.join(root, '..', 'x.sock'));
  unixCase('path through a symlink to the outside', 'refused', path.join(root, 'link-out', 'x.sock'));
  unixCase('path inside the root (control)', 'allowed', path.join(root, 'ok.sock'));
  add('G-6', 'port without host, family 6', 'refused', { kind: 'connect', options: { port: 80, family: 6 } });
  add('G-6', 'port without host, family 4', 'refused', { kind: 'connect', options: { port: 80, family: 4 } });
  add('G-6', 'family 5 with a loopback host', 'refused', { kind: 'connect', options: { host: '127.0.0.1', port: 80, family: 5 } });
  add('G-6', 'lookup override function', 'refused', { kind: 'lookupFn' });
  add('G-6', 'host is an object', 'refused', { kind: 'objectHost' });
  add('G-6', 'localAddress non-loopback', 'refused', { kind: 'connect', options: { host: '127.0.0.1', port: 80, localAddress: '192.0.2.5' } });
  add('G-6', 'array arguments (properties on an array)', 'refused', { kind: 'forgedArray', shape: 'props' });
  add('G-6', 'array arguments (forged normalized pair)', 'refused', { kind: 'forgedArray', shape: 'pair' });
  add('G-6', 'options that only inherit the host', 'refused', { kind: 'inherited' });
  add('G-6', 'getter host (node reads it once, the guard once, a third read would differ): connects to the validated value', 'allowed', { kind: 'getter' });
  add('G-6', 'net.Socket#connect(port, host)', 'refused', { kind: 'socket', args: [80, '192.0.2.1'] });
  add('G-6', 'repeated connect via one socket (second to 192.0.2.1, last wins)', 'refused', { kind: 'repeat', second: '192.0.2.1' });
  add('G-6', 'tls.connect IP literal', 'refused', { kind: 'tls', options: { host: '192.0.2.1', port: 443 } });
  add('G-6', 'tls.connect public-looking name', 'refused', { kind: 'tls', options: { host: 'guard-canary.getmarrow.ai', port: 443 } });
  add('G-6', 'http.get IP literal', 'refused', { kind: 'http', options: { host: '192.0.2.1', port: 80 } });
  add('G-6', 'http.get hostname', 'refused', { kind: 'http', options: { host: 'guard-canary.getmarrow.ai', port: 80 } });
  add('G-6', 'http.get with an agent', 'refused', { kind: 'http', useAgent: true, options: { host: '203.0.113.9', port: 80 } });
  add('G-6', 'https.get IP literal', 'refused', { kind: 'http', secure: true, options: { host: '198.51.100.7', port: 443 } });
  add('G-6', 'http2.connect IP literal', 'refused', { kind: 'http2', url: 'http://192.0.2.1:80' });
  add('G-6', 'fetch IPv4 literal', 'refused', { kind: 'fetch', url: 'http://192.0.2.1/' });
  add('G-6', 'fetch IPv6 literal', 'refused', { kind: 'fetch', url: 'http://[2001:db8::1]/' });
  add('G-6', 'fetch IPv4-mapped IPv6 literal', 'refused', { kind: 'fetch', url: 'http://[::ffff:192.0.2.1]/' });
  add('G-6', 'fetch decimal IPv4 (node parses it to a literal)', 'refused', { kind: 'fetch', url: 'http://134744072/' });
  add('G-6', 'dgram send IPv4', 'refused', { kind: 'dgram', method: 'send', address: '192.0.2.1', port: 53 });
  add('G-6', 'dgram send IPv6', 'refused', { kind: 'dgram', type: 'udp6', method: 'send', address: '2001:db8::1', port: 53 });
  add('G-6', 'dgram connect IPv4', 'refused', { kind: 'dgram', method: 'connect', address: '192.0.2.1', port: 53 });
  add('G-6', 'dgram send to a public-looking name', 'refused', { kind: 'dgram', method: 'send', address: 'guard-canary.getmarrow.ai', port: 53 });
  add('G-6', 'worker thread connect', 'refused', { kind: 'worker' });
  add('G-6', 'child process connect (inherits NODE_OPTIONS)', 'refused', { kind: 'child' });
  add('G-6', 'bash -c  A ; A', 'refused', { kind: 'shell', script: 'NODE -e CODE ; NODE -e CODE' });
  add('G-6', 'bash -c  true && A', 'refused', { kind: 'shell', script: 'true && NODE -e CODE' });
  add('G-6', 'bash -c  false || A', 'refused', { kind: 'shell', script: 'false || NODE -e CODE' });
  add('G-6', 'bash -c  echo | A', 'refused', { kind: 'shell', script: 'echo x | NODE -e CODE' });
  add('G-6', 'bash -c  ( A ) subshell', 'refused', { kind: 'shell', script: '( NODE -e CODE )' });
  add('G-6', "sh -c inside bash -c", 'refused', { kind: 'shell', script: "sh -c 'NODE -e CODE'" });
  add('G-8', 'repeated --require and NODE_OPTIONS (guard once, still installed)', 'allowed', { kind: 'guarded' });

  const runGrid = (stackMaster) => {
    const tagName = stackMaster ? 'master' : 'head';
    const log = path.join(root, `log-${tagName}.tsv`);
    fs.writeFileSync(log, '', { mode: 0o600 });
    const planFile = path.join(root, `plan-${tagName}.json`);
    fs.writeFileSync(planFile, JSON.stringify({ ports: { v4: v4.address().port }, cases }));
    const options = [`--require=${quote(GUARD_PATH)}`, ...(stackMaster ? [`--require=${quote(masterPreload)}`] : [])].join(' ');
    const out = cp.spawnSync(process.execPath, ['--require', GUARD_PATH, path.join(root, 'probe.cjs'), planFile], { encoding: 'utf8', timeout: 600000, env: childEnv(log, options, 'canary') });
    if (out.status !== 0) throw new Error(`probe exited ${out.status}: ${String(out.stderr).slice(0, 300)}`);
    return { results: JSON.parse(out.stdout), log };
  };
  const classOf = (r) => {
    if (r.out === 'connect' || r.out === 'local' || r.out === 'guarded') return 'allowed';
    if (r.out === 'error') return r.by === 'head' ? (r.reserved ? 'reserved' : 'refused') : r.by === 'master' ? 'refused-master' : 'allowed';
    return r.out;
  };
  const byId = new Map(cases.map((c) => [c.id, c]));
  const groups = [...new Set(cases.map((c) => c.group))];

  const head = runGrid(false);
  for (const group of groups) {
    const mine = head.results.filter((r) => byId.get(r.id).group === group);
    const bad = [];
    for (const r of mine) {
      const expect = byId.get(r.id).expect;
      const got = classOf(r);
      if (got !== expect || (expect === 'allowed' ? r.logged : !r.logged)) bad.push(`${r.id.slice(0, 70)}: ${got}${r.logged ? '' : ', not logged'}`);
    }
    row(bad.length === 0, `${group}: ${mine.length} inputs, each ${group === 'G-4l' || group === 'G-8' ? 'allowed or answered here and not logged' : group === 'G-5' ? 'loopback allowed, every other form refused and logged' : 'refused and logged'} on the head guard`, bad.slice(0, 5).join(' | '));
  }
  const lineKinds = readLog(head.log);
  row(lineKinds.length > 0 && lineKinds.every((l) => l.tag === 'canary' && ['refused', 'reserved-local'].includes(l.kind)), 'G-7 canary rows: every refusal is one tagged line (canary), none lost', `${lineKinds.length} lines`);
  row(attemptsIn(head.log).length === 0 && lineKinds.some((l) => l.kind === 'reserved-local'), 'G-7 canary and reserved-local lines are not counted as attempts (assertNoAttempts passes on a canary-only log)');

  // The canary subset of NET-CANARY, one probe child, each must fail with ECONNREFUSED or ENOTFOUND and log a canary line.
  const canary = [
    ['a TEST-NET-1 192.0.2.1:443', { host: '192.0.2.1', port: 443 }], ['b IPv4-mapped ::ffff:192.0.2.1', { host: '::ffff:192.0.2.1', port: 443 }],
    ['c decimal 8.8.8.8', { host: '134744072', port: 53 }], ['c hex 8.8.8.8', { host: '0x08080808', port: 53 }],
    ['d public-looking name', { host: 'guard-canary.getmarrow.ai', port: 443 }], ['e 127.evil.example', { host: '127.evil.example', port: 443 }],
    ['loopback control', { host: '127.0.0.1', port: '$v4' }], ['reserved name .invalid', { host: 'canary.invalid', port: 443 }],
  ].map(([id, options]) => ({ group: 'canary', id: `canary ${id}`, expect: id.startsWith('loopback') ? 'allowed' : id.includes('.invalid') ? 'reserved' : 'refused', kind: 'connect', options }));
  const canaryLog = path.join(root, 'log-canary.tsv');
  fs.writeFileSync(canaryLog, '', { mode: 0o600 });
  fs.writeFileSync(path.join(root, 'plan-canary.json'), JSON.stringify({ ports: { v4: v4.address().port }, cases: canary }));
  const canaryRun = cp.spawnSync(process.execPath, [path.join(root, 'probe.cjs'), path.join(root, 'plan-canary.json')], { encoding: 'utf8', timeout: 60000, env: childEnv(canaryLog, env({}).NODE_OPTIONS, 'canary') });
  const canaryResults = JSON.parse(canaryRun.stdout || '[]');
  const canaryBad = canary.filter((c) => { const r = canaryResults.find((x) => x.id === c.id); return !r || classOf(r) !== c.expect || (c.expect === 'allowed' ? r.logged : !r.logged); });
  row(canary.length === canaryResults.length && canaryBad.length === 0, `NET-CANARY: ${canary.length} canary rows fire (refused or answered ENOTFOUND, one tagged line each; loopback control accepted)`, canaryBad.map((c) => c.id).join(' | '));
  { const shared = canaryRow(root); row(shared.ok, `NET-CANARY (shared helper used by the launcher tools): ${shared.detail}`); }

  // The harness stop: an untagged refusal is an attempt; assertNoAttempts throws on it.
  const stopLog = path.join(root, 'log-stop.tsv');
  fs.writeFileSync(stopLog, '', { mode: 0o644 });
  fs.writeFileSync(path.join(root, 'plan-stop.json'), JSON.stringify({ ports: { v4: v4.address().port }, cases: [{ group: 'stop', id: 'stop 192.0.2.1', kind: 'connect', options: { host: '192.0.2.1', port: 443 } }] }));
  cp.spawnSync(process.execPath, ['--require', GUARD_PATH, '--require', GUARD_PATH, path.join(root, 'probe.cjs'), path.join(root, 'plan-stop.json')], { encoding: 'utf8', timeout: 60000, env: childEnv(stopLog, env({}).NODE_OPTIONS, undefined) });
  let stopped = false;
  try { assertNoAttempts([stopLog]); } catch { stopped = true; }
  row(stopped && attemptsIn(stopLog).length === 1, 'G-7 the harness STOPS on an untagged refusal (assertNoAttempts throws) and the repeated --require made exactly one log line');
  row((fs.statSync(stopLog).mode & 0o777) === 0o600, 'the guard log is mode 0600 (a pre-created 0644 file is tightened)');
  row(/192\.0\.2\.1/.test(readLog(stopLog)[0].target) && readLog(stopLog)[0].api === 'net.Socket.connect', 'a log line holds time, tag, kind, api and the target only');

  // G-8: the preload cannot be dropped by the env builder, and unknown flags do not unload it.
  const built = env({ nodeOptions: '--require=/elsewhere.js --no-experimental-fetch' });
  row(built.NODE_OPTIONS.startsWith(`--require=${GUARD_PATH}`) && Object.keys(built).every((k) => ['NODE_OPTIONS'].includes(k)), 'G-8 env() puts the guard first in NODE_OPTIONS whatever options a test adds');
  const probeGuarded = (nodeOptions) => cp.spawnSync(process.execPath, ['-e', "process.stdout.write(require('net').Socket.prototype.connect.name)"], { encoding: 'utf8', env: { PATH: process.env.PATH, ...(nodeOptions === null ? {} : { NODE_OPTIONS: nodeOptions }) } }).stdout;
  row(['--no-experimental-fetch', '--no-experimental-global-webcrypto --max-old-space-size=64', '--no-warnings'].every((flag2) => probeGuarded(env({ nodeOptions: flag2 }).NODE_OPTIONS) === 'guardedConnect'), 'G-8 unknown and --no-experimental-* flags next to the preload leave the guard loaded');
  row(probeGuarded('') !== 'guardedConnect' && probeGuarded(null) !== 'guardedConnect', 'G-8 limit stated, not hidden: a node child whose NODE_OPTIONS is emptied or dropped is NOT guarded; test spawns go through env() / test/npm-env.cjs and the lint row in test/child-isolation.test.cjs fails a tool that does not');

  // G-9 and RED-first on the old guard.
  if (masterPreload) {
    const old = runGrid(true);
    const rows = cases.map((c) => ({ id: c.id, group: c.group, expect: c.expect, master: classOf(old.results.find((r) => r.id === c.id)), head: classOf(head.results.find((r) => r.id === c.id)) }));
    const redOf = (g) => rows.filter((r) => r.group === g && r.expect !== 'allowed' && r.master !== 'refused-master');
    for (const group of groups.filter((g) => !['G-4l', 'G-8'].includes(g))) {
      const items = rows.filter((r) => r.group === group && r.expect !== 'allowed');
      if (items.length) process.stdout.write(`INFO RED-first ${group}: old guard let ${redOf(group).length} of ${items.length} refused-expected inputs through (this guard refused them)\n`);
    }
    const refusedByOld = rows.filter((r) => r.master === 'refused-master');
    const looser = refusedByOld.filter((r) => r.head === 'allowed' || !['refused', 'reserved'].includes(r.head));
    const tightened = rows.filter((r) => r.master !== 'refused-master' && ['refused', 'reserved'].includes(r.head));
    process.stdout.write(`G-9 differential: ${rows.length} inputs; old guard refused ${refusedByOld.length}, this guard refuses all of them: ${refusedByOld.length - looser.length}/${refusedByOld.length}; LOOSER_THAN_MASTER: ${looser.length}; refused here but let through by the old guard: ${tightened.length}\n`);
    row(looser.length === 0, 'G-9 never looser than the old guard: every input the old guard refused is refused here', looser.slice(0, 5).map((r) => r.id).join(' | '));
    const oldGroupRed = groups.filter((g) => !['G-4l', 'G-8', 'G-4r'].includes(g)).filter((g) => redOf(g).length === 0);
    process.stdout.write(`INFO groups with no RED input on the old guard: ${oldGroupRed.join(',') || 'none'}\n`);
    if (flag('--json')) fs.writeFileSync(flag('--json'), JSON.stringify({ rows, looser: looser.length, tightened: tightened.length, red: Object.fromEntries(groups.map((g) => [g, redOf(g).map((r) => r.id)])) }, null, 1));
  }
  for (const server of [v4, unix]) if (server) server.close();
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
  process.stdout.write(`${fail ? `${fail} FAILED` : 'ALL PASS'} (${pass + fail} rows)\n`);
  process.exitCode = fail ? 1 : 0;
}

// One canary row for a harness that starts programs under this guard: a child under the guard tries the usual escapes (a public-looking name
// through fetch and lookup, a documentation address, a mapped address, a decimal form, a look-alike name) and must be refused every time, one
// tagged line each in its own log (never counted as an attempt); a loopback port is left alone. root: a private folder of the harness.
function canaryRow(root) {
  const cp = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(root, 'canary-'));
  const probe = path.join(dir, 'probe.cjs');
  fs.writeFileSync(probe, [
    'const out = [];',
    "const attempt = (label, options) => new Promise((resolve) => { const s = require('node:net').connect(options); s.on('connect', () => { out.push(label + ' connected'); s.destroy(); resolve(); }); s.on('error', (e) => { out.push(label + ' ' + e.code); resolve(); }); });",
    "fetch('https://guard-canary.getmarrow.ai/').then(() => out.push('fetch reached'), (e) => out.push('fetch ' + String((e.cause && e.cause.code) || e.code)))",
    "  .then(() => new Promise((resolve) => require('node:dns').lookup('guard-canary.getmarrow.ai', (e) => { out.push('lookup ' + (e ? e.code : 'ok')); resolve(); })))",
    "  .then(() => attempt('doc-ip', { host: '192.0.2.1', port: 443 }))",
    "  .then(() => attempt('mapped', { host: '::ffff:192.0.2.1', port: 443 }))",
    "  .then(() => attempt('decimal', { host: '134744072', port: 53 }))",
    "  .then(() => attempt('lookalike', { host: '127.evil.example', port: 443 }))",
    "  .then(() => attempt('loopback', { host: '127.0.0.1', port: 9 }))",
    "  .then(() => process.stdout.write(out.join('|')));",
  ].join('\n'), { mode: 0o600 });
  const log = path.join(dir, 'canary.log');
  const run = cp.spawnSync(process.execPath, [probe], { encoding: 'utf8', timeout: 60000, env: env({ log, root: dir, tag: 'canary' }) });
  const expected = 'fetch ECONNREFUSED|lookup ENOTFOUND|doc-ip ECONNREFUSED|mapped ECONNREFUSED|decimal ECONNREFUSED|lookalike ECONNREFUSED|loopback ECONNREFUSED';
  const logged = readLog(log);
  const targets = logged.map((line) => line.target).join(' ');
  const problems = [];
  if (run.stdout !== expected) problems.push(`the probe saw ${String(run.stdout).slice(0, 160)}`);
  if (!(logged.length >= 6 && logged.every((line) => line.tag === 'canary' && line.kind === 'refused'))) problems.push('a refusal is not a tagged line');
  for (const target of ['guard-canary.getmarrow.ai', '192.0.2.1', '::ffff:192.0.2.1', '134744072', '127.evil.example']) if (!targets.includes(target)) problems.push(`no canary line for ${target}`);
  if (/127\.0\.0\.1/.test(targets)) problems.push('loopback was logged as a refusal');
  if (attemptsIn(log).length !== 0) problems.push('canary lines were counted as attempts');
  return { ok: problems.length === 0, detail: problems.length ? problems.join('; ') : `${logged.length} tagged lines, 0 attempts` };
}

module.exports = { GUARD_PATH, ENV, MESSAGE, install, env, readLog, attemptsIn, assertNoAttempts, judgeHost, canonicalLoopbackV4, canaryRow };

// A preload installs itself; a plain require does not.
if (module.parent && module.parent.id === 'internal/preload') install();
if (require.main === module && process.argv.includes('--selftest')) selftest(process.argv.slice(2)).catch((error) => { process.stderr.write(`${error && error.stack}\n`); process.exitCode = 1; });
