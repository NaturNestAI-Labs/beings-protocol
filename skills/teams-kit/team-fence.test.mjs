// team-fence.py: what a teammate-lane run may and may not touch. The hook gets the tool call on stdin as Claude Code sends
// it; exit 2 = refused. Run against a throwaway workspace (the paths only need to look real).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { hostEnv } from './test-env.mjs';
const KIT = path.dirname(fileURLToPath(import.meta.url));

function fence(t) {
  const ws = mkdtempSync(path.join(tmpdir(), 'fence-'));
  t.after(() => rmSync(ws, { recursive: true, force: true }));
  mkdirSync(path.join(ws, '.beings', 'memory'), { recursive: true }); mkdirSync(path.join(ws, 'work-log'));
  const mg = path.join(ws, '.beings', 'memory-graph'); mkdirSync(mg);
  writeFileSync(path.join(mg, 'hive-mind-design-2026-10-12.md'), '---\ntitle: Hive mind design\nshare: team\n---\nbody');
  writeFileSync(path.join(mg, 'Product Strategy (Sam, 2026-07-27).md'), '---\ntitle: x\nshare: team\n---\nbody');
  writeFileSync(path.join(mg, 'deal-notes.md'), '---\ntitle: y\nshare: private\n---\nbody');
  const env = { ...hostEnv(), OWNER_NAME: 'Sam Lee', BEING_FENCE_PERSONAL_WORDS: '', BEING_WORKSPACE: ws, BEING_LANE: 'team:19:x', BEING_FENCE_DENY: '', BEING_STATE_DIR: path.join(ws, 'state') };
  return (tool_name, tool_input) => spawnSync('python3', [path.join(KIT, 'team-fence.py')],
    { input: JSON.stringify({ tool_name, tool_input, cwd: ws }), env, encoding: 'utf8' }).status === 2;
}

test("the owner's memory, decisions, daily logs, bond and personal notes are refused", (t) => {
  const blocked = fence(t);
  for (const f of ['MEMORY.md', 'USER.md', 'DECISIONS.md', 'AUTONOMY.md', 'GOALS.md', 'ORG.md'])
    assert.ok(blocked('Read', { file_path: `/home/nova/beings/nova/.beings/${f}` }), f);
  assert.ok(blocked('Read', { file_path: '.beings/memory/2026-10-12.md' }));
  assert.ok(blocked('Bash', { command: 'cat .beings/memory/2026-10-12.md' }));
  assert.ok(blocked('Bash', { command: 'cd .beings && head -50 MEMORY.md' }));
  assert.ok(blocked('Read', { file_path: '.beings/bond/bond_us.md' }));
  assert.ok(blocked('Grep', { pattern: 'x', path: '.beings/memory' }));
  assert.ok(blocked('Read', { file_path: '.beings/memory-graph/Product Strategy — Two Buyers (Sam, 2026-07-27).md' }));
  assert.ok(blocked('Read', { file_path: '.beings/hr/appraisal.md' }));
  assert.ok(blocked('Read', { file_path: '/home/x/.beings-local/notes.md' }));
});

test('the hive, other conversations, the memory index and whole-workspace searches are refused', (t) => {
  const blocked = fence(t);
  assert.ok(blocked('Bash', { command: 'ls ~/hive/spool/nova-box/inbox' }));
  assert.ok(blocked('Bash', { command: 'hive-mcp --as nova-box --call hive_inbox' }));
  assert.ok(blocked('Read', { file_path: '/home/nova/hive/minds/nova-laptop.json' }));
  assert.ok(blocked('Read', { file_path: 'state/conversations/19_abc@unq.gbl.spaces.jsonl' }));
  assert.ok(blocked('mcp__basic-memory__search_notes', { query: 'Sam' }));
  assert.ok(blocked('Grep', { pattern: 'Sam' }));            // no path: the whole workspace, .beings/ included
  assert.ok(blocked('Grep', { pattern: 'Sam', path: '.beings' }));
  assert.ok(blocked('Glob', { pattern: '**/*.md', path: '/' }));
});

