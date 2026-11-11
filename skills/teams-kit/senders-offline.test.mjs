// Offline refusals of the newer sender options: each exits before any sign-in (needs npm install for graph.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const KIT = path.dirname(fileURLToPath(import.meta.url));
const skip = !existsSync(path.join(KIT, 'node_modules', '@azure', 'msal-node')) && 'npm install first';

test('send-as, image, group, shared-mailbox and owner-lane tools refuse before signing in', { skip }, (t) => {
  const d = mkdtempSync(path.join(tmpdir(), 'snd-'));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  writeFileSync(path.join(d, 'x.png'), 'not an image');
  const env = { PATH: process.env.PATH, HOME: d, BEING_UPN: 'nova@example.test', BEING_CACHE: path.join(d, 'c.json'), BEING_STATE_DIR: d,
    OWNER_UPN: 'sam@example.test', M365_CLIENT_ID: 'x', M365_TENANT_ID: 'y' };
  const run = (script, args, input = '') => spawnSync(process.execPath, [path.join(KIT, script), ...args], { input, env, encoding: 'utf8' });
  const cases = [
    ['teams-send-dm.mjs', ['--as', 'kim@example.test', '--draft', 'D1'], 3, /BEING_ALLOW_SEND_AS/],
    ['teams-send-dm.mjs', ['--as', 'kim@example.test'], 2, /needs --draft/],
    ['teams-send-dm.mjs', ['--as', 'kim@example.test', '--draft', 'D1', '--chat', 'c'], 2, /only the approved draft/],
    ['teams-send-dm.mjs', ['--image', path.join(d, 'x.png')], 2, /PNG, JPEG or GIF/],
    ['teams-send-dm.mjs', ['--group', 'a@example.test,b@example.test'], 2, /--topic/],
    ['teams-send-dm.mjs', ['--topic', 'x'], 2, /goes with --group/],
    ['mail.mjs', ['--mailbox', 'shared@example.test', '--list'], 3, /BEING_SHARED_MAILBOXES/],
    ['mail.mjs', ['--mailbox', 'shared@example.test', '--send'], 2, /read-only/],
    ['docs-index-cli.mjs', ['refresh'], 2, /BEING_DOCS_INDEX/],
    ['set-photo.mjs', [path.join(d, 'x.png')], 2, /PNG or JPEG/],
    ['onedrive.mjs', ['bogus'], 2, /usage/],
  ];
  for (const [script, args, code, re] of cases) {
    const r = run(script, args, 'hi');
    assert.equal(r.status, code, `${script} ${args.join(' ')}: ${r.stderr}`);
    assert.match(r.stderr, re, `${script} ${args.join(' ')}`);
  }
});
