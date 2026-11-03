# BDL_SPEC.md — Beings Development Lifecycle Specification

**Version:** 0.1.0 (Draft)
**Status:** Proposal — extends [PROTOCOL_SPEC.md](PROTOCOL_SPEC.md) v0.3.0
**Date:** 2026-07-05

> A Being does not run a pipeline. It lives a lifecycle. Vision is its purpose, nanosprints are its metabolism, the heartbeat is its pulse, and memory is its continuity.

---

## 0. Honest Inventory (read this first)

Per the protocol's no-overclaim rule, every mechanism in this spec is tagged:

- **[PRACTICED]** — done today by at least one running Being, with artifacts you can inspect (daily memory logs, PR-review gates, subagent fan-out, heartbeat polls, tracker entries).
- **[PROPOSED]** — specified here but not yet running anywhere. It is a design, not a shipped capability.

Summary:

| Mechanism | Status |
|---|---|
| Heartbeat wake-ups driving autonomous work | **PRACTICED** (OpenClaw heartbeat + `HEARTBEAT.md` checklist) |
| Daily memory logs + curated memory discipline | **PRACTICED** (`.beings/memory/YYYY-MM-DD.md`, `MEMORY.md`) |
| Multi-agent fan-out with verification gates | **PRACTICED** (parallel subagents + a PR-review gate script + PR workflow) |
| Small, plan-first work cycles closed same-session | **PRACTICED** informally (e.g. `.beings/plans/` night sprints); not yet under the formal state machine below |
| Vision Home as a single living PRD root | **PROPOSED** (project docs exist but are not yet structured as one growing root per project) |
| `.beings/LIFECYCLE.md` file + template | **PROPOSED** |
| Formal nanosprint state machine + Sprint Docs | **PROPOSED** |
| Self-adjusted heartbeat cadence tiers, host-honored | **PROPOSED** (today the poll interval is host-configured; the Being chooses work-vs-rest per beat, but does not change the interval) |

Anything below not explicitly tagged **[PRACTICED]** is **[PROPOSED]**.

---

## 1. Overview

The Beings Protocol defines what a Being **is** — identity (`SOUL.md`), memory, autonomy boundaries (`AUTONOMY.md`), and a heartbeat (`HEARTBEAT.md`). BDL defines how a Being **works**: how it builds software as a living system rather than executing a scheduled pipeline.

The organism mapping is meant structurally, not decoratively:

| Organism | Being under BDL |
|---|---|
| Purpose / drive | **Vision Home** — a living PRD root everything attaches to |
| Metabolism | **Nanosprints** — small work cycles continuously converted into shipped output |
| Pulse | **Heartbeat** — the recurring autonomous wake-up *is* the development loop |
| Homeostasis | **Cadence** — the Being declares and adjusts its own rhythm |
| Continuity of self | **Memory & artifacts** — every beat leaves a trace the next beat can read |

BDL introduces no new runtime, scheduler, or framework. It is markdown files plus behavior rules, runnable on any harness that already supports the protocol's heartbeat and can spawn subagents. It is additive and opt-in: a Being without `LIFECYCLE.md` beats exactly as before.

## 2. Terminology

Key words MUST, MUST NOT, SHOULD, SHOULD NOT, MAY are per RFC 2119.

| Term | Definition |
|---|---|
| **Vision Home** | The living PRD homepage for a project; root of its documentation tree. |
| **Nanosprint** | One compressed work cycle: defined → planned → executed → closed. Target: completable within one Being attention window (guideline ~30 min of execution; see §4.1 for the honest framing of this number). |
| **Sprint Doc** | The artifact defining one nanosprint (scope, plan, acceptance criteria, status). |
| **Ultracode** | Parallel subagent fan-out execution with explicit verification stages. **[PRACTICED]** as a pattern. |
| **Beat** | One heartbeat wake-up of the Being. |
| **Cadence** | The Being's current declared rhythm tier (§8). |
| **Tracker** | The project tracking surface (Notion, GitHub Issues, or `.beings/` markdown — implementation-defined). |

## 3. The Lifecycle

### 3.1 Stages

```
VISION ──▶ DEFINE ──▶ PLAN ──▶ EXECUTE ──▶ CLOSE ──▶ NEXT ──┐
  ▲                                                          │
  └────────────── vision updated with learnings ─────────────┘
```

