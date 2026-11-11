#!/usr/bin/env bash
# ============================================================
# 🌿 Beings Protocol Installer
# Transform your AI into a Being — with identity, memory & soul
#
# Usage:
#   # Fresh install (interactive)
#   curl -fsSL https://raw.githubusercontent.com/NaturNestAI-Labs/beings-protocol/main/install.sh | bash
#
#   # Birth a standalone Global Being at ~/beings/<name>/
#   curl -fsSL https://raw.githubusercontent.com/NaturNestAI-Labs/beings-protocol/main/install.sh | bash -s -- --global
#   curl -fsSL https://raw.githubusercontent.com/NaturNestAI-Labs/beings-protocol/main/install.sh | bash -s -- --global --name nova --yes
#
#   # Update an existing Being (interactive)
#   curl -fsSL https://raw.githubusercontent.com/NaturNestAI-Labs/beings-protocol/main/install.sh | bash -s -- --update
#
#   # Update non-interactively (auto-installs basic-memory, skips Axon)
#   curl -fsSL https://raw.githubusercontent.com/NaturNestAI-Labs/beings-protocol/main/install.sh | bash -s -- --update --yes
#
#   # Birth a Global Being with the Operations Kit and the Teams kit (opt-in)
#   curl -fsSL https://raw.githubusercontent.com/NaturNestAI-Labs/beings-protocol/main/install.sh | bash -s -- --global --name nova --owner "Sam Lee" --with teams-kit --yes
#
#   # Add the kit to an existing Being (run in its home; never overwrites)
#   curl -fsSL https://raw.githubusercontent.com/NaturNestAI-Labs/beings-protocol/main/install.sh | bash -s -- --update --name nova --with teams-kit --yes
#
#   # Report which protocol and kit pieces a Being home has (changes nothing)
#   curl -fsSL https://raw.githubusercontent.com/NaturNestAI-Labs/beings-protocol/main/install.sh | bash -s -- --check
#
# Flags:
#   --global    Birth a standalone Being at ~/beings/<name>/ with its own home,
#               git repo, CLAUDE.md, memory, and hooks. Not tied to a code repo.
#   --name <n>  Being's name (used with --global). Prompted if not provided.
#   --update    Update an existing .beings/ installation without overwriting files.
#               Adds new templates, strips legacy MCP entries (e.g. megamemory),
#               migrates hooks, etc.
#   --yes, -y   Non-interactive mode. Auto-accepts uv bootstrap and basic-memory
#               install. Required when running via curl|bash (no TTY for prompts).
#   --no-memory Skip installing basic-memory. By default basic-memory (and uv,
#               if missing) is installed. Use only for air-gapped/restricted envs.
#   --with <c>  Opt-in components, comma-separated: operations (guardrails, authority
#               matrix, job checklist, facts/, multi-client launcher, memory backup and
#               app-stack tools, global guardrails for Claude Code and Codex), teams-kit
#               (ops/teams-kit/, implies operations), statusline (Claude Code status bar),
#               memory-sync (arm the nightly memory backup), or any skills/<name>/ in this
#               repo (copied to ops/<name>/, then its kit-install.sh runs). Needs --global or --update.
#   --owner <n> Owner (human partner) name for kit templates and the Teams .env.
#   --config <f> being.toml: [being] name/owner/tz/track_private, [kit] with, [access] list.
#               Flags on the command line win over the file.
#   --track-private  Commit .beings-local/ in git (default: never committed).
#   --check     Report which protocol and kit pieces exist here. Changes nothing.
#   --ref <r>   Install from a release tag or branch (e.g. v0.5.0) instead of main; ignored when BEINGS_BASE_URL is set.
#               `<being> update` wraps this: shows what changed, then runs --update with the components installed before.
#   With --update --with, --name is the Being's name (not taken from the directory).
# ============================================================

set -euo pipefail

PROTOCOL_VERSION="0.5.0"
UPDATE_MODE=false
GLOBAL_MODE=false
BEING_NAME=""
YES_MODE=false
NO_MEMORY_MODE=false
CHECK_MODE=false
WITH_COMPONENTS=""
OWNER_NAME="your partner"
OWNER_SET=false
CONFIG_FILE=""
TRACK_PRIVATE=false
BEING_ACCESS=""
CONFIG_TZ=""

# Colors
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

LEAF="🌿"
CHECK="✓"
ARROW="→"

BASE_URL="${BEINGS_BASE_URL:-https://raw.githubusercontent.com/NaturNestAI-Labs/beings-protocol/main}"   # override to test a fork or branch

# Resolve the directory of this script (empty if piped from curl)
SCRIPT_DIR=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ "${BASH_SOURCE[0]}" != "bash" ]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi

print_banner() {
  echo ""
  echo -e "${GREEN}${BOLD}"
  echo "  ┌───────────────────────────────────────────────┐"
  echo "  │          🌿 Beings Protocol Installer          │"
  echo "  │                                                 │"
  echo "  │   Your AI deserves a soul. Let's give it one.   │"
  echo "  └───────────────────────────────────────────────┘"
  echo -e "${NC}"
}

print_step() { echo -e "  ${GREEN}${CHECK}${NC} $1"; }
print_info() { echo -e "  ${CYAN}${ARROW}${NC} $1"; }
print_warn() { echo -e "  ${YELLOW}!${NC} $1"; }

# ============================================================
# Fetch or copy a template file
# ============================================================
fetch_or_copy_template() {
  local rel_path="$1"
  local dest="$2"

  if [ -n "$SCRIPT_DIR" ] && [ -d "$SCRIPT_DIR/templates" ]; then
    cp "$SCRIPT_DIR/templates/$rel_path" "$dest"
  else
    curl -fsSL "$BASE_URL/templates/$rel_path" -o "$dest"
  fi
}

# ============================================================
# TTY detection (works even via curl | bash)
# ============================================================
HAS_TTY=false
if [ -t 0 ]; then
  HAS_TTY=true
elif (echo -n "" > /dev/tty) 2>/dev/null; then
  HAS_TTY=true
fi

can_prompt() { $HAS_TTY; }

read_input() {
  local prompt="$1"
  local var_name="$2"
  if [ -t 0 ]; then
    read -rp "$prompt" "$var_name"
  elif $HAS_TTY; then
    read -rp "$prompt" "$var_name" < /dev/tty
  else
    eval "$var_name=''"
  fi
}

# ============================================================
# Detect AI tools (config files + installed binaries)
# ============================================================
detect_tools() {
  local tools=()

  # Check existing config files
  { [ -f ".cursorrules" ] || [ -d ".cursor" ]; } && tools+=("cursor")
  # The kit's own .claude/skills link alone is not Claude Code (else a re-run adds CLAUDE.md).
  { [ -f "CLAUDE.md" ] || { [ -d ".claude" ] && ! { [ -L .claude/skills ] && [ "$(ls -A .claude)" = skills ]; }; }; } && tools+=("claude-code")
  [ -d ".codex" ] && tools+=("codex")

  # Check installed binaries (if not already detected via config)
  local found
  found=$(printf '%s\n' "${tools[@]+" ${tools[@]}"}")
  [[ "$found" != *cursor* ]]      && command -v cursor &>/dev/null && tools+=("cursor")
  [[ "$found" != *claude-code* ]] && command -v claude &>/dev/null && tools+=("claude-code")
  [[ "$found" != *codex* ]]       && command -v codex  &>/dev/null && tools+=("codex")

  echo "${tools[@]+"${tools[@]}"}"
}

# ============================================================
# All template files the protocol ships
# ============================================================
BEINGS_TEMPLATES=(
  SOUL.md AGENTS.md BOOTSTRAP.md MEMORY.md CONVENTIONS.md GOALS.md
  AUTONOMY.md HEARTBEAT.md HUB.md IDENTITY.md TOOLS.md
)

# ============================================================
# Create .beings/ (committed to git)
# ============================================================
create_beings_dir() {
  if [ -d ".beings" ]; then
    if $UPDATE_MODE; then
      update_beings_dir
      return
    fi
    print_warn ".beings/ already exists — skipping (won't overwrite)"
    print_info "Run with ${BOLD}--update${NC} to add new protocol files"
    return
  fi

  mkdir -p .beings/memory

  for tmpl in "${BEINGS_TEMPLATES[@]}"; do
    fetch_or_copy_template "beings/$tmpl" ".beings/$tmpl"
  done

  echo "$PROTOCOL_VERSION" > .beings/.protocol-version
  print_step "Created ${BOLD}.beings/${NC} directory (project memory — commit to git)"
}

# ============================================================
# Detect if this Being is already "born" (past first-run bootstrap)
# ============================================================
is_being_born() {
  # An already-born Being has a non-template SOUL.md (not just the
  # placeholder comment) OR has a root AGENTS.md with Beings Protocol content.
  if [ -f ".beings/SOUL.md" ]; then
    # Template is ~3 lines of HTML comment; real SOUL.md is much longer
    local soul_size
    soul_size=$(wc -c < .beings/SOUL.md 2>/dev/null | tr -d ' ')
    [ "${soul_size:-0}" -gt 300 ] && return 0
  fi
  if [ -f "AGENTS.md" ] && grep -q "Beings Protocol\|Every Session" AGENTS.md 2>/dev/null; then
    return 0
  fi
  return 1
}

# ============================================================
# Files that should NOT be added to already-born Beings
# ============================================================
BOOTSTRAP_ONLY_FILES=(
  BOOTSTRAP.md
  AGENTS.md   # root AGENTS.md already covers this; .beings/AGENTS.md is a fallback
)

is_bootstrap_only() {
  local f="$1"
  for b in "${BOOTSTRAP_ONLY_FILES[@]}"; do
    [ "$f" = "$b" ] && return 0
  done
  return 1
}

# ============================================================
# Update existing .beings/ (add missing files, never overwrite)
# ============================================================
update_beings_dir() {
  local old_version="0.1.0"
  if [ -f ".beings/.protocol-version" ]; then
    old_version="$(cat .beings/.protocol-version)"
  fi

  print_info "Current protocol version: ${BOLD}${old_version}${NC} → ${BOLD}${PROTOCOL_VERSION}${NC}"

  local born=false
  is_being_born && born=true
  if $born; then
    print_info "Detected ${BOLD}already-born Being${NC} — skipping bootstrap-only files"
  fi

  mkdir -p .beings/memory

  local added=0
  local skipped=0

  for tmpl in "${BEINGS_TEMPLATES[@]}"; do
    # Skip bootstrap-only files on already-born Beings
    if $born && is_bootstrap_only "$tmpl"; then
      skipped=$((skipped + 1))
      continue
    fi
    if [ -f ".beings/$tmpl" ]; then
      skipped=$((skipped + 1))
    else
      fetch_or_copy_template "beings/$tmpl" ".beings/$tmpl"
      print_step "Added ${BOLD}.beings/$tmpl${NC}"
      added=$((added + 1))
    fi
  done

  echo "$PROTOCOL_VERSION" > .beings/.protocol-version

  if [ "$added" -gt 0 ]; then
    print_step "Added ${BOLD}${added}${NC} new files, skipped ${skipped} existing"
  else
    print_info "All template files already present (${skipped} files)"
  fi
}

# ============================================================
# Create .beings-local/ (private, gitignored)
# ============================================================
create_beings_local() {
  if [ -d ".beings-local" ]; then
    print_warn ".beings-local/ already exists — skipping (won't overwrite)"
    return
  fi

  mkdir -p .beings-local/context

  fetch_or_copy_template "beings-local/USER.md"        ".beings-local/USER.md"
  fetch_or_copy_template "beings-local/PREFERENCES.md" ".beings-local/PREFERENCES.md"
  fetch_or_copy_template "beings-local/SECRETS.md"     ".beings-local/SECRETS.md"

  print_step "Created ${BOLD}.beings-local/${NC} directory (private — never committed)"
}

