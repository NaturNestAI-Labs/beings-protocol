# Evolution Protocol — Self-Evolving AI Beings

A reusable skill for the [Beings Protocol](https://github.com/NaturNestAI-Labs/beings-protocol) that gives any Being the ability to:

1. **Self-modify** — improve their own code via Claude Code CLI (git worktree isolation, PR-based review)
2. **Spawn subagents** — create temporary agents for focused tasks with restricted tool sets
3. **Self-learn** — detect patterns in performance data and trigger autonomous evolution

## Safety Model

- SOUL.md is **never** modified (identity is sacred)
- All code changes via **PR** (never auto-merge)
- Git **worktree** isolation (separate branch, never touches main)
- Tests **must pass** before PR creation
- **Rate limited** (configurable: default 2/day, $0.50/evolution)
- **Disabled by default** — opt-in via config

## Usage

Add to your Being's config:
```yaml
evolution:
  enabled: true
  reflect_every_n: 5
  auto_evolve: false
  max_evolve_per_day: 2
  max_budget_per_evolve_usd: 0.50
  require_tests: true
```

Add the EvolutionMixin to your Being class:
```python
from beings.skills.evolution import EvolutionMixin, WSServerMixin

class MyBeing(EvolutionMixin, WSServerMixin, ...):
    pass
```

Give your Being the evolution tools:
```python
from beings.skills.evolution import evolve, propose_change, spawn_agent
```

## The Protocol

The Evolution Protocol is also a meta-process for development:

1. **ANALYZE** — spawn introspection agent to understand the problem
2. **IMPLEMENT** — parallel evolve() calls, each in own worktree
3. **REVIEW** — spawn analysis agent to review diffs
4. **TEST** — pytest in each worktree before PR
5. **INTEGRATE** — human reviews, merges in dependency order

## Files

| File | Purpose |
|------|---------|
| `evolve.py` | Self-modification via Claude Code CLI with worktree isolation |
| `spawn.py` | Subagent spawning with configurable tool sets |
| `evolution_mixin.py` | Pattern detection, self-learning loop, auto-evolution triggers |
| `ws_server.py` | WebSocket server mixin for real-time client communication |
| `config.py` | EvolutionConfig dataclass with safe defaults |

## Customization

### Custom Pattern Detection

Override `_detect_patterns` in your Being to add domain-specific patterns:

```python
class MyBeing(EvolutionMixin, ...):
    def _detect_patterns(self, data: dict) -> list[dict]:
        patterns = super()._detect_patterns(data)
        # Add your domain-specific patterns
        if data.get("my_metric", 0) > threshold:
            patterns.append({
                "type": "my_pattern",
                "description": "...",
                "confidence": 0.85,
                "occurrences": count,
                "suggested_action": "...",
            })
        return patterns
```

### Custom Tool Sets for Spawned Agents

Pass custom tool sets when spawning:

```python
from beings.skills.evolution.spawn import register_tool_set

register_tool_set("my_tools", ["tool_a", "tool_b"])
result = spawn_agent("Do something", tool_set="my_tools")
```

## First Implementation

Built for [DJ Treta](https://github.com/VeltriaAI/dj-treta) — an AI DJ Being that plays, produces, and evolves her music autonomously.