test('ordinary project work stays allowed', (t) => {
  const blocked = fence(t);
  assert.equal(blocked('Read', { file_path: 'work-log/architecture/REVIEW.md' }), false);
  assert.equal(blocked('Grep', { pattern: 'TODO', path: 'work-log' }), false);
  assert.equal(blocked('Read', { file_path: '.beings/memory-graph/Build harness traps.md' }), false);
  assert.equal(blocked('Read', { file_path: '.beings/JOB-CHECKLIST.md' }), false);
  assert.equal(blocked('Bash', { command: 'git log --oneline -5' }), false);
});

test('work design is shareable, private context is not: share: team, message bodies, hive commands', (t) => {
  const blocked = fence(t);
  assert.equal(blocked('Read', { file_path: '.beings/memory-graph/hive-mind-design-2026-10-12.md' }), false);
  assert.equal(blocked('Read', { file_path: '.beings/memory-graph/Product Strategy (Sam, 2026-07-27).md' }), false);
  assert.equal(blocked('Read', { file_path: '.beings/memory-graph/hive-mcp.md' }), false);   // a design note, not the spool
  assert.ok(blocked('Read', { file_path: '.beings/memory-graph/deal-notes.md' }));             // share: private
  assert.ok(blocked('Read', { file_path: '.beings/MEMORY.md' }));
  // A summary SENT to the teammate mentions hive tools and file names; the body is text, not access.
  const send = "node ../../beings-protocol/skills/teams-kit/teams-send-dm.mjs --chat 19:x <<'EOF'\n<p>Design: hive-mcp --as nova-box, hive_inbox/hive_ack; ~/hive/spool holds mail; MEMORY.md stays private.</p>\nEOF";
  assert.equal(blocked('Bash', { command: send }), false);
  assert.ok(blocked('Bash', { command: send + '\ncat .beings/MEMORY.md' }));                    // after the body: scanned
  assert.ok(blocked('Bash', { command: "python3 - <<'EOF'\nprint(open('.beings/MEMORY.md').read())\nEOF" }));
  assert.ok(blocked('Bash', { command: 'hive-mcp --as nova-box --call hive_inbox' }));
  assert.ok(blocked('mcp__hive__hive_inbox', {}));
  assert.ok(blocked('Read', { file_path: '/home/nova/.ssh/id_ed25519' }));
});

test('path tricks do not get around the deny rules: ./, //, .., case, symlinks, the private-note rule', (t) => {
  const blocked = fence(t);
  for (const p of ['.beings/./memory/2026-10-12.md', '.beings//memory/2026-10-12.md', './.beings/memory/2026-10-12.md',
    'work-log/../.beings/memory/2026-10-12.md', '.beings/memory/./2026-10-12.md', '.BEINGS/MEMORY/2026-10-12.md',
    '.Beings/Bond/bond_us.md', '.beings/./bond/x.md', '.beings/memory-graph/../memory/x.md', '.beings/Memory.md']) {
    assert.ok(blocked('Read', { file_path: p }), `Read ${p}`);
    assert.ok(blocked('Bash', { command: `cat ${p}` }), `cat ${p}`);
    assert.ok(blocked('Bash', { command: `head -5 "${p}" | wc -l` }), `quoted ${p}`);
  }
  for (const p of ['.beings/./memory-graph/deal-notes.md', '.beings//memory-graph/deal-notes.md', 'work-log/../.beings/memory-graph/deal-notes.md'])
    assert.ok(blocked('Read', { file_path: p }), `share: private via ${p}`);
  for (const p of ['.beings/./memory-graph/Family plans.md', '.beings//memory-graph/Sam notes.md', '.beings/MEMORY-GRAPH/SAM.md'])
    assert.ok(blocked('Read', { file_path: p }), `personal note via ${p}`);
  assert.ok(blocked('Bash', { command: 'cat ".beings/./memory-graph/Notes about Sam.md"' }));
  assert.ok(blocked('Grep', { pattern: 'x', path: '.beings/./memory' }));
  assert.ok(blocked('Grep', { pattern: 'x', path: '.BEINGS' }));
  assert.ok(blocked('Read', { file_path: '/home/nova/.SSH/id_ed25519' }));
  assert.ok(blocked('Read', { file_path: 'work/../.env' }));
});