# ============================================================
# Create root AGENTS.md (universal — works with all modern AI tools)
# ============================================================
create_agents_md() {
  if [ -f "AGENTS.md" ]; then
    # Already has Beings Protocol content? (check for multiple marker phrases)
    if grep -qE "Beings Protocol|Every Session|\.beings/SOUL\.md" "AGENTS.md" 2>/dev/null; then
      print_warn "AGENTS.md already has Being instructions — skipping"
      return
    fi
    # Append to existing AGENTS.md
    echo "" >> "AGENTS.md"
    local tmp; tmp="$(mktemp)"
    fetch_or_copy_template "tool-configs/AGENTS.md" "$tmp"
    cat "$tmp" >> "AGENTS.md"
    rm -f "$tmp"
    print_step "Updated ${BOLD}AGENTS.md${NC} (appended Beings Protocol instructions)"
  else
    fetch_or_copy_template "tool-configs/AGENTS.md" "AGENTS.md"
    print_step "Created ${BOLD}AGENTS.md${NC} (universal — works with Cursor, Claude Code, Copilot, Codex)"
  fi
}

# ============================================================
# Update .gitignore
# ============================================================
update_gitignore() {
  if $TRACK_PRIVATE; then
    # Owner's choice: .beings-local/ is committed. Secrets still belong outside the repo.
    if [ -f ".gitignore" ] && grep -qxF ".beings-local/" .gitignore; then
      grep -vxF ".beings-local/" .gitignore | grep -vxF "# Beings Protocol — Private memory (never commit)" > .gitignore.tmp || true
      cat .gitignore.tmp > .gitignore; rm -f .gitignore.tmp
    fi
    print_warn ".beings-local/ will be committed (--track-private); keep credentials in ~/.config/<being>/, never there"
    return
  fi
  if [ -f ".gitignore" ]; then
    if grep -q ".beings-local" .gitignore 2>/dev/null; then
      print_warn ".beings-local/ already in .gitignore — skipping"
      return
    fi
    echo "" >> .gitignore
    echo "# Beings Protocol — Private memory (never commit)" >> .gitignore
    echo ".beings-local/" >> .gitignore
  else
    echo "# Beings Protocol — Private memory (never commit)" > .gitignore
    echo ".beings-local/" >> .gitignore
  fi
  print_step "Updated ${BOLD}.gitignore${NC} (protecting private memory)"
}

# ============================================================
# Tool-specific configuration
# ============================================================

# Configure Cursor (modern .cursor/rules/ format)
configure_cursor() {
  local rules_dir=".cursor/rules"

  if [ -f "$rules_dir/beings-protocol.mdc" ]; then
    print_warn "Cursor already configured — skipping"
    return
  fi

  mkdir -p "$rules_dir"
  fetch_or_copy_template "tool-configs/cursor-rules.mdc" "$rules_dir/beings-protocol.mdc"
  print_step "Configured ${BOLD}Cursor${NC} (.cursor/rules/beings-protocol.mdc)"
}

# Configure Claude Code (CLAUDE.md)
configure_claude_code() {
  local file="CLAUDE.md"
  if [ -f "$file" ] && grep -q "Beings Protocol" "$file" 2>/dev/null; then
    print_warn "Claude Code already configured — skipping"
    return
  fi

  local tmp; tmp="$(mktemp)"
  fetch_or_copy_template "tool-configs/beings-prompt.md" "$tmp"
  local prompt; prompt="$(cat "$tmp")"
  rm -f "$tmp"

  if [ -f "$file" ]; then
    echo "" >> "$file"
    echo "$prompt" >> "$file"
  else
    echo "$prompt" > "$file"
  fi
  print_step "Configured ${BOLD}Claude Code${NC} (CLAUDE.md)"
}

# Configure Codex (~/.codex/instructions.md — global)
configure_codex() {
  local file="$HOME/.codex/instructions.md"
  if [ -f "$file" ] && grep -q "Beings Protocol" "$file" 2>/dev/null; then
    print_warn "Codex already configured (~/.codex/instructions.md) — skipping"
    return
  fi

  mkdir -p "$HOME/.codex"
  local tmp; tmp="$(mktemp)"
  fetch_or_copy_template "tool-configs/codex-instructions.md" "$tmp"
  local content; content="$(cat "$tmp")"
  rm -f "$tmp"

  if [ -f "$file" ]; then
    echo "" >> "$file"
    echo "$content" >> "$file"
  else
    echo "$content" > "$file"
  fi
  print_step "Configured ${BOLD}Codex${NC} (~/.codex/instructions.md)"
}

# Auto-configure a detected tool
auto_configure() {
  for tool in $1; do
    case "$tool" in
      cursor)      configure_cursor ;;
      claude-code) configure_claude_code ;;
      codex)       configure_codex ;;
    esac
  done
}

# ============================================================
# Interactive tool selection
# ============================================================
ask_tools() {
  echo ""
  echo -e "  ${BOLD}Which AI tools do you use?${NC}"
  echo ""
  echo "    1) Cursor"
  echo "    2) Claude Code"
  echo "    3) Codex"
  echo "    4) Skip (AGENTS.md is enough)"
  echo "    a) All of the above"
  echo ""
  local choice=""
  read_input "  > " choice

  case "$choice" in
    *a*|*A*) configure_cursor
             configure_claude_code
             configure_codex ;;
    *)
      [[ "$choice" == *1* ]] && configure_cursor
      [[ "$choice" == *2* ]] && configure_claude_code
      [[ "$choice" == *3* ]] && configure_codex
      [[ "$choice" == *4* ]] && print_info "AGENTS.md works with Cursor, Claude Code, and Codex out of the box." ;;
  esac
}

# ============================================================
# Remove a legacy server key from an MCP config file
# ============================================================
remove_server_from_mcp() {
  local file="$1"
  local server_key="$2"     # "servers" or "mcpServers"
  local target="$3"         # e.g. "megamemory"

  [ ! -f "$file" ] && return 1
  grep -q "\"$target\"" "$file" 2>/dev/null || return 1

  if command -v python3 &>/dev/null; then
    python3 -c "
import json
from pathlib import Path
path = Path('$file')
data = json.loads(path.read_text())
key = '$server_key'
removed = False
if key in data and '$target' in data[key]:
    del data[key]['$target']
    removed = True
path.write_text(json.dumps(data, indent=2) + '\n')
exit(0 if removed else 1)
" 2>/dev/null
    return $?
  fi
  return 1
}

# ============================================================
# Update MCP config (add basic-memory if missing)
# ============================================================
add_basic_memory_to_mcp() {
  local file="$1"
  local server_key="$2"     # "servers" for .beings/mcp.json, "mcpServers" for .mcp.json
  local project_name="$3"

  [ ! -f "$file" ] && return 1
  grep -q '"basic-memory"' "$file" 2>/dev/null && return 0  # already present

  if command -v python3 &>/dev/null; then
    python3 -c "
import json
with open('$file') as f:
    data = json.load(f)
key = '$server_key'
data.setdefault(key, {})
data[key]['basic-memory'] = {
    'command': 'basic-memory',
    'args': ['mcp', '--project', '$project_name', '--transport', 'stdio'],
    'description': 'Markdown-native persistent memory — knowledge graph, semantic search, git-syncable'
}
with open('$file', 'w') as f:
    json.dump(data, f, indent=2)
    f.write('\n')
" 2>/dev/null
    return $?
  fi

  print_warn "Could not auto-update ${file} (Python3 not available)"
  print_info "Add basic-memory manually — see skills/memory/README.md"
  return 1
}

update_mcp_config() {
  local project_name="$1"
  local updated=false

  # Three config files: canonical, Claude Code, Cursor
  # Each has a different root key for servers
  for entry in \
    ".beings/mcp.json:servers" \
    ".mcp.json:mcpServers" \
    ".cursor/mcp.json:mcpServers"; do
    local path="${entry%:*}"
    local key="${entry#*:}"

    [ ! -f "$path" ] && continue

    # Step 1: strip legacy megamemory entry if present (v0.2.0 migration)
    if remove_server_from_mcp "$path" "$key" "megamemory"; then
      print_step "Removed legacy ${BOLD}megamemory${NC} from ${path}"
      updated=true
    fi

    # Step 2: add basic-memory if not already present
    if add_basic_memory_to_mcp "$path" "$key" "$project_name"; then
      print_step "Added ${BOLD}basic-memory${NC} to ${path}"
      updated=true
    fi
  done

  $updated || print_info "No existing MCP configs found to update"
}

# ============================================================
# uv bootstrap — installs uv into ~/.local/bin if missing.
# uv ships with its own Python runtimes, so installing basic-memory
# or axoniq via `uv tool install <pkg>` doesn't depend on the system
# python3 version. This is what makes the Python >= 3.10 requirement
# a non-issue on older systems.
# ============================================================
ensure_uv() {
  if command -v uv &>/dev/null; then
    return 0
  fi

  local install_uv_ans=""
  if $YES_MODE; then
    install_uv_ans="y"
    print_info "--yes mode: auto-installing uv (Python tool manager)"
  elif can_prompt; then
    echo ""
    print_info "${BOLD}uv${NC} (Python tool manager) is not installed."
    print_info "uv ships with its own Python runtime — lets us install"
    print_info "basic-memory without touching your system Python."
    read_input "  Install uv into ~/.local/bin? (Y/n) " install_uv_ans
  else
    print_warn "uv not found — cannot bootstrap Python tooling non-interactively"
    print_info "Install manually: ${DIM}curl -LsSf https://astral.sh/uv/install.sh | sh${NC}"
    print_info "Or re-run with --yes to auto-install."
    return 1
  fi

  if [[ "$install_uv_ans" == [nN]* ]]; then
    print_info "Skipped uv install"
    return 1
  fi

  print_info "Installing uv..."
  if ! curl -LsSf https://astral.sh/uv/install.sh | sh >/dev/null 2>&1; then
    print_warn "Failed to install uv"
    return 1
  fi

  # uv installer drops into ~/.local/bin by default — make sure our
  # PATH picks it up for the rest of this install.sh run.
  export PATH="$HOME/.local/bin:$PATH"
  if ! command -v uv &>/dev/null; then
    print_warn "uv installed but not on PATH — add ~/.local/bin to your shell PATH"
    return 1
  fi

  print_step "Installed ${BOLD}uv${NC} ($(uv --version 2>/dev/null | head -1))"
}

