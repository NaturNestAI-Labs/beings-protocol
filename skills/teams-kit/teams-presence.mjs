#!/usr/bin/env node
// Presence wired to the runner (usage: README.md). setPresence needs sessionId = the app's client id;
// setUserPreferredPresence alone creates no session.
import { connect, need, fail } from './graph.mjs';

const mode = (process.argv[2] || 'available').toLowerCase();
if (!['available', 'offline', 'status'].includes(mode)) fail('usage: teams-presence.mjs [available|offline|status]', 2);
const { g, me } = await connect({ upn: need('BEING_UPN'), scopes: ['Presence.ReadWrite', 'User.Read'] });
const sessionId = need('M365_CLIENT_ID');
try {
  if (mode === 'status') {
    const p = await g(`/users/${me.id}/presence`);
    console.log(`${p.availability} / ${p.activity}`);
  } else if (mode === 'offline') {
    await g(`/users/${me.id}/presence/clearPresence`, { body: { sessionId } });
    console.log('cleared');
  } else {
    await g(`/users/${me.id}/presence/setPresence`, { body: { sessionId, availability: 'Available', activity: 'Available', expirationDuration: 'PT15M' } });
    console.log('Available');
  }
} catch (e) { fail(`presence ${mode} failed: ${e.message}`); }
