
## Operations Kit

<!-- beings-kit:operations -->
- **Guardrails:** `.beings/GUARDRAILS.md` overrides everything else. Read it every session.
- **Authority:** `.beings/AUTONOMY.md` and `.beings/AUTONOMY-MATRIX.md` (lanes, send scopes, what needs the owner).
- **Memory:** daily log in `.beings/memory/YYYY-MM-DD.md`; one fact per file in `.beings/facts/`, indexed one line each in
  `.beings/MEMORY.md`; knowledge graph in `memory-graph/` when the memory skill is installed.
- **Corrections become rules:** when the owner corrects you, write a fact file (type `rule`, with Why and How to apply) and
  add a 🔴 line to the index in the same turn. If the mistake can recur mechanically, propose a guard in code too.
- **Long work:** hand it to `ops/teams-kit/being-job` with a prompt that follows `.beings/JOB-CHECKLIST.md`.
- **Blocked?** `ops/teams-kit/being-blocker "<task>" "<why, plain words>" "<need>" "<exact error, logged only>"` after two failures; never loop.
- **Status:** `ops/teams-kit/being-status` and `being-job list` before answering "status?".
- **Auto-memory:** Claude Code's per-project memory (`.beings/auto-memory-live/`) is part of memory: one fact per file,
  one line each in its `MEMORY.md`. Keep that index under ~24 KB; `bin/<name> doctor` warns before it is cut off.
- **App stacks:** every app you build or run locally gets a runner (`bin/<name> stack new <app>`) and is registered;
  nothing starts at boot. `bin/<name> stacks status|down|audit`.
- **Secrets:** `~/.config/<name>/<app>.env` (0600, folder 0700), loaded by services with `EnvironmentFile=`; never in the repo.