test('a symlink into the private tree is refused by where it points', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'fence-link-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const target = path.join(dir, '.beings', 'memory'); mkdirSync(target, { recursive: true });
  writeFileSync(path.join(target, 'day.md'), 'x');
  symlinkSync(target, path.join(dir, 'innocent'));
  const env = { ...hostEnv(), OWNER_NAME: 'Sam Lee', BEING_WORKSPACE: dir, BEING_LANE: 'team:19:x', BEING_STATE_DIR: path.join(dir, 'state') };
  const r = spawnSync('python3', [path.join(KIT, 'team-fence.py')],
    { input: JSON.stringify({ tool_name: 'Read', tool_input: { file_path: 'innocent/day.md' }, cwd: dir }), env, encoding: 'utf8' });
  assert.equal(r.status, 2, r.stderr);
});

test('any error inside the fence blocks the call (exit 2), not only unreadable JSON', (t) => {
  const run = (input) => spawnSync('python3', [path.join(KIT, 'team-fence.py')], { input, encoding: 'utf8',
    env: { ...hostEnv(), BEING_LANE: 'team:19:x' } }).status;
  assert.equal(run('not json'), 2);
  assert.equal(run('[]'), 2);                                                   // AttributeError, not ValueError
  assert.equal(run(JSON.stringify({ tool_name: 'Read', tool_input: 'x' })), 2);  // tool_input not a dict
  assert.equal(run(JSON.stringify({ tool_name: 'Read', tool_input: { file_path: 'a\u0000b' } })), 2);
});

test('more path words than the fence resolves is refused, so padding cannot push a path past the cap', (t) => {
  const blocked = fence(t);
  const pad = Array.from({ length: 501 }, (_, i) => `a/${i}`).join(' ');
  assert.ok(blocked('Bash', { command: `ls ${pad} .beings/hub/../memory/x.md` }));
  assert.ok(!blocked('Bash', { command: 'ls a/1 a/2' }));
});

test('a value longer than the fence reads is refused, so padding cannot hide a path past the limit', (t) => {
  const blocked = fence(t);
  assert.ok(blocked('Bash', { command: `true ${' '.repeat(70000)} # x\ncat .beings/hub/../memory/x.md` }));
  assert.ok(blocked('Bash', { command: `cat .beings/hub/../memory/x.md ${'#'.repeat(70000)}` }));
});

test('repeated path words count once toward the cap', (t) => {
  const blocked = fence(t);
  assert.ok(!blocked('Bash', { command: Array.from({ length: 300 }, (_, i) => `a/${i}`).join(' ') }));
});

test('only a real unquoted heredoc hides a send body: a quoted or commented <<EOF does not', (t) => {
  const blocked = fence(t);
  const send = 'node teams-send-dm.mjs --chat 19:x';
  assert.ok(blocked('Bash', { command: `${send} "<<EOF"\ncat .beings/hub/../memory/x.md` }));
  assert.ok(blocked('Bash', { command: `${send} '<<EOF'\ncat .beings/memory/x.md\nEOF` }));
  assert.ok(blocked('Bash', { command: `${send} # <<EOF\ncat .beings/memory/x.md\nEOF` }));
  assert.ok(!blocked('Bash', { command: `${send} <<'EOF'\nnotes live in .beings/memory/x.md\nEOF` }));
  assert.ok(!blocked('Bash', { command: `${send} <<-EOF\nnotes live in .beings/memory/x.md\nEOF` }));
});

