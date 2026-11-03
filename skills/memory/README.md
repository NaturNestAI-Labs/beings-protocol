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
5. **Rebuildable** — the SQLite index is a cache. Lose it, run `basic-memory sync`, it rebuilds from the markdown.

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

1. **`basic-memory sync --watch`** — background daemon. Installed once, runs forever. Watches `memory-graph/` for changes (via fsevents/inotify) and reindexes automatically. Any edit from any tool — your Being via MCP, you via Obsidian, `git pull` from another machine — is picked up within milliseconds.

2. **`basic-memory mcp --project <name>`** — MCP server spawned per-session by Claude Code. Reads from the same SQLite index the watcher keeps fresh.

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

Three hooks automate memory capture and recall:

### PreCompact
Fires before context is compressed. The Being extracts key decisions, learnings, and facts from the session and writes them to `memory-graph/` via `write_note`. Preserves knowledge that would otherwise be lost to compaction.

### Stop (Session End)
Fires when a session ends. The Being writes a session summary note to `memory-graph/sessions/YYYY-MM-DD.md` capturing what was built, decisions made, and unresolved questions.

### SessionStart
Fires when a new session starts (including resumes). The Being queries `search_notes` and `recent_activity` for context relevant to the conversation, supplementing the always-loaded identity files.

Hooks use `echo` to inject instructions into the Being's context. The Being then uses MCP tools to act on those instructions.

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
6. Start the `basic-memory sync --watch` daemon in the background
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

# 3. Start the watcher
basic-memory sync --watch &

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
- Creates `memory-graph/`, registers the project, starts the watch daemon
- Adds `.basic-memory/` to `.gitignore`

**Optional cleanup** after migration:
1. Your MegaMemory knowledge graph (`.megamemory/knowledge.db`) is still on disk — gitignored but takes ~23MB. Delete if you want: `rm -rf .megamemory/`
2. (Optional) Re-seed your new basic-memory graph from your `.beings/` MD files. Ask your Being: "seed your memory from my identity files" — it'll walk `MEMORY.md`, `TOOLS.md`, `CONVENTIONS.md`, etc. and write them as notes in `memory-graph/`.

The v0.2.0 memory skill README and hooks used `understand`/`get_concept` — v0.2.1+ uses `write_note`/`search_notes`. The mental model is identical; only the implementation changed.

## First implementation

Part of the [Beings Protocol](https://github.com/NaturNestAI-Labs/beings-protocol) — giving AI Beings persistent identity, memory, and soul.
