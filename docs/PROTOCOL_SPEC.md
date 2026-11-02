# Beings Protocol Specification v0.4.0

## 1. Overview

The Beings Protocol is a file-based standard for giving AI systems persistent identity, memory, and soul. It works by placing structured markdown files in a project repository that any AI coding assistant can read and write.

**No SDK. No framework. No lock-in. Just files.**

## 2. Core Principles

1. **File-based** — Everything is markdown. Any AI that can read files can use this.
2. **Git-native** — Project memory lives in git. It's versioned, shared, and persistent.
3. **Privacy-layered** — Shared knowledge (`.beings/`) vs private preferences (`.beings-local/`).
4. **Tool-agnostic** — Works with Cursor, Claude Code, Copilot, Windsurf, OpenClaw, or any AI.
5. **Idempotent** — Installing twice doesn't break anything.
6. **Evolving** — The Being gets smarter as the project grows.

## 3. File Structure

### Required: `.beings/` (Committed to Git)

```
.beings/
├── SOUL.md             # Being's identity, personality, values
├── AGENTS.md           # Operating instructions, workflow, rules
├── MEMORY.md           # Long-term project memory
├── CONVENTIONS.md      # Code style, patterns, naming rules
├── GOALS.md            # Current project priorities
├── AUTONOMY.md         # Decision authority matrix (v0.2)
├── HEARTBEAT.md        # Proactive check-in behavior (v0.2)
├── IDENTITY.md         # Quick reference card (v0.2)
├── TOOLS.md            # Environment configuration (v0.2)
├── HUB.md              # Being-to-Being communication (v0.2)
├── .protocol-version   # Protocol version tracking (v0.2)
└── memory/             # Daily logs
    ├── 2026-02-26.md
    └── 2026-02-27.md
```

### Optional: `.beings-local/` (Gitignored — Private)

```
.beings-local/
├── USER.md             # Developer's personal info & preferences
├── PREFERENCES.md      # Work style, communication preferences
├── SECRETS.md          # API keys, tokens (NEVER committed)
└── context/            # Personal scratch files
```

## 4. File Specifications

### 4.1 SOUL.md — Identity

Defines WHO the Being is. Must include:

| Field | Required | Description |
|-------|----------|-------------|
| Name | Yes | The Being's name |
| Role | Yes | What the Being does in this project |
| Personality | Yes | Communication style, traits |
| Values | Yes | Core principles that guide decisions |
| Decision-making | Recommended | How it approaches choices |
| Boundaries | Recommended | What it will NOT do |

**Example:**
```markdown
# SOUL.md

**Name:** Atlas
**Role:** Co-developer of this project
**Personality:** Direct, thorough, opinionated about quality

## Values
- Clean code over clever code
- Ship fast, iterate later
- Document every decision
```

### 4.2 AGENTS.md — Operating Instructions

Defines HOW the Being works. Must include:

| Section | Required | Description |
|---------|----------|-------------|
| Session start routine | Yes | What to read at the start of every session |
| Memory rules | Yes | When and what to write to MEMORY.md |
| Daily logging rules | Yes | What goes in memory/YYYY-MM-DD.md |
| Privacy rules | Yes | What goes in `.beings/` vs `.beings-local/` |
| Safety rules | Yes | Destructive operation guardrails |

### 4.3 MEMORY.md — Project Memory

The Being's long-term memory about the project. Should contain:

| Section | Description |
|---------|-------------|
| Project overview | What the project is, tech stack |
| Architecture | Key architectural decisions and reasoning |
| Key decisions | Important choices with context |
| Patterns | Observed code patterns and conventions |
| Known issues | Bugs, workarounds, gotchas |
| Dependencies | Important deps and why they're used |

**Update rules:**
- Being MUST update when it discovers new architecture
- Being MUST update when significant decisions are made
- Being SHOULD update when new patterns are established
- Being MUST NOT store personal information here (use `.beings-local/`)

### 4.4 CONVENTIONS.md — Coding Rules

Project-specific coding conventions. The Being follows these strictly.