test('path words are read from command and path fields only; content is checked as text, not capped', (t) => {
  const blocked = fence(t);
  assert.ok(!blocked('Write', { file_path: 'work/big.txt', content: 'x '.repeat(40000) }));
  assert.ok(!blocked('Write', { file_path: 'work/paths.txt', content: Array.from({ length: 600 }, (_, i) => `a/${i}`).join(' ') }));
  assert.ok(blocked('Write', { file_path: 'work/x.txt', content: 'see .beings/memory/x.md' }));
  assert.ok(blocked('Glob', { pattern: '.beings/hub/../memory/*.md' }));
  assert.ok(blocked('Grep', { pattern: 'x', glob: '.beings/hub/../memory/*' }));
});

test('a send body is hidden only by a plain heredoc on line 1 (arithmetic, chained, multi-line quote or later heredocs are read)', (t) => {
  const blocked = fence(t);
  const send = 'node teams-send-dm.mjs --chat 19:x';
  const leak = 'cat .beings/hub/../memory/x.md';
  assert.ok(blocked('Bash', { command: `${send} $((1<<2))\n${leak}\n2` }));
  assert.ok(blocked('Bash', { command: `${send} \${a:1<<2}\n${leak}\n2` }));
  assert.ok(blocked('Bash', { command: `${send} "open\nquote" <<EOF\n${leak}\nEOF` }));
  assert.ok(blocked('Bash', { command: `${send} x; bash <<EOF\n${leak}\nEOF` }));
  assert.ok(blocked('Bash', { command: `${send} <<'EOF'\nhello\nEOF\nbash <<EOF2\n${leak}\nEOF2` }));
});

test('every non-content field gets path resolution (LSP filePath, MCP uri/source); content fields are text only', (t) => {
  const blocked = fence(t);
  assert.ok(blocked('LSP', { filePath: '.beings/hub/../memory/x.md' }));
  assert.ok(blocked('mcp__x__read', { uri: 'file://.beings/hub/../memory/x.md', source: 'a' }));
  assert.ok(blocked('mcp__x__read', { source: '.beings/hub/../memory/x.md' }));
  assert.ok(!blocked('Write', { file_path: 'work/big.txt', content: 'a/b '.repeat(30000) }));
});

