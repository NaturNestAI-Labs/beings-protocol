# Memory Skill — Markdown-Native Persistent Memory

Give your Being a persistent, semantic, git-syncable memory built on markdown files.

Built on [basic-memory](https://github.com/basicmachines-co/basic-memory) — a knowledge management system that keeps markdown as the source of truth and builds a searchable index over it.

## Why markdown as the source of truth

The memory skill follows a two-layer model:

| Layer | What | Where | Role |
|-------|------|-------|------|
| **Identity files** | SOUL.md, IDENTITY.md, USER.md | `.beings/`, `.beings-local/` | Always loaded every session — who you are |
| **Knowledge graph** | Notes, decisions, patterns, sessions | `memory-graph/*.md` | Queried on demand via semantic search |

**Identity files stay always-loaded.** They're who you are — not optional.

**The knowledge graph lives in markdown files** inside `memory-graph/`. Every note is a real file you can open, read, edit, diff, commit, and share.

### Why this matters

1. **Git-syncable** — commit `memory-graph/` to your repo. Your Being's memory travels with the project. Switch machines, `git pull`, memory is there.
2. **Hand-editable** — open a note in Obsidian, VS Code, Vim, whatever. Fix a typo, correct a fact, add context. The watcher reindexes automatically.
3. **Human-readable** — you can actually read what your Being remembers. No binary DB to inspect.
4. **Obsidian-compatible** — point an Obsidian vault at `memory-graph/` and get a visual knowledge graph for free.
5. **Rebuildable** — the SQLite index is a cache. Lose it, run `bin/being-bm-repair`, it rebuilds from the markdown.

## The note format

Every memory is a markdown file like this:

```markdown
---
title: DocForge Skill
type: note
permalink: products/docforge-skill
tags: [skill, documents]
---

# DocForge Skill

Professional PDF proposal generator at ~/skills/docforge/.

## Observations
- [location] ~/skills/docforge/
- [purpose] PDF proposal generator for client deals
- [rule] Always use --no-toc flag unless TOC explicitly requested
- [contact] sales@example.com

## Relations
- implements [[Proposal Workflow]]
- outputs_to [[Shared Proposals Folder]]
- depends_on [[Playwright]]
```

**Structure:**
- **YAML frontmatter** — title, type, permalink (URL slug), tags
- **Observations** — bulleted `- [category] fact` lines. Machine-readable structured claims.
- **Relations** — `[[wikilinks]]` become edges in the knowledge graph. The word before the link (`implements`, `depends_on`, etc.) is the relationship type.

Write notes in your own words. basic-memory indexes them into a searchable graph.

## How it works

```
┌──────────────────────────────────────────────┐
│  memory-graph/                               │  ← Source of truth
│  ├── identity/nova.md                        │    Committed to git
│  ├── team/roster.md                          │    Hand-editable
│  ├── products/docforge-skill.md              │    Obsidian-compatible
│  └── decisions/memory-backend-choice.md      │
└──────────────────────────────────────────────┘
            ↓ watcher (inotify/fsevents)
┌──────────────────────────────────────────────┐
│  ~/.basic-memory/memory.db                   │  ← Index (cache)
│  ├── FTS5 full-text search                   │    Rebuildable
│  ├── sqlite-vec embeddings                   │    Gitignored
│  └── entities + observations + relations     │    Global, per-project isolated
└──────────────────────────────────────────────┘
            ↓ MCP tools
┌──────────────────────────────────────────────┐
│  Your Being                                  │
│  write_note, search_notes, read_note, ...    │
└──────────────────────────────────────────────┘
```

Two processes keep this working:

1. **The index watcher**, a systemd user unit `<project>-memory-index.service` running `bin/being-memory-index watch`
   (installed by `install.sh`; it survives reboots, unlike a `nohup` process). On basic-memory versions with
   `sync --watch` it runs that; newer versions without it get an incremental `reindex` every `BEING_BM_INTERVAL`
   seconds (300). Without systemd, run `bin/being-memory-index watch` under your own supervisor.

2. **`basic-memory mcp --project <name>`** — MCP server spawned per-session by Claude Code. Reads from the same SQLite index.

`bin/being-bm-repair [project]` rebuilds the index from the markdown on demand (new box, bulk edits, a corrupt index).
It uses `reindex --full`, the older `sync`, or the sync service directly, whichever the installed version has.

## The four memory layers

| Layer | Where | Loaded |
|---|---|---|
| Identity and rules | `.beings/*.md` | every session |
| Daily log | `.beings/memory/YYYY-MM-DD.md` | today and yesterday |
| Auto-memory | `~/.claude/projects/<home>/memory/` (linked as `.beings/auto-memory-live`) | its `MEMORY.md` index every session |
| Knowledge graph | `memory-graph/` | searched on demand |

**Auto-memory** is Claude Code's own per-project memory: one small file per fact plus a one-line-per-fact `MEMORY.md`
index. It lives outside git, so the Operations Kit links it into the home for Codex (`AGENTS.md` startup step 6) and
`bin/being-memory-sync` snapshots it into `.beings/auto-memory/` every night. Claude loads only about the first 24 KB of
the index; `bin/<name> doctor` warns before entries start being cut off.

**Session registry.** `bin/being-session-registry` keeps `.beings/sessions/manifest.jsonl` and `INDEX.md`: every Claude
Code session of the home, never dropped, flagged `present: false` when its transcript disappears (exit 2, logged by the
nightly backup).

## MCP tools

When your Being is connected via MCP, it can use these tools:

| Tool | Purpose |
|------|---------|
| `write_note` | Create or update a markdown note (with title, folder, content, tags) |
| `read_note` | Read a note by title or permalink |
| `search_notes` | Hybrid FTS5 + semantic search across all notes |
| `edit_note` | Incremental edits (append/prepend/find_replace/replace_section) |
| `view_note` | Formatted view of a note |
| `move_note` / `delete_note` | Move or delete notes |
| `recent_activity` | What changed recently |
| `build_context` | Get context for continuing a prior discussion |
| `list_memory_projects` | List registered projects |

## Claude Code hooks

Two hooks, both of which put text into the model's context:

### SessionStart
Fires when a session starts (including resumes). The Being queries `search_notes` and `recent_activity` for context
relevant to the conversation, supplementing the always-loaded identity files.

### UserPromptSubmit
Adds today's date and a reminder to check `.beings/GOALS.md`.

Earlier kits also installed echo-only reminders on PreCompact, Stop, PreToolUse and PostToolUse. Their output never
reached the model and only added noise, so `install.sh --update` removes them (hooks you wrote yourself are kept).
Memory is written during work, as the startup files say, not on a reminder. `.claude/settings.local.json` is not
committed, so run `install.sh --update` once on each new box to get the hooks there.

## Installation

### Via install.sh (recommended)

```bash
# Fresh install (interactive)
curl -fsSL https://raw.githubusercontent.com/NaturNestAI-Labs/beings-protocol/main/install.sh | bash

# Update existing Being (interactive)
curl -fsSL https://raw.githubusercontent.com/NaturNestAI-Labs/beings-protocol/main/install.sh | bash -s -- --update

# Non-interactive — auto-install basic-memory without prompting
curl -fsSL https://raw.githubusercontent.com/NaturNestAI-Labs/beings-protocol/main/install.sh | bash -s -- --update --yes
```

Use `--yes` when piping via `curl | bash` since there's no TTY for interactive prompts.

The installer will:
1. Install `basic-memory` via `uv tool` (preferred), `pipx`, or `pip --user` (skips install if the binary is already on PATH)
2. Create `memory-graph/` in your project
3. Register the project with basic-memory (using folder name as project name)
4. Add basic-memory to your MCP configs (`.beings/mcp.json`, `.mcp.json`, `.cursor/mcp.json`)
5. Install Claude Code hooks into `.claude/settings.local.json` if Claude Code is detected
6. Install `bin/being-memory-index` and `bin/being-bm-repair`, and run the index watcher as a systemd user unit
   (`BEING_NO_SYSTEMD=1` skips it)
7. Add `.basic-memory/` to `.gitignore`

**For v0.2.0 users upgrading from MegaMemory:** the installer also strips legacy `megamemory` entries from your MCP configs and replaces old MegaMemory hook commands with the new basic-memory ones. Run `bash install.sh --update --yes` and the migration is fully automated — no manual cleanup needed.

### Manual setup

```bash
# 1. Install basic-memory (prefer uv)
uv tool install basic-memory
# OR: pipx install basic-memory
# OR: pip install --user basic-memory

# 2. Create the memory folder and register project
mkdir -p memory-graph
basic-memory project add my-being "$(pwd)/memory-graph" --default

# 3. Keep the index current (systemd user unit; see "How it works")
bin/being-memory-index install

# 4. Add to your MCP config (.mcp.json for Claude Code):
```

```json
{
  "mcpServers": {
    "basic-memory": {
      "command": "basic-memory",
      "args": ["mcp", "--project", "my-being", "--transport", "stdio"],
      "description": "Markdown-native persistent memory"
    }
  }
}
```

```bash
# 5. Add .basic-memory/ to .gitignore (safety net — the global index lives in ~/.basic-memory/)
echo ".basic-memory/" >> .gitignore
```

## Rebuilding

See [REBUILD.md](REBUILD.md) — with basic-memory, rebuild is a single command since the markdown files ARE the source of truth.

## Obsidian integration

Point an Obsidian vault at your `memory-graph/` directory. You get:
- Visual graph view of all your Being's notes and their relations
- Wiki-link autocomplete when editing
- Full-text search across your Being's mind
- Hand-edit memories and see the watcher reindex them in real time

## Migration from MegaMemory (v0.2.0 users)

If you were running the v0.2.0 memory skill with MegaMemory, the upgrade is a single command:

```bash
bash install.sh --update --yes
```

This automatically:
- Strips the legacy `megamemory` entry from `.beings/mcp.json`, `.mcp.json`, `.cursor/mcp.json`
- Adds the new `basic-memory` entry in its place (using your folder name as project name)
- Replaces old MegaMemory Claude Code hooks (the ones mentioning `understand` / `get_concept`) with the new basic-memory hooks (mentioning `write_note` / `search_notes`)
- Installs basic-memory via `uv tool` / `pipx` / `pip` if not already present
- Creates `memory-graph/`, registers the project, installs the index watcher unit
- Adds `.basic-memory/` to `.gitignore`

**Optional cleanup** after migration:
1. Your MegaMemory knowledge graph (`.megamemory/knowledge.db`) is still on disk — gitignored but takes ~23MB. Delete if you want: `rm -rf .megamemory/`
2. (Optional) Re-seed your new basic-memory graph from your `.beings/` MD files. Ask your Being: "seed your memory from my identity files" — it'll walk `MEMORY.md`, `TOOLS.md`, `CONVENTIONS.md`, etc. and write them as notes in `memory-graph/`.

The v0.2.0 memory skill README and hooks used `understand`/`get_concept` — v0.2.1+ uses `write_note`/`search_notes`. The mental model is identical; only the implementation changed.

## First implementation

Part of the [Beings Protocol](https://github.com/NaturNestAI-Labs/beings-protocol) — giving AI Beings persistent identity, memory, and soul.
