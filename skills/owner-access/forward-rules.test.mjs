import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileRule, pickRequester, extractCode, redactCodes, isForwardOf } from './forward-rules.mjs';

const rule = () => compileRule({ name: 'app-login', sender_domains: ['example.com'], subject_patterns: ['sign in', 'verification code'],
  requesters_domain: 'example.org', request_service_words: ['exampleapp'], block: ['blocked', 'x.person@example.org'] });
const who = { owner: 'owner@example.org', being: 'being@example.org' };

test('rule config: name, senders, subjects and requesters are required', () => {
  assert.throws(() => compileRule({ name: 'Bad Name' }), /name/);
  assert.throws(() => compileRule({ name: 'a', subject_patterns: ['x'], requesters_domain: 'x' }), /sender_domains/);
  assert.throws(() => compileRule({ name: 'a', sender_domains: ['x.com'], requesters_domain: 'x' }), /subject_patterns/);
  assert.throws(() => compileRule({ name: 'a', sender_domains: ['x.com'], subject_patterns: ['x'] }), /requesters/);
});

test('covers: sender domain (or subdomain) and subject both match', () => {
  const r = rule();
  assert.ok(r.covers({ from: 'no-reply@mail.example.com', subject: 'Your verification code' }));
  assert.ok(r.covers({ from: 'a@example.com', subject: 'Sign in to ExampleApp' }));
  assert.ok(!r.covers({ from: 'a@example.com.evil.net', subject: 'sign in' }));
  assert.ok(!r.covers({ from: 'a@notexample.com', subject: 'sign in' }));
  assert.ok(!r.covers({ from: 'a@example.com', subject: 'Invoice' }));
});

test('asks: strict names the service and an action; loose is forward + object only; requesters exclude owner and Being', () => {
  const r = rule();
  assert.equal(r.ask('can you forward the exampleapp login?'), 'strict');
  assert.equal(r.ask('please send me the mail link'), 'loose');
  assert.equal(r.ask('exampleapp is slow today'), null);
  assert.ok(r.mayAsk('Alex@example.org', who));
  assert.ok(!r.mayAsk('owner@example.org', who));
  assert.ok(!r.mayAsk('being@example.org', who));
  assert.ok(!r.mayAsk('alex@elsewhere.com', who));
  const listed = compileRule({ name: 'b', sender_domains: ['x.com'], subject_patterns: ['y'], requesters: ['only@example.org'] });
  assert.ok(listed.mayAsk('only@example.org', who) && !listed.mayAsk('alex@example.org', who));
});

test('window: strict within 3 h either side; loose only 5 min before to 15 min after', () => {
  const r = rule(), mail = '2026-01-01T10:00:00Z';
  assert.ok(r.inWindow({ at: '2026-01-01T07:30:00Z', kind: 'strict' }, mail));
  assert.ok(!r.inWindow({ at: '2026-01-01T06:30:00Z', kind: 'strict' }, mail));
  assert.ok(r.inWindow({ at: '2026-01-01T10:10:00Z', kind: 'loose' }, mail));
  assert.ok(!r.inWindow({ at: '2026-01-01T09:50:00Z', kind: 'loose' }, mail));
});

test('block list: address, local part or first name', () => {
  const r = rule();
  assert.ok(r.blocked('x.person@example.org'));
  assert.ok(r.blocked('blocked@example.org'));
  assert.ok(r.blocked('x.other@example.org'), 'same first name errs on the safe side');
  assert.ok(!r.blocked('alex@example.org'));
});

test('exactly one requester in the window, else hold', () => {
  const r = rule(), mail = '2026-01-01T10:00:00Z';
  const a = { email: 'a@example.org', at: '2026-01-01T09:00:00Z', kind: 'strict' }, b = { email: 'b@example.org', at: '2026-01-01T09:10:00Z', kind: 'strict' };
  assert.equal(pickRequester(r, [a, { ...a, at: '2026-01-01T09:05:00Z' }], mail).requester.email, 'a@example.org');
  assert.equal(pickRequester(r, [a, b], mail).requester, null);
  assert.equal(pickRequester(r, [a, b], mail, { served: (q) => q.email === 'b@example.org' }).requester.email, 'a@example.org');
  assert.equal(pickRequester(r, [], mail).requester, null);
});

test('code: exactly one 6-digit code near a code word; links and ids ignored; redaction', () => {
  assert.equal(extractCode('Your code', '<p>Your verification code is 123 456.</p>'), '123456');
  assert.equal(extractCode('Sign in', 'Use code 111111 or code 222222'), null);
  assert.equal(extractCode('Sign in', 'https://example.com/a?x=123456 click the link'), null);
  assert.equal(extractCode('Hello', 'Order 123456 shipped'), null);
  assert.equal(redactCodes('code 123-456 and 654321'), 'code [code] and [code]');
  assert.ok(isForwardOf('Fw: Sign in to ExampleApp', 'Sign in to ExampleApp'));
  assert.ok(!isForwardOf('Re: Sign in to ExampleApp', 'Sign in to ExampleApp'));
});