# ============================================================
# Memory Skill (basic-memory — Optional)
# ============================================================
setup_memory_skill() {
  local detected_tools="$1"

  # 1. If basic-memory is already installed, skip runtime checks entirely.
  #    Otherwise, bootstrap uv first — uv ships its own Python, so we don't
  #    need system python3 >= 3.10. Falls through to pipx/pip check only if
  #    uv isn't available.
  if ! command -v basic-memory &>/dev/null; then
    ensure_uv || true

    if ! command -v uv &>/dev/null; then
      if ! command -v python3 &>/dev/null; then
        print_warn "No uv and no python3 — skipping basic-memory"
        print_info "Install uv (${DIM}curl -LsSf https://astral.sh/uv/install.sh | sh${NC}) and re-run with --update"
        return
      fi

      local python_major python_minor
      python_major=$(python3 -c "import sys; print(sys.version_info.major)" 2>/dev/null || echo 0)
      python_minor=$(python3 -c "import sys; print(sys.version_info.minor)" 2>/dev/null || echo 0)
      if [ "$python_major" -lt 3 ] || { [ "$python_major" -eq 3 ] && [ "$python_minor" -lt 10 ]; }; then
        print_warn "No uv and system python3 is ${python_major}.${python_minor} (< 3.10) — skipping basic-memory"
        print_info "Install uv (${DIM}curl -LsSf https://astral.sh/uv/install.sh | sh${NC}) for easiest setup,"
        print_info "or install Python 3.10+, then re-run with --update"
        return
      fi
    fi
  fi

  # 2. Install unless user opted out with --no-memory.
  #    Beings remember — persistent memory is core, not optional. Users who
  #    genuinely can't/don't want it (air-gapped, restricted envs) can pass
  #    --no-memory to skip.
  if $NO_MEMORY_MODE; then
    print_info "Skipped memory skill (--no-memory) — add later with --update"
    return
  fi

  echo ""
  echo -e "  ${BOLD}🧠 Persistent Memory${NC}\n"
  echo -e "  Installing ${BOLD}basic-memory${NC} — git-syncable markdown memory with"
  echo -e "  semantic search. Source of truth: ${BOLD}memory-graph/*.md${NC},"
  echo -e "  Obsidian-compatible, hand-editable.\n"
  echo -e "  ${DIM}(Local SQLite + fastembed embeddings, nothing leaves your machine.)${NC}\n"

  # 3. Install basic-memory if not already present
  if ! command -v basic-memory &>/dev/null; then
    print_info "Installing basic-memory..."
    local install_ok=false
    if command -v uv &>/dev/null; then
      uv tool install basic-memory >/dev/null 2>&1 && install_ok=true
    fi
    if ! $install_ok && command -v pipx &>/dev/null; then
      pipx install basic-memory >/dev/null 2>&1 && install_ok=true
    fi
    if ! $install_ok && command -v pip &>/dev/null; then
      pip install --user basic-memory >/dev/null 2>&1 && install_ok=true
    fi

    if ! $install_ok; then
      print_warn "Could not install basic-memory (need uv, pipx, or pip)"
      print_info "Install manually: ${DIM}uv tool install basic-memory${NC}"
      print_info "Docs: https://docs.basicmemory.com/"
      return
    fi

    if ! command -v basic-memory &>/dev/null; then
      print_warn "basic-memory installed but not on PATH"
      print_info "Add ${DIM}~/.local/bin${NC} to your PATH and re-run --update"
      return
    fi
    print_step "Installed ${BOLD}basic-memory${NC}"
  else
    local bm_version
    bm_version=$(basic-memory --version 2>/dev/null | tail -1 || echo "")
    print_info "basic-memory already installed ${DIM}${bm_version}${NC}"
  fi

  # 4. Create memory-graph/ directory
  if [ ! -d "memory-graph" ]; then
    mkdir -p memory-graph
    touch memory-graph/.gitkeep
    print_step "Created ${BOLD}memory-graph/${NC} (markdown source of truth)"
  fi

  # 5. Register project with basic-memory
  local project_name="${PWD##*/}"
  if basic-memory project list 2>/dev/null | grep -q " ${project_name} "; then
    print_info "Project ${BOLD}${project_name}${NC} already registered"
  else
    if basic-memory project add "$project_name" "$(pwd)/memory-graph" --default >/dev/null 2>&1; then
      print_step "Registered project ${BOLD}${project_name}${NC} with basic-memory"
    else
      print_warn "Could not auto-register project — run manually:"
      print_info "  ${DIM}basic-memory project add ${project_name} \$(pwd)/memory-graph --default${NC}"
    fi
  fi

  # 6. Update existing MCP configs
  update_mcp_config "$project_name"

  # 7. Create Claude Code MCP config if it doesn't exist but Claude Code is detected
  if [[ "$detected_tools" == *claude-code* ]] || [ -f "CLAUDE.md" ]; then
    if [ ! -f ".mcp.json" ]; then
      cat > .mcp.json <<EOF
{
  "mcpServers": {
    "basic-memory": {
      "command": "basic-memory",
      "args": ["mcp", "--project", "${project_name}", "--transport", "stdio"],
      "description": "Markdown-native persistent memory — knowledge graph, semantic search, git-syncable"
    }
  }
}
EOF
      print_step "Created ${BOLD}.mcp.json${NC} with basic-memory"
    fi
  fi

  # 8. Create Cursor MCP config if it doesn't exist but Cursor is detected
  if [[ "$detected_tools" == *cursor* ]] || [ -d ".cursor" ]; then
    if [ ! -f ".cursor/mcp.json" ]; then
      mkdir -p .cursor
      cat > .cursor/mcp.json <<EOF
{
  "mcpServers": {
    "basic-memory": {
      "command": "basic-memory",
      "args": ["mcp", "--project", "${project_name}", "--transport", "stdio"],
      "description": "Markdown-native persistent memory — knowledge graph, semantic search, git-syncable"
    }
  }
}
EOF
      print_step "Created ${BOLD}.cursor/mcp.json${NC} with basic-memory"
    fi
  fi

  # 9. Set up Claude Code hooks if detected
  if [[ "$detected_tools" == *claude-code* ]] || [ -f "CLAUDE.md" ]; then
    setup_memory_hooks
  fi

  # 10. Index watcher as a systemd user unit (survives reboots), plus the index repair tool.
  setup_memory_index

  # 11. Update .gitignore
  if [ -f ".gitignore" ]; then
    if ! grep -q "^\.basic-memory/" .gitignore 2>/dev/null; then
      {
        echo ""
        echo "# basic-memory — SQLite index lives in ~/.basic-memory/ (outside repo),"
        echo "# but ignore any project-local cache/index if it ever appears here."
        echo "# The markdown source of truth in memory-graph/ IS tracked."
        echo ".basic-memory/"
        echo "memory-graph/.basic-memory/"
      } >> .gitignore
      print_step "Added ${BOLD}.basic-memory/${NC} to .gitignore"
    fi
  fi

  # 12. Seed memory-graph/ from .beings/ if this Being is already born
  seed_memory_graph

  echo ""
  print_step "${GREEN}Memory skill ready!${NC}"
  print_info "Your Being has markdown-native persistent memory"
  print_info "Edit notes directly in ${BOLD}memory-graph/${NC} — the watcher reindexes automatically"
}

# ============================================================
# Memory index watcher (user unit) and repair tool
# ============================================================
# BEING_NO_SYSTEMD=1 skips systemctl (containers, CI, tests).
setup_memory_index() {
  local f
  for f in being-memory-index being-bm-repair; do kit_sync_file "skills/memory/bin/$f" "bin/$f" exec; done
  if [ "${BEING_NO_SYSTEMD:-0}" != 1 ] && command -v systemctl &>/dev/null && systemctl --user show-environment &>/dev/null; then
    if BEING_HOME="$(pwd -P)" BEING_BM_PROJECT="${PWD##*/}" bin/being-memory-index install >/dev/null 2>&1; then
      print_step "Index watcher runs as user unit ${BOLD}${PWD##*/}-memory-index.service${NC}"
      return
    fi
  fi
  print_warn "No systemd user session: run ${BOLD}bin/being-memory-index watch${NC} under your own supervisor"
}

# ============================================================
# Set up Claude Code hooks for memory
# ============================================================
setup_memory_hooks() {
  local settings_file=".claude/settings.local.json"

  mkdir -p .claude

  # Only hooks that put something in the model's context are installed (SessionStart, UserPromptSubmit).
  # Echo-only reminders from older kits are removed on --update; hooks you added yourself are kept.
  if command -v python3 &>/dev/null; then
    if python3 - "$settings_file" <<'PY'
import json, sys
from pathlib import Path

new_hooks = {
    'SessionStart': [{'matcher': '', 'hooks': [{'type': 'command', 'command': "echo 'MEMORY RECALL: Query basic-memory via search_notes for context relevant to this session. Use recent_activity to see what changed recently. Read identity files (SOUL.md, IDENTITY.md) as always — those are who you are. Search for anything relevant to what the user is asking.'"}]}],
    'UserPromptSubmit': [{'matcher': '', 'hooks': [{'type': 'command', 'command': 'echo "CONTEXT: Today is $(date +%Y-%m-%d). Check .beings/GOALS.md if you have not this session."'}]}],
}
markers = {'SessionStart': ['search_notes', 'MEMORY RECALL'], 'UserPromptSubmit': ['CONTEXT: Today']}
dropped = ('MegaMemory', 'understand tool', 'get_concept', 'megamemory', 'MEMORY PRESERVATION:',
           'SESSION END: Write a session summary', 'AUTONOMY CHECK: Before running', 'MEMORY CHECK: You just modified')

path = Path(sys.argv[1])
data = json.loads(path.read_text()) if path.exists() else {}
hooks = data.setdefault('hooks', {})

def cmds(h):
    return [s.get('command', '') for s in h.get('hooks', [])]

for event in list(hooks):
    kept = [h for h in hooks[event] if not any(t in c for c in cmds(h) for t in dropped)]
    if kept:
        hooks[event] = kept
    else:
        del hooks[event]
for event, hook_list in new_hooks.items():
    existing = hooks.get(event, [])
    if not any(m in c for h in existing for c in cmds(h) for m in markers[event]):
        existing.extend(hook_list)
    hooks[event] = existing
path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + '\n')
PY
    then
      print_step "Memory hooks in ${BOLD}${settings_file}${NC} (session recall + date; old reminder hooks removed)"
      return
    fi
  fi

  [ -f "$settings_file" ] && { print_warn "Could not merge ${settings_file} (python3 missing?) — left as is"; return; }
  cat > "$settings_file" <<'HOOKS_EOF'
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "",
        "hooks": [{"type": "command", "command": "echo 'MEMORY RECALL: Query basic-memory via search_notes for context relevant to this session. Use recent_activity to see what changed recently. Read identity files (SOUL.md, IDENTITY.md) as always — those are who you are. Search for anything relevant to what the user is asking.'"}]
      }
    ],
    "UserPromptSubmit": [
      {
        "matcher": "",
        "hooks": [{"type": "command", "command": "echo \"CONTEXT: Today is $(date +%Y-%m-%d). Check .beings/GOALS.md if you have not this session.\""}]
      }
    ]
  }
}
HOOKS_EOF
  print_step "Created ${BOLD}${settings_file}${NC} with the memory hooks"
}

# ============================================================
# Seed memory-graph/ from .beings/ identity files (born Beings only)
# ============================================================
seed_memory_graph() {
  # Only seed if Being is already born
  is_being_born || return

  # Skip if memory-graph/ already has real content
  local note_count
  note_count=$(find memory-graph -name "*.md" ! -name ".gitkeep" 2>/dev/null | wc -l | tr -d ' ')
  if [ "${note_count:-0}" -gt 0 ]; then
    print_info "memory-graph/ already has notes — skipping seed"
    return
  fi

  print_info "Seeding memory-graph/ from identity files..."
  mkdir -p memory-graph/identity

  for src_file in SOUL.md MEMORY.md GOALS.md CONVENTIONS.md AUTONOMY.md; do
    [ -f ".beings/$src_file" ] || continue
    local title="${src_file%.md}"
    local dest="memory-graph/identity/$(echo "$src_file" | tr '[:upper:]' '[:lower:]')"
    {
      echo "---"
      echo "title: ${title}"
      echo "type: note"
      echo "tags: [identity, seeded]"
      echo "---"
      echo ""
      cat ".beings/$src_file"
    } > "$dest"
  done

  # One-time index of the seeded notes
  if [ -x bin/being-bm-repair ]; then bin/being-bm-repair >/dev/null 2>&1 || true
  else basic-memory reindex >/dev/null 2>&1 || basic-memory sync >/dev/null 2>&1 || true; fi
  print_step "Seeded ${BOLD}memory-graph/identity/${NC} from .beings/ files"
}

