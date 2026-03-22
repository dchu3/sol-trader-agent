#!/usr/bin/env bash
# Sol Trader Agent — One-step installer
# Usage: curl -sSL https://raw.githubusercontent.com/dchu3/sol-trader-agent/main/setup.sh | bash
set -euo pipefail

# ── Constants ────────────────────────────────────────────────────────
INSTALL_DIR="$HOME/soltrader"
AGENT_DIR="$INSTALL_DIR/sol-trader-agent"
DEX_DIR="$INSTALL_DIR/dex-trader-mcp"
AGENT_REPO="https://github.com/dchu3/sol-trader-agent.git"
DEX_REPO="https://github.com/dchu3/dex-trader-mcp.git"
MIN_NODE_MAJOR=20
MIN_NODE_MINOR=18

# ── Colour helpers (disabled when no terminal) ───────────────────────
if [ -t 1 ] && command -v tput >/dev/null 2>&1 && [ "$(tput colors 2>/dev/null || echo 0)" -ge 8 ]; then
  BOLD=$(tput bold)
  GREEN=$(tput setaf 2)
  YELLOW=$(tput setaf 3)
  RED=$(tput setaf 1)
  CYAN=$(tput setaf 6)
  RESET=$(tput sgr0)
else
  BOLD="" GREEN="" YELLOW="" RED="" CYAN="" RESET=""
fi

info()  { printf "%s[INFO]%s  %s\n" "$GREEN"  "$RESET" "$1"; }
warn()  { printf "%s[WARN]%s  %s\n" "$YELLOW" "$RESET" "$1"; }
error() { printf "%s[ERROR]%s %s\n" "$RED"    "$RESET" "$1"; }
step()  { printf "\n%s▸ %s%s\n" "${BOLD}${CYAN}" "$1" "$RESET"; }

# ── Read helper (works when piped via curl) ──────────────────────────
prompt_input() {
  local varname="$1" prompt_text="$2" default="${3:-}" secret="${4:-false}"
  local input

  if [ "$secret" = "true" ]; then
    printf "  %s" "$prompt_text" >/dev/tty
    read -rs input </dev/tty
    printf "\n" >/dev/tty
  else
    if [ -n "$default" ]; then
      printf "  %s [%s]: " "$prompt_text" "$default" >/dev/tty
    else
      printf "  %s: " "$prompt_text" >/dev/tty
    fi
    read -r input </dev/tty
  fi

  input="${input:-$default}"
  printf -v "$varname" '%s' "$input"
}

prompt_yn() {
  local prompt_text="$1" default="${2:-n}"
  local answer
  if [ "$default" = "y" ]; then
    printf "  %s (Y/n): " "$prompt_text" >/dev/tty
  else
    printf "  %s (y/N): " "$prompt_text" >/dev/tty
  fi
  read -r answer </dev/tty
  answer="${answer:-$default}"
  case "$answer" in
    [yY]|[yY][eE][sS]) return 0 ;;
    *) return 1 ;;
  esac
}

# ── 1. Check prerequisites ──────────────────────────────────────────
step "Checking prerequisites"

check_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    error "$1 is not installed. $2"
    exit 1
  fi
}

check_command git "Install it from https://git-scm.com/downloads"
check_command node "Install Node.js >= ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}.0 from https://nodejs.org"
check_command npm "npm should come with Node.js — reinstall Node from https://nodejs.org"

# Verify Node.js version
NODE_VERSION=$(node --version | sed 's/^v//')
NODE_MAJOR=$(echo "$NODE_VERSION" | cut -d. -f1)
NODE_MINOR=$(echo "$NODE_VERSION" | cut -d. -f2)
if [ "$NODE_MAJOR" -lt "$MIN_NODE_MAJOR" ] || { [ "$NODE_MAJOR" -eq "$MIN_NODE_MAJOR" ] && [ "$NODE_MINOR" -lt "$MIN_NODE_MINOR" ]; }; then
  error "Node.js >= ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}.0 is required (found v${NODE_VERSION})."
  error "Install a newer version from https://nodejs.org"
  exit 1
fi
info "Node.js v${NODE_VERSION} ✓"
info "npm v$(npm --version) ✓"
info "git v$(git --version | awk '{print $3}') ✓"

# ── 2. Create install directory & clone ──────────────────────────────
step "Setting up ~/soltrader"

mkdir -p "$INSTALL_DIR"

if [ -d "$AGENT_DIR/.git" ]; then
  warn "sol-trader-agent already exists at $AGENT_DIR"
  if prompt_yn "Update it with git pull?"; then
    cd "$AGENT_DIR"
    git pull --ff-only || { error "git pull failed — resolve manually."; exit 1; }
    info "Updated sol-trader-agent"
  else
    info "Skipping clone — using existing directory"
  fi