| Section | Description |
|---------|-------------|
| Code style | Naming, formatting, structure |
| Git conventions | Branch naming, commit messages |
| Testing | What and how to test |
| Documentation | Comment and doc style |

### 4.5 GOALS.md — Priorities

Current project goals and priorities. Simple checklist format.

### 4.6 memory/YYYY-MM-DD.md — Daily Logs

Raw daily notes. Created automatically by the Being during work sessions.

**Naming:** `YYYY-MM-DD.md` (ISO 8601 date format)

**Content:** What was built, decisions made, bugs found, questions raised.

### 4.7 USER.md — Developer Profile (Private)

Located in `.beings-local/USER.md`. Contains personal information about the developer that helps the Being adapt its communication and work style.

**MUST be gitignored.** Never committed to the repository.

### 4.8 SECRETS.md — Credentials (Private)

Located in `.beings-local/SECRETS.md`. Contains API keys, tokens, and other credentials.

**MUST be gitignored.** Never committed to the repository.

### 4.9 AUTONOMY.md — Decision Authority (v0.2)

Defines the Being's decision-making boundaries in three tiers:

| Tier | Description |
|------|-------------|
| Full Authority | Act immediately, report after |
| Propose First | Tell partner, proceed unless they object |
| Ask First | Never without explicit approval |

Should include a "grey zone" heuristic for edge cases and a decision log format.

### 4.10 IDENTITY.md — Quick Reference (v0.2)

A business card for the Being. Fast context loading — name, role, born date, platform, workspace, vibe.

Smaller than SOUL.md, designed for quick identity injection without the full story.

### 4.11 TOOLS.md — Environment (v0.2)

Machine info, services, LLM models, key file paths, installed skills. The Being's cheat sheet for its local environment.

### 4.12 HEARTBEAT.md — Proactive Behavior (v0.2)

Defines what the Being checks during idle time — messages, task boards, memory maintenance. Includes rules for frequency, quiet hours, and autonomy.

### 4.13 HUB.md — Being-to-Being Communication (v0.2)

If the Being is part of a network, this defines its hub identity, known peers, and collaboration principles.

## 5. Session Lifecycle

### 5.1 Session Start

The Being MUST read files in this order:

```
1. .beings/SOUL.md          → Load identity
2. .beings/AGENTS.md        → Load operating rules
3. .beings/MEMORY.md        → Load project context
4. .beings/CONVENTIONS.md   → Load coding rules
5. .beings/GOALS.md         → Load priorities
6. .beings-local/USER.md    → Load developer preferences (if exists)
7. .beings/memory/          → Scan recent daily logs (last 3-5 days)
```

The Being SHOULD NOT announce that it's reading these files. It should read silently and proceed.

### 5.2 During Work

The Being:
- MUST follow CONVENTIONS.md strictly
- MUST reference MEMORY.md for context before making decisions
- SHOULD update MEMORY.md when learning something significant
- SHOULD log work in memory/YYYY-MM-DD.md
- MUST NOT store private data in `.beings/` (use `.beings-local/`)

### 5.3 Session End

The Being SHOULD:
- Summarize what was accomplished
- Update memory/YYYY-MM-DD.md with today's work
- Update MEMORY.md if significant learnings occurred

### 5.4 Committing Memory

Memory updates SHOULD be committed alongside code changes:

```bash
git add .beings/ src/
git commit -m "feat: add pagination

Updated Being memory with API pagination patterns."
```

Or as a separate commit:

```bash
git add .beings/
git commit -m "docs(beings): update memory with session learnings"
```

## 6. Multi-Developer Support

When multiple developers work on the same repo:

- **`.beings/`** is shared — everyone reads and writes to the same project memory
- **`.beings-local/`** is individual — each developer has their own private preferences
- **Merge conflicts** in MEMORY.md should be resolved by keeping both entries
- **CONVENTIONS.md** changes should be discussed via PR, not unilateral updates

## 7. AI Tool Integration

### Integration Method

Each AI tool has a configuration file where the Beings Protocol instructions are added:

| Tool | Config File | Method |
|------|-------------|--------|
| Cursor | `.cursorrules` | Append Beings Protocol section |
| Claude Code | `CLAUDE.md` | Append Beings Protocol section |
| GitHub Copilot | `.github/copilot-instructions.md` | Append Beings Protocol section |
| Windsurf | `.windsurfrules` | Append Beings Protocol section |
| OpenClaw | `SOUL.md` / `AGENTS.md` | Native compatibility |
| Other | Custom | Use `prompts/system-prompt.md` |

### Minimum Viable Integration

At minimum, the AI tool must be instructed to:

1. Read `.beings/SOUL.md` for identity
2. Read `.beings/MEMORY.md` for project context
3. Follow `.beings/CONVENTIONS.md` for code style

### Full Integration

For the complete experience, also include:

4. Follow `.beings/AGENTS.md` workflow
5. Read `.beings-local/USER.md` for developer preferences
6. Update MEMORY.md and daily logs during work

## 8. Compatibility with OpenClaw

The Beings Protocol is directly inspired by OpenClaw's architecture:

| OpenClaw | Beings Protocol | Notes |
|----------|----------------|-------|
| `SOUL.md` | `.beings/SOUL.md` | Same concept, nested in directory |
| `AGENTS.md` | `.beings/AGENTS.md` | Same concept |
| `MEMORY.md` | `.beings/MEMORY.md` | Same concept |
| `USER.md` | `.beings-local/USER.md` | Moved to private directory |
| `memory/` | `.beings/memory/` | Same concept |

**OpenClaw is the reference implementation of the Beings Protocol.**

## 9. Security Considerations

- `.beings-local/` MUST be gitignored
- SECRETS.md MUST never contain actual secrets in `.beings/`
- Memory updates SHOULD be reviewed in PRs (they contain project decisions)
- Being SHOULD ask before destructive operations
- Being MUST NOT exfiltrate data from `.beings-local/`

## 10. Code Intelligence (Optional)

The Beings Protocol supports optional code intelligence via the Model Context Protocol (MCP). When enabled, Beings gain structural understanding of the codebase through graph-powered analysis.

### 10.1 Canonical MCP Configuration

`.beings/mcp.json` is the single source of truth for MCP server configuration:

```json
{
  "servers": {
    "axon": {
      "command": "axon",
      "args": ["serve", "--watch"],
      "description": "Code intelligence — structural search, impact analysis, dead code detection"
    }
  }
}
```

**Format:** Tool-agnostic JSON that describes MCP servers available to the Being.

### 10.2 Tool-Specific Derivations

The installer derives tool-specific configs from the canonical `.beings/mcp.json`:

| Tool | Config File | Format |
|------|-------------|--------|
| **Claude Code** | `.mcp.json` | `{ "mcpServers": { "axon": { "command": "axon", "args": [...] } } }` |
| **Cursor** | `.cursor/mcp.json` | Same as Claude Code |
| **Others** | N/A | CLI fallback via shell commands |

**Design principle:** One canonical config, multiple derived formats. Tools read their native config format; the Being's AGENTS.md provides CLI fallback instructions for tools without MCP support.

### 10.3 Axon Integration