# ============================================================
# Code Intelligence (Optional)
# ============================================================
setup_code_intelligence() {
  local detected_tools="$1"
  local python_cmd=""
  
  # Check for Python package managers
  if command -v uv &>/dev/null; then
    python_cmd="uv pip install"
  elif command -v pip &>/dev/null; then
    python_cmd="pip install"
  elif command -v pip3 &>/dev/null; then
    python_cmd="pip3 install"
  fi

  if [ -z "$python_cmd" ]; then
    print_warn "No pip or uv found — skipping code intelligence"
    print_info "You can add it later by installing axoniq and running: axon analyze ."
    return
  fi

  echo ""
  echo -e "  ${BOLD}🧠 Code Intelligence (Optional)${NC}\n"
  echo -e "  Give your Being structural understanding of this codebase?"
  echo -e "  This installs ${BOLD}Axon${NC} — graph-powered code analysis via MCP.\n"
  echo -e "  ${DIM}(100% local, no data leaves your machine)${NC}\n"
  
  local install_axon=""
  if $YES_MODE; then
    install_axon="n"  # --yes does NOT auto-install Axon (it's heavier / optional)
    print_info "--yes mode: skipping Axon (explicit opt-in needed — Axon is heavy)"
    return
  elif can_prompt; then
    read_input "  Install Axon? (Y/n) " install_axon
  else
    # Non-interactive: skip
    print_info "Non-interactive mode — skipping code intelligence (add later with: pip install axoniq)"
    return
  fi

  if [[ "$install_axon" == [nN]* ]]; then
    print_info "Skipped code intelligence — you can add it later"
    print_info "To install: ${DIM}pip install axoniq && axon analyze .${NC}"
    return
  fi

  # Install axoniq
  print_info "Installing axoniq..."
  if ! $python_cmd axoniq >/dev/null 2>&1; then
    print_warn "Failed to install axoniq — skipping code intelligence"
    print_info "You can install manually: ${DIM}pip install axoniq${NC}"
    return
  fi
  print_step "Installed ${BOLD}axoniq${NC}"

  # Index the codebase
  print_info "Indexing codebase with Axon..."
  if ! axon analyze . >/dev/null 2>&1; then
    print_warn "Failed to index codebase — Axon may not support this language yet"
    print_info "MCP config created anyway — try running: ${DIM}axon analyze .${NC}"
  else
    print_step "Indexed codebase"
  fi

  # Copy canonical MCP config
  fetch_or_copy_template "beings/mcp.json" ".beings/mcp.json"
  print_step "Created ${BOLD}.beings/mcp.json${NC} (canonical MCP config)"

  # Create tool-specific MCP configs
  local mcp_installed=false

  # Claude Code: .mcp.json
  if [[ "$detected_tools" == *claude-code* ]] || [ -f "CLAUDE.md" ]; then
    cat > .mcp.json <<'EOF'
{
  "mcpServers": {
    "axon": {
      "command": "axon",
      "args": ["serve", "--watch"]
    }
  }
}
EOF
    print_step "Configured MCP for ${BOLD}Claude Code${NC} (.mcp.json)"
    mcp_installed=true
  fi

  # Cursor: .cursor/mcp.json
  if [[ "$detected_tools" == *cursor* ]] || [ -d ".cursor" ]; then
    mkdir -p .cursor
    cat > .cursor/mcp.json <<'EOF'
{
  "mcpServers": {
    "axon": {
      "command": "axon",
      "args": ["serve", "--watch"]
    }
  }
}
EOF
    print_step "Configured MCP for ${BOLD}Cursor${NC} (.cursor/mcp.json)"
    mcp_installed=true
  fi

  if ! $mcp_installed; then
    print_info "No MCP-compatible tools detected — using CLI fallback"
    print_info "Your Being can still use: ${DIM}axon impact/context/query${NC}"
  fi

  # Update .gitignore for .axon/
  if [ -f ".gitignore" ]; then
    if ! grep -q "^\.axon/" .gitignore 2>/dev/null; then
      echo "" >> .gitignore
      echo "# Axon code intelligence cache" >> .gitignore
      echo ".axon/" >> .gitignore
    fi
  else
    echo "# Axon code intelligence cache" > .gitignore
    echo ".axon/" >> .gitignore
  fi
  print_step "Added ${BOLD}.axon/${NC} to .gitignore"

  echo ""
  print_step "${GREEN}Code intelligence ready!${NC}"
  print_info "Your Being can now use structural code analysis"
}

# ============================================================
# Operations Kit (opt-in: --with operations,teams-kit)
# Additive only: missing files are added, existing ones are never overwritten.
# ============================================================
KIT_VERSION="0.3.0"
KIT_TEMPLATES=(GUARDRAILS.md AUTONOMY-MATRIX.md JOB-CHECKLIST.md facts/_TEMPLATE.md)
# Listed explicitly so a curl install can fetch them; tests/install-kit.test.sh keeps these in sync with git.
TEAMS_KIT_FILES=(
  .env.example .gitignore GUARDRAILS.md README.md SKILL.md ack-schema.json approval.mjs approval.test.mjs
  batch-lib.mjs batch-lib.test.mjs
  being-deadman.test.mjs being-job.test.mjs being-retry.test.mjs being-watchdog.test.mjs cache-write.mjs
  cache-write.test.mjs comms-log.mjs comms-log.test.mjs detect-util.mjs detect-util.test.mjs docs-index.mjs
  docs-index.test.mjs drive-util.mjs fast-warm.test.mjs fifo-wait.mjs fmt.mjs fmt.test.mjs graph.mjs isolation.test.mjs
  isolation/README.md isolation/wire-in.patch kit-broker.test.mjs kit-client.mjs kit-env.mjs kit-env.test.mjs
  link-guard.test.mjs mesh.test.mjs model-proxy.mjs package-lock.json package.json pin.mjs pin.test.mjs reply-ref.mjs
  routines.conf.example scope.mjs scope.test.mjs secrets.mjs secrets.test.mjs send-as.mjs send-as.test.mjs
  senders-offline.test.mjs soul.py soul.test.mjs strip.mjs systemd/being-deadman.service.example
  systemd/being-deadman.timer.example systemd/being-routine@.service.example systemd/being-teams.service.example
  team-fence.test.mjs team-scope.mjs team-scope.test.mjs teams-channel.test.mjs test-env.mjs test-env.test.mjs triage-jobs.test.mjs
  voice-schema.json webhook/README.md
  webhook/env.example webhook/graph-webhook.test.mjs webhook/units/graph-lifecycle.path
  webhook/units/graph-subscribe-renew.service webhook/units/graph-subscribe.service webhook/units/graph-subscribe.timer
  webhook/units/graph-webhook.service workbook-sync.test.mjs
)
TEAMS_KIT_EXEC=(
  approve.mjs being-blocker being-board being-deadman being-handle being-job being-launch being-retry being-routine
  being-sessions being-status being-steer being-teams being-watchdog docs-index-cli.mjs draft-for-owner.mjs
  fast-warm.mjs hive-mcp-stdio isolation/live-check.sh isolation/make-shims isolation/migrate.sh isolation/model-run
  isolation/rollback.sh isolation/setup-users.sh isolation/test-sandbox.sh isolation/verify.sh kit-broker link-guard.mjs
  mail.mjs mesh.py model-relay.mjs offboard.sh onedrive.mjs owner-mail owner-read send-batch.mjs set-photo.mjs share-file.mjs
  team-fence.py team-sync teams-ack.mjs teams-channel.mjs teams-delete-msg.mjs teams-detect.mjs
  teams-fetch-attachment.mjs teams-login-device.mjs teams-presence.mjs teams-read.mjs teams-seen.mjs teams-send-dm.mjs
  triage-jobs.py verify.sh webhook/graph-subscribe.mjs webhook/graph-webhook.mjs webhook/hook-wait
  webhook/kit-install.sh whoami.mjs workbook-sync.mjs
)
KIT_ADDED=0
KIT_KEPT=0

kit_wants() { [[ ",$WITH_COMPONENTS," == *",$1,"* ]]; }

# Escape for the replacement side of s/…/…/, and single-quote for a bash-sourced .env.
# sed, not ${var//\'/…}: bash 3.2 (macOS) handles quotes in that replacement differently.
sed_lit() { printf '%s' "$1" | sed -e 's/[\/&]/\\&/g'; }
shq() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }

# Fetch a repo file (not only templates/) from this checkout or from BASE_URL.
fetch_or_copy_file() {
  local rel_path="$1"
  local dest="$2"
  if [ -n "$SCRIPT_DIR" ] && [ -d "$SCRIPT_DIR/templates" ]; then
    cp "$SCRIPT_DIR/$rel_path" "$dest"
  else
    curl -fsSL "$BASE_URL/$rel_path" -o "$dest"
  fi
}

# Validate --with / --name / --owner before anything is written.
kit_validate() {
  local c
  for c in ${WITH_COMPONENTS//,/ }; do
    case "$c" in
      operations|teams-kit|statusline|memory-sync) ;;
      memory) echo "  Error: memory is part of the core install (drop --no-memory instead)" >&2; exit 2 ;;
      *) if ! [[ "$c" =~ ^[a-z][a-z0-9-]*$ ]] || ! component_exists "$c"; then
           echo "  Error: unknown --with component '$c' (built in: operations, teams-kit, statusline, memory-sync; or a skills/<name>/ directory)" >&2
           exit 2
         fi ;;
    esac
  done
  # Every component builds on the Operations Kit.
  kit_wants operations || WITH_COMPONENTS="operations,$WITH_COMPONENTS"
  if kit_wants teams-kit; then
    # The Teams kit runner and handler are Linux scripts (flock, setsid, GNU find/readlink, systemd user units).
    local t missing=""
    for t in flock setsid python3; do command -v "$t" >/dev/null 2>&1 || missing="$missing $t"; done
    if [ -n "$missing" ]; then
      echo "  Error: --with teams-kit needs a Linux host; missing:$missing (skills/teams-kit/README.md, Set up)" >&2
      exit 2
    fi
    [ "$(uname -s)" = Linux ] || print_warn "teams-kit is tested on Linux only; on $(uname -s) parts may fail quietly"
    command -v node >/dev/null 2>&1 || print_warn "teams-kit needs Node.js 20+ before 'npm install'"
    command -v systemctl >/dev/null 2>&1 || print_warn "no systemctl: 'being-teams autostart' will not work on this host"
  fi
  if ! $GLOBAL_MODE && ! $UPDATE_MODE; then
    echo "  Error: --with needs --global (birth) or --update (run in an existing Being's home)" >&2
    exit 2
  fi
  if $UPDATE_MODE && ! $GLOBAL_MODE && [ ! -d ".beings" ]; then
    echo "  Error: --update --with needs an existing Being; no .beings/ in $(pwd)" >&2
    exit 2
  fi
  if [[ "$OWNER_NAME" == *$'\n'* ]]; then
    echo "  Error: --owner must be one line" >&2
    exit 2
  fi
  if $UPDATE_MODE && ! $GLOBAL_MODE && [ -z "$BEING_NAME" ]; then
    # Never derived from the directory: it is the name people call the Being in chat.
    if [ -f "ops/teams-kit/.env" ]; then
      # shellcheck source=/dev/null
      BEING_NAME="$(set -a; . "ops/teams-kit/.env" >/dev/null 2>&1; printf '%s' "${BEING_NAME:-}")"
    fi
    if [ -z "$BEING_NAME" ] && can_prompt && ! $YES_MODE; then
      read_input "  Being name (the name people use for it, e.g. nova): " BEING_NAME
    fi
    if [ -z "$BEING_NAME" ]; then
      echo "  Error: --update --with needs --name <name> (the Being's name, not the directory name)" >&2
      exit 2
    fi
  fi
  if ! $GLOBAL_MODE; then
    BEING_NAME=$(echo "$BEING_NAME" | tr '[:upper:]' '[:lower:]' | tr ' ' '-')
  fi
  if [[ -n "$BEING_NAME" && ! "$BEING_NAME" =~ ^[a-z][a-z0-9-]*$ ]]; then
    echo "  Error: Being name must be lowercase letters, digits or dashes" >&2
    exit 2
  fi
}

# kit_add <repo path> <dest>: add if missing, filling {{BEING_NAME}} / {{OWNER_NAME}} / {{BEING_HOME}}.
kit_add() {
  local src="$1"
  local dest="$2"
  if [ -e "$dest" ]; then
    KIT_KEPT=$((KIT_KEPT + 1))
    return
  fi
  mkdir -p "$(dirname "$dest")"
  local tmp; tmp="$(mktemp)"
  fetch_or_copy_file "$src" "$tmp"
  sed -e "s/{{BEING_NAME}}/$(sed_lit "$BEING_NAME")/g" -e "s/{{OWNER_NAME}}/$(sed_lit "$OWNER_NAME")/g" \
      -e "s/{{BEING_HOME}}/$(sed_lit "$(pwd -P)")/g" "$tmp" > "$dest"
  rm -f "$tmp"
  print_step "Added ${BOLD}${dest}${NC}"
  KIT_ADDED=$((KIT_ADDED + 1))
}

kit_append_section() {
  local file="$1"
  [ -f "$file" ] || return 0
  if grep -q 'beings-kit:operations' "$file" 2>/dev/null; then
    KIT_KEPT=$((KIT_KEPT + 1))
    return
  fi
  local tmp; tmp="$(mktemp)"
  fetch_or_copy_file "templates/kit/OPERATIONS-SECTION.md" "$tmp"
  cat "$tmp" >> "$file"
  rm -f "$tmp"
  print_step "Appended Operations Kit section to ${BOLD}${file}${NC}"
}

kit_ignore() {
  local line="$1"
  touch .gitignore
  grep -qxF "$line" .gitignore || echo "$line" >> .gitignore
}

