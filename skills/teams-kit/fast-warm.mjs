#!/usr/bin/env node
// fast-warm.mjs serve | ask <lane> <timeoutMs> <prompt file> | prewarm <lane> <prompt file> [name]: one warm
// fast-model process per lane for triage and voice, so a turn costs model time only (README "Script notes").
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const day = () => new Date().toLocaleDateString('sv');   // local YYYY-MM-DD
const ts = () => { const d = new Date(); return `${d.toLocaleString('sv').replace(' ', 'T')}.${String(d.getMilliseconds()).padStart(3, '0')}`; };

export function claudeArgs(sys, { model = 'haiku', effort = 'low', sessionId = randomUUID(), name = '' } = {}) {
  return ['-p', ...(name ? ['-n', name] : []), '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--model', model, ...(effort ? ['--effort', effort] : []), '--tools', '', '--strict-mcp-config', '--disable-slash-commands',
    '--system-prompt', sys, '--session-id', sessionId];
}

// One lane's warm process. spawnFn(sys, opts) returns a child with stdin/stdout pipes speaking stream-json; opts carries the
// model and effort being-handle read from .env for this turn, so a changed .env restarts the lane instead of being ignored.
export class Lane {
  constructor(name, spawnFn, { maxTurns = 30, log = () => {} } = {}) {
    Object.assign(this, { name, spawnFn, maxTurns, log, child: null, chain: Promise.resolve(), gen: 0, lastUse: 0 });
  }

  alive() { return !!this.child && this.child.exitCode === null && this.child.signalCode === null && !this.child.dead; }

  kill(why) {
    if (!this.child) return;
    const c = this.child; this.child = null; c.dead = true;
    try { c.kill('SIGKILL'); } catch { /* already gone */ }
    this.log(`${this.name}: process stopped (${why})`);
  }

  start(sys, opts = {}) {
    this.kill('restart');
    const c = this.spawnFn(sys, { ...opts, lane: this.name }); this.gen++;
    Object.assign(this, { child: c, sysHash: hash(sys, opts), day: day(), turns: 0, buf: '', waiter: null, lastUse: Date.now() });
    c.stdout.setEncoding('utf8');
    c.stdout.on('data', (d) => this.onData(c, d));
    c.on('exit', (code, sig) => {
      c.dead = true;
      if (this.child === c) { this.child = null; this.log(`${this.name}: process exited (${code ?? sig})`); }
      if (this.waiter?.child === c) this.waiter.reject(new Error(`process exited (${code ?? sig})`));
    });
    c.on('error', (e) => { c.dead = true; if (this.waiter?.child === c) this.waiter.reject(e); });
    c.stdin.on('error', () => {});   // EPIPE after a crash is reported by 'exit'
    const dg = /<!-- digest (\w+) -->/.exec(sys);   // soul.py's digest key: a changed board/DECISIONS/SOUL shows here as a new one
    this.log(`${this.name}: process started (gen ${this.gen}, pid ${c.pid}${dg ? `, digest ${dg[1]}` : ''})`);
  }