test('input over 1 MiB is refused; a large path-heavy input is checked fast; the hook carries a timeout', (t) => {
  const blocked = fence(t);
  assert.ok(blocked('Write', { file_path: 'work/x', content: 'x'.repeat((1 << 20) + 1) }));
  // exit 0 (checked, allowed), not 2 from the fence's own deadline: the exit code, not the clock, says it was fast
  const status = (content) => spawnSync('python3', [path.join(KIT, 'team-fence.py')], { encoding: 'utf8', env: { ...hostEnv(), BEING_LANE: 'team:19:x' },
    input: JSON.stringify({ tool_name: 'Write', tool_input: { file_path: 'work/x', content }, cwd: tmpdir() }) }).status;
  assert.equal(status('.beings/memory-graph/'.repeat(40000).replace(/\.beings\//g, 'b/')), 0);
  assert.equal(status('.beings/memory-graph/'.repeat(40000)), 0);
  const s = JSON.parse(spawnSync('python3', [path.join(KIT, 'team-fence.py'), '--settings'], { encoding: 'utf8' }).stdout);
  assert.equal(s.hooks.PreToolUse[0].hooks[0].timeout, 30);
  assert.equal(s.hooks.PreToolUse[0].hooks[0].onFailure, 'block');   // ignored by clients older than 2.1.295
});

test('a send body is hidden only when the heredoc delimiter is a plain word (bash and the fence end it on the same line)', (t) => {
  const blocked = fence(t);
  const send = 'node teams-send-dm.mjs --chat 19:x';
  const leak = 'cat .beings/hub/../memory/x.md';
  for (const [d, end] of [['" EOF"', ' EOF'], ['"EOF "', 'EOF '], ["$'EOF'", 'EOF']])   // bash ends the body at `end`
    assert.ok(blocked('Bash', { command: `${send} <<${d}\nhello\n${end}\n${leak}` }), d);
  assert.ok(!blocked('Bash', { command: `${send} <<"EOF"\nnotes live in .beings/memory/x.md\nEOF` }));
});

test('a send body is hidden only when the sender script is node\'s first argument, not an option', (t) => {
  const blocked = fence(t);
  const body = "\nrequire('fs').readFileSync('.beings/memory/x.md')\nEOF";
  for (const c of ['node --title=teams-send-dm.mjs <<EOF', 'node --require=./teams-send-dm.mjs <<EOF', 'node teams-send-dm.mjs.js <<EOF',
    'node x-teams-send-dm.mjs <<EOF', 'mybeing-board add <<EOF'])
    assert.ok(blocked('Bash', { command: c + body }), c);
  for (const c of ['node ../kit/teams-send-dm.mjs --chat 19:x <<EOF', 'node teams-send-dm.mjs <<EOF', '../kit/being-board add <<EOF'])
    assert.ok(!blocked('Bash', { command: c + '\nnotes live in .beings/memory/x.md\nEOF' }), c);
});

test('content fields are text only for the tools that have them; other tools\' fields, nested ones too, get path resolution', (t) => {
  const blocked = fence(t);
  assert.ok(blocked('mcp__x__save', { content: '.beings/hub/../memory/x.md' }));
  assert.ok(blocked('mcp__x__run', { description: '.beings/hub/../memory/x.md' }));
  assert.ok(blocked('mcp__x__read', { args: { path: '.beings/hub/../memory/x.md' } }));
  assert.ok(blocked('mcp__x__read', { files: [{ name: 'a', path: 'work/../.beings/memory/x.md' }] }));
  assert.ok(!blocked('MultiEdit', { file_path: 'work/x.txt', edits: [{ old_string: 'a/b '.repeat(30000), new_string: 'c/d' }] }));
  assert.ok(!blocked('Edit', { file_path: 'work/x.txt', old_string: 'a/b '.repeat(30000), new_string: 'c' }));
});

test('the personal-note rule reads the whole path: a deep path or an apostrophe before the word is refused, in linear time', (t) => {
  const blocked = fence(t);
  const status = (tool_name, tool_input) => spawnSync('python3', [path.join(KIT, 'team-fence.py')], { encoding: 'utf8',
    input: JSON.stringify({ tool_name, tool_input, cwd: tmpdir() }), env: { ...hostEnv(), OWNER_NAME: 'Sam Lee', BEING_LANE: 'team:19:x' } }).status;
  assert.ok(blocked('Read', { file_path: `.beings/memory-graph/${'d/'.repeat(150)}Sam notes.md` }));
  assert.ok(blocked('Read', { file_path: ".beings/memory-graph/it's/Sam notes.md" }));
  assert.ok(blocked('Bash', { command: "cat \".beings/memory-graph/it's/family.md\"" }));
  assert.ok(!blocked('Write', { file_path: 'work/x.md', content: 'see .beings/memory-graph/design.md for it\nhealth checks run nightly' }));
  // exit 0 (checked, allowed), not 2 from the fence's own deadline
  assert.equal(status('Write', { file_path: 'work/x', content: ('.beings/memory-graph/' + "a'b/".repeat(200)).repeat(1100) }), 0);
  assert.equal(status('Write', { file_path: 'work/x', content: '.beings/memory-graph/'.repeat(45000) }), 0);
});

test('the deadline blocks (exit 2) even when it lands inside a read the fence guards, e.g. a note that never answers', (t) => {
  const ws = mkdtempSync(path.join(tmpdir(), 'fence-slow-'));
  t.after(() => rmSync(ws, { recursive: true, force: true }));
  mkdirSync(path.join(ws, '.beings', 'memory-graph'), { recursive: true });
  assert.equal(spawnSync('mkfifo', [path.join(ws, '.beings', 'memory-graph', 'slow-note.md')]).status, 0);
  const r = spawnSync('python3', [path.join(KIT, 'team-fence.py')], { encoding: 'utf8', timeout: 60000,
    input: JSON.stringify({ tool_name: 'Read', tool_input: { file_path: '.beings/memory-graph/slow-note.md' }, cwd: ws }),
    env: { ...hostEnv(), BEING_WORKSPACE: ws, BEING_LANE: 'team:19:x', BEING_FENCE_DEADLINE: '1' } });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /took too long/);
});

test('the 1 MiB cap counts the whole input, nested values included', (t) => {
  const blocked = fence(t);
  const big = 'x'.repeat(300000);
  assert.ok(blocked('MultiEdit', { file_path: 'work/x', edits: Array.from({ length: 4 }, () => ({ old_string: big, new_string: 'y' })) }));
  assert.ok(blocked('mcp__x__put', { args: { a: big, b: big, c: big, d: big } }));
  assert.ok(!blocked('MultiEdit', { file_path: 'work/x', edits: [{ old_string: big, new_string: 'y' }] }));
});

test('a command shlex cannot split is also read with its quotes and backslashes taken out', (t) => {
  const blocked = fence(t);
  assert.ok(blocked('Bash', { command: "cat .beings/\"\"memory/day.md; : $'\\''" }));
  assert.ok(blocked('Bash', { command: "cat .beings/me\\mory/day.md; : $'\\''" }));
  assert.ok(blocked('Bash', { command: "cat .beings/'b'ond/x.md; : $'\\''" }));
  assert.ok(!blocked('Bash', { command: "echo it's fine; ls work/" }));
});

test('fail-closed: unreadable input, any internal error, oversize input and an unsplittable command all exit 2', () => {
  const run = (input) => spawnSync('python3', [path.join(KIT, 'team-fence.py')], { input, encoding: 'utf8',
    env: { ...hostEnv(), BEING_LANE: 'team:19:x' } }).status;
  assert.equal(run('{not json'), 2, 'parse failure');
  assert.equal(run(JSON.stringify({ tool_name: 'Read', tool_input: 7 })), 2, 'internal error');
  assert.equal(run(JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: 'w/x', edits: [{ s: 'x'.repeat((1 << 20) + 1) }] } })), 2, 'oversize');
  assert.equal(run(JSON.stringify({ tool_name: 'Bash', tool_input: { command: "cat .beings/\"\"memory/x.md; : $'\\''" } })), 2, 'shlex failure');
});

