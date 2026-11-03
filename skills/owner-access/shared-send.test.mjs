// Offline CLI integration: real approval and ledger code, inert transport and isolated fixture state.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const source = path.dirname(fileURLToPath(import.meta.url));
const addr = (role) => [role, ['example', 'invalid'].join('.')].join(String.fromCharCode(64));
function setup(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'shared-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const f of ['shared-mailbox-drafts.mjs', 'owner-session.mjs', 'go-approval.mjs', 'manifest-set.mjs', 'mailbox-lib.mjs', 'ledger.mjs']) copyFileSync(path.join(source, f), path.join(dir, f));
  const put = (f, s) => writeFileSync(path.join(dir, f), s);
  const state = path.join(dir, 'fixture');
  mkdirSync(path.join(state, 'owner-access', 'shared-mailbox'), { recursive: true });
  const config = { shared_mailbox: { address: addr('shared'), send_gap_seconds: 0 } };
  const env = { BEING_STATE_DIR: state, BEING_UPN: addr('being'), OWNER_UPN: addr('owner'), BEING_CACHE: 'being', OWNER_CACHE: 'owner' };
  put('oa-env.mjs', '');
  put('kit-env.mjs', `export const kitEnv=()=>(${JSON.stringify(env)}); export const ownerDelegate=()=>true; export const mailCache=()=>'';`);
  put('scope.mjs', "export const currentScope=()=>({why:'grant',scope:'owner-only'});");
  put('comms-log.mjs', 'export const logComms=()=>{};');
  put('sessions.mjs', "export const SCOPES={being:{teams:[],outlook:[]},owner:{outlook:[]}}; export const checkStamp=()=>null; export const separationProblems=()=>[];");
  put('oa-config.mjs', `export const KIT=${JSON.stringify(dir)}; export const loadConfig=()=>(${JSON.stringify(config)}); export const abilityOn=()=>true; export const paused=()=>false; export const pauseFile=()=>''; export const approversFor=()=>new Set([${JSON.stringify(addr('approver'))}]);`);
  put('browser-route.mjs', "export const routeFor=()=> 'graph';");
  put('owner-browser.mjs', 'export const outlookFromBrowser=()=>{throw Error("unexpected browser");};');
  put('guards.mjs', "import {g} from './graph.mjs'; export const guardedGraph=()=>g; export const draftsRoute=()=>true; export const browserRequestAllowed=()=>false; export const OUTLOOK_API='';");
  put('teams-send-dm.mjs', 'process.exit(0);');
  const rows = ['first', 'second', 'third'].map((id) => ({ id, subject: id, to: [addr(id)], cc: [], attachment: '' }));
  const files = rows.map((r) => {
    const file = path.join(dir, `${r.id}.json`);
    writeFileSync(file, JSON.stringify({ batch: r.id, mailbox: addr('shared'), created: new Date(Date.now() - 60000).toISOString(), rows: [r] }));
    return file;
  });
  writeFileSync(path.join(state, 'owner-access', 'shared-mailbox', `${addr('shared')}-own.jsonl`), rows.map((r) => JSON.stringify(r)).join('\n')+'\n');
  put('fixture.json', JSON.stringify({ state, rows, box: addr('shared'), being: addr('being'), approver: addr('approver') }));
  put('graph.mjs', `
import {readFileSync,writeFileSync,appendFileSync,existsSync} from 'node:fs';
import path from 'node:path';
const dir=path.dirname(new URL(import.meta.url).pathname), f=JSON.parse(readFileSync(path.join(dir,'fixture.json')));
const saved=path.join(dir,'prompt.json'), sent=path.join(dir,'sent.txt');
const members=[{userId:'approver',email:f.approver},{userId:'being',email:f.being}];
export const standby=()=>false;
export const fail=(m)=>{throw Error(m)};
export const connect=async()=>({g,me:{},token:'inert'});
export async function g(url, opts={}) {
 if(url.startsWith('/me/chats')) return {value:[{id:'conversation',chatType:'oneOnOne',members}]};
 if(url.endsWith('/members')) return {value:members};
 if(url.endsWith('/messages') && opts.body) {
  const p={id:'preview',createdDateTime:new Date().toISOString(),from:{user:{id:'being'}},body:opts.body.body};
  writeFileSync(saved,JSON.stringify(p)); return p;
 }
 if(url.endsWith('/messages/preview')) return JSON.parse(readFileSync(saved));
 if(url.endsWith('/messages/approval')) return JSON.parse(readFileSync(path.join(dir,'approval.json')));
 if(url.startsWith('/chats/')) return {id:'conversation',chatType:'oneOnOne'};
 if(url.includes('/mailFolders/drafts')) return {id:'draft-folder'};
 if(url.includes('/mailFolders/sentitems')) {
  if(f.advance) { const time=Date.now()+f.advance; Date.now=()=>time; f.advance=0; }
  const ids=existsSync(sent)?readFileSync(sent,'utf8').trim().split('\\n'):[];
  return {value:f.rows.filter(r=>ids.includes(r.id)).map(r=>({subject:r.subject,toRecipients:r.to.map(address=>({emailAddress:{address}})),ccRecipients:[]}))};
 }
 if(url.endsWith('/send')) {appendFileSync(sent,url.split('/').at(-2)+'\\n');return {};}
 if(url.includes('/attachments')) return {value:[]};
 const id=url.split('/').at(-1).split('?')[0], r=f.rows.find(r=>r.id===id);
 if(r) return {id:r.id,subject:r.subject,toRecipients:r.to.map(address=>({emailAddress:{address}})),ccRecipients:[],isDraft:true,parentFolderId:'draft-folder',from:{emailAddress:{address:f.box}}};
 throw Error('unexpected fixture request');
}
`);
  const run = (args) => spawnSync(process.execPath, [path.join(dir, 'shared-mailbox-drafts.mjs'), ...args], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  const planned = run(['plan-set', ...files.flatMap((f) => ['--manifest', f]), '--approver-id', 'approver']);
  assert.equal(planned.status, 0, planned.stderr);
  const approve = (ago = 0) => put('approval.json', JSON.stringify({ id: 'approval', from: { user: { id: 'approver' } }, body: { content: 'SEND' }, createdDateTime: new Date(Date.now() - ago).toISOString() }));
  approve();
  const send = (extra = []) => run(['send', '--preview', path.join(state, 'batches', 'B1.json'), '--go-chat', 'conversation', '--go-msg', 'approval', ...extra]);
  return { dir, files, send, approve, put };
}

test('CLI plans several manifests, consumes one SEND, sends each once and rejects replay', (t) => {
  const f = setup(t), r = f.send();
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(readFileSync(path.join(f.dir, 'sent.txt'), 'utf8').trim().split('\n'), ['first', 'second', 'third']);
  assert.notEqual(f.send().status, 0);
});

test('CLI refuses a changed manifest before sending', (t) => {
  const f = setup(t); writeFileSync(f.files[0], readFileSync(f.files[0], 'utf8') + '\n');
  const r = f.send(); assert.notEqual(r.status, 0); assert.match(r.stderr, /manifest set changed/);
});

test('CLI refuses an approval queued longer than 24 hours', (t) => {
  const f = setup(t); f.approve(25 * 3600e3);
  const r = f.send(); assert.notEqual(r.status, 0); assert.match(r.stderr, /older than/);
});

test('CLI rechecks expiry after approval was accepted but before the send', (t) => {
  const f = setup(t);
  const fixture = JSON.parse(readFileSync(path.join(f.dir, 'fixture.json')));
  fixture.advance = 25 * 3600e3;
  f.put('fixture.json', JSON.stringify(fixture));
  const r = f.send();
  assert.notEqual(r.status, 0); assert.match(r.stderr, /older than 24h at actual send time/);
});