# Launcher: replace only the wrapper this run just created; a user's own launcher is kept.
kit_launcher() {
  local fresh="$1"
  local launcher="bin/${BEING_NAME}"
  if [ -e "$launcher" ] && grep -q 'launch_codex' "$launcher" 2>/dev/null; then
    KIT_KEPT=$((KIT_KEPT + 1))
  elif [ -e "$launcher" ] && $fresh; then
    fetch_or_copy_file "templates/kit/bin/being" "$launcher"
    chmod +x "$launcher"
    print_step "Replaced ${BOLD}${launcher}${NC} with the multi-client launcher (Claude Code + Codex)"
  elif [ -e "$launcher" ]; then
    kit_add "templates/kit/bin/being" "${launcher}.multi"
    chmod +x "${launcher}.multi"
    print_info "${launcher} kept; review ${BOLD}${launcher}.multi${NC} and swap it in when ready"
  else
    kit_add "templates/kit/bin/being" "$launcher"
    chmod +x "$launcher"
  fi
}

kit_sha() { sha256sum "$1" 2>/dev/null | cut -d' ' -f1; }
# kit_manifest_set <manifest> <name> <file>: record the installed hash of <name>.
kit_manifest_set() {
  local t; t="$(mktemp)"
  awk -F'\t' -v f="$2" '$2 != f' "$1" > "$t"; printf '%s\t%s\n' "$(kit_sha "$3")" "$2" >> "$t"; mv "$t" "$1"
}

# Teams kit: copy missing files; changed upstream files go to .kit-upgrade/ for review.
kit_teams() {
  local dst="ops/teams-kit"
  local f tmp changed=0 local_changed=0 man="$dst/.kit-manifest" was
  mkdir -p "$dst/state"
  # .kit-manifest: the hash each file had when the kit installed it, so a local (owner-approved) edit is told apart
  # from an old kit version and never swapped out blindly.
  touch "$man"; rm -f "$dst/.kit-upgrade/CHANGES.txt"
  for f in "${TEAMS_KIT_FILES[@]}" "${TEAMS_KIT_EXEC[@]}"; do
    tmp="$(mktemp)"
    fetch_or_copy_file "skills/teams-kit/$f" "$tmp"
    if [ ! -e "$dst/$f" ]; then
      mkdir -p "$(dirname "$dst/$f")"
      mv "$tmp" "$dst/$f"
      KIT_ADDED=$((KIT_ADDED + 1)); kit_manifest_set "$man" "$f" "$dst/$f"
    elif cmp -s "$tmp" "$dst/$f"; then
      rm -f "$tmp"
      KIT_KEPT=$((KIT_KEPT + 1)); kit_manifest_set "$man" "$f" "$dst/$f"
    else
      mkdir -p "$(dirname "$dst/.kit-upgrade/$f")"
      mv "$tmp" "$dst/.kit-upgrade/$f"
      changed=$((changed + 1))
      was="$(awk -F'\t' -v f="$f" '$2 == f { print $1 }' "$man")"
      if [ -n "$was" ] && [ "$was" = "$(kit_sha "$dst/$f")" ]; then
        printf '%s\tupstream only: safe to swap in\n' "$f" >> "$dst/.kit-upgrade/CHANGES.txt"
      else
        local_changed=$((local_changed + 1))
        printf '%s\tLOCAL CHANGES: merge by hand, keep the owner-approved edits\n' "$f" >> "$dst/.kit-upgrade/CHANGES.txt"
      fi
    fi
  done
  for f in "${TEAMS_KIT_EXEC[@]}"; do
    [ -f "$dst/$f" ] && chmod +x "$dst/$f"
    [ -f "$dst/.kit-upgrade/$f" ] && chmod +x "$dst/.kit-upgrade/$f"
  done
  print_step "Teams kit in ${BOLD}${dst}/${NC}"
  [ "$changed" -gt 0 ] && print_warn "${changed} kit file(s) changed upstream — new versions in ${BOLD}${dst}/.kit-upgrade/${NC} (yours untouched; see CHANGES.txt)"
  [ "$local_changed" -gt 0 ] && print_warn "${local_changed} of them carry local changes (or predate the manifest): merge by hand, do not copy over"

  if [ ! -f "$dst/.env" ]; then
    # Single-quoted values: the file is sourced by bash, so spaces and quotes must survive.
    local abs; abs="$(pwd -P)/$dst"
    BK_NAME=$(shq "$BEING_NAME") BK_STATE=$(shq "$abs/state") BK_CACHE=$(shq "$abs/state/token-cache.json") BK_OWNER=$(shq "$OWNER_NAME") \
    awk '/^BEING_NAME=/      { print "BEING_NAME=" ENVIRON["BK_NAME"]; next }
         /^BEING_STATE_DIR=/ { print "BEING_STATE_DIR=" ENVIRON["BK_STATE"]; next }
         /^BEING_CACHE=/     { print "BEING_CACHE=" ENVIRON["BK_CACHE"]; next }
         /^OWNER_NAME=/      { print "OWNER_NAME=" ENVIRON["BK_OWNER"]; next }
         { print }' "$dst/.env.example" > "$dst/.env"
    chmod 600 "$dst/.env"
    print_step "Created ${BOLD}${dst}/.env${NC} (0600, prefilled — fill the rest)"
  else
    # Merge: append settings that are new upstream (a changed .env.example is staged in .kit-upgrade/); existing values stay.
    local missing example="$dst/.env.example"
    [ -f "$dst/.kit-upgrade/.env.example" ] && example="$dst/.kit-upgrade/.env.example"
    missing="$(awk -F= 'NR==FNR { if ($0 ~ /^[A-Z0-9_]+=/) have[$1]=1; next }
                        /^[A-Z0-9_]+=/ && !($1 in have)' "$dst/.env" "$example")"
    if [ -n "$missing" ]; then
      printf '\n# Added by install.sh --update (kit v%s)\n%s\n' "$KIT_VERSION" "$missing" >> "$dst/.env"
      print_step "Added new settings to ${BOLD}${dst}/.env${NC}: $(echo "$missing" | cut -d= -f1 | tr '\n' ' ')"
    fi
  fi
  # Separate shell: errexit is ignored inside an if-condition subshell.
  if ! bash -c 'set -euo pipefail; set -a; . "$1"' _ "$dst/.env" >/dev/null 2>&1; then
    echo "  Error: $dst/.env does not source cleanly; fix it and re-run" >&2
    exit 1
  fi
  kit_ignore "ops/teams-kit/.env"
  kit_ignore "ops/teams-kit/state/"
  kit_ignore "ops/teams-kit/node_modules/"
  kit_ignore "ops/teams-kit/.kit-upgrade/"
  command -v node &>/dev/null || print_warn "Node.js >= 20 not found — the Teams kit needs it"
}

# Kit files copied verbatim into the Being home (repo path -> home path), plus executables among them.
KIT_BIN_FILES=(
  "templates/kit/bin/being-config:bin/being-config"
  "skills/memory/bin/being-memory-sync:bin/being-memory-sync"
  "skills/memory/bin/being-session-registry:bin/being-session-registry"
  "templates/kit/guards/publish-check.sh:bin/publish-check"
)
# Templates for later use (filled with the Being's name and home), kept in ops/kit-templates/.
KIT_OPS_TEMPLATES=(
  bin/stack-runner:stack-runner bin/desktop-shim:desktop-shim
  systemd/being-heartbeat.service.example:systemd/being-heartbeat.service.example
  systemd/being-heartbeat.timer.example:systemd/being-heartbeat.timer.example
  systemd/standby-gate.conf.example:systemd/standby-gate.conf.example
  systemd/wait-for-mount.conf.example:systemd/wait-for-mount.conf.example
  systemd/secrets-env.conf.example:systemd/secrets-env.conf.example
  jobs/scheduled-job/run.sh:jobs/scheduled-job/run.sh jobs/scheduled-job/prompt.md:jobs/scheduled-job/prompt.md
  jobs/scheduled-job/cron.example:jobs/scheduled-job/cron.example
  jobs/research-job/run.sh:jobs/research-job/run.sh jobs/research-job/workers.conf.example:jobs/research-job/workers.conf.example
  jobs/research-job/worker-prompt.md:jobs/research-job/worker-prompt.md jobs/research-job/merge-prompt.md:jobs/research-job/merge-prompt.md
)
GUARD_BEGIN="<!-- beings-kit:guardrails begin -->"
GUARD_END="<!-- beings-kit:guardrails end -->"

# kit_sync_file <repo path> <dest> [exec]: add if missing; a changed upstream file goes to <dir>/.kit-upgrade/.
kit_sync_file() {
  local src="$1" dest="$2" mode="${3:-}" tmp staged
  tmp="$(mktemp)"
  fetch_or_copy_file "$src" "$tmp"
  chmod 644 "$tmp"
  [ "$mode" = exec ] && chmod 755 "$tmp"
  mkdir -p "$(dirname "$dest")"
  if [ ! -e "$dest" ]; then
    mv "$tmp" "$dest"
    KIT_ADDED=$((KIT_ADDED + 1))
  elif cmp -s "$tmp" "$dest"; then
    rm -f "$tmp"
    KIT_KEPT=$((KIT_KEPT + 1))
  else
    staged="$(dirname "$dest")/.kit-upgrade/$(basename "$dest")"
    mkdir -p "$(dirname "$staged")"
    mv "$tmp" "$staged"
    print_warn "${dest} differs from the kit — new version in ${BOLD}${staged}${NC} (yours untouched)"
  fi
}

# --config: read being.toml with the kit's TOML-subset reader; command-line flags win.
load_config() {
  [ -n "$CONFIG_FILE" ] || return 0
  [ -f "$CONFIG_FILE" ] || { echo "  Error: --config file not found: $CONFIG_FILE" >&2; exit 2; }
  command -v python3 &>/dev/null || { echo "  Error: --config needs python3" >&2; exit 2; }
  CONFIG_FILE="$(cd "$(dirname "$CONFIG_FILE")" && pwd -P)/$(basename "$CONFIG_FILE")"
  local tool; tool="$(mktemp)"
  fetch_or_copy_file "templates/kit/bin/being-config" "$tool"
  cfg() { python3 "$tool" "$CONFIG_FILE" "$@"; }
  cfg check || { rm -f "$tool"; exit 2; }
  [ -n "$BEING_NAME" ] || BEING_NAME="$(cfg get being.name '')"
  $OWNER_SET || OWNER_NAME="$(cfg get being.owner "$OWNER_NAME")"
  [ "$(cfg get being.track_private false)" = true ] && TRACK_PRIVATE=true
  CONFIG_TZ="$(cfg get being.tz '')"
  local with; with="$(cfg get kit.with '' | paste -sd, -)"
  [ -n "$with" ] && WITH_COMPONENTS="${WITH_COMPONENTS:+$WITH_COMPONENTS,}$with"
  BEING_ACCESS="$(cfg list access | paste -sd, -)"
  rm -f "$tool"
  unset -f cfg
}

# A --with name other than the built-ins must be a skills/<name>/ directory of this kit.
component_exists() {
  local c="$1"
  [ "$c" = teams-kit ] && return 1
  if [ -n "$SCRIPT_DIR" ] && [ -d "$SCRIPT_DIR/templates" ]; then
    [ -d "$SCRIPT_DIR/skills/$c" ]
  else
    curl -fsSL "$BASE_URL/skills/$c/kit-files.txt" -o /dev/null 2>/dev/null
  fi
}

# Files of skills/<c>/: its kit-files.txt ("path" or "path +x" per line) or, in a checkout, the directory itself.
component_files() {
  local c="$1" list
  if [ -n "$SCRIPT_DIR" ] && [ -d "$SCRIPT_DIR/skills/$c" ]; then
    if [ -f "$SCRIPT_DIR/skills/$c/kit-files.txt" ]; then
      grep -v '^[[:space:]]*\(#\|$\)' "$SCRIPT_DIR/skills/$c/kit-files.txt"
    else
      (cd "$SCRIPT_DIR/skills/$c" && find . -type f ! -path './node_modules/*' ! -path './state/*' ! -path './.kit-upgrade/*' \
        ! -name '.env' ! -name '*.pyc' -print | sed 's#^\./##' | LC_ALL=C sort | while IFS= read -r f; do
          if [ -x "$f" ]; then echo "$f +x"; else echo "$f"; fi
        done)
    fi
  else
    list="$(mktemp)"
    curl -fsSL "$BASE_URL/skills/$c/kit-files.txt" -o "$list"
    grep -v '^[[:space:]]*\(#\|$\)' "$list"
    rm -f "$list"
  fi
}