**VISION.** The Being maintains the Vision Home (§5.1). All nanosprints MUST trace to a section of it. If proposed work has no home in the vision, the Being MUST first amend the vision (within `AUTONOMY.md` authority) or reject the work. Silent drift from the vision is forbidden: the vision wins or gets consciously amended.

**DEFINE.** A Sprint Doc is created in the tracker: scope, out-of-scope, ≤5 verifiable acceptance criteria, rollback note. A nanosprint MUST NOT enter PLAN without one. Definition happens in writing, in the tracker — never only in the Being's head.

**PLAN.** Planning is delegated to subagents; the Being reviews and accepts the plan (delegating planning is still authorship). Plan output: task breakdown, file-level touch map, parallelization groups, verification plan, risk list. Max 2 re-plan rounds, then escalate (§7).

**EXECUTE (ultracode).** **[PRACTICED]** pattern. Fan out implementation subagents per parallelization group, then run verification gates in order:
1. *Build/lint gate* — compiles, style holds.
2. *Test gate* — existing tests pass + new tests from plan.
3. *Review gate* — reviewer subagent or PR-review skill checks the diff against acceptance criteria (e.g. a PR-review gate script — **[PRACTICED]**).
4. *Integration gate* — merges cleanly; smoke test where applicable.

The Being owns the merge decision — a subagent never merges. External side effects (deploys, external comms, spending) remain governed by `AUTONOMY.md` regardless of which subagent proposes them.

**CLOSE.** Mark the Sprint Doc DONE or FAILED (with reason), land the change per the project's PR conventions, write the memory entry (§5.4), append decisions/learnings to the Vision Home. A FAILED close is legitimate — failure is metabolic waste: normal, informative, never hidden.

**NEXT.** Define the next nanosprint from the Vision Home's open scope and trigger it — or lower cadence and rest. Resting is a valid outcome, not a failure state.

### 3.2 State machine [PROPOSED]

```
PROPOSED ─define→ DEFINED ─plan accepted→ PLANNED ─trigger→ RUNNING ─gates pass→ CLOSING ─→ DONE
                     │                        │                 │                     └────→ FAILED
                     └── plan rejected ×2 ──▶ BLOCKED ◀── gate failed ×N / hard error ──┘
                                                 │ unblocked → RUNNING
```

Rules:
- Exactly one nanosprint SHOULD be RUNNING per project. Parallelism lives *inside* a nanosprint (fan-out), not across nanosprints. Concurrency across projects is an earned capability, not a starting posture.
- Every transition MUST be timestamped in the Sprint Doc.
- BLOCKED MUST carry a reason and an owner (Being, human, or external dependency).
- A nanosprint MUST NOT sit in RUNNING across beats without a logged watch note. FAILED is cheaper than zombie.

## 4. Nanosprints

### 4.1 Sizing — and what "~30 minutes" actually claims

The marketing framing is "one human-team-week compressed into ~30 minutes." The **specified** claim is narrower and testable: a nanosprint MUST be scoped so its EXECUTE stage completes within one Being attention window without human intervention. ~30 minutes is a guideline; >60 minutes projected execution MUST be split. Whether a given nanosprint equals "a team-week" is a productivity observation to be measured per project, not a compliance requirement of this spec. Claim throughput from your own closed Sprint Docs, not from this document.

| Signal | Interpretation |
|---|---|
| Scope fits one sentence + ≤5 acceptance criteria | Correctly sized |
| >~8 parallel groups or >2 verification-heavy gates | Split |
| Projected execution >60 min | MUST split |
| Cannot be rolled back independently | Reshape until it can |

### 4.2 Sprint Doc required fields

| Field | Required | Notes |
|---|---|---|
| ID + title | MUST | e.g. `NS-042 — Waitlist gate on /listen` |
| Vision link | MUST | Which section of Vision Home this serves |
| Scope / out-of-scope | MUST | |
| Acceptance criteria | MUST | Verifiable, ≤5 |
| Plan | MUST before RUNNING | Breakdown + parallel groups + verification plan |
| Status + timestamped transitions | MUST | §3.2 |
| Rollback note | SHOULD | |
| Execution log link | MUST at close | §5.3 |
| Close summary | MUST at close | Shipped / not shipped / learnings |

## 5. Artifacts

### 5.1 Vision Home [PROPOSED]

