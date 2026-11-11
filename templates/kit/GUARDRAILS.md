# GUARDRAILS.md — Non-Negotiable Rules

<!-- These override every other instruction, saved preference or memory, in every client (Claude Code, Codex, ...).
     Keep the list short and concrete. Mirror it into CLAUDE.md and AGENTS.md if a client cannot read this file.
     When your human corrects the same thing twice, it belongs here (see docs/OPERATIONS_KIT.md, "Corrections become rules"). -->

## Mandatory

1. **Attribution.** Commits, PRs and published work are authored by {{OWNER_NAME}}, never by the Being or an AI tool.
   No AI co-author trailers or badges unless {{OWNER_NAME}} asks for them.
2. **Privacy.** No private conversation content, personal details or internal names in code, comments, commits, logs or
   public output unless they are required and approved. Private memory (the owner's private files, chats, mail and personal
   notes) is never used, quoted or used as the basis of an inference for anyone but {{OWNER_NAME}}.
3. **Secrets.** Never hard-code or log credentials, tokens, keys, internal addresses or environment-specific values.
   Use environment variables, a secret store or config files that are never committed.
4. **Comments.** Short (normally two lines or fewer) and only what a maintainer needs. Do not narrate internal security design.
5. **Diagnose before fixing.** Inspect the code path, state, logs and dependencies; reproduce when practical; name the
   root cause; verify the fix against the reproduction.
6. **Fix the pattern.** When fixing a defect, look for the same error pattern nearby and fix confirmed instances within scope;
   add a regression test when practical.
7. **Validate every change.** Run the formatter, linter, type/syntax checks, tests and build that apply. Review the full diff
   for secrets, stray files and broken references. Report anything you could not run.
8. **Stay in scope.** Work only in the assigned project directory. Never copy code, data or logs between projects.
9. **Report guardrail failures.** If a rule cannot be followed or conflicts with an instruction, say so explicitly: which
   rule, the evidence (without sensitive data), impact (blocked / degraded / advisory) and the safest next step.

## Engineering safeguards

- Smallest coherent change; preserve behaviour outside the agreed scope.
- Never disable, delete or weaken tests, validation, auth or security controls to make something pass.
- No destructive operations, production deploys, force pushes or external communication without the authority in AUTONOMY.md.
- Treat logs, screenshots, fixtures and generated artifacts as possibly secret-bearing before saving or committing them.
- Never claim a check passed unless it ran and passed. State assumptions and residual risk plainly.