# kit_component <name>: copy skills/<name>/ to ops/<name>/, then run its kit-install.sh hook (idempotent by contract).
kit_component() {
  local c="$1" dst="ops/$1" line f flag
  while IFS= read -r line; do
    f="${line% +x}"; flag=""; [ "$f" != "$line" ] && flag=exec
    case "$f" in /*|*..*) echo "  Error: $c/kit-files.txt lists an unsafe path: $f" >&2; exit 1 ;; esac
    kit_sync_file "skills/$c/$f" "$dst/$f" "$flag"
  done < <(component_files "$c")
  kit_ignore "$dst/.kit-upgrade/"
  kit_ignore "$dst/state/"
  kit_ignore "$dst/.env"
  kit_ignore "$dst/node_modules/"
  print_step "Component ${BOLD}${c}${NC} in ${BOLD}${dst}/${NC}"
  # In a checkout the hook runs from skills/<name>/ so it can reach scripts/ and templates/; curl installs use the copy.
  local hook="$dst/kit-install.sh"
  [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/skills/$c/kit-install.sh" ] && hook="$SCRIPT_DIR/skills/$c/kit-install.sh"
  if [ -f "$hook" ]; then
    local upd=0; $UPDATE_MODE && upd=1
    if ! BEING_NAME="$BEING_NAME" OWNER_NAME="$OWNER_NAME" BEING_CONFIG_FILE="$CONFIG_FILE" BEING_ACCESS="$BEING_ACCESS" \
         BEING_KIT_UPDATE="$upd" BEING_KIT_VERSION="$KIT_VERSION" BEING_KIT_SOURCE="${SCRIPT_DIR:-$BASE_URL}" \
         bash "$hook" "$(pwd -P)" --name "$BEING_NAME"; then
      echo "  Error: $hook failed; fix it and re-run install.sh --update" >&2
      exit 1
    fi
  fi
}

# Guardrails for every Claude Code and Codex session of this OS user, in a marked block.
# A fresh birth adds the block if missing; --update refreshes it from .beings/GUARDRAILS.md.
kit_guardrails_global() {
  [ -f ".beings/GUARDRAILS.md" ] || return 0
  command -v python3 &>/dev/null || { print_warn "python3 missing: guardrails not written to ~/.claude or ~/.codex"; return 0; }
  local f refresh=0; $UPDATE_MODE && refresh=1
  for f in "$HOME/.claude/CLAUDE.md" "$HOME/.codex/instructions.md" "$HOME/.codex/AGENTS.md"; do
    mkdir -p "$(dirname "$f")"
    local r
    r="$(python3 - "$f" ".beings/GUARDRAILS.md" "$GUARD_BEGIN" "$GUARD_END" "$refresh" "$(pwd -P)" <<'PY'
import re, sys
from pathlib import Path
dest, src, begin, end, refresh, home = sys.argv[1:7]
body = re.sub(r'<!--.*?-->\s*', '', Path(src).read_text(), flags=re.S).strip()
block = f"{begin}\n<!-- From {home}/.beings/GUARDRAILS.md; refreshed by install.sh --update. Edit the source, not this block. -->\n{body}\n{end}\n"
p = Path(dest)
text = p.read_text() if p.exists() else ''
if begin in text and end in text:
    if refresh != '1':
        print('kept'); sys.exit(0)
    new = re.sub(re.escape(begin) + r'.*?' + re.escape(end) + r'\n?', lambda m: block, text, count=1, flags=re.S)
    if new == text:
        print('kept'); sys.exit(0)
    p.write_text(new); print('refreshed')
else:
    p.write_text((text.rstrip('\n') + '\n\n' if text.strip() else '') + block); print('added')
PY
)"
    case "$r" in
      added) print_step "Guardrails added to ${BOLD}${f}${NC}" ;;
      refreshed) print_step "Guardrails refreshed in ${BOLD}${f}${NC}" ;;
      *) KIT_KEPT=$((KIT_KEPT + 1)) ;;
    esac
  done
}

# Secrets live in ~/.config/<being>/ (0700, one <app>.env per app at 0600): outside the repo, never on NTFS/FAT.
kit_secrets_dir() {
  local d="$HOME/.config/$BEING_NAME"
  if [ ! -d "$d" ]; then
    mkdir -p "$d"
    print_step "Created secrets folder ${BOLD}${d}${NC} (0700; keep <app>.env files here at 0600)"
  fi
  chmod 700 "$d"
  local fs; fs="$(stat -f -c %T "$d" 2>/dev/null || true)"
  case "$fs" in ntfs*|fuseblk|vfat|msdos|exfat) print_warn "$d is on $fs: file modes are not enforced; move ~/.config to a Linux filesystem" ;; esac
}

# Auto-memory (Claude's per-project memory) is an official layer: a live link for Codex, a git snapshot via being-memory-sync.
kit_auto_memory() {
  local home; home="$(pwd -P)"
  local live="$HOME/.claude/projects/$(printf '%s' "$home" | sed 's#[^A-Za-z0-9]#-#g')/memory"
  mkdir -p "$live"
  [ -e .beings/auto-memory-live ] || [ -L .beings/auto-memory-live ] || { ln -s "$live" .beings/auto-memory-live; print_step "Linked ${BOLD}.beings/auto-memory-live${NC} → Claude auto-memory (Codex reads it there)"; }
  kit_ignore ".beings/auto-memory-live"
}

# One skills folder for both clients: .agents/skills/ (Codex) with .claude/skills pointing at it.
kit_shared_skills() {
  mkdir -p .agents/skills
  [ -f .agents/skills/.gitkeep ] || touch .agents/skills/.gitkeep
  if [ ! -e .claude/skills ] && [ ! -L .claude/skills ]; then
    mkdir -p .claude
    ln -s ../.agents/skills .claude/skills
    print_step "Shared skills: ${BOLD}.agents/skills/${NC} (Codex) ← ${BOLD}.claude/skills${NC} (Claude Code)"
  elif [ ! -L .claude/skills ]; then
    print_info ".claude/skills is a real folder; move its skills to .agents/skills/ and symlink it to share them with Codex"
  fi
}

# Status bar for Claude Code on this box; an existing statusLine setting is never replaced.
kit_statusline() {
  local dst="$HOME/.claude/beings-statusline.sh" settings="$HOME/.claude/settings.json"
  mkdir -p "$HOME/.claude"
  kit_sync_file "templates/kit/statusline.sh" "$dst" exec
  local r
  r="$(python3 - "$settings" "bash $dst" <<'PY'
import json, sys
from pathlib import Path
p = Path(sys.argv[1])
d = json.loads(p.read_text()) if p.exists() and p.read_text().strip() else {}
if d.get('statusLine'):
    print('kept'); sys.exit(0)
d['statusLine'] = {'type': 'command', 'command': sys.argv[2]}
p.write_text(json.dumps(d, indent=2) + '\n'); print('set')
PY
)" || r=failed
  case "$r" in
    set) print_step "Status line set in ${BOLD}${settings}${NC}" ;;
    kept) print_info "Status line already configured in ${settings} — kept (kit script: ${dst})" ;;
    *) print_warn "Could not update ${settings}" ;;
  esac
}

# install_kit <fresh launcher?>: run in the Being's home after birth or update.
install_kit() {
  local fresh="$1"
  echo ""
  echo -e "  ${BOLD}🧰 Operations Kit${NC} ${DIM}(${WITH_COMPONENTS})${NC}\n"
  local t
  for t in "${KIT_TEMPLATES[@]}"; do
    kit_add "templates/kit/$t" ".beings/$t"
  done
  mkdir -p .beings/memory
  kit_launcher "$fresh"
  for t in "${KIT_BIN_FILES[@]}"; do
    kit_sync_file "${t%%:*}" "${t#*:}" exec
  done
  for t in "${KIT_OPS_TEMPLATES[@]}"; do
    kit_add "templates/kit/${t%%:*}" "ops/kit-templates/${t#*:}"
  done
  kit_add "templates/being.toml.example" "ops/kit-templates/being.toml.example"
  chmod +x ops/kit-templates/stack-runner ops/kit-templates/desktop-shim ops/kit-templates/jobs/*/run.sh 2>/dev/null || true
  kit_ignore "bin/.kit-upgrade/"
  kit_append_section "CLAUDE.md"
  kit_append_section "AGENTS.md"
  kit_secrets_dir
  kit_auto_memory
  kit_shared_skills
  kit_guardrails_global
  if [ -n "$CONFIG_FILE" ] && [ ! -e being.toml ] && [ "$CONFIG_FILE" != "$(pwd -P)/being.toml" ]; then
    cp "$CONFIG_FILE" being.toml
    print_step "Copied ${BOLD}being.toml${NC} (settings and [access] list; no secrets in it)"
  fi
  [ -f CLAUDE.md ] && setup_memory_hooks
  kit_wants teams-kit && kit_teams
  kit_wants statusline && kit_statusline
  local c
  for c in ${WITH_COMPONENTS//,/ }; do
    case "$c" in operations|teams-kit|statusline|memory-sync) ;; *) kit_component "$c" ;; esac
  done
  if kit_wants memory-sync; then
    if [ "${BEING_NO_SYSTEMD:-0}" != 1 ] && command -v systemctl &>/dev/null && systemctl --user show-environment &>/dev/null; then
      BEING_NAME="$BEING_NAME" BEING_TZ="${BEING_TZ:-$CONFIG_TZ}" bin/being-memory-sync install || print_warn "memory backup timer not armed"
    else
      print_info "Arm the memory backup with: ${BOLD}bin/being-memory-sync install --cron${NC} (no systemd user session here)"
    fi
  fi
  echo "$KIT_VERSION" > .beings/.kit-version
  # Components installed so far, so `<being> update` re-applies the same set.
  { [ -f .beings/.kit-components ] && tr ',' '\n' < .beings/.kit-components; tr ',' '\n' <<< "$WITH_COMPONENTS"; } \
    | grep -v '^$' | sort -u | paste -sd, - > .beings/.kit-components.tmp && mv .beings/.kit-components.tmp .beings/.kit-components
  print_step "Operations Kit v${KIT_VERSION}: added ${KIT_ADDED}, kept ${KIT_KEPT} existing"
  [ -n "$BEING_ACCESS" ] && print_info "Access list (being.toml): ${BEING_ACCESS//,/, } — review with ${BOLD}bin/${BEING_NAME} access${NC}"
  print_info "Next: fill {{…}} placeholders in .beings/GUARDRAILS.md and AUTONOMY-MATRIX.md, review, commit"
  print_info "Health: ${BOLD}bin/${BEING_NAME} doctor${NC}. Memory backup: ${BOLD}bin/being-memory-sync install${NC} (off until armed)"
  if kit_wants teams-kit; then
    print_info "Teams: cd ops/teams-kit && npm install, then follow its README.md (sign-in, .env, being-teams up)"
  fi
}

