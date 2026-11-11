#!/usr/bin/env node
// kit-client: the model side of kit-broker, installed as shims named like the kit commands (the verb = the file name).
// Holds no token; files cross the broker socket as bytes in both directions (isolation/README.md).
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const VERB_OF = { 'teams-send-dm.mjs': 'teams-send-dm', 'teams-fetch-attachment.mjs': 'teams-fetch-attachment', 'mail.mjs': 'mail',
  'draft-for-owner.mjs': 'draft-for-owner' };
const IN_FLAGS = { mail: { '--attach': 'list', '--inline': 'cid' }, 'draft-for-owner': { '--attach': 'list' } };
const OUT_FLAGS = { 'teams-fetch-attachment': ['--out'], mail: ['--save'] };

const base = path.basename(process.argv[1] || '');
const verb = process.env.KIT_CLIENT_VERB || VERB_OF[base] || base.replace(/\.(mjs|py)$/, '');
// --flag=VALUE → --flag VALUE for file flags, as kit-broker splits them, so the file indexes below match its own.
const fileFlag = (f) => f in (IN_FLAGS[verb] || {}) || (OUT_FLAGS[verb] || []).includes(f);
const args = process.argv.slice(2).flatMap((a) => {
  const i = a.indexOf('=');
  return a.startsWith('--') && i > 0 && fileFlag(a.slice(0, i)) ? [a.slice(0, i), a.slice(i + 1)] : [a];
});
const sock = process.env.BEING_BROKER_SOCK || '/run/kit/broker.sock';

const filesIn = {};
let outDir = null;
args.forEach((a, i) => {
  const prev = args[i - 1];
  const kind = (IN_FLAGS[verb] || {})[prev];
  if (kind) {
    filesIn[String(i)] = a.split(',').map((x) => x.trim()).filter(Boolean).map((spec) => {
      const eq = kind === 'cid' ? spec.lastIndexOf('=') : -1, f = eq > 0 ? spec.slice(0, eq) : spec;   // path=cid
      return { name: path.basename(f), b64: fs.readFileSync(f).toString('base64'), ...(eq > 0 && { cid: spec.slice(eq + 1) }) };
    });
  }
  if ((OUT_FLAGS[verb] || []).includes(prev)) outDir = path.resolve(a);
});
// Default save dir: ./attachments, but a sandboxed lane's cwd (the workspace) is read-only, so fall back to $HOME/attachments
// and then the temp dir.
const writableDir = (dirs) => {
  for (const d of dirs) {
    try { fs.mkdirSync(d, { recursive: true }); fs.accessSync(d, fs.constants.W_OK); return d; } catch { /* next */ }
  }
  return null;
};
if (verb === 'teams-fetch-attachment' && !outDir) {
  outDir = writableDir([path.resolve('attachments'), process.env.HOME && path.join(process.env.HOME, 'attachments'),
    path.join(os.tmpdir(), 'attachments')].filter(Boolean));
}
// Saved files: the command prints the broker's own temp paths; those do not exist on this side, so its stdout is held and
// those paths are rewritten to where the files were saved here.
const holdOut = !!OUT_FLAGS[verb];
let held = Buffer.alloc(0);

const frame = (t, buf) => { const h = Buffer.alloc(5); h.write(t, 0, 'latin1'); h.writeUInt32BE(buf.length, 1); return Buffer.concat([h, buf]); };
const c = net.createConnection(sock);
let connected = false, gotExit = false;
// The broker may answer and close before all of stdin is written (a refusal, or a command that ignores stdin): EPIPE /
// ECONNRESET after connecting is not a failure; what the broker sent is read and its exit code used.
c.on('error', (e) => {
  if (connected && ['EPIPE', 'ECONNRESET'].includes(e.code)) return;
  process.stderr.write(`kit-client: broker unreachable (${sock}): ${e.code || e.message}\n`); process.exit(4);
});
c.on('connect', () => {
  connected = true;
  c.write(frame('H', Buffer.from(JSON.stringify({ verb, args, files_in: filesIn }))));
  if (process.stdin.isTTY) { c.write(frame('E', Buffer.alloc(0))); return; }
  process.stdin.on('data', (d) => { if (!c.destroyed && c.writable) c.write(frame('I', d)); });
  const end = () => { if (!c.destroyed && c.writable) c.write(frame('E', Buffer.alloc(0))); };
  process.stdin.on('end', end); process.stdin.on('error', end);
});

let buf = Buffer.alloc(0), rc = 4;
const saved = [];
c.on('data', (d) => {
  buf = Buffer.concat([buf, d]);
  while (buf.length >= 5) {
    const t = buf.toString('latin1', 0, 1), n = buf.readUInt32BE(1);
    if (buf.length < 5 + n) break;
    const p = buf.subarray(5, 5 + n); buf = buf.subarray(5 + n);
    if (t === 'O') { if (holdOut) held = Buffer.concat([held, p]); else process.stdout.write(p); }
    else if (t === 'R') process.stderr.write(p);
    else if (t === 'F') {
      const f = JSON.parse(p);
      // A named dir that cannot be written here (a read-only workspace path) falls back like the default does.
      if (!writableDir([outDir || '.'])) outDir = writableDir([process.env.HOME && path.join(process.env.HOME, 'attachments'),
        path.join(os.tmpdir(), 'attachments')].filter(Boolean)) || '.';
      const dst = path.join(outDir || '.', path.basename(f.name)); fs.writeFileSync(dst, Buffer.from(f.b64, 'base64')); saved.push(dst);
    } else if (t === 'X') {
      const x = JSON.parse(p); rc = x.rc; gotExit = true; c.end();
      if (holdOut) {
        let text = held.toString('utf8');
        if (x.tmp && outDir) text = text.split(x.tmp + '/').join(outDir + '/').split(x.tmp).join(outDir);
        process.stdout.write(text);
      }
      if (saved.length) process.stderr.write(`kit-client: saved ${saved.join(', ')}\n`);
    }
  }
});
c.on('close', () => { if (!gotExit) process.stderr.write('kit-client: broker closed without an exit code\n'); process.exit(rc); });
