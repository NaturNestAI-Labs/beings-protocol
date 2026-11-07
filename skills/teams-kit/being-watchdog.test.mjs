// being-watchdog: a job that only waits its turn is not stuck; a stalled one gets one alert naming its last tool action,
// including a run job that resumes a Claude session. Throwaway kit and state; the sender is a stub that records alerts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const KIT = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function kit(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'wd-'));
  const k = path.join(dir, 'kit'), st = path.join(dir, 'state'), ws = path.join(dir, 'ws'), home = path.join(dir, 'home');
  for (const d of [k, path.join(st, 'jobs'), ws, home]) mkdirSync(d, { recursive: true });
  copyFileSync(path.join(KIT, 'being-watchdog'), path.join(k, 'being-watchdog'));
  copyFileSync(path.join(KIT, 'being-blocker'), path.join(k, 'being-blocker')); chmodSync(path.join(k, 'being-blocker'), 0o755);
  writeFileSync(path.join(k, 'teams-send-dm.mjs'),
    `import fs from 'fs'; if (fs.existsSync(${JSON.stringify(path.join(dir, 'fail'))})) process.exit(1);\n`
    + `fs.appendFileSync(${JSON.stringify(path.join(dir, 'alerts.txt'))}, fs.readFileSync(0, 'utf8') + '\\n---\\n');\n`);
  writeFileSync(path.join(k, '.env'), `BEING_NAME=testbeing\nBEING_STATE_DIR=${st}\nBEING_WORKSPACE=${ws}\nBEING_STALL_MIN=0\n`);
  const procs = [];
  t.after(() => { for (const p of procs) { try { process.kill(-p.pid, 'SIGKILL'); } catch { /* gone */ } } rmSync(dir, { recursive: true, force: true }); });
  const host = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(BEING_|OWNER_|M365_)/.test(key)));
  const env = { ...host, HOME: home };
  const claudeDir = path.join(home, '.claude', 'projects', ws.replace(/[/.]/g, '-'));
  const job = (id, o, script) => {
    writeFileSync(path.join(st, 'jobs', id + '.json'), JSON.stringify({ id, kind: 'run', name: id, status: 'running',
      started: new Date(Date.now() - 3600e3).toISOString(), payload: [], ...o }));
    // Stands in for `being-job __exec <id>`: the watchdog finds a job's tree by that command line.
    const p = spawn('bash', ['-c', script + '; true', 'being-job', '__exec', id], { detached: true, stdio: 'ignore' });
    procs.push(p); return p;
  };
  const run = () => spawnSync('python3', [path.join(k, 'being-watchdog')], { env, encoding: 'utf8' });
  const alerts = () => (existsSync(path.join(dir, 'alerts.txt')) ? readFileSync(path.join(dir, 'alerts.txt'), 'utf8') : '');
  return { dir, st, claudeDir, job, run, alerts };
}

test('a job that only sleeps in a wait loop is queued, not stuck: no alert', async (t) => {
  const { job, run, alerts } = kit(t);
  job('0101-000000-queued', {}, 'while true; do sleep 600; done');
  await sleep(300);
  for (let i = 0; i < 3; i++) { const r = run(); assert.equal(r.status, 0, r.stderr); await sleep(1100); }
  assert.equal(alerts(), '');
});

test('a stalled job gets one alert with the last tool action, from the session a run job resumes', async (t) => {
  const { claudeDir, job, run, alerts } = kit(t);
  const sid = '11111111-2222-3333-4444-555555555555';
  mkdirSync(claudeDir, { recursive: true });
  const tx = path.join(claudeDir, sid + '.jsonl');
  writeFileSync(tx, JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { content: [
    { type: 'tool_use', name: 'Bash', input: { command: 'make <deploy>' } }] } }) + '\n');
  job('0101-000000-stalled', { payload: ['claude', '--resume', sid, '-p', 'go on'] }, 'tail -f /dev/null');   // alive, idle, not a wait loop
  await sleep(300);
  // Idle = CPU unchanged between two checks; under load the process start can take a few checks to settle.
  for (let i = 0; i < 10 && !alerts(); i++) { run(); await sleep(1100); }
  run();
  const a = alerts();
  assert.equal(a.split('---').filter((x) => x.trim()).length, 1, a);   // once only
  assert.match(a, /Needs a look: job “0101-000000-stalled”/);
  assert.match(a, /Last action: <code>Bash: make &lt;deploy&gt;<\/code>/);
});

const gone = (st, id, o = {}) => writeFileSync(path.join(st, 'jobs', id + '.json'), JSON.stringify({ id, kind: 'run', name: id,
  status: 'running', started: new Date(Date.now() - 3600e3).toISOString(), ...o }));
const recOf = (st, id) => JSON.parse(readFileSync(path.join(st, 'jobs', id + '.json'), 'utf8'));
const blockers = (st) => (existsSync(path.join(st, 'blockers.jsonl'))
  ? readFileSync(path.join(st, 'blockers.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

test('a job whose process is gone is marked died, with a reason, and raises one blocker', async (t) => {
  const { st, run, alerts } = kit(t);
  const id = '0101-000000-vanished';
  gone(st, id);
  run(); run();
  assert.equal(recOf(st, id).status, 'died'); assert.equal(recOf(st, id).exit, -1);
  assert.match(recOf(st, id).reason, /empty logs/);
  const b = blockers(st);
  assert.equal(b.length, 1, JSON.stringify(b)); assert.match(b[0].task, /stopped unexpectedly/); assert.match(b[0].need, new RegExp(id));
  assert.match(alerts(), /Stuck: Job .*stopped unexpectedly/);
  assert.equal(alerts().split('---').filter((x) => x.trim()).length, 1);
});

test('died: a job started from a unit without its own scope names the unit and KillMode; its own stderr wins', async (t) => {
  const { st, run } = kit(t);
  gone(st, '0101-000000-unit', { started_in: 'nova-routine@brief.service', own_scope: 'no' });
  gone(st, '0101-000000-said', { started_in: 'x.service', own_scope: 'no' });
  writeFileSync(path.join(st, 'jobs', '0101-000000-said.exec.log'), 'node: out of memory\n');
  run();
  assert.match(recOf(st, '0101-000000-unit').reason, /nova-routine@brief\.service.*KillMode=process/);
  assert.match(recOf(st, '0101-000000-said').reason, /exec\.log: node: out of memory/);
  assert.equal(blockers(st).length, 2);
});

test('died: when the owner alert cannot be sent, the next check retries it once, with no second blocker line', async (t) => {
  const { dir, st, run, alerts } = kit(t);
  const id = '0101-000000-unsent';
  gone(st, id);
  writeFileSync(path.join(dir, 'fail'), '');
  run();
  assert.equal(recOf(st, id).status, 'died'); assert.equal(alerts(), '');
  rmSync(path.join(dir, 'fail'));
  run(); run();
  assert.equal(alerts().split('---').filter((x) => x.trim()).length, 1, alerts());
  assert.match(alerts(), new RegExp(`stopped unexpectedly.*${id}`, 's'));
  assert.equal(blockers(st).length, 1);
});