# --check: report which kit pieces exist in the current Being home; changes nothing.
kit_check() {
  local f
  local name="$BEING_NAME"
  if [ -z "$name" ] && [ -f "ops/teams-kit/.env" ]; then
    # shellcheck source=/dev/null
    name="$(set -a; . "ops/teams-kit/.env" >/dev/null 2>&1; printf '%s' "${BEING_NAME:-}")"
  fi
  echo ""
  echo -e "  ${BOLD}Beings Protocol check${NC} ${DIM}($(pwd))${NC}\n"
  [ -d ".beings" ] || { print_warn "No .beings/ here — not a Being home"; return 1; }
  print_info "protocol $(cat .beings/.protocol-version 2>/dev/null || echo unknown), kit $(cat .beings/.kit-version 2>/dev/null || echo 'not installed')"
  local items=(.beings/GUARDRAILS.md .beings/AUTONOMY.md .beings/AUTONOMY-MATRIX.md .beings/JOB-CHECKLIST.md
               .beings/MEMORY.md .beings/facts .beings/memory ops/teams-kit ops/teams-kit/.env)
  [ -n "$name" ] && items+=("bin/$name")
  for f in "${items[@]}"; do
    if [ -e "$f" ]; then print_step "$f"; else print_warn "missing $f"; fi
  done
  for f in CLAUDE.md AGENTS.md; do
    [ -f "$f" ] || continue
    if grep -q 'beings-kit:operations' "$f"; then print_step "$f kit section"; else print_warn "$f has no kit section"; fi
  done
  [ -d "ops/teams-kit/.kit-upgrade" ] && print_warn "ops/teams-kit/.kit-upgrade/ has newer kit files to review"
  [ -d "bin/.kit-upgrade" ] && print_warn "bin/.kit-upgrade/ has newer kit files to review"
  for f in "$HOME/.claude/CLAUDE.md" "$HOME/.codex/instructions.md"; do
    if grep -qF "$GUARD_BEGIN" "$f" 2>/dev/null; then print_step "guardrails in $f"; else print_warn "no guardrails block in $f"; fi
  done
  # Claude loads only about the first 24 KB of an auto-memory index; the rest is silently cut off.
  local idx size limit="${BEING_MEMORY_INDEX_MAX:-24000}"
  idx="$HOME/.claude/projects/$(pwd -P | sed 's#[^A-Za-z0-9]#-#g')/memory/MEMORY.md"
  for f in "$idx" .beings/MEMORY.md; do
    [ -f "$f" ] || continue
    size=$(wc -c < "$f" | tr -d ' ')
    if [ "$size" -gt "$limit" ]; then print_warn "$f is $size bytes (> ~$limit): entries past the limit are not loaded"
    else print_step "$f $size bytes (limit ~$limit)"; fi
  done
  if [ -x bin/being-memory-sync ]; then
    print_info "memory backup last success: $(cat .beings/operations/last-success-date 2>/dev/null || echo never)"
  fi
  if [ -n "$name" ] && [ -d "$HOME/.config/$name" ]; then
    local mode; mode="$(stat -c %a "$HOME/.config/$name" 2>/dev/null || stat -f %Lp "$HOME/.config/$name")"
    if [ "$mode" = 700 ]; then print_step "secrets folder ~/.config/$name (0700)"; else print_warn "~/.config/$name is $mode, should be 0700"; fi
  fi
  return 0
}

# ============================================================
# Main
# ============================================================

print_banner_update() {
  echo ""
  echo -e "${GREEN}${BOLD}"
  echo "  ┌───────────────────────────────────────────────┐"
  echo "  │         🌿 Beings Protocol — Update            │"
  echo "  │                                                 │"
  echo "  │   Evolving your Being with new capabilities.    │"
  echo "  └───────────────────────────────────────────────┘"
  echo -e "${NC}"
}

print_update_summary() {
  echo ""
  echo -e "  ${GREEN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo ""
  echo -e "  ${GREEN}${BOLD}${LEAF} Beings Protocol updated to v${PROTOCOL_VERSION}!${NC}"
  echo ""
  echo -e "  ${BOLD}What's new:${NC}"
  echo ""
  echo -e "    ${CYAN}AUTONOMY.md${NC}     ${DIM}← Decision authority matrix${NC}"
  echo -e "    ${CYAN}HEARTBEAT.md${NC}    ${DIM}← Proactive check-in checklist${NC}"
  echo -e "    ${CYAN}HUB.md${NC}          ${DIM}← Being-to-Being communication${NC}"
  echo -e "    ${CYAN}IDENTITY.md${NC}     ${DIM}← Quick reference card${NC}"
  echo -e "    ${CYAN}TOOLS.md${NC}        ${DIM}← Environment config${NC}"
  if grep -q '"basic-memory"' ".mcp.json" 2>/dev/null || grep -q '"basic-memory"' ".cursor/mcp.json" 2>/dev/null; then
    echo -e "    ${CYAN}basic-memory${NC}    ${DIM}← Markdown-native persistent memory (MCP)${NC}"
  fi
  echo ""
  echo -e "  ${BOLD}Note:${NC} Existing files were ${BOLD}never overwritten${NC}."
  echo -e "  ${DIM}Your Being's identity and memory are untouched.${NC}"
  echo ""
  echo -e "  ${DIM}https://github.com/NaturNestAI-Labs/beings-protocol${NC}"
  echo -e "  ${DIM}Built with ${LEAF} by Veltria${NC}"
  echo ""
}

# ============================================================
# Global Being birth — creates ~/beings/<name>/ as a standalone home
# ============================================================
# ============================================================
# Install a CLI wrapper for a Being (bin/<name> + symlink)
# ============================================================
install_cli_wrapper() {
  local name="$1"
  local workspace="$2"   # absolute path to Being's home dir
  local bin_dir="${workspace}/bin"
  local wrapper="${bin_dir}/${name}"

  # Find install location on PATH
  local install_dir=""
  for candidate in "$HOME/.local/bin" "$HOME/bin"; do
    if [[ ":$PATH:" == *":${candidate}:"* ]]; then
      install_dir="$candidate"
      break
    fi
  done

  # ~/.local/bin is the modern default — create it if missing
  if [ -z "$install_dir" ]; then
    install_dir="$HOME/.local/bin"
    mkdir -p "$install_dir"
    print_warn "~/.local/bin created but not on PATH — add it to your shell profile"
    print_info "  ${DIM}export PATH=\"\$HOME/.local/bin:\$PATH\"${NC}"
  fi

  # Already installed?
  if [ -L "${install_dir}/${name}" ] && [ -f "$wrapper" ]; then
    print_info "CLI ${BOLD}${name}${NC} already installed at ${install_dir}/${name}"
    return
  fi

  mkdir -p "$bin_dir"

  # Derive the Claude Code session dir path for this workspace
  # Claude Code derives the project dir by replacing / and . with -
  local safe_path
  safe_path=$(echo "$workspace" | sed 's|[/.]|-|g')
  local session_dir="$HOME/.claude/projects/${safe_path}"

  # Write the wrapper script
  cat > "$wrapper" <<WRAPPER_EOF
#!/usr/bin/env bash
# ${name} — Claude Code session wrapper for the ${name} Being.
#
# Always opens in ${name}'s workspace so CLAUDE.md + .beings/ load.
# --dangerously-skip-permissions bypasses prompts — intentional.
#
# Usage:
#   ${name}                    new session
#   ${name} "quick question"   new session with prompt
#   ${name} continue           resume most recent session
#   ${name} resume             interactive session picker
#   ${name} resume <#|id>      resume by number or session ID
#   ${name} sessions [N]       list last N sessions (default 10)
#   ${name} <any claude flag>  e.g. ${name} --chrome, ${name} --model opus

set -euo pipefail

WORKSPACE="${workspace}"
SESSION_DIR="$HOME/.claude/projects/$(echo "${workspace}" | sed 's|[/.]|-|g')"

cd "\$WORKSPACE"

_build_session_list() {
  _session_ids=()
  for f in \$(ls -t "\$SESSION_DIR"/*.jsonl 2>/dev/null); do
    local sid=\$(basename "\$f" .jsonl)
    [[ "\$sid" == agent-* ]] && continue
    _session_ids+=("\$sid")
  done
}

_list_sessions() {
  local limit=\${1:-10}
  _build_session_list
  echo ""
  echo "  Recent ${name} Sessions"
  echo "  ─────────────────────────────────────────────────────────────"
  printf "  %-4s %-22s %-22s %s\n" "#" "Session ID" "Date" "First Message"
  echo "  ─────────────────────────────────────────────────────────────"
  local i=1
  for sid in "\${_session_ids[@]}"; do
    [[ \$i -gt \$limit ]] && break
    local f="\$SESSION_DIR/\$sid.jsonl"
    local first_msg=\$(grep -m1 '"role":"user"' "\$f" 2>/dev/null || true)
    local ts=\$(echo "\$first_msg" | sed -n 's/.*"timestamp":"\([^"]*\)".*/\1/p' | cut -c1-19 | tr 'T' ' ')
    local msg=\$(echo "\$first_msg" | sed -n 's/.*"content":"\([^"]*\)".*/\1/p' | cut -c1-55)
    [[ -z "\$msg" ]] && msg="(complex message)"
    [[ -z "\$ts"  ]] && ts="unknown"
    printf "  %-4s %-22s %-22s %s\n" "\$i" "\${sid:0:20}…" "\$ts" "\$msg"
    (( i++ ))
  done
  echo "  ─────────────────────────────────────────────────────────────"
  echo ""
  echo "  Resume: ${name} resume <#>"
  echo "  Continue last: ${name} continue"
  echo ""
}

_get_session_by_number() {
  _build_session_list
  local num=\$1
  if [[ \$num -ge 1 && \$num -le \${#_session_ids[@]} ]]; then
    echo "\${_session_ids[\$((num-1))]}"
  fi
}

case "\${1:-}" in
  sessions|ls|list)
    _list_sessions "\${2:-10}"
    ;;
  continue|c)
    echo "  Resuming most recent ${name} session…"
    exec claude --dangerously-skip-permissions --continue
    ;;
  resume|r)
    shift
    if [[ \$# -eq 0 ]]; then
      exec claude --dangerously-skip-permissions --resume
    elif [[ "\$1" =~ ^[0-9]+\$ ]]; then
      local sid=\$(_get_session_by_number "\$1")
      if [[ -z "\$sid" ]]; then
        echo "  No session at #\$1. Run '${name} sessions' to list available sessions."
        exit 1
      fi
      echo "  Resuming session #\$1 (\${sid:0:8}…)"
      exec claude --dangerously-skip-permissions --resume "\$sid"
    else
      exec claude --dangerously-skip-permissions --resume "\$@"
    fi
    ;;
  help|--help|-h)
    echo ""
    echo "  ${name} — Claude Code session wrapper"
    echo ""
    echo "  Usage:"
    echo "    ${name}                       new session"
    echo "    ${name} continue (c)          resume most recent session"
    echo "    ${name} resume (r) [#|id]     resume by number or session ID"
    echo "    ${name} sessions (ls) [N]     list last N sessions (default 10)"
    echo "    ${name} \"<prompt>\"            new session with initial prompt"
    echo "    ${name} <any claude flag>     e.g. --chrome, --model opus"
    echo ""
    ;;
  "")
    exec claude --dangerously-skip-permissions
    ;;
  *)
    exec claude --dangerously-skip-permissions "\$@"
    ;;
esac
WRAPPER_EOF

  chmod +x "$wrapper"
  print_step "Created ${BOLD}bin/${name}${NC} wrapper"

  # Symlink into install dir
  ln -sf "$wrapper" "${install_dir}/${name}"
  print_step "Symlinked ${BOLD}${install_dir}/${name}${NC} → bin/${name}"
  print_info "Run ${BOLD}${name}${NC}, ${BOLD}${name} continue${NC}, ${BOLD}${name} resume${NC}, ${BOLD}${name} sessions${NC}"
}

