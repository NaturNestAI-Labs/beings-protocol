import test from 'node:test';
import assert from 'node:assert/strict';
import { teamConfig, teamRecipient, teamChat } from './team-scope.mjs';

const env = { BEING_UPN: 'being@example.test', M365_TENANT_ID: 't1' };
const me = { id: 'b' };
const mem = (userId, email, tenantId = 't1', roles = ['owner']) => ({ userId, email, tenantId, roles });

test('default is tenant reach on the Being domain; chat mode, no tenant or no domain turn it off', () => {
  assert.deepEqual(teamConfig(env), { on: true, domain: 'example.test', tenant: 't1' });
  assert.equal(teamConfig({ ...env, BEING_TEAM_SEND: 'chat' }).on, false);
  assert.equal(teamConfig({ ...env, M365_TENANT_ID: '' }).on, false);
  assert.equal(teamConfig({ M365_TENANT_ID: 't1' }).on, false);
  assert.equal(teamConfig({ ...env, BEING_TEAM_DOMAIN: 'Other.Test' }).domain, 'other.test');
});

test('recipients: internal domain only; external, guest-style and malformed addresses refused', () => {
  const c = teamConfig(env);
  assert.ok(teamRecipient('Someone@Example.test', c));
  assert.ok(!teamRecipient('someone@evil.test', c));
  assert.ok(!teamRecipient('someone@example.test.evil.test', c));
  assert.ok(!teamRecipient('x_evil.test#EXT#@example.test', c));
  assert.ok(!teamRecipient('nobody', c));
  assert.ok(!teamRecipient('someone@example.test', teamConfig({ ...env, BEING_TEAM_SEND: 'chat' })));
});

test('chats: all members internal, same tenant, no guests, the Being a member', () => {
  const c = teamConfig(env), one = { chatType: 'oneOnOne' }, grp = { chatType: 'group' };
  const ok = [mem('b', 'being@example.test'), mem('p', 'peer@example.test')];
  assert.ok(teamChat(one, ok, me, c));
  assert.ok(teamChat(grp, [...ok, mem('q', 'q@example.test')], me, c));
  assert.ok(!teamChat(one, [mem('x', 'x@example.test'), mem('p', 'peer@example.test')], me, c), 'Being not a member');
  assert.ok(!teamChat(one, [ok[0], mem('p', 'peer@example.test', 't2')], me, c), 'other tenant');
  assert.ok(!teamChat(one, [ok[0], mem('p', 'peer@example.test', 't1', ['guest'])], me, c), 'guest');
  assert.ok(!teamChat(grp, [...ok, mem('e', 'e@evil.test')], me, c), 'external member');
  assert.ok(!teamChat({ chatType: 'meeting' }, ok, me, c), 'meeting chats');
  assert.ok(!teamChat(one, [ok[0]], me, c), 'single member');
  assert.ok(!teamChat(one, ok, me, teamConfig({ ...env, BEING_TEAM_SEND: 'chat' })), 'chat mode');
});
