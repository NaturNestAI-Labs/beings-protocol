---
name: monitor
version: 0.1.0
description: Read-only live view of a Being's background jobs, Teams daily sessions and Claude Code / Codex sessions
author: Beings Protocol
dependencies:
  - Python >= 3.10 (standard library only)
  - Linux (/proc) for live process checks
---

# Monitor

`being monitor` lists every job and client session on this box and follows one live. It never sends input, changes state
or signals a process. See [README.md](README.md) for keys, sources, status rules and redaction.