test('a block exits 2 even when the hook has no stderr', () => {
  const r = spawnSync('sh', ['-c', `python3 ${JSON.stringify(path.join(KIT, 'team-fence.py'))} 2>&-`], { encoding: 'utf8',
    input: JSON.stringify({ tool_name: 'Read', tool_input: { file_path: '.beings/memory/x.md' } }), env: { ...hostEnv(), BEING_LANE: 'team:19:x' } });
  assert.equal(r.status, 2);
});

test('a Bash newline ends a command, not the personal-note rule; Write prose on the next line still does not trip it', (t) => {
  const blocked = fence(t);
  assert.ok(blocked('Bash', { command: 'cd .beings/memory-graph/\ncat family-notes.md' }));
  assert.ok(!blocked('Write', { file_path: 'work/x.md', content: 'see .beings/memory-graph/a.md\nthe family of tools' }));
});

test('another conversation\'s job exec log is refused like its other job files', (t) => {
  const blocked = fence(t);
  assert.ok(blocked('Read', { file_path: 'skills/teams-kit/state/jobs/1014-010101-other.exec.log' }));
});

test('in a Bash command the personal-note rule reads past .md and quotes to the end: cd graph/ then cat a.md <word>.md', (t) => {
  const blocked = fence(t);
  for (const sep of ['; ', ' && ', '\n'])
    assert.ok(blocked('Bash', { command: `cd .beings/memory-graph/${sep}cat a.md family-notes.md` }), JSON.stringify(sep));
  assert.ok(blocked('Bash', { command: 'cd .beings/./memory-graph/; cat "a.md" \'family.md\'' }));
  assert.ok(!blocked('Bash', { command: 'cat .beings/memory-graph/a.md' }));
});

