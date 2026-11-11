// Import first: identity, app and state settings come from the kit's on-disk .env, overriding the process env,
// so a run cannot point the owner tools at another cache, account or state directory.
import { kitEnv } from './kit-env.mjs';

const E = kitEnv();
for (const k of ['BEING_UPN', 'BEING_CACHE', 'BEING_NAME', 'OWNER_UPN', 'OWNER_CACHE', 'OWNER_OID', 'OWNER_NAME', 'OWNER_DM_CHAT',
  'BEING_OWNER_DELEGATE', 'M365_CLIENT_ID', 'M365_TENANT_ID', 'BEING_STATE_DIR', 'BEING_COMMS_LOG']) {
  if (E[k] !== undefined) process.env[k] = E[k];
}
