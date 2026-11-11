# CONVENTIONS.md — Project Conventions

<!-- I'll document the project's code style and patterns
     as I discover them. -->

## Personas

Reusable expert personas live in `.beings/personas/`. Each is a markdown file defining:
- Name, role, and domain
- 5–10 review or decision lenses
- When to invoke

Example: `.beings/personas/cbo-varuna.md` — Chief Business Officer persona for
proposal review. Invoke by saying: "Wear your Varuna hat and review this proposal."

The Being loads the persona file on demand — not every session.

## App stacks

Every app the Being builds or runs locally gets its own runner and is registered, so starting and stopping is always a
deliberate step and one command can stop them all:

- One command per app (`~/.local/bin/<app>`): `up`, `down`, `status`, `restart`, `logs`, `open`; `destroy` removes
  containers, `reset` wipes data after a typed confirmation. `down` keeps data and works even when config is broken.
- Never at boot: after every `up` the runner sets Docker's restart policy to `no`. Only the Being's own services
  (its chat watcher, memory backup) start at boot, on purpose.
- `<APP>_HOME` picks the checkout or worktree; nothing points at one fixed folder.
- One runner per Docker compose project, registered in `~/.config/<being>/stacks.tsv`.
- Generate with `bin/<being> stack new <app>`; check with `bin/<being> stacks audit`.

## Messages to the owner

- One language for every message, reply, draft and mail (set it in USER.md), even when someone writes in another.
- Short and plain: lead with the answer; status in a few lines; links as named links.
- Blocked: `being-blocker "<task>" "<why, plain words>" "<the one thing you need>" ["<exact error>"]`. The owner sees
  Stuck / Why / Need; the exact error stays in the log. Never loop on retries.
- Before claiming something was sent, armed or deployed, check it live (outbox, a GET, the real state), not a log line.

## Long and heavy work

- Anything over about two minutes runs as a background job (`being-job`), not inside a chat reply.
- Heavy tasks (video renders, large builds, browser fleets) run through `heavy-lock <name> -- <cmd>` so only one runs at
  a time and only when memory is free.
- Each app stack and job stays in its own scope: stopping one never stops or prunes another.
