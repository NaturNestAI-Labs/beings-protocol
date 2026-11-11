---
name: owner-access
version: 0.1.0
description: Optional, off by default. Lets a Being use the owner's own Microsoft 365 sessions for named jobs — read the owner's files and web pages, draft and send reviewed batches in a shared mailbox, post reviewed batches in one channel, forward mail under pre-approved rules — each ability switched on separately.
author: Beings Protocol
scope: owner lane only (owner chat, owner jobs, routines); never teammate lanes
dependencies:
  - skills/teams-kit installed (graph.mjs, scope.mjs, comms-log.mjs, teams-login-device.mjs)
  - playwright-core + Chrome for owner-web only
  - python3 for verify-upload.py
installed_by: install.sh --with owner-access  →  <being-home>/ops/teams-kit (docs as OWNER-ACCESS.md)
---

# Owner Access

Read `OWNER-ACCESS.md` (this component's README) before using any of these tools.

## Levels

1. **Get in**: the Being and the owner are each signed in, in **separate** headless sessions, for Teams and for Outlook
   (own token cache, own browser profile each). `node owner-access-doctor.mjs` shows what is signed in.
2. **Research, read only**: `owner-read`, `owner-mail`, `owner-web search|shared|ls|get|open`, `shared-inbox-monitor.mjs scan`.
3. **Act after approval**: prepare, show the approver, then run the tool with their go message:
   `draft-for-owner.mjs` → `send Dn`; `shared-mailbox-drafts.mjs plan` → `go <batch> <fingerprint>` → `send`;
   `channel-posts.mjs preview` → `go <batch> <fingerprint>` → `apply`.
4. **Act on a pre-approved rule**: `mail-forward-rules.mjs` runs on a schedule; you do not run it to satisfy a request.

## Rules for the model

- Use only these scripts. Never open the owner's token cache or browser profile yourself, never copy a session, never ask
  for the owner's password or code.
- An ability that is off (exit 4), paused (exit 5) or not signed in (exit 6) stays that way: tell the owner what is
  needed; do not look for another route.
- Read tools are for reading. Nothing you read as the owner goes into a teammate's chat unless the owner asked.
- A go counts only when an approver typed it in their own 1:1 with the Being, with the exact text the tool printed. Never
  type, quote or forward a go yourself. A changed batch needs a new go.
- Every as-owner action is logged (`kind: as-owner`) and reported to the owner; do not hide or batch-away a failure.
- Teammate lanes: refuse politely and say the owner's tools are for the owner only.

## Separate sessions

| Service | Being | Owner | Check |
|---|---|---|---|
| Teams | own API cache + own browser profile | own API cache + own browser profile | who-am-I per service before every action |
| Outlook | same | same | same |

Owner access for a service stays off until both sessions for that service are signed in on this box.
