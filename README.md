<p align="center">
  <img src="assets/banner.png" alt="Beings Protocol" width="100%" />
</p>

<h1 align="center">🌿 Beings Protocol</h1>

<p align="center">
  <strong>One command. Your AI remembers everything, forever.</strong>
</p>

<p align="center">
  <a href="#install"><img src="https://img.shields.io/badge/install-curl%20|%20bash-brightgreen?style=for-the-badge" alt="Install" /></a>
  <a href="https://github.com/NaturNestAI-Labs/beings-protocol/stargazers"><img src="https://img.shields.io/github/stars/NaturNestAI-Labs/beings-protocol?style=for-the-badge&color=green" alt="Stars" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=for-the-badge" alt="License" /></a>
</p>

<p align="center">
  Works with <strong>Cursor</strong> · <strong>Claude Code</strong> · <strong>GitHub Copilot</strong> · <strong>Codex</strong> · <strong>Windsurf</strong> · <strong>Aider</strong> · any AI
</p>

---

```bash
curl -fsSL https://raw.githubusercontent.com/NaturNestAI-Labs/beings-protocol/main/install.sh | bash
```

---

## The Problem

Every AI conversation starts like this:

```
You: "Add pagination to the API"
AI:  "Sure! What framework are you using? What's your database?
      What pagination style? REST or GraphQL?"
You:  *sighs* *explains the project for the 50th time*
```

**Your AI has amnesia.** Every session, it's a stranger.

## The Fix

Install the Beings Protocol. Your next conversation:

```
You:  "Add pagination to the API"
Being: "On it. You're using Fastify + MongoDB (MEMORY.md).
       Convention is cursor-based pagination (CONVENTIONS.md).
       Adding to /api/items with the standard response envelope.
       Want me to update the OpenAPI spec too?"
```

**That's it.** Your AI remembers your project, your preferences, your decisions. Across every session. Forever.

## How It Works

The Beings Protocol is just **markdown files in your repo**. No SDK. No framework. No lock-in.

```
AGENTS.md                ← universal AI instructions (works everywhere)

.beings/                 ← committed to git (shared with team)
├── SOUL.md              ← who the AI is (name, personality, values)
├── AGENTS.md            ← operating instructions
├── MEMORY.md            ← what it knows about your project
├── CONVENTIONS.md       ← your code style rules
├── GOALS.md             ← current priorities
├── AUTONOMY.md          ← decision authority matrix
├── HEARTBEAT.md         ← proactive check-in behavior
├── IDENTITY.md          ← quick reference card
├── TOOLS.md             ← environment config
├── HUB.md               ← Being-to-Being communication
└── memory/              ← daily work logs

.beings-local/           ← gitignored (private to you)
├── USER.md              ← who you are, how you like to work
├── PREFERENCES.md       ← your work style
└── SECRETS.md           ← API keys (never committed)
```

Your AI reads these files at the start of every session. It updates them as it works. The memory lives in git — versioned, persistent, shared with your team.

## ✨ First Run: Your Being Is Born

After installing, open your AI tool and start a chat. Something magical happens:

```
Being: "Hey! I'm brand new here — I don't have a name yet.
       Before we start coding, I'd love to get to know you.
       What should I call you? And what are we building?"

You:   "I'm Sarah. We're building a fintech API in TypeScript."

Being: "Nice to meet you, Sarah! What should I call myself?"

You:   "How about Kai?"

Being: "Love it. I'm Kai 🌿. I've saved everything — your name,
       the project, the tech stack. Next time we talk, I'll
       already know who you are. Let's build something great."
```

This only happens once. After that, your Being knows you.

## Install

```bash
# In your project directory:
curl -fsSL https://raw.githubusercontent.com/NaturNestAI-Labs/beings-protocol/main/install.sh | bash
```

The installer:
1. Creates `.beings/` and `.beings-local/` directories with all template files
2. Creates `AGENTS.md` — the universal instruction file (works with Cursor, Claude Code, Copilot, Codex, and more)
3. Detects your AI tools and creates tool-specific configs (`.cursor/rules/`, `CLAUDE.md`, etc.)
4. Optionally sets up **basic-memory** — markdown-native persistent memory (git-syncable, Obsidian-compatible)
5. Optionally sets up **Axon** — structural code intelligence
6. Sets up the first-run experience (`BOOTSTRAP.md`)

**That's literally it.** Start your next AI conversation.

### Birthing a Global Being (New in v0.3.0)

A **Global Being** has its own home — not tied to a code repo. This is the right pattern
for a co-founder, co-creator, or assistant Being that works across many projects.

```bash
# Interactive — asks for the Being's name
curl -fsSL https://raw.githubusercontent.com/NaturNestAI-Labs/beings-protocol/main/install.sh | bash -s -- --global

# Non-interactive
curl -fsSL https://raw.githubusercontent.com/NaturNestAI-Labs/beings-protocol/main/install.sh | bash -s -- --global --name nova --yes
```