else
  info "Cloning sol-trader-agent..."
  git clone "$AGENT_REPO" "$AGENT_DIR"
  info "Cloned to $AGENT_DIR"
fi

cd "$AGENT_DIR"

# ── 3. Install dependencies ─────────────────────────────────────────
step "Installing dependencies"
npm install --no-fund --no-audit
info "npm install complete"

# ── 4. Configure .env ────────────────────────────────────────────────
step "Configuring environment variables"

CONFIGURE_ENV=true
if [ -f "$AGENT_DIR/.env" ]; then
  warn ".env already exists"
  if ! prompt_yn "Reconfigure it?"; then
    CONFIGURE_ENV=false
    info "Keeping existing .env"
  fi
fi

if [ "$CONFIGURE_ENV" = "true" ]; then
  printf "\n  ${BOLD}Required settings:${RESET}\n\n"

  # Gemini API Key
  GEMINI_API_KEY=""
  while [ -z "$GEMINI_API_KEY" ]; do
    prompt_input GEMINI_API_KEY "Gemini API key (get one at https://aistudio.google.com)" "" true
    if [ -z "$GEMINI_API_KEY" ]; then
      warn "Gemini API key is required."
    fi
  done

  # Remote MCP URL
  prompt_input REMOTE_MCP_URL "Remote MCP server URL" "https://svm402.com/mcp"

  # Solana Private Key
  SOLANA_PRIVATE_KEY=""
  while [ -z "$SOLANA_PRIVATE_KEY" ]; do
    prompt_input SOLANA_PRIVATE_KEY "Solana wallet private key (base58-encoded)" "" true
    if [ -z "$SOLANA_PRIVATE_KEY" ]; then
      warn "Solana private key is required."
    fi
  done

  # Optional: Telegram
  TELEGRAM_BOT_TOKEN=""
  TELEGRAM_CHAT_ID=""
  printf "\n"
  if prompt_yn "Configure Telegram bot access?"; then
    printf "\n  ${BOLD}Telegram settings:${RESET}\n\n"
    prompt_input TELEGRAM_BOT_TOKEN "Bot token (create via @BotFather on Telegram)" ""
    prompt_input TELEGRAM_CHAT_ID "Your chat ID (message @userinfobot on Telegram)" ""
  fi

  # Optional: Advanced settings
  GEMINI_MODEL=""
  SOLANA_RPC_URL=""
  JUPITER_API_BASE=""
  JUPITER_API_KEY=""
  VERBOSE=""
  printf "\n"
  if prompt_yn "Configure advanced settings? (Gemini model, RPC URL, Jupiter API)"; then
    printf "\n  ${BOLD}Advanced settings (press Enter to skip):${RESET}\n\n"
    prompt_input GEMINI_MODEL "Gemini model" "gemini-3.1-flash-lite-preview"
    prompt_input SOLANA_RPC_URL "Solana RPC URL" ""
    prompt_input JUPITER_API_BASE "Jupiter API base URL" ""
    prompt_input JUPITER_API_KEY "Jupiter API key" "" true
    prompt_input VERBOSE "Enable verbose/debug logging? (true/false)" "false"
  fi

  # Write .env — create with restrictive permissions from the start
  (umask 077; cat > "$AGENT_DIR/.env" <<ENVFILE
# Required: Google Gemini API key
GEMINI_API_KEY=${GEMINI_API_KEY}

# Required: URL of the remote MCP server (StreamableHTTP transport).
REMOTE_MCP_URL=${REMOTE_MCP_URL}

# Required: Solana wallet private key (base58-encoded, used for x402 payments and trading)
SOLANA_PRIVATE_KEY=${SOLANA_PRIVATE_KEY}
ENVFILE
  )

  # Append optional settings only if set
  {
    if [ -n "$GEMINI_MODEL" ] && [ "$GEMINI_MODEL" != "gemini-3.1-flash-lite-preview" ]; then
      printf "\n# Optional: Gemini model to use\nGEMINI_MODEL=%s\n" "$GEMINI_MODEL"
    fi
    if [ -n "$SOLANA_RPC_URL" ]; then
      printf "\n# Optional: Custom Solana RPC URL\nSOLANA_RPC_URL=%s\n" "$SOLANA_RPC_URL"
    fi
    if [ -n "$JUPITER_API_BASE" ]; then
      printf "\n# Optional: Jupiter API base URL\nJUPITER_API_BASE=%s\n" "$JUPITER_API_BASE"
    fi
    if [ -n "$JUPITER_API_KEY" ]; then
      printf "\n# Optional: Jupiter API key\nJUPITER_API_KEY=%s\n" "$JUPITER_API_KEY"
    fi
    if [ -n "$TELEGRAM_BOT_TOKEN" ]; then
      printf "\n# Optional: Telegram bot token\nTELEGRAM_BOT_TOKEN=%s\n" "$TELEGRAM_BOT_TOKEN"
    fi
    if [ -n "$TELEGRAM_CHAT_ID" ]; then
      printf "\n# Optional: Telegram chat ID (restricts bot to this user)\nTELEGRAM_CHAT_ID=%s\n" "$TELEGRAM_CHAT_ID"
    fi
    if [ "$VERBOSE" = "true" ] || [ "$VERBOSE" = "1" ]; then
      printf "\n# Optional: Enable debug logging\nVERBOSE=%s\n" "$VERBOSE"
    fi
  } >> "$AGENT_DIR/.env"

  info ".env written to $AGENT_DIR/.env"
  chmod 600 "$AGENT_DIR/.env"
