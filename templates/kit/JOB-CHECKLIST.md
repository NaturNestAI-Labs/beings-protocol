# JOB-CHECKLIST.md — Writing a Background-Job Prompt

A background job runs with no conversation history and nobody to ask. The prompt is the whole briefing.

- [ ] **Goal in one line**: what "done" looks like, from the requester's point of view.
- [ ] **Inputs**: absolute paths, branch names, ticket or PR numbers, links. Nothing "as discussed".
- [ ] **Where to work**: the repo/worktree path, and the branch to create or use (e.g. today's batch branch).
- [ ] **Outputs**: exact files to produce and where, plus the format (Markdown, PDF, PR description draft, ...).
- [ ] **Verification**: the command(s) that prove it works (tests, build, lint, a screenshot, a diff check).
- [ ] **Limits**: what NOT to do (no push, no merge, no deploy, no cancelling CI runs, no messages to anyone).
- [ ] **Authority**: anything that needs the owner is a stop-and-report, not a guess.
- [ ] **Blockers**: "if a step fails twice for reasons outside your control, run being-blocker and finish what you can".
- [ ] **Result file**: a short summary of what was produced, paths, how it was verified, what is unverified.
- [ ] **Model**: `--small` for chores (lookups, account set-up, probes); default strong model for research, reviews, builds.
- [ ] **Parallel jobs on one repo**: each branches from and merges into the day's batch branch; only the Being merges the batch.
- [ ] **Apps it starts**: anything the job builds or runs locally gets a runner (`bin/<name> stack new <app>`), is
      registered in the stacks list, and is stopped (`<app> down`) when the job ends. Nothing is armed to start at boot.