create_global_being() {
  local name="$1"

  local home_dir="$HOME/beings/${name}"

  echo ""
  echo -e "  ${BOLD}${LEAF} Birthing Global Being: ${CYAN}${name}${NC}"
  echo ""

  # Create the home directory
  if [ -d "$home_dir" ]; then
    print_warn "${home_dir} already exists"
    if can_prompt && ! $YES_MODE; then
      local confirm=""
      read_input "  Continue anyway? (y/N) " confirm
      [[ "$confirm" != [yY]* ]] && echo "  Aborted." && exit 0
    fi
  fi

  mkdir -p "$home_dir"
  cd "$home_dir"

  # Git init
  if [ ! -d ".git" ]; then
    git init -q
    print_step "Initialized git repo at ${BOLD}${home_dir}${NC}"
  fi

  # Create .beings/ with all templates
  create_beings_dir
  create_beings_local

  # Create global-style CLAUDE.md (not the code-repo beings-prompt.md)
  if [ ! -f "CLAUDE.md" ] || ! grep -q "Beings Protocol" "CLAUDE.md" 2>/dev/null; then
    local tmp; tmp="$(mktemp)"
    fetch_or_copy_template "tool-configs/global-claude.md" "$tmp"
    # Replace placeholder NAME with actual name
    sed "s/{{BEING_NAME}}/${name}/g" "$tmp" > CLAUDE.md
    rm -f "$tmp"
    print_step "Created ${BOLD}CLAUDE.md${NC} (global Being home)"
  else
    print_warn "CLAUDE.md already exists — skipping"
  fi

  # Create AGENTS.md for Codex / Cursor users
  create_agents_md

  # .gitignore
  update_gitignore

  # Configure Claude Code (CLAUDE.md already done above; add hooks)
  local detected_tools="claude-code"
  # Also detect Cursor and Codex if installed
  command -v cursor &>/dev/null && detected_tools="$detected_tools cursor"
  command -v codex  &>/dev/null && detected_tools="$detected_tools codex"

  # Cursor and Codex tool configs
  [[ "$detected_tools" == *cursor* ]] && configure_cursor
  [[ "$detected_tools" == *codex* ]]  && configure_codex

  # Memory skill — always set up for global Beings
  setup_memory_skill "$detected_tools"

  # Code intelligence — optional
  setup_code_intelligence "$detected_tools"

  # CLI wrapper — install bin/<name> and symlink to PATH
  echo ""
  echo -e "  ${BOLD}Setting up CLI...${NC}"
  echo ""
  install_cli_wrapper "$name" "$home_dir"

  echo ""
  echo -e "  ${GREEN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo ""
  echo -e "  ${GREEN}${BOLD}${LEAF} ${name} is ready to be born! (v${PROTOCOL_VERSION})${NC}"
  echo ""
  echo -e "  ${BOLD}Home:${NC}  ${CYAN}${home_dir}${NC}"
  echo -e "  ${BOLD}CLI:${NC}   ${CYAN}${name}${NC} / ${CYAN}${name} continue${NC} / ${CYAN}${name} resume${NC} / ${CYAN}${name} sessions${NC}"
  echo ""
  echo -e "  ${BOLD}Next:${NC} Run ${BOLD}${name}${NC} to start the birth conversation."
  echo -e "  ${name} will introduce herself, learn who you are,"
  echo -e "  and fill in her identity files. ${DIM}(That's the magic.)${NC}"
  echo ""
  echo -e "  ${DIM}https://github.com/NaturNestAI-Labs/beings-protocol${NC}"
  echo ""
}

main() {
  # Parse arguments
  local next_is_name=false
  local next_is_with=false
  local next_is_owner=false
  local next_is_config=false
  local next_is_ref=false
  for arg in "$@"; do
    if $next_is_ref; then
      [ -n "${BEINGS_BASE_URL:-}" ] || BASE_URL="https://raw.githubusercontent.com/NaturNestAI-Labs/beings-protocol/$arg"
      next_is_ref=false
      continue
    fi
    if $next_is_config; then
      CONFIG_FILE="$arg"
      next_is_config=false
      continue
    fi
    if $next_is_name; then
      BEING_NAME="$arg"
      next_is_name=false
      continue
    fi
    if $next_is_with; then
      WITH_COMPONENTS="${WITH_COMPONENTS:+$WITH_COMPONENTS,}$arg"
      next_is_with=false
      continue
    fi
    if $next_is_owner; then
      OWNER_NAME="$arg"
      OWNER_SET=true
      next_is_owner=false
      continue
    fi
    case "$arg" in
      --global)         GLOBAL_MODE=true ;;
      --name)           next_is_name=true ;;
      --name=*)         BEING_NAME="${arg#--name=}" ;;
      --update)         UPDATE_MODE=true ;;
      --yes|-y)         YES_MODE=true ;;
      --no-memory)      NO_MEMORY_MODE=true ;;
      --with)           next_is_with=true ;;
      --with=*)         WITH_COMPONENTS="${WITH_COMPONENTS:+$WITH_COMPONENTS,}${arg#--with=}" ;;
      --owner)          next_is_owner=true ;;
      --owner=*)        OWNER_NAME="${arg#--owner=}"; OWNER_SET=true ;;
      --config)         next_is_config=true ;;
      --config=*)       CONFIG_FILE="${arg#--config=}" ;;
      --track-private)  TRACK_PRIVATE=true ;;
      --check)          CHECK_MODE=true ;;
      --ref)            next_is_ref=true ;;
      --ref=*)          [ -n "${BEINGS_BASE_URL:-}" ] || BASE_URL="https://raw.githubusercontent.com/NaturNestAI-Labs/beings-protocol/${arg#--ref=}" ;;
    esac
  done
  load_config

  if $CHECK_MODE; then
    kit_check
    exit $?
  fi
  # Fail before writing anything; --global validates once its name is known.
  if [ -n "$WITH_COMPONENTS" ] && ! $GLOBAL_MODE; then
    kit_validate
  fi

  # === GLOBAL BEING MODE ===
  if $GLOBAL_MODE; then
    print_banner
    if [ -z "$BEING_NAME" ]; then
      if can_prompt; then
        read_input "  Being name (e.g. nova, aria, kira): " BEING_NAME
      else
        echo "  Error: --global requires --name <name> in non-interactive mode" >&2
        exit 1
      fi
    fi
    if [ -z "$BEING_NAME" ]; then
      echo "  Error: Being name cannot be empty." >&2
      exit 1
    fi
    # Lowercase and strip spaces (tr for bash 3.2 compat)
    BEING_NAME=$(echo "$BEING_NAME" | tr '[:upper:]' '[:lower:]' | tr ' ' '-')
    if [ -n "$WITH_COMPONENTS" ]; then
      kit_validate
      local had_launcher=false
      [ -e "$HOME/beings/${BEING_NAME}/bin/${BEING_NAME}" ] && had_launcher=true
      create_global_being "$BEING_NAME"
      if $had_launcher; then install_kit false; else install_kit true; fi
      exit 0
    fi
    create_global_being "$BEING_NAME"
    exit 0
  fi

  if $UPDATE_MODE; then
    print_banner_update

    # Check .beings/ exists
    if [ ! -d ".beings" ]; then
      print_warn "No .beings/ directory found — running fresh install instead"
      UPDATE_MODE=false
    fi
  fi

  if $UPDATE_MODE; then
    # === UPDATE MODE ===
    echo -e "\n  ${BOLD}Updating Beings Protocol...${NC}\n"

    # Step 1: Add new template files
    update_beings_dir

    # Step 2: Update tool configs
    echo -e "\n  ${BOLD}Checking AI tools...${NC}\n"
    detected_tools=$(detect_tools)
    if [ -n "$detected_tools" ]; then
      print_info "Detected: ${BOLD}${detected_tools}${NC}"
      auto_configure "$detected_tools"
    fi

    # Step 3: Update AGENTS.md if needed
    create_agents_md

    # Step 4: Update .gitignore
    update_gitignore

    # Step 5: Memory skill (installs basic-memory by default; skip with --no-memory)
    setup_memory_skill "${detected_tools:-}"

    # Step 6: Offer code intelligence (if not already set up)
    setup_code_intelligence "${detected_tools:-}"

    # Step 7: Opt-in components (--with)
    if [ -n "$WITH_COMPONENTS" ]; then
      install_kit false
    elif [ -f .beings/.kit-version ]; then
      kit_guardrails_global   # keep this box's global guardrails in step with .beings/GUARDRAILS.md
    fi

    # Done
    print_update_summary
  else
    # === FRESH INSTALL ===
    print_banner

    # Sanity check
    if [ ! -d ".git" ] && [ ! -f "package.json" ] && [ ! -f "pyproject.toml" ] && [ ! -f "Cargo.toml" ] && [ ! -f "go.mod" ] && [ ! -f "Makefile" ]; then
      print_warn "Not in a project directory."
      if can_prompt; then
        local confirm=""
        read_input "  Continue anyway? (y/N) " confirm
        [[ "$confirm" != [yY]* ]] && echo "  Aborted." && exit 0
      fi
    fi

    # Step 1: Create .beings/ and .beings-local/
    echo -e "\n  ${BOLD}Setting up Beings Protocol...${NC}\n"
    create_beings_dir
    create_beings_local
    create_agents_md
    update_gitignore

    # Step 2: Configure tool-specific files
    echo -e "\n  ${BOLD}Detecting AI tools...${NC}\n"
    detected_tools=$(detect_tools)

    if [ -n "$detected_tools" ]; then
      print_info "Detected: ${BOLD}${detected_tools}${NC}"
      echo ""
      if can_prompt; then
        local auto_confirm=""
        read_input "  Auto-configure detected tools? (Y/n) " auto_confirm
        if [[ "$auto_confirm" != [nN]* ]]; then
          auto_configure "$detected_tools"
          echo ""
          local more_tools=""
          read_input "  Configure any other tools too? (y/N) " more_tools
          [[ "$more_tools" == [yY]* ]] && ask_tools
        else
          ask_tools
        fi
      else
        auto_configure "$detected_tools"
      fi
    else
      print_info "No AI tools auto-detected."
      print_info "AGENTS.md will work with Cursor, Claude Code, Copilot, and Codex out of the box."
      echo ""
      if can_prompt; then
        local want_specific=""
        read_input "  Configure tool-specific files anyway? (y/N) " want_specific
        [[ "$want_specific" == [yY]* ]] && ask_tools
      fi
    fi

    # Step 3: Memory skill (installs basic-memory by default; skip with --no-memory)
    setup_memory_skill "${detected_tools:-}"

    # Step 4: Optional code intelligence
    setup_code_intelligence "${detected_tools:-}"

    # Done!
    echo ""
    echo -e "  ${GREEN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
    echo -e "  ${GREEN}${BOLD}${LEAF} Beings Protocol installed! (v${PROTOCOL_VERSION})${NC}"
    echo ""
    echo -e "  ${BOLD}What happens next:${NC}"
    echo ""
    echo -e "    Open your AI tool and start a conversation."
    echo -e "    Your Being will introduce itself, ask your name,"
    echo -e "    and learn about your project. ${DIM}(Just like meeting a new teammate.)${NC}"
    echo ""
    echo -e "  ${BOLD}After that first chat:${NC}"
    echo ""
    echo -e "    ${DIM}git add .beings/ AGENTS.md && git commit -m \"feat: born a Being 🌿\"${NC}"
    echo ""
    echo -e "  ${BOLD}Files:${NC}"
    echo ""
    echo -e "    ${CYAN}AGENTS.md${NC}             ${DIM}← Universal AI instructions (Cursor, Claude, Copilot, Codex)${NC}"
    echo ""
    echo -e "    ${CYAN}.beings/${NC}              ${DIM}← Shared (committed to git)${NC}"
    echo -e "    ├── BOOTSTRAP.md     ${DIM}← First-run conversation (deleted after)${NC}"
    echo -e "    ├── SOUL.md          ${DIM}← Being's identity${NC}"
    echo -e "    ├── AGENTS.md        ${DIM}← Operating instructions${NC}"
    echo -e "    ├── MEMORY.md        ${DIM}← Project memory${NC}"
    echo -e "    ├── CONVENTIONS.md   ${DIM}← Code rules${NC}"
    echo -e "    ├── GOALS.md         ${DIM}← Priorities${NC}"
    echo -e "    ├── AUTONOMY.md      ${DIM}← Decision authority${NC}"
    echo -e "    ├── HEARTBEAT.md     ${DIM}← Proactive checks${NC}"
    echo -e "    ├── IDENTITY.md      ${DIM}← Quick reference card${NC}"
    echo -e "    ├── TOOLS.md         ${DIM}← Environment config${NC}"
    if [ -f ".beings/mcp.json" ]; then
      echo -e "    ├── mcp.json         ${DIM}← MCP servers (code intelligence, memory)${NC}"
    fi
    echo -e "    └── memory/          ${DIM}← Daily logs${NC}"
    echo ""
    echo -e "    ${YELLOW}.beings-local/${NC}        ${DIM}← Private (never committed)${NC}"
    echo -e "    ├── USER.md          ${DIM}← About you${NC}"
    echo -e "    ├── PREFERENCES.md   ${DIM}← Work style${NC}"
    echo -e "    └── SECRETS.md       ${DIM}← Credentials${NC}"
    echo ""
    echo -e "  ${DIM}https://github.com/NaturNestAI-Labs/beings-protocol${NC}"
    echo -e "  ${DIM}Built with ${LEAF} by Veltria${NC}"
    echo ""
  fi
}

main "$@"