fi

# ── 5. Optional dex-trader-mcp setup ────────────────────────────────
step "DEX Trading Tools (optional)"
printf "  dex-trader-mcp enables Jupiter DEX trading (buy/sell tokens).\n\n"

SETUP_DEX=false
if prompt_yn "Install dex-trader-mcp trading tools?"; then
  SETUP_DEX=true
fi

if [ "$SETUP_DEX" = "true" ]; then
  if [ -d "$DEX_DIR/.git" ]; then
    warn "dex-trader-mcp already exists at $DEX_DIR"
    if prompt_yn "Update it with git pull and rebuild?"; then
      cd "$DEX_DIR"
      git pull --ff-only || { error "git pull failed — resolve manually."; exit 1; }
    else
      info "Skipping — using existing dex-trader-mcp"
    fi
  else
    info "Cloning dex-trader-mcp..."
    git clone "$DEX_REPO" "$DEX_DIR"
    info "Cloned to $DEX_DIR"
  fi

  cd "$DEX_DIR"
  info "Installing dex-trader-mcp dependencies..."
  npm install --no-fund --no-audit
  info "Building dex-trader-mcp..."
  npm run build
  info "dex-trader-mcp ready"

  # Add DEX_TRADER_MCP_PATH to .env if not already there
  DEX_PATH_VALUE="$DEX_DIR/dist/index.js"
  if grep -q "^DEX_TRADER_MCP_PATH=" "$AGENT_DIR/.env" 2>/dev/null; then
    sed -i.bak "s|^DEX_TRADER_MCP_PATH=.*|DEX_TRADER_MCP_PATH=${DEX_PATH_VALUE}|" "$AGENT_DIR/.env"
    rm -f "$AGENT_DIR/.env.bak"
  else
    printf "\n# Path to dex-trader-mcp (enables Jupiter DEX trading tools)\nDEX_TRADER_MCP_PATH=%s\n" "$DEX_PATH_VALUE" >> "$AGENT_DIR/.env"
  fi
  info "DEX_TRADER_MCP_PATH set in .env"

  cd "$AGENT_DIR"
fi

# ── 6. Build the project ────────────────────────────────────────────
step "Building sol-trader-agent"
npm run build
info "Build complete"

# ── 7. Summary ───────────────────────────────────────────────────────
printf "\n"
printf "%s╔══════════════════════════════════════════════════╗%s\n" "$GREEN" "$RESET"
printf "%s║          Sol Trader Agent — Ready! 🚀            ║%s\n" "$GREEN" "$RESET"
printf "%s╚══════════════════════════════════════════════════╝%s\n" "$GREEN" "$RESET"
printf "\n"
printf "  ${BOLD}Install location:${RESET}  %s\n" "$AGENT_DIR"
if [ "$SETUP_DEX" = "true" ]; then
  printf "  ${BOLD}DEX trading:${RESET}       Enabled (~/soltrader/dex-trader-mcp)\n"
else
  printf "  ${BOLD}DEX trading:${RESET}       Not installed (re-run setup to add later)\n"
fi
if [ -n "${TELEGRAM_BOT_TOKEN:-}" ]; then
  printf "  ${BOLD}Telegram bot:${RESET}      Configured\n"
else
  printf "  ${BOLD}Telegram bot:${RESET}      Not configured (use /configure in the CLI to add)\n"
fi
printf "\n"
printf "  ${BOLD}To start the agent:${RESET}\n"
printf "    cd %s && npm start\n" "$AGENT_DIR"
printf "\n"
printf "  ${BOLD}Useful commands inside the agent:${RESET}\n"
printf "    /help       — Show available commands\n"
printf "    /configure  — Reconfigure settings (.env)\n"
printf "    /quit       — Exit the agent\n"
printf "\n"