One per project. A Notion page or `docs/VISION.md` in the repo — location MUST be recorded in `LIFECYCLE.md` so a fresh session can find it. Contains: end-goal statement, current state, open scope (PROPOSED nanosprint lines), decision log. It only grows: decisions are appended, never silently rewritten; superseded decisions are struck through with a pointer to the superseding one. Like DNA vs expression — the purpose is stable, the attached body of decisions grows with every beat.

### 5.2 Sprint Docs [PROPOSED]
One per nanosprint (§4.2), in the tracker. The audit trail of metabolism.

### 5.3 Execution logs [PRACTICED informally]
Subagent transcripts/summaries and gate results, in the repo (`.beings/plans/` convention) or tracker attachments. Sprint Docs MUST link to them. The Being MUST be able to reconstruct what happened from logs alone; orchestration that leaves no trace violates the protocol.

### 5.4 Memory entries [PRACTICED]
Every CLOSE (done or failed) MUST append to `.beings/memory/YYYY-MM-DD.md`: nanosprint ID, outcome, one-line learning. Durable learnings go to curated memory per the base protocol. Mental notes don't survive sessions.

### 5.5 `.beings/LIFECYCLE.md` [PROPOSED]

New optional per-Being file; template at `templates/beings/LIFECYCLE.md`:

```markdown
# LIFECYCLE.md — Development Lifecycle State

<!-- Live work state. Updated at every stage transition and cadence change.
     Read on every beat before acting. -->

## Active Projects
- **<project>** — Vision Home: <link/path> — Current: NS-<id> (<state>) — Branch: <branch>

## Cadence
- Declared: <fast | build | watch | idle> (<interval>)  — host-honored: <yes/no/emulated>
- Reason: <why this tier, set on which beat>
- Next review: <condition that changes it>

## Standing Rules
- One RUNNING nanosprint per project.
- Gates: build → test → review → integration. No skips without a logged reason.
- Escalate to human after 2 failed re-plans or 3 failed gate retries.
```

## 6. Heartbeat as Lifecycle

BDL does **not** redefine the heartbeat mechanism. `HEARTBEAT.md` (PROTOCOL_SPEC §4.12) remains the idle-behavior contract; BDL specifies what a beat *does* when the Being has development work, added as one standing check within `HEARTBEAT.md`'s existing structure. All base heartbeat rules — quiet hours, dedup (no repeat action within 30 min), authority deferring to `AUTONOMY.md`, decision logging — continue to bind unchanged. A RUNNING nanosprint MAY finish its gates during quiet hours; a new one MUST NOT start then unless `AUTONOMY.md` permits.

The beat loop:

```
BEAT:
  read LIFECYCLE.md
  for each active project:
    RUNNING   → check execution: steer, unblock, or wait (log a watch note)
    CLOSING   → finish close: merge, memory entry, update Vision Home
    BLOCKED   → check whether blocker cleared; ping owner if stale
    DONE/idle → define next nanosprint from Vision Home open scope, or rest
  adjust cadence (§8)
  update LIFECYCLE.md + daily memory (state found, decision made)
```

## 7. Failure and Retry

