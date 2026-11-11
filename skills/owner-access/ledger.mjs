// Batch manifests and append-only ledgers for as-owner batches (shared-mailbox sends, channel posts).
// A ledger line is written right after each action, so a rerun never repeats one; "started" without "done" stops the run.
import { createHash } from 'node:crypto';
import { open, readFile, unlink } from 'node:fs/promises';

export const sha256 = (v) => createHash('sha256').update(v).digest('hex');
const canon = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x)
  ? Object.fromEntries(Object.keys(x).sort().map((key) => [key, x[key]])) : x));
// Short fingerprint the approver types with the go ("go <batch> <fp>"): any change to the batch changes it.
export const fingerprint = (manifest) => sha256(canon(manifest)).slice(0, 12);

export const BATCH_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

// Plan = the batch's operations with stable ids; the ledger only accepts rows for this plan's digest.
export function planOf(batch, operations) {
  if (!BATCH_RE.test(batch || '')) throw new Error('batch name must be 1-64 letters, digits, dot, dash or underscore');
  const ids = new Set();
  const ops = operations.map((op) => {
    const id = op.id || sha256(canon({ batch, ...op })).slice(0, 24);
    if (ids.has(id)) throw new Error(`duplicate operation ${id}`);
    ids.add(id);
    return { ...op, id };
  });
  return { batch, operations: ops, digest: sha256(canon({ batch, ops })) };
}

export function parseLedger(text, plan) {
  if (text && !text.endsWith('\n')) throw new Error('ledger ends in a partial line; check it by hand before any rerun');
  const records = new Map(), allowed = new Set(plan.operations.map((o) => o.id));
  for (const line of text.split('\n').filter(Boolean)) {
    const row = JSON.parse(line);
    if (row.plan !== plan.digest || !allowed.has(row.id) || !['started', 'done'].includes(row.state)) throw new Error('ledger does not match this batch');
    if (records.get(row.id)?.state === 'done' && row.state !== 'done') throw new Error('ledger state went backwards');
    records.set(row.id, { ...records.get(row.id), ...row });
  }
  return records;
}

// Runs fn(ledger) under an exclusive lock file; ledger.put(op, state, extra) appends and fsyncs one row.
export async function withLedger(file, plan, fn) {
  const lock = await open(`${file}.lock`, 'wx', 0o600).catch((e) => {
    if (e.code === 'EEXIST') throw new Error(`${file}.lock exists: another run is active or one died; check, then remove it`);
    throw e;
  });
  let fh;
  try {
    const text = await readFile(file, 'utf8').catch((e) => { if (e.code !== 'ENOENT') throw e; return ''; });
    const records = parseLedger(text, plan);
    fh = await open(file, 'a', 0o600);
    const ledger = {
      records,
      async put(op, state, extra = {}) {
        const row = { ...records.get(op.id), ...extra, plan: plan.digest, batch: plan.batch, id: op.id, kind: op.kind, state, at: new Date().toISOString() };
        await fh.writeFile(JSON.stringify(row) + '\n');
        await fh.sync();
        records.set(op.id, row);
      },
    };
    return await fn(ledger);
  } finally { await fh?.close(); await lock.close(); await unlink(`${file}.lock`); }
}

// Pending operations; refuses when one was started but never confirmed (the caller must reconcile it first).
export function pendingOps(plan, records, { reconciled = new Set() } = {}) {
  const uncertain = plan.operations.filter((o) => records.get(o.id)?.state === 'started' && !reconciled.has(o.id));
  if (uncertain.length) throw new Error(`unconfirmed action(s) from an earlier run: ${uncertain.map((o) => o.title || o.id).join(', ')}; reconcile first`);
  return plan.operations.filter((o) => records.get(o.id)?.state !== 'done');
}