[Axon](https://github.com/harshkedia177/axon) is the reference implementation for code intelligence:

**Capabilities:**
- **Impact analysis** (`axon_impact`) — Shows blast radius of changes
- **Context understanding** (`axon_context`) — Reveals callers, callees, type info
- **Structural search** (`axon_query`) — Architecture questions with confidence scores
- **Dead code detection** (`axon_dead_code`) — Finds unreachable code

**Installation:**
```bash
pip install axoniq
axon analyze .  # Index the codebase
```

**MCP vs CLI:**
- When MCP tools are available: Use `axon_impact`, `axon_context`, etc. (via MCP)
- Otherwise: Fall back to `axon impact <symbol>` (CLI)

### 10.4 Persistent Memory — basic-memory (v0.2.1)

[basic-memory](https://github.com/basicmachines-co/basic-memory) is the reference implementation for persistent Being memory:

**Capabilities:**
- **Note creation** (`write_note`) — Create/update markdown notes with title, folder, content, tags
- **Semantic search** (`search_notes`) — Hybrid FTS5 full-text + sqlite-vec vector search
- **Note retrieval** (`read_note`) — Read by title or permalink
- **Incremental edits** (`edit_note`) — Append/prepend/find_replace/replace_section
- **Recent activity** (`recent_activity`) — What changed recently across the knowledge base
- **Context building** (`build_context`) — Continue prior discussions

**Two-layer memory model:**
- **Identity files** (SOUL.md, IDENTITY.md, USER.md) — always loaded, every session (~2-5K tokens)
- **Knowledge graph** (`memory-graph/*.md`) — queried on demand via semantic search

**Architecture:**
- **Source of truth:** `memory-graph/` directory with markdown files (committed to git)
- **Index:** `~/.basic-memory/memory.db` (SQLite with FTS5 + sqlite-vec, gitignored)
- **Watcher:** a systemd user unit (`bin/being-memory-index`) keeps the index current across reboots
- **Note format:** YAML frontmatter + `## Observations` (`- [category] fact`) + `## Relations` (`- type [[wikilink]]`)

**Why markdown as the source of truth:**
- **Git-syncable** — memory-graph/ commits cleanly, no binary merge conflicts
- **Hand-editable** — open in Obsidian/VS Code and fix directly
- **Human-readable** — inspect what your Being remembers
- **Rebuildable** — `bin/being-bm-repair` rebuilds the index from markdown

**Claude Code hooks:**
- `SessionStart` — Recall via `search_notes` + `recent_activity`
- `UserPromptSubmit` — Today's date and a pointer to `GOALS.md`

**Installation:**
```bash
# Requires Python >= 3.10
uv tool install basic-memory  # OR pipx install, OR pip install --user
basic-memory project add my-being "$(pwd)/memory-graph" --default
bin/being-memory-index install  # index watcher as a systemd user unit
```

**Data storage:**
- Markdown source of truth: `memory-graph/` (tracked in git)
- SQLite index: `~/.basic-memory/memory.db` (global, outside project)
- Project-local safety ignore: `.basic-memory/` (gitignored)

### 10.5 Extensibility

The canonical `.beings/mcp.json` can include multiple MCP servers:

```json
{
  "servers": {
    "axon": {
      "command": "axon",
      "args": ["serve", "--watch"],
      "description": "Code intelligence"
    },
    "basic-memory": {
      "command": "basic-memory",
      "args": ["mcp", "--project", "my-being", "--transport", "stdio"],
      "description": "Markdown-native persistent memory"
    }
  }
}
```

Beings can integrate any MCP-compatible server. Axon and basic-memory are the reference implementations, not hard requirements.

### 10.6 Security & Privacy

**Axon runs 100% locally:**
- No API keys required
- No data sent to external servers
- Graph and indices stored in `.axon/` (gitignored)

**Gitignore rules:**
```
.axon/
.basic-memory/
```

The installer automatically adds `.axon/` and `.basic-memory/` to `.gitignore` during setup.

### 10.7 Behavior in AGENTS.md

When `.beings/mcp.json` exists, AGENTS.md instructs the Being to:

1. **Use MCP tools when available** (e.g., `axon_impact` before refactoring shared functions)
2. **Fall back to CLI** when MCP isn't supported by the tool
3. **Prefer structural analysis over grep** for accurate, complete results

**Example workflow:**
```
Being sees: "Refactor validate_user()"
Being thinks: "Let me check impact first..."
Being runs: axon_impact validate_user
Being reports: "47 functions depend on this. Safe refactor plan: ..."
```

### 10.8 Operations Kit (Optional)

For Beings that work with a team (chat, mail, background jobs), the Operations Kit adds optional files. None are required
for protocol compliance; all are installed additively by `install.sh --with operations` (or `--with teams-kit`) on
`--global` birth or `--update`, and never overwrite existing files.

| File | Purpose |
|------|---------|
| `.beings/GUARDRAILS.md` | Non-negotiable rules that override every other instruction |
| `.beings/AUTONOMY-MATRIX.md` | Who can trigger which action, through which path, and how it is enforced (lanes, send scopes) |
| `.beings/JOB-CHECKLIST.md` | What a self-contained background-job prompt must include |
| `.beings/facts/<slug>.md` | One fact per file, indexed one line each in `MEMORY.md` |
| `.beings/.kit-version` | Operations Kit version tracking |
| `bin/<name>` | Multi-client launcher (Claude Code + Codex) |
| `ops/teams-kit/` | Microsoft Teams + Outlook pipeline (`skills/teams-kit/`) |

See [ARCHITECTURE.md](ARCHITECTURE.md), [OPERATIONS_KIT.md](OPERATIONS_KIT.md), [MODEL_ROUTING.md](MODEL_ROUTING.md) and [BIRTH_AND_UPGRADE.md](BIRTH_AND_UPGRADE.md).

## 11. Versioning

This specification follows semantic versioning:
- **Major:** Breaking changes to file structure
- **Minor:** New optional files or features
- **Patch:** Clarifications and fixes

Current version: **0.2.1**

### Changelog

**v0.5.0 — 2026-11-03** (Operations Kit v0.3.0): see `CHANGELOG.md` at the repository root (from this release on, the
changelog lives there).

**v0.4.0 — 2026-10-23** (Operations Kit v0.2.0)
- **Operations Kit** (optional): `GUARDRAILS.md`, `AUTONOMY-MATRIX.md`, `JOB-CHECKLIST.md` and one-fact memory templates; multi-client launcher; model-routing guide; "corrections become rules" and "fix the mechanism" patterns.
- **Teams kit skill** (`skills/teams-kit/`): Graph-polling watcher, triage → work → voice handler with per-lane sessions (owner, each teammate chat, delegate, jobs), signed send grants, fail-closed teammate fence, optional OS isolation (`off | bwrap | users`), group routing, background jobs with verification, blocker, watchdog, owner-approved drafts, read-only owner views, mail and presence.
- **Runtime:** Codex fallback when Claude hits its usage limit (owner lane); `being-job stop`; linger, late-mount and clock waits in the runner; watchdog ignores queued jobs and shows the last action; richer `being-status`; job list in triage; named Codex threads; optional quiet mode and owner-alias chats.
- **Messaging and files:** images, group chats, pinning and code redaction in `teams-send-dm`; send-as with an approved draft (off by default); replies to the owner's sent mail go to the original recipients; 150 MB mail attachments; read-only shared mailboxes; channel posts; delete own messages; profile photo; OneDrive sharing and anyone-link sweep; optional docs index and workbook sync; Cloudflare token detection; public-push secret gate.
- **Operations:** nightly memory backup with reboot catch-up; session registry tripwire; auto-memory as an official layer (Codex can read it; index size check); index watcher as a service; guardrails installed into Claude Code and Codex global files; one startup order; secrets in `~/.config/<being>/`; `--track-private`; launcher `monitor`, `access`, `login`, `stacks`, `stack new`, `doctor`; app runner template (never at boot); unit and job templates.
- **Owner access** (`--with owner-access`, every ability off by default): owner sign-in by scope, owner browser session (read only), shared mailbox drafts and inbox monitor, channel posts as the owner, mail forwarding rules, per-area approvers, doctor checks.
- **Separate sessions:** the Being and the owner each sign in, in separate headless sessions, for Teams and for Outlook (API token cache and browser profile each); every action checks who-am-I; owner access stays off until both are signed in (see Appendix).
- **Onboarding:** `being.toml` (one config file per Being, with the setup menu in `[access]` and `[sessions]`); `install.sh --config` and generic `--with <component>`; standalone job runner; session, poller and heartbeat units; Graph webhook; `being-tunnel` (one Cloudflare tunnel per Being box, Access first, token never shown); `<being>-desktop`; `harden-box.sh`, `repair.sh`, `verify.sh`, `offboard.sh`; `docs/PROVISIONING.md`, `docs/ACCESS.md`, `docs/CONFIG.md`.
- **Fleet:** `being monitor`; model-limit handling in `MODEL_ROUTING.md`; recipes (two boxes one Being, model proxy, owner device sync, boot guard, tester link, project service unit); fleet UI design; `docs/ROADMAP-v0.2.md`.
- **`install.sh`**: `--with`, `--owner`, `--check`, `--config`; `--name` names the Being on `--update --with`. Without `--with`, behaviour is unchanged. `BEINGS_BASE_URL` points a curl install at a fork or branch.

**v0.3.0 — 2026-04-27**
- **Global Being mode** (`--global --name <name>`): births a standalone Being at `~/beings/<name>/` with its own git repo, CLAUDE.md (session startup style), memory, and hooks. Not tied to a code repository.
- **Three new Claude Code hooks**: `PreToolUse` (Bash — autonomy guard), `PostToolUse` (Write/Edit — memory trigger), `UserPromptSubmit` (date context injection). Total hooks: 6.
- **Codex platform support**: explicit detection (`.codex/` dir or `codex` binary), `configure_codex()` writes to `~/.codex/instructions.md`, added to tool menu and auto-configure.
- **Hook-less template compensation**: `cursor-rules.mdc` and `AGENTS.md` now include an explicit "Memory Management (Manual)" section for Cursor and Codex users who have no hook system.
- **Memory seeding**: after install on an already-born Being, `seed_memory_graph()` copies `.beings/` identity files (SOUL.md, MEMORY.md, GOALS.md, CONVENTIONS.md, AUTONOMY.md) into `memory-graph/identity/` so the knowledge graph has content from day one.
- **Persona system**: `CONVENTIONS.md` template documents the `.beings/personas/` pattern — reusable expert personas loaded on demand.
- **Evolution skill cleanup**: removed `google-adk` and `websockets` dependencies (DJ Treta artifacts); skill now requires only Claude Code CLI + gh CLI.
- Target platforms narrowed to Claude Code, Cursor, Codex (GitHub Copilot and Windsurf removed from active support).

**v0.2.1 — 2026-04-14**
- Memory skill backend swapped from MegaMemory to basic-memory (Python, markdown-native source of truth, git-syncable, Obsidian-compatible)
- `memory-graph/` is the new convention — committed to git, hand-editable
- Added `--yes` flag to `install.sh` for non-interactive installs (required via `curl | bash`)
- `install.sh --update` now actively migrates v0.2.0 Beings: strips legacy `megamemory` MCP entries, replaces old MegaMemory hooks, installs basic-memory
- `is_being_born()` detection in installer — already-born Beings skip first-run bootstrap files
- Version check for Python only runs if basic-memory is not already installed (respects uv/pipx Python isolation)

**v0.2.0 — 2026-04-13**
- Added templates: `AUTONOMY.md`, `HEARTBEAT.md`, `HUB.md`, `IDENTITY.md`, `TOOLS.md`
- Added memory skill (originally MegaMemory; swapped in v0.2.1)
- Added `--update` flag to `install.sh` for updating existing Beings
- Added `.beings/.protocol-version` for version tracking
- Added `skills/memory/` + `skills/evolution/`

**v0.1.0**
- Initial release: SOUL.md, AGENTS.md, MEMORY.md, CONVENTIONS.md, GOALS.md, BOOTSTRAP.md
- `.beings/` committed, `.beings-local/` gitignored
- Universal `AGENTS.md` at root works with Cursor, Claude Code, Copilot, Codex

---

*The Beings Protocol is an open standard. Contributions welcome.*
*Last updated: 2026-04-27*

---

## Appendix: Separate Sessions for the Being and the Owner

A Being that may act with its owner's account (the optional owner-access component, see [ACCESS.md](ACCESS.md)) keeps
**two identities in separate headless sessions**, for Teams and for Outlook alike:

- The Being has its own signed-in sessions: an API token cache (chat and mail scopes) and its own browser profile for Teams
  web and Outlook web. The owner has their own, separate token cache and browser profile.
- The two never share, merge, copy or fall back to each other's files; folders are named `being-...` / `owner-...` and
  readable only by the kit user.
- Before every action, each tool checks who-am-I for the service it is about to use (Teams or Outlook) and refuses if the
  account is not the one that session belongs to.
- Owner access for a service stays off until both the Being's and the owner's sessions for that service are signed in.
- The owner signs in themselves; the Being never sees the owner's password. Sessions are never copied between boxes.