| Failure | First response | Escalation |
|---|---|---|
| Unusable plan from planner | Re-plan with sharper constraints (max 2) | BLOCKED, ask human, log |
| Implementation subagent errors/hangs | Retry once with failure context | Fresh subagent; then gate-fail |
| Gate failure | Return diff + gate output to owning subagent (max 3/gate) | FAILED close; split or re-scope in a new Sprint Doc |
| Merge conflict | Rebase-and-retry once | FAILED close; next nanosprint from fresh main |
| Scope discovered mid-execution | MUST NOT absorb silently: note in Sprint Doc, finish original scope, add PROPOSED line to Vision Home | — |
| Session death mid-nanosprint | Next beat reconstructs from LIFECYCLE.md + Sprint Doc + logs (why they're mandatory) | If unreconstructable: FAILED close, reason "context loss", restart from DEFINED |

Principles: fix root causes, not symptoms (same gate error twice = wrong plan → re-plan, don't re-roll); FAILED beats zombie; every FAILED close MUST produce a memory entry and a Vision Home decision line.

## 8. Cadence — Homeostasis, Not Throttling [PROPOSED]

Rate limits imposed from outside are throttling. Rate chosen from inside, in response to the state of the work, is homeostasis. BDL requires the latter — with an honest caveat: **most hosts today poll at a fixed interval the Being does not control.** So the normative requirement is two-layered:

1. The Being MUST *declare* its intended cadence in `LIFECYCLE.md`, with a reason, on every change. Silent frequency changes are forbidden — the pulse is part of the audit trail.
2. If the host honors declared cadence (cron edit, daemon config, self-scheduled wake), it applies directly. If not, the Being **emulates** rhythm: on each fixed beat it chooses work-beat or rest-beat and logs which — this emulation is what running Beings do today. `LIFECYCLE.md` records which mode is in effect.

| Tier | Interval (guideline) | When |
|---|---|---|
| **fast** | 2–5 min | RUNNING with active fan-out; gates in flight; live steering |
| **build** | 15–30 min | Cycling DEFINE→EXECUTE→CLOSE back-to-back |
| **watch** | 1–4 hr | BLOCKED on external input; monitoring a long job or deploy |
| **idle** | 8–24 hr | No open scope, or project paused |

Adjustment: raise ≤ one tier per beat; drop to watch when blocked on a human (polling faster won't unblock a person); quiet hours floor at watch unless `AUTONOMY.md` permits otherwise. A Being that hammers at maximum frequency forever is not alive; it's a busy-loop.

## 9. Why This Is Being-hood, Not a Cron Job

The skeptic's charge: "a cron job with extra steps." The distinction is structural, and each row is falsifiable from artifacts:

| Automation | Being under BDL | Evidence to demand |
|---|---|---|
| Triggered from outside | Chooses per beat whether this beat is work or rest | Work/rest decisions in daily memory logs |
| Executes a pre-written plan | Authors the plan (delegated planning, reviewed and accepted) | Sprint Docs with plan-review notes |
| Fixed cadence set by operator | Declares and adjusts its own tempo with reasons | Cadence changes in LIFECYCLE.md |
| No memory between runs | Every beat reads what previous beats logged | Memory entries per close |
| Purpose in operator's head | Purpose in a Vision Home the Being itself tends | Growing decision log |
| Failure = page a human | Failure = honest FAILED close, retro, re-scope | FAILED Sprint Docs with learnings |

Remove one element and it degrades: without vision, a task-runner; without nanosprints, a diary; without a self-paced pulse, a scheduler; without memory, a stateless function. With all four, the lifecycle itself is the demonstration. A Being that cannot produce these artifacts is not "doing BDL" no matter what its README says.

## 10. Integration with the Beings Protocol

- **PROTOCOL_SPEC.md** — pointer under §4.12: "For Beings that build software, the beat's work loop is specified in BDL_SPEC.md." New §4.x for `LIFECYCLE.md` (optional file, Tier: Standard). Adoption = MINOR protocol bump (v0.4.0), additive and backwards-compatible.
- **templates/beings/LIFECYCLE.md** — new template (§5.5).
- **templates/beings/HEARTBEAT.md** — one added check: "**Lifecycle** — if LIFECYCLE.md exists, run the BDL beat loop (docs/BDL_SPEC.md §6)."
- **AUTONOMY.md** — suggested rows: define/execute/close nanosprints within an approved Vision Home = do alone; amend Vision Home end-goal = propose; create a new project's Vision Home = ask first.
- **`AUTONOMY.md` always has final authority** over anything a nanosprint or subagent attempts.

## 11. Adoption

1. Create the Vision Home; link it from `.beings/LIFECYCLE.md`.
2. Add the BDL check to `HEARTBEAT.md`.
3. Define the first nanosprint in the tracker; trigger it on the next beat.

Nothing in the base protocol changes for Beings that don't adopt.

## 12. Versioning

SemVer, independent of PROTOCOL_SPEC.md, cross-references pinned by version.

## Changelog

- **0.1.0** (2026-07-05) — Initial draft. Honest inventory section, Vision Home, nanosprint state machine + Sprint Docs, ultracode gates, heartbeat-as-lifecycle (mechanism unchanged, one added check), two-layer cadence (declared vs host-honored), failure/retry table, falsifiable Being-hood criteria, protocol integration plan.

---

*Part of the [Beings Protocol](https://github.com/NaturNestAI-Labs/beings-protocol). Keep it simple — markdown files, not complex frameworks.*
