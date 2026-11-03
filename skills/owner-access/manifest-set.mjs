// Seals exact file bytes and membership; runtime state is deliberately outside the seal.
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { sha256 } from './ledger.mjs';
import { validateManifest } from './mailbox-lib.mjs';

export function sealManifests(files) {
  if (!files.length) throw new Error('at least one manifest is required');
  const batches = new Set(), drafts = new Set();
  const entries = files.map((file) => {
    const name = path.resolve(file), target = realpathSync(name), bytes = readFileSync(name), manifest = validateManifest(JSON.parse(bytes));
    if (batches.has(manifest.batch)) throw new Error('duplicate batch');
    batches.add(manifest.batch);
    for (const row of manifest.rows) {
      const key = `${manifest.mailbox}\n${row.id}`;
      if (drafts.has(key)) throw new Error('duplicate draft across manifests');
      drafts.add(key);
    }
    return { file: name, target, sha256: sha256(bytes), manifest };
  }).sort((a, b) => a.file.localeCompare(b.file));
  if (new Set(entries.map((e) => e.manifest.mailbox)).size !== 1) throw new Error('manifests must use one mailbox');
  return { entries, digest: sha256(JSON.stringify(entries.map(({ file, target, sha256 }) => ({ file, target, sha256 })))) };
}

export function checkManifestSet(preview, files = preview.entries.map((e) => e.file)) {
  const current = sealManifests(files);
  if (current.digest !== preview.digest || JSON.stringify(current.entries) !== JSON.stringify(preview.entries)) {
    throw new Error('manifest set changed after preview; create a fresh preview and SEND');
  }
  return current.entries.map((e) => e.manifest);
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export function renderManifestSet(p) {
  const count = p.entries.reduce((n, e) => n + e.manifest.rows.length, 0);
  return `<p>Shared mailbox batch ${esc(p.id)}: ${p.entries.length} batches, ${count} mails total.</p>`
    + p.entries.map(({ manifest: m }) => `<p>${esc(m.batch)}: ${m.rows.length} mails<br>`
      + m.rows.map((r) => `${esc(r.to.join(', '))}${r.cc.length ? `; cc ${esc(r.cc.join(', '))}` : ''} — ${esc(r.subject)}`).join('<br>') + '</p>').join('')
    + `<p>Set fingerprint ${p.digest}. Reply SEND to approve exactly this set. Approval expires 24h after your message; a delayed send needs fresh approval.</p>`;
}

const visible = (s) => String(s || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
export function checkSetApproval({ preview, prompt, msg, chat, members, beingUpn }) {
  checkManifestSet(preview);
  if (chat.id !== preview.promptChatId || msg.from?.user?.id !== preview.approverId) throw new Error('SEND is not from the configured preview approver in the preview chat');
  const being = members.find((m) => String(m.email).toLowerCase() === beingUpn)?.userId;
  if (!being || prompt?.from?.user?.id !== being || prompt.from?.application || prompt.deletedDateTime || prompt.lastEditedDateTime) throw new Error('preview missing, edited or not posted by the Being');
  if (!(Date.parse(prompt.createdDateTime) <= Date.parse(msg.createdDateTime))) throw new Error('SEND predates preview');
  if (visible(prompt.body?.content) !== visible(renderManifestSet(preview))) throw new Error('preview content does not match manifest set');
  if (visible(msg.body?.content) !== 'SEND') throw new Error('approval must be exactly SEND');
}