  onData(c, d) {
    if (c !== this.child) return;
    this.buf += d;
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i); this.buf = this.buf.slice(i + 1);
      let e; try { e = JSON.parse(line); } catch { continue; }
      if (e.type !== 'result' || !this.waiter) continue;
      if (e.is_error || e.subtype !== 'success') this.waiter.reject(new Error(`model error: ${String(e.result || e.subtype).slice(0, 200)}`));
      else this.waiter.resolve(String(e.result ?? ''));
    }
  }

  // Start the process ahead of the first message (no model turn).
  prewarm(sys, opts = {}) {
    const run = this.chain.then(() => {
      const why = !this.alive() ? 'none running' : this.sysHash !== hash(sys, opts) ? 'rules, digest or model changed' : this.day !== day() ? 'new day' : '';
      if (why) { this.log(`${this.name}: prewarm (re)start: ${why}`); this.start(sys, opts); }
      return { prewarmed: !!why };
    });
    this.chain = run.catch(() => {});
    return run;
  }

  // Serialised per lane: one turn at a time in one process.
  ask(sys, prompt, timeoutMs, opts = {}) {
    const run = this.chain.then(() => this.turn(sys, prompt, timeoutMs, opts));
    this.chain = run.catch(() => {});
    return run;
  }

  async turn(sys, prompt, timeoutMs, opts = {}) {
    const why = !this.alive() ? 'none running' : this.sysHash !== hash(sys, opts) ? 'rules, digest or model changed'
      : this.day !== day() ? 'new day' : this.turns >= this.maxTurns ? `${this.turns} turns` : '';
    if (why) { this.log(`${this.name}: (re)start: ${why}`); this.start(sys, opts); }
    const c = this.child, t0 = performance.now(), fresh = this.turns === 0;
    this.lastUse = Date.now();
    try {
      const text = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timeout after ${timeoutMs} ms`)), timeoutMs);
        const done = (f) => (v) => { clearTimeout(timer); this.waiter = null; f(v); };
        this.waiter = { child: c, resolve: done(resolve), reject: done(reject) };
        c.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } }) + '\n');
      });
      this.turns++;
      const ms = Math.round(performance.now() - t0);
      this.log(`${this.name}: turn ${this.turns} (gen ${this.gen}${fresh ? ', fresh' : ''}) ${ms} ms`);
      if (this.turns >= this.maxTurns) setImmediate(() => { if (!this.waiter) this.start(sys, opts); });   // next message finds it warm
      return { text, ms, turn: this.turns, gen: this.gen, fresh };
    } catch (e) {
      this.log(`${this.name}: turn failed: ${e.message}`);
      this.kill('failed turn');   // a half-answered turn would leak into the next one
      throw e;
    }
  }
}

// nova-warm-owner / nova-warm-<first name> (being-handle sends the name; this is the fallback).
export function warmName(lane = 'owner', name = '') {
  if (name) return name;
  const p = (process.env.BEING_NAME || 'being').toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return `${p}-warm-${lane === 'owner' ? 'owner' : 'team-' + createHash('sha1').update(lane.slice(5)).digest('hex').slice(0, 10)}`;
}

const hash = (s, o = {}) => createHash('sha256').update(`${o.model || ''}\n${o.effort || ''}\n${s}`).digest('hex').slice(0, 16);

// ---------- daemon ----------
async function serve() {
  const STATE = process.env.BEING_STATE_DIR || (console.error('BEING_STATE_DIR not set'), process.exit(1));
  const SOCK = path.join(STATE, 'fast-warm.sock'), PID = path.join(STATE, 'fast-warm.pid'), LOG = path.join(STATE, 'fast-warm.log');
  const cwd = path.join(STATE, 'fast-cwd'); mkdirSync(cwd, { recursive: true });
  const log = (m) => appendFileSync(LOG, `${ts()} ${m}\n`);
  if (await reachable(SOCK)) { console.error('fast-warm: already running'); process.exit(0); }
  try { unlinkSync(SOCK); } catch { /* none */ }
  const cmd = process.env.BEING_FAST_WARM_CMD || process.env.BEING_CLAUDE_BIN || 'claude';
  const env = { ...process.env, ENABLE_CLAUDEAI_MCP_SERVERS: 'false', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' };
  const dflt = { model: process.env.BEING_FAST_MODEL || 'haiku', effort: process.env.BEING_FAST_EFFORT || '' };
  const errFd = openSync(path.join(STATE, 'fast.log'), 'a');
  // Session registry (being-sessions): each lane process is listed by name while it runs, and marked ended when it exits.
  const sessions = path.join(path.dirname(fileURLToPath(import.meta.url)), 'being-sessions');
  const reg = (...a) => { try { spawn('python3', [sessions, ...a], { stdio: 'ignore' }).on('error', () => {}); } catch { /* registry is best effort */ } };
  const spawnFn = (sys, o) => {
    const opts = { model: o.model || dflt.model, effort: o.effort ?? dflt.effort, sessionId: randomUUID(), name: warmName(o.lane, o.name) };   // effort '' = the model's default
    log(`spawn ${opts.model} / ${opts.effort || 'default effort'} as ${opts.name}`);
    const c = spawn(cmd, claudeArgs(sys, opts), { cwd, env, stdio: ['pipe', 'pipe', errFd] });
    if (c.pid) {
      reg('register', '--name', opts.name, '--lane', o.lane || 'owner', '--kind', 'warm', '--pid', String(c.pid), '--sid', opts.sessionId);
      c.on('exit', () => reg('end', '--name', opts.name, '--pid', String(c.pid)));
    }
    return c;
  };
  const maxTurns = Number(process.env.BEING_FAST_WARM_TURNS || 30);
  const lanes = new Map();
  const lane = (n) => lanes.get(n) || lanes.set(n, new Lane(n, spawnFn, { maxTurns, log })).get(n);

  const server = net.createServer((sock) => {
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('error', () => {});
    sock.on('data', async (d) => {
      buf += d;
      const i = buf.indexOf('\n'); if (i < 0) return;
      let req; try { req = JSON.parse(buf.slice(0, i)); } catch { return sock.end(JSON.stringify({ ok: false, error: 'bad request' }) + '\n'); }
      buf = '';
      try {
        if (!/^(owner|team:[^\s/]+)$/.test(req.lane || '')) throw new Error('bad lane');
        const l = lane(req.lane), sys = String(req.sys || '');
        const o = { model: /^[\w.-]{1,64}$/.test(req.model || '') ? req.model : '', effort: /^[a-z]{0,16}$/.test(req.effort ?? '') ? (req.effort ?? '') : '',
          name: /^[a-z0-9][a-z0-9-]{0,47}$/.test(req.name || '') ? req.name : '' };
        const r = req.prewarm ? await l.prewarm(sys, o) : await l.ask(sys, String(req.prompt || ''), Number(req.timeoutMs) || 10000, o);
        sock.end(JSON.stringify({ ok: true, ...r }) + '\n');
      } catch (e) { sock.end(JSON.stringify({ ok: false, error: e.message }) + '\n'); }
    });
  });
  server.listen(SOCK, () => { chmodSync(SOCK, 0o600); writeFileSync(PID, String(process.pid)); log(`daemon up (pid ${process.pid})`); });
  // Idle lanes give their process back: teammate lanes after BEING_FAST_WARM_IDLE_MIN (120), the owner's after 6 h.
  const idle = Number(process.env.BEING_FAST_WARM_IDLE_MIN || 120) * 60e3;
  setInterval(() => {
    for (const l of lanes.values()) {
      if (!l.alive() || l.waiter) continue;
      if (l.day !== day()) l.kill('day rollover');
      else if (Date.now() - l.lastUse > (l.name === 'owner' ? 6 * 3600e3 : idle)) l.kill('idle');
    }
  }, 60e3).unref();
  const bye = () => { for (const l of lanes.values()) l.kill('daemon exit'); try { unlinkSync(SOCK); } catch { /* gone */ } process.exit(0); };
  process.on('SIGTERM', bye); process.on('SIGINT', bye); process.on('SIGHUP', bye);
}

const reachable = (sock) => new Promise((res) => {
  const c = net.connect(sock); c.on('connect', () => { c.end(); res(true); }); c.on('error', () => res(false));
});

// ---------- client ----------
export function ask(sock, req, timeoutMs) {
  return new Promise((resolve) => {
    const c = net.connect(sock); let buf = '';
    const timer = setTimeout(() => { c.destroy(); resolve({ ok: false, code: 3, error: 'client timeout' }); }, timeoutMs + 1500);
    c.setEncoding('utf8');
    c.on('connect', () => c.write(JSON.stringify(req) + '\n'));
    c.on('data', (d) => { buf += d; });
    c.on('end', () => { clearTimeout(timer); try { resolve({ code: 3, ...JSON.parse(buf) }); } catch { resolve({ ok: false, code: 3, error: 'bad reply' }); } });
    c.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, code: 2, error: `no daemon (${e.code || e.message})` }); });
  });
}

const envModel = () => ({ model: process.env.BEING_FAST_MODEL || 'haiku', effort: process.env.BEING_FAST_EFFORT || '' });
const [mode, ...rest] = process.argv.slice(2);
if (mode === 'serve') serve();
else if (mode === 'prewarm') {
  const sock = path.join(process.env.BEING_STATE_DIR || '.', 'fast-warm.sock');
  const r = await ask(sock, { lane: rest[0], prewarm: true, sys: readFileSync(rest[1], 'utf8'), name: rest[2] || '', ...envModel() }, 5000);
  if (!r.ok) { console.error(`fast-warm: ${r.error}`); process.exit(r.code || 3); }
} else if (mode === 'ask') {
  const [lane, tms, sysFile] = rest;
  const timeoutMs = Number(tms) || 10000;
  const sock = path.join(process.env.BEING_STATE_DIR || '.', 'fast-warm.sock');
  if (!existsSync(sock)) { console.error('fast-warm: no daemon'); process.exit(2); }
  const r = await ask(sock, { lane, timeoutMs, sys: readFileSync(sysFile, 'utf8'), prompt: readFileSync(0, 'utf8'), ...envModel() }, timeoutMs);
  if (!r.ok) { console.error(`fast-warm: ${r.error}`); process.exit(r.code || 3); }
  console.error(`fast-warm: ${lane} turn ${r.turn} gen ${r.gen}${r.fresh ? ' fresh' : ''} ${r.ms} ms`);
  process.stdout.write(r.text);
}