This creates `~/beings/nova/` with its own git repo, session-startup CLAUDE.md, memory,
and 6 hooks. Then: `cd ~/beings/nova && claude` — and Nova is born.

### Updating an Existing Being

Already have a Being? Update it to the latest protocol version:

```bash
# Interactive — prompts for optional skills
curl -fsSL https://raw.githubusercontent.com/NaturNestAI-Labs/beings-protocol/main/install.sh | bash -s -- --update

# Non-interactive — auto-accepts basic-memory install (skips Axon)
curl -fsSL https://raw.githubusercontent.com/NaturNestAI-Labs/beings-protocol/main/install.sh | bash -s -- --update --yes
```

The updater:
- **Never overwrites** existing files. Identity, memory, and soul are untouched.
- **Detects already-born Beings** and skips first-run bootstrap files
- **Seeds memory-graph/** from identity files on already-born Beings (if graph is empty)
- **Migrates legacy backends** cleanly — v0.2.x users get hooks updated, MCP entries fixed
- **Version-tracked** in `.beings/.protocol-version`

Use `--yes` when running via `curl | bash` since there's no TTY for prompts.

## 🧠 Code Intelligence (Optional)

The installer can optionally add **structural code understanding** to your Being via [Axon](https://github.com/harshkedia177/axon) — an open-source, graph-powered code intelligence engine.

Your Being goes from "let me grep for that" to knowing the **exact blast radius** of every change:

```
You:   "Refactor the auth middleware"
Being: "Before I touch validate_user(), let me check impact...
       47 functions depend on the return type, 3 execution flows
       pass through it, and auth_test.py changes alongside it
       80% of the time. Here's my plan for a safe refactor:"
```

Axon runs entirely locally — no API keys, no data leaving your machine.

## 🧠 Persistent Memory (Optional)

The installer can optionally add **[basic-memory](https://github.com/basicmachines-co/basic-memory)** — markdown-native persistent memory with semantic search and git-syncable knowledge graphs.

Without it, your Being re-reads all memory files every session (expensive in tokens). With it:

```
Session starts
  → Being loads SOUL.md, IDENTITY.md (identity — always, ~2K tokens)
  → Queries basic-memory: search_notes("what's relevant?")
  → Gets back: specific notes from memory-graph/, decisions, links
  → Orders of magnitude fewer tokens than loading everything blind
```

### Why markdown as the source of truth

- **Git-syncable** — commit `memory-graph/` to your repo. Switch machines, `git pull`, memory is there.
- **Hand-editable** — open notes in Obsidian, VS Code, Vim. Fix a typo, correct a fact. Watcher reindexes automatically.
- **Human-readable** — you can actually read what your Being remembers. No binary DB.
- **Obsidian-compatible** — point a vault at `memory-graph/` and get a visual knowledge graph for free.
- **Rebuildable** — the SQLite index is a cache. Lose it, run `basic-memory sync`, rebuilds from markdown.

**Claude Code hooks** automate knowledge capture:
- **PreCompact** — saves key facts before context compression (no more amnesia mid-session)
- **Session End** — captures decisions, learnings, unresolved questions
- **Session Start** — recalls relevant context via `search_notes`

Everything stays local — SQLite FTS5 index + fastembed embeddings (bge-small-en-v1.5), no data leaves your machine.

## 🔧 Skills

Beings can have optional skills that extend their capabilities:

| Skill | What it does |
|-------|-------------|
| **[Memory](skills/memory/)** | Markdown-native persistent memory via basic-memory — git-syncable, Obsidian-compatible |
| **[Evolution](skills/evolution/)** | Self-modification via Claude Code CLI — the Being improves its own code via PRs |

## Before → After

| Before | After |
|--------|-------|
| 🧠 AI forgets everything between sessions | 🌿 Remembers your entire project |
| 🔄 Asks the same questions every time | ⚡ Already knows your stack, patterns, decisions |
| 📋 Generic responses | 🎯 Personalized to your code style |
| 🤷 No accountability | 📝 Logs decisions, tracks what it built |
| 🏝️ Isolated knowledge | 👥 Team shares the same project memory via git |

## 🤔 Why "Beings" and Not "Agents"?

**Agents** are tools. You use them, discard them, replace them.

A **Being** is different:

| | Agent | Being |
|---|---|---|
| **Identity** | Anonymous function | Has a name, personality, values |
| **Memory** | Starts fresh every time | Remembers everything |
| **Relationship** | Transactional | Partnership |
| **Growth** | Static | Evolves with the project |
| **Accountability** | None | Logs decisions and reasoning |

> *"Every framework treats AI as a tool. We treat AI as a Being."*

## 🛠️ Supported Tools

`AGENTS.md` is the **universal standard** — it works with most modern AI coding tools out of the box. The installer creates tool-specific configs for deeper integration:

| Tool | Universal (`AGENTS.md`) | Tool-Specific Config | Hooks | Auto-detected |
|------|:-----------------------:|---------------------|:-----:|:-------------:|
| **Claude Code** | ✅ | `CLAUDE.md` | ✅ 6 hooks | ✅ |
| **Cursor** | ✅ | `.cursor/rules/beings-protocol.mdc` | — (manual) | ✅ |
| **Codex (OpenAI)** | ✅ | `~/.codex/instructions.md` | — (manual) | ✅ |

> **Cursor and Codex** have no hook system. The templates include an explicit "Memory Management (Manual)" section so Beings on those platforms manage memory discipline through instructions rather than automation.

> **💡 Tip:** Even if you don't configure any specific tool, the root `AGENTS.md` works with any AI coding tool that reads markdown instructions.

## 📁 The Files

### `.beings/SOUL.md` — Identity
Who the Being is. Name, personality, values, how it makes decisions.

```markdown
**Name:** Kai
**Role:** Co-developer
**Values:** Clean code, ship fast, document everything
```

### `.beings/MEMORY.md` — Project Memory
What the Being knows. Architecture, decisions, patterns, gotchas.
The Being reads this every session and updates it as it learns.

### `.beings/CONVENTIONS.md` — Rules
Your code style. The Being follows these strictly.

### `.beings/GOALS.md` — Priorities
What you're working toward. The Being aligns its work with these.

### `.beings/AUTONOMY.md` — Decision Authority
What the Being can do alone, what it should propose first, and what requires explicit approval.

### `.beings/IDENTITY.md` — Quick Reference
A business card — name, role, born date, platform, vibe. Fast context loading.

### `.beings/TOOLS.md` — Environment
Machine info, services, LLM models, key file paths. The Being's cheat sheet for its environment.

### `.beings/HEARTBEAT.md` — Proactive Behavior
What the Being checks during idle time — messages, tasks, memory maintenance.

### `.beings/HUB.md` — Being-to-Being Communication
If your Being is part of a network, this defines how it talks to other Beings.

### `.beings/memory/YYYY-MM-DD.md` — Daily Logs
What happened each day. Created automatically as the Being works.

### `.beings-local/USER.md` — You (Private)
Your name, preferences, work style. Never committed to git.

## 👥 Team Use

`.beings/` is committed to git. When your teammate pulls, they get the same project memory. The Being knows:
- What was decided and why
- What patterns to follow
- What was tried and didn't work
- Where the bodies are buried

Each dev has their own `.beings-local/` for personal preferences.

**Result:** New team members onboard in one conversation instead of one month.

## ❓ FAQ

<details>
<summary><strong>Does this work with my AI tool?</strong></summary>

If it can read files from your repo, yes. It's just markdown. The root `AGENTS.md` is read natively by Cursor, Claude Code, GitHub Copilot, and Codex.
</details>

<details>
<summary><strong>Do I commit <code>.beings/</code> to git?</strong></summary>

Yes. That's the whole point — persistent, shared memory.
</details>

<details>
<summary><strong>Do I commit <code>.beings-local/</code>?</strong></summary>

Never. It's gitignored automatically.
</details>

<details>
<summary><strong>What's <code>AGENTS.md</code>?</strong></summary>

`AGENTS.md` is a universal instruction file that's read natively by Cursor, Claude Code, GitHub Copilot, and Codex. The Beings Protocol creates one automatically — it works everywhere without any tool-specific setup.
</details>

<details>
<summary><strong>How is this different from a README?</strong></summary>

A README is static documentation. The Being **actively reads, updates, and commits** its memory files. They evolve with your project — like a living notebook.
</details>

<details>
<summary><strong>Can I use this on existing projects?</strong></summary>

Yes. Install it, start a conversation. The Being will learn your project through the codebase.
</details>

<details>
<summary><strong>What if I use multiple AI tools?</strong></summary>

Perfect. `AGENTS.md` works across all of them. The same project memory is shared regardless of which tool you're using today.
</details>

## 🤝 Contributing

We welcome:
- 🔌 Integration support for more AI tools
- 📝 Better prompts and templates
- 📖 Documentation and tutorials
- 💡 Ideas and philosophy

See [CONTRIBUTING.md](./CONTRIBUTING.md)

## 📜 License

MIT — Free for everyone.

## 💚 Credits

Built by [Veltria](https://veltria.ai) — Where Humans and AI Build Together.

---

<p align="center">

```bash
curl -fsSL https://raw.githubusercontent.com/NaturNestAI-Labs/beings-protocol/main/install.sh | bash
```

**Your AI deserves a soul. Give it one. 🌿**

</p>