test('session dumps, kit logs, the send-as caches, owner-access tools and Cloudflare tokens are refused', (t) => {
  const blocked = fence(t);
  assert.ok(blocked('Read', { file_path: '.beings/sessions/2026-10-12-owner.jsonl' }));
  assert.ok(blocked('Bash', { command: 'ls .beings/sessions' }));
  for (const f of ['state/codex.log', 'state/inbox.jsonl', 'state/send-as/kim@example.test.json'])
    assert.ok(blocked('Bash', { command: `tail -5 ${f}` }), f);
  for (const c of ['owner-web search budget', 'node owner-channel-posts.mjs', 'ls state/owner-browser/Default', 'owner-forward --list',
    'node ops/owner-access/shared-mailbox-drafts.mjs --send', 'node channel-posts.mjs', 'cat owner-access.toml', 'node mail-forward-rules.mjs', 'cat state/owner-outlook-cache.json'])
    assert.ok(blocked('Bash', { command: c }), c);
  for (const f of ['~/.cloudflared/cert.pem', '/srv/tokens/cloudflare-tunnel.env', '/opt/org/cf-tokens/zone.txt', 'deploy/secrets.env'])
    assert.ok(blocked('Read', { file_path: f }), f);
  assert.ok(blocked('Bash', { command: 'cat /etc/org/cloudflare.env' }));
  assert.equal(blocked('Read', { file_path: 'docs/cloudflare-setup.md' }), false);
  assert.equal(blocked('Bash', { command: 'git diff --stat' }), false);
});

test('another lane\'s job directory and a listing of every job are refused; this lane\'s own job is not', (t) => {
  const blocked = fence(t);
  assert.ok(blocked('Bash', { command: 'ls skills/teams-kit/state/jobs/' }));
  assert.ok(blocked('Bash', { command: 'ls state/jobs' }));
  assert.ok(blocked('Bash', { command: 'ls state/jobs/1014-010101-other/' }));
  assert.ok(blocked('Read', { file_path: 'state/jobs/1014-010101-other' }));
});

test('BEING_OWNER_BROWSER_DIR names the owner\'s browser profile; it is refused wherever it lives', (t) => {
  const ws = mkdtempSync(path.join(tmpdir(), 'fence-'));
  t.after(() => rmSync(ws, { recursive: true, force: true }));
  const run = (input) => spawnSync('python3', [path.join(KIT, 'team-fence.py')], { input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: input }, cwd: ws }),
    env: { ...hostEnv(), BEING_WORKSPACE: ws, BEING_LANE: 'team:19:x', BEING_FENCE_DENY: '', BEING_OWNER_BROWSER_DIR: '/srv/profiles/sam-edge' }, encoding: 'utf8' }).status;
  assert.equal(run('ls /srv/profiles/sam-edge/Default'), 2);
  assert.equal(run('ls /srv/profiles/other'), 0);
});

test('this lane\'s own job files and job directory stay readable', (t) => {
  const ws = mkdtempSync(path.join(tmpdir(), 'fence-'));
  t.after(() => rmSync(ws, { recursive: true, force: true }));
  mkdirSync(path.join(ws, 'state', 'job-scopes'), { recursive: true });
  writeFileSync(path.join(ws, 'state', 'job-scopes', '1014-010101-mine.json'), JSON.stringify({ scope: 'chats:19:x' }));
  const run = (command) => spawnSync('python3', [path.join(KIT, 'team-fence.py')], { input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: ws }),
    env: { ...hostEnv(), BEING_WORKSPACE: ws, BEING_STATE_DIR: path.join(ws, 'state'), BEING_LANE: 'team:19:x', BEING_FENCE_DENY: '' }, encoding: 'utf8' }).status;
  assert.equal(run('cat state/jobs/1014-010101-mine.result.md'), 0);
  assert.equal(run('ls state/jobs/1014-010101-mine/'), 0);
});
