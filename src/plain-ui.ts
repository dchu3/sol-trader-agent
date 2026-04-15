import * as readline from "node:readline";
import type { Content } from "@google/genai";
import type { Config } from "./config.js";
import type { ToolRouter, ConfirmFn } from "./agent.js";
import { runAgent } from "./agent.js";
import type { TokenCache } from "./token-cache.js";
import { extractTokenAddress } from "./token-cache.js";
import type { WhaleDb, WhaleAlert } from "./whale-db.js";
import type { WhaleTracker, WhaleSwapEvent } from "./whale-tracker.js";

// ── ANSI helpers ─────────────────────────────────────────────────────
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const BLUE = "\x1b[34m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const RED = "\x1b[31m";
const MAGENTA = "\x1b[35m";

function blue(s: string): string { return `${BLUE}${s}${RESET}`; }
function green(s: string): string { return `${GREEN}${s}${RESET}`; }
function yellow(s: string): string { return `${YELLOW}${s}${RESET}`; }
function cyan(s: string): string { return `${CYAN}${s}${RESET}`; }
function red(s: string): string { return `${RED}${s}${RESET}`; }
function dim(s: string): string { return `${DIM}${s}${RESET}`; }
function bold(s: string): string { return `${BOLD}${s}${RESET}`; }

function printSystem(text: string): void {
  console.log(`${YELLOW}${DIM}ℹ ${text}${RESET}`);
}

function printAgent(text: string): void {
  console.log(`\n${GREEN}${BOLD}Agent${RESET} ${DIM}[${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}]${RESET}`);
  console.log(`  ${text.replace(/\n/g, "\n  ")}`);
}

function printUser(text: string): void {
  console.log(`\n${BLUE}${BOLD}You${RESET} ${DIM}[${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}]${RESET}`);
  console.log(`  ${text}`);
}

function printWhaleAlert(alert: WhaleAlert): void {
  const label = alert.walletLabel || alert.walletAddress.slice(0, 8) + "...";
  const token = alert.tokenSymbol || alert.tokenAddress.slice(0, 8) + "...";
  const action = alert.action === "buy" ? `${GREEN}🟢 BUY${RESET}` : alert.action === "sell" ? `${RED}🔴 SELL${RESET}` : "⚪ ???";
  console.log(`${MAGENTA}🐋${RESET} ${action} ${bold(label)} → ${cyan(token)} (${alert.solAmount} SOL)`);
}

// ── Slash command handling ───────────────────────────────────────────
function handleCommand(
  cmd: string,
  argStr: string,
  cache: TokenCache,
  whaleDb: WhaleDb,
  whaleTracker: WhaleTracker | null,
): boolean {
  switch (cmd) {
    case "/help":
      printSystem([
        "Sol Trader Agent — Commands:",
        "  /help       Show this help",
        "  /clear      Clear conversation history",
        "  /cache      Show token cache",
        "  /cache clear [addr]  Clear cache",
        "  /watch <addr> [label]  Watch a whale wallet",
        "  /unwatch <addr>  Stop watching a wallet",
        "  /whales     List watched wallets & alerts",
        "  /purge <addr>  Remove wallet, alerts, and tracking cursor",
        "  /pause <addr>  Pause tracking for a wallet",
        "  /resume <addr>  Resume tracking for a wallet",
        "  /quit       Exit",
      ].join("\n"));
      return true;

    case "/cache": {
      const parts = argStr.trim().split(/\s+/);
      if (!argStr.trim()) {
        const entries = cache.list();
        if (entries.length === 0) {
          printSystem("Token cache is empty.");
        } else {
          const lines = entries.map((e) => {
            const ageMs = Date.now() - e.createdAt;
            const ageMin = Math.round(ageMs / 60_000);
            const ageLabel = ageMin < 1 ? "<1m" : `${ageMin}m`;
            const addr = extractTokenAddress(JSON.parse(e.argsJson) as Record<string, unknown>) ?? "—";
            const staleTag = e.stale ? " [stale]" : "";
            return `  ${e.toolName}  ${addr}  (${ageLabel} ago)${staleTag}`;
          });
          printSystem(`Cached entries (${entries.length}):\n${lines.join("\n")}`);
        }
      } else if (parts[0] === "clear") {
        const address = parts[1];
        const removed = cache.clear(address);
        printSystem(address
          ? `Cleared ${removed} cache entries for ${address}.`
          : `Cleared ${removed} cache entries.`);
      }
      return true;
    }

    case "/watch": {
      const parts = argStr.trim().split(/\s+/);
      const addr = parts[0];
      if (!addr || addr.length < 32) {
        printSystem("Usage: /watch <wallet_address> [label]\nAddress must be at least 32 characters.");
        return true;
      }
      const label = parts.slice(1).join(" ");
      const added = whaleDb.addWallet(addr, label);
      printSystem(added
        ? `🐋 Now watching ${label ? `"${label}" (${addr})` : addr}`
        : `Already watching ${addr}`);
      return true;
    }

    case "/unwatch": {
      const addr = argStr.trim();
      if (!addr) { printSystem("Usage: /unwatch <address>"); return true; }
      const removed = whaleDb.removeWallet(addr);
      printSystem(removed ? `Stopped watching ${addr}` : `${addr} was not watched`);
      return true;
    }

    case "/whales": {
      const wallets = whaleDb.listWallets();
      const alerts = whaleDb.recentAlerts(10);
      const walletLines = wallets.length === 0
        ? ["  No wallets being watched."]
        : wallets.map((w) => {
          const l = w.label ? ` (${w.label})` : "";
          const status = w.paused ? " [PAUSED]" : "";
          return `  ${w.address}${l}${status}`;
        });
      const alertLines = alerts.length === 0
        ? ["  No alerts yet."]
        : alerts.map((a) => {
          const label = a.walletLabel || a.walletAddress.slice(0, 8) + "...";
          const token = a.tokenSymbol || a.tokenAddress.slice(0, 8) + "...";
          const action = a.action === "buy" ? "🟢 BUY" : a.action === "sell" ? "🔴 SELL" : "⚪ ???";
          return `  ${action} ${label} → ${token} (${a.solAmount} SOL)`;
        });
      printSystem(`🐋 Watched Wallets (${wallets.length}):\n${walletLines.join("\n")}\n\nRecent Alerts (${alerts.length}):\n${alertLines.join("\n")}`);
      return true;
    }

    case "/purge": {
      const addr = argStr.trim();
      if (!addr) { printSystem("Usage: /purge <address>"); return true; }
      const removed = whaleDb.removeWallet(addr);
      printSystem(removed
        ? `🗑️ Purged wallet ${addr} — removed wallet, alerts, and tracking cursor.`
        : `Wallet ${addr} was not found in the watch list.`);
      return true;
    }

    case "/pause": {
      const addr = argStr.trim();
      if (!addr) { printSystem("Usage: /pause <address>"); return true; }
      const paused = whaleDb.pauseWallet(addr);
      printSystem(paused ? `⏸️ Paused tracking for ${addr}` : `${addr} is not watched or already paused.`);
      return true;
    }

    case "/resume": {
      const addr = argStr.trim();
      if (!addr) { printSystem("Usage: /resume <address>"); return true; }
      const resumed = whaleDb.resumeWallet(addr);
      if (resumed && whaleTracker) whaleTracker.resetAlertCount(addr);
      printSystem(resumed ? `▶️ Resumed tracking for ${addr}` : `${addr} is not watched or not paused.`);
      return true;
    }

    default:
      return false;
  }
}

// ── Main plain-mode UI ──────────────────────────────────────────────
export interface PlainUiOptions {
  config: Config;
  router: ToolRouter;
  cache: TokenCache;
  whaleDb: WhaleDb;
  whaleTracker: WhaleTracker | null;
  serverCount: number;
  verbose: boolean;
  onQuit: () => Promise<void>;
}

export async function runPlainUi(opts: PlainUiOptions): Promise<void> {
  const { config, router, cache, whaleDb, whaleTracker, serverCount, onQuit } = opts;

  const shortWallet = config.walletAddress.length > 12
    ? `${config.walletAddress.slice(0, 4)}...${config.walletAddress.slice(-4)}`
    : config.walletAddress;

  console.log(
    `${CYAN}${BOLD}🪐 Sol Trader Agent${RESET} ${DIM}| 💳 ${shortWallet} | 🤖 ${config.geminiModel} | ⚡ ${serverCount} MCP${serverCount !== 1 ? "s" : ""}${RESET}`,
  );
  console.log(dim("Plain mode — output goes to stdout for tmux/terminal scrollback."));
  console.log(dim("Type /help for commands, /quit to exit.\n"));

  const history: Content[] = [];

  // Subscribe to whale alerts
  if (whaleTracker) {
    whaleTracker.on("alert", (event: WhaleSwapEvent) => {
      printWhaleAlert({ ...event.alert, alertedAt: Date.now() });
    });

    whaleTracker.on("rate-limited", ({ label, address, count }: { label: string; address: string; count: number }) => {
      printSystem(`⚠️ Wallet "${label}" (${address}) is generating too many alerts (${count} in 5min) — auto-pausing.`);
    });

    whaleTracker.on("wallet-paused", ({ label, address }: { label: string; address: string }) => {
      printSystem(`⏸️ Wallet "${label}" (${address}) has been paused. Use /resume <addr> to re-enable.`);
    });
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `${BLUE}${BOLD}> ${RESET}`,
  });

  const promptAndRead = (): Promise<string | null> =>
    new Promise((resolve) => {
      rl.prompt();
      rl.once("line", (line: string) => resolve(line));
      rl.once("close", () => resolve(null));
    });

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const line = await promptAndRead();
    if (line === null) {
      // EOF (Ctrl+D) — graceful shutdown
      printSystem("EOF received, shutting down...");
      rl.close();
      await onQuit();
      return;
    }
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Slash commands
    if (trimmed.startsWith("/")) {
      const spaceIdx = trimmed.indexOf(" ");
      const cmd = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
      const argStr = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1);

      if (cmd === "/quit") {
        printSystem("Shutting down...");
        rl.close();
        await onQuit();
        return;
      }

      if (cmd === "/clear") {
        history.length = 0;
        printSystem("Conversation history cleared.");
        continue;
      }

      const handled = handleCommand(cmd, argStr, cache, whaleDb, whaleTracker);
      if (handled) continue;

      printSystem(`Unknown command: ${cmd}. Try /help`);
      continue;
    }

    // Normal message → agent
    printUser(trimmed);
    process.stdout.write(dim("Thinking...\r"));

    const confirmFn: ConfirmFn = async (message: string): Promise<boolean> => {
      return new Promise((resolve) => {
        rl.question(`${YELLOW}⚠ ${message}${RESET}\n${DIM}  Approve? (y/n): ${RESET}`, (answer: string) => {
          resolve(answer.trim().toLowerCase().startsWith("y"));
        });
      });
    };

    try {
      const answer = await runAgent(
        config.geminiApiKey,
        config.geminiModel,
        router,
        trimmed,
        history,
        config.walletAddress,
        confirmFn,
        "cli",
        cache,
      );
      // Clear "Thinking..." line
      process.stdout.write("\x1b[2K\r");
      printAgent(answer);
    } catch (err) {
      process.stdout.write("\x1b[2K\r");
      printSystem(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
