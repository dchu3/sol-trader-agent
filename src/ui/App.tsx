import React, { useState, useCallback, useEffect, useRef } from "react";
import { Box, useApp, useStdout } from "ink";
import type { Content } from "@google/genai";
import type { ToolRouter, ConfirmFn, Channel } from "../agent.js";
import { runAgent } from "../agent.js";
import type { Config } from "../config.js";
import { reloadConfig } from "../config.js";
import { setVerbose } from "../logger.js";
import type { TokenCache } from "../token-cache.js";
import { extractTokenAddress } from "../token-cache.js";
import type { WhaleDb } from "../whale-db.js";
import type { WhaleTracker, WhaleSwapEvent } from "../whale-tracker.js";
import type { WhaleAlert } from "../whale-db.js";
import type { ExchangeDb, ExchangeTransfer } from "../exchange-db.js";
import type { ExchangeTracker, ExchangeTransferEvent } from "../exchange-tracker.js";

import { Header } from "./Header.js";
import { MessageLog } from "./MessageLog.js";
import type { Message } from "./MessageLog.js";
import { InputPrompt } from "./InputPrompt.js";
import type { CommandDef } from "./InputPrompt.js";
import { ConfirmDialog } from "./ConfirmDialog.js";
import { Spinner } from "./Spinner.js";
import { AlertPanel } from "./AlertPanel.js";
import { ExchangeAlertPanel } from "./ExchangeAlertPanel.js";

export interface AppProps {
  config: Config;
  router: ToolRouter;
  cache: TokenCache;
  whaleDb: WhaleDb;
  whaleTracker: WhaleTracker | null;
  exchangeDb: ExchangeDb;
  exchangeTracker: ExchangeTracker | null;
  analyzeExchangeTransfer: (event: ExchangeTransferEvent) => Promise<string>;
  serverCount: number;
  verbose: boolean;
  onQuit: () => Promise<void>;
}

const SLASH_COMMANDS: CommandDef[] = [
  { name: "/help", description: "Show all commands" },
  { name: "/clear", description: "Clear conversation" },
  { name: "/cache", description: "Show token cache" },
  { name: "/watch", description: "Watch a whale wallet" },
  { name: "/unwatch", description: "Stop watching a wallet" },
  { name: "/whales", description: "List wallets & alerts" },
  { name: "/purge", description: "Remove wallet + all data" },
  { name: "/pause", description: "Pause whale wallet tracking" },
  { name: "/resume", description: "Resume whale wallet tracking" },
  { name: "/exchanges", description: "List exchange wallets & transfers" },
  { name: "/add_exchange", description: "Add an exchange wallet" },
  { name: "/remove_exchange", description: "Remove an exchange wallet" },
  { name: "/pause_exchange", description: "Pause an exchange wallet" },
  { name: "/resume_exchange", description: "Resume a paused exchange wallet" },
  { name: "/configure", description: "View/update settings" },
  { name: "/quit", description: "Exit the agent" },
];

export function App({
  config,
  router,
  cache,
  whaleDb,
  whaleTracker,
  exchangeDb,
  exchangeTracker,
  analyzeExchangeTransfer,
  serverCount,
  verbose,
  onQuit,
}: AppProps): React.JSX.Element {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [termHeight, setTermHeight] = useState(stdout?.rows ?? 24);
  const [termColumns, setTermColumns] = useState(stdout?.columns ?? 80);
  const [messages, setMessages] = useState<Message[]>([]);
  const [processing, setProcessing] = useState(false);
  const [pendingConfirm, setPendingConfirm] = useState<{
    message: string;
    resolve: (approved: boolean) => void;
  } | null>(null);
  const [whaleAlerts, setWhaleAlerts] = useState<WhaleAlert[]>(() =>
    whaleDb.recentAlerts(10),
  );
  const [exchangeTransfers, setExchangeTransfers] = useState<ExchangeTransfer[]>(() =>
    exchangeDb.recentTransfers(8),
  );

  const historyRef = useRef<Content[]>([]);
  const configRef = useRef(config);

  const alertBufferRef = useRef<WhaleSwapEvent[]>([]);
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Track terminal resize
  useEffect(() => {
    if (!stdout) return;
    const onResize = () => { setTermHeight(stdout.rows); setTermColumns(stdout.columns); };
    stdout.on("resize", onResize);
    return () => { stdout.off("resize", onResize); };
  }, [stdout]);

  // Subscribe to whale alerts (batched), rate-limited, and wallet-paused events
  useEffect(() => {
    if (!whaleTracker) return;

    const flushAlertBuffer = () => {
      const buffered = alertBufferRef.current;
      if (buffered.length === 0) return;
      alertBufferRef.current = [];
      flushTimerRef.current = null;

      const fullAlerts: WhaleAlert[] = buffered.map((e) => ({
        ...e.alert,
        alertedAt: Date.now(),
      }));
      setWhaleAlerts((prev) => [...fullAlerts, ...prev].slice(0, 50));

      if (fullAlerts.length === 1) {
        const a = fullAlerts[0];
        const label = a.walletLabel || a.walletAddress.slice(0, 8) + "...";
        const token = a.tokenSymbol || a.tokenAddress.slice(0, 8) + "...";
        const action = a.action === "buy" ? "🟢 BUY" : a.action === "sell" ? "🔴 SELL" : "⚪ ???";
        setMessages((prev) => [
          ...prev,
          {
            role: "system" as const,
            text: `🐋 Whale Alert: ${action} ${label} → ${token} (${a.solAmount} SOL)`,
            timestamp: Date.now(),
          },
        ]);
      } else {
        const buys = fullAlerts.filter((a) => a.action === "buy").length;
        const sells = fullAlerts.filter((a) => a.action === "sell").length;
        const label = fullAlerts[0].walletLabel || fullAlerts[0].walletAddress.slice(0, 8) + "...";
        setMessages((prev) => [
          ...prev,
          {
            role: "system" as const,
            text: `🐋 ${fullAlerts.length} whale alerts: ${buys} buys, ${sells} sell${sells !== 1 ? "s" : ""} from ${label} (see /whales for details)`,
            timestamp: Date.now(),
          },
        ]);
      }
    };

    const handler = (event: WhaleSwapEvent) => {
      alertBufferRef.current.push(event);
      if (flushTimerRef.current !== null) {
        clearTimeout(flushTimerRef.current);
      }
      flushTimerRef.current = setTimeout(flushAlertBuffer, 2000);
    };

    const rateLimitedHandler = ({ label, address, count }: { label: string; address: string; count: number }) => {
      setMessages((prev) => [
        ...prev,
        {
          role: "system" as const,
          text: `⚠️ Wallet "${label}" (${address}) is generating too many alerts (${count} in 5min) — auto-pausing.`,
          timestamp: Date.now(),
        },
      ]);
    };

    const walletPausedHandler = ({ label, address }: { label: string; address: string }) => {
      setMessages((prev) => [
        ...prev,
        {
          role: "system" as const,
          text: `⏸️ Wallet "${label}" (${address}) has been paused. Use /resume <addr> to re-enable.`,
          timestamp: Date.now(),
        },
      ]);
    };

    whaleTracker.on("alert", handler);
    whaleTracker.on("rate-limited", rateLimitedHandler);
    whaleTracker.on("wallet-paused", walletPausedHandler);
    return () => {
      whaleTracker.off("alert", handler);
      whaleTracker.off("rate-limited", rateLimitedHandler);
      whaleTracker.off("wallet-paused", walletPausedHandler);
      if (flushTimerRef.current !== null) {
        clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
      }
    };
  }, [whaleTracker]);

  // Subscribe to exchange transfer events
  useEffect(() => {
    if (!exchangeTracker) return;

    const handler = (event: ExchangeTransferEvent) => {
      const t = event.transfer;
      const typeIcon =
        t.transferType === "cold_to_hot"
          ? "🔴"
          : t.transferType === "hot_to_cold"
          ? "🟢"
          : "🔄";
      const typeLabel = t.transferType.replace(/_/g, " ").toUpperCase();

      // Add to the exchange alert panel
      setExchangeTransfers((prev) =>
        [{ ...t, alertedAt: Date.now() }, ...prev].slice(0, 50),
      );

      // Show immediate alert in message log
      setMessages((prev) => [
        ...prev,
        {
          role: "system" as const,
          text: `🏦 ${typeIcon} Exchange Alert: ${t.exchangeName} — ${typeLabel} — ${t.solAmount.toFixed(0)} SOL\nRunning Gemini analysis...`,
          timestamp: Date.now(),
        },
      ]);

      // Run proactive Gemini analysis and push result to message log
      analyzeExchangeTransfer(event)
        .then((analysis) => {
          setMessages((prev) => [
            ...prev,
            {
              role: "agent" as const,
              text: `🤖 Exchange Analysis (${t.exchangeName} ${typeLabel}):\n\n${analysis}`,
              timestamp: Date.now(),
            },
          ]);
        })
        .catch((err) => {
          setMessages((prev) => [
            ...prev,
            {
              role: "system" as const,
              text: `⚠️ Exchange analysis failed: ${err instanceof Error ? err.message : String(err)}`,
              timestamp: Date.now(),
            },
          ]);
        });
    };

    exchangeTracker.on("transfer", handler);
    return () => {
      exchangeTracker.off("transfer", handler);
    };
  }, [exchangeTracker, analyzeExchangeTransfer]);

  const addMessage = useCallback((role: Message["role"], text: string) => {
    setMessages((prev) => [...prev, { role, text, timestamp: Date.now() }]);
  }, []);

  const handleCommand = useCallback(
    async (cmd: string, argStr: string): Promise<boolean> => {
      switch (cmd) {
        case "/quit":
          addMessage("system", "Shutting down...");
          await onQuit();
          exit();
          return true;

        case "/help":
          addMessage("system", [
            "Sol Trader Agent — Commands:",
            "  /help       Show this help",
            "  /clear      Clear conversation",
            "  /cache      Show token cache",
            "  /cache clear [addr]  Clear cache",
            "  /watch <addr> [label]  Watch a whale wallet",
            "  /unwatch <addr>  Stop watching a wallet",
            "  /whales     List watched wallets & alerts",
            "  /purge <addr>  Remove wallet, alerts, and tracking cursor",
            "  /pause <addr>  Pause whale wallet tracking",
            "  /resume <addr>  Resume whale wallet tracking",
            "",
            "Exchange Tracker:",
            "  /exchanges  List exchange wallets & recent transfers",
            "  /add_exchange <addr> <hot|cold> <name> [label]  Add an exchange wallet",
            "  /remove_exchange <addr>  Remove an exchange wallet",
            "  /pause_exchange <addr>  Pause tracking for an exchange wallet",
            "  /resume_exchange <addr>  Resume a paused exchange wallet",
            "",
            "  /configure  View/update settings",
            "  /quit       Exit",
            "",
            "Scroll keybindings:",
            "  Shift+↑/↓       Scroll up/down (5 lines)",
            "  Page Up/Down    Scroll by page",
            "  Ctrl+↑/↓        Jump to top/bottom",
            "",
            "Tip: Use --plain flag for tmux-friendly output with native scrollback.",
          ].join("\n"));
          return true;

        case "/clear":
          historyRef.current.length = 0;
          setMessages([]);
          addMessage("system", "Conversation history cleared.");
          return true;

        case "/cache": {
          const parts = argStr.trim().split(/\s+/);
          if (!argStr.trim()) {
            const entries = cache.list();
            if (entries.length === 0) {
              addMessage("system", "Token cache is empty.");
            } else {
              const lines = entries.map((e) => {
                const ageMs = Date.now() - e.createdAt;
                const ageMin = Math.round(ageMs / 60_000);
                const ageLabel = ageMin < 1 ? "<1m" : `${ageMin}m`;
                const addr = extractTokenAddress(JSON.parse(e.argsJson) as Record<string, unknown>) ?? "—";
                const staleTag = e.stale ? " [stale]" : "";
                return `  ${e.toolName}  ${addr}  (${ageLabel} ago)${staleTag}`;
              });
              addMessage("system", `Cached entries (${entries.length}):\n${lines.join("\n")}`);
            }
          } else if (parts[0] === "clear") {
            const address = parts[1];
            const removed = cache.clear(address);
            addMessage("system", address
              ? `Cleared ${removed} cache entries for ${address}.`
              : `Cleared ${removed} cache entries.`);
          }
          return true;
        }

        case "/watch": {
          const parts = argStr.trim().split(/\s+/);
          const addr = parts[0];
          if (!addr || addr.length < 32) {
            addMessage("system", "Usage: /watch <wallet_address> [label]\nAddress must be at least 32 characters.");
            return true;
          }
          const label = parts.slice(1).join(" ");
          const added = whaleDb.addWallet(addr, label);
          if (added) {
            addMessage("system", `🐋 Now watching ${label ? `"${label}" (${addr})` : addr}`);
          } else {
            addMessage("system", `Already watching ${addr}`);
          }
          return true;
        }

        case "/unwatch": {
          const addr = argStr.trim();
          if (!addr) {
            addMessage("system", "Usage: /unwatch <address>");
            return true;
          }
          const removed = whaleDb.removeWallet(addr);
          addMessage("system", removed ? `Stopped watching ${addr}` : `${addr} was not watched`);
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
          addMessage("system", `🐋 Watched Wallets (${wallets.length}):\n${walletLines.join("\n")}\n\nRecent Alerts (${alerts.length}):\n${alertLines.join("\n")}`);
          return true;
        }

        case "/purge": {
          const addr = argStr.trim();
          if (!addr) {
            addMessage("system", "Usage: /purge <address>");
            return true;
          }
          const removed = whaleDb.removeWallet(addr);
          if (removed) {
            setWhaleAlerts((prev) => prev.filter((a) => a.walletAddress !== addr));
            addMessage("system", `🗑️ Purged wallet ${addr} — removed wallet, alerts, and tracking cursor.`);
          } else {
            addMessage("system", `Wallet ${addr} was not found in the watch list.`);
          }
          return true;
        }

        case "/pause": {
          const addr = argStr.trim();
          if (!addr) {
            addMessage("system", "Usage: /pause <address>");
            return true;
          }
          const paused = whaleDb.pauseWallet(addr);
          addMessage("system", paused ? `⏸️ Paused tracking for ${addr}` : `${addr} is not watched or already paused.`);
          return true;
        }

        case "/resume": {
          const addr = argStr.trim();
          if (!addr) {
            addMessage("system", "Usage: /resume <address>");
            return true;
          }
          const resumed = whaleDb.resumeWallet(addr);
          if (resumed && whaleTracker) {
            whaleTracker.resetAlertCount(addr);
          }
          addMessage("system", resumed ? `▶️ Resumed tracking for ${addr}` : `${addr} is not watched or not paused.`);
          return true;
        }

        case "/configure":
          addMessage("system", "Runtime configuration is not yet supported in the ink UI. Edit your .env file and restart the agent to change settings.");
          return true;

        case "/exchanges": {
          const wallets = exchangeDb.listWallets();
          const transfers = exchangeDb.recentTransfers(10);

          const byExchange = new Map<string, typeof wallets>();
          for (const w of wallets) {
            const group = byExchange.get(w.exchangeName) ?? [];
            group.push(w);
            byExchange.set(w.exchangeName, group);
          }

          const walletLines: string[] = wallets.length === 0
            ? ["  No exchange wallets tracked."]
            : [];
          for (const [exchange, group] of [...byExchange.entries()].sort()) {
            walletLines.push(`  ${exchange}:`);
            for (const w of group) {
              const icon = w.walletType === "hot" ? "🔥" : "🧊";
              const status = w.paused ? " [PAUSED]" : "";
              walletLines.push(`    ${icon} ${w.walletType}${status}: ${w.address.slice(0, 12)}...`);
            }
          }

          const transferLines = transfers.length === 0
            ? ["  No large transfers detected yet (threshold: ≥1000 SOL)."]
            : transfers.map((t) => {
              const icon = t.transferType === "cold_to_hot" ? "🔴" : t.transferType === "hot_to_cold" ? "🟢" : "🔄";
              return `  ${icon} ${t.exchangeName}: ${t.solAmount.toFixed(0)} SOL (${t.transferType.replace(/_/g, "→")})`;
            });

          addMessage("system", `🏦 Exchange Wallets (${wallets.length}):\n${walletLines.join("\n")}\n\nRecent Transfers (${transfers.length}):\n${transferLines.join("\n")}`);
          return true;
        }

        case "/add_exchange": {
          const parts = argStr.trim().split(/\s+/);
          if (parts.length < 3) {
            addMessage("system", "Usage: /add_exchange <address> <hot|cold> <exchange_name> [label]");
            return true;
          }
          const [addr, walletTypeRaw, exchangeName, ...labelParts] = parts;
          if (!addr || addr.length < 32) {
            addMessage("system", "Invalid wallet address.\nUsage: /add_exchange <address> <hot|cold> <exchange_name> [label]");
            return true;
          }
          if (walletTypeRaw !== "hot" && walletTypeRaw !== "cold") {
            addMessage("system", "wallet_type must be 'hot' or 'cold'.\nUsage: /add_exchange <address> <hot|cold> <exchange_name> [label]");
            return true;
          }
          const label = labelParts.length > 0 ? labelParts.join(" ") : undefined;
          const added = exchangeDb.addWallet(addr, exchangeName, walletTypeRaw, label ?? "");
          addMessage("system", added
            ? `✅ Added ${exchangeName} ${walletTypeRaw} wallet: ${addr}`
            : `Wallet ${addr} is already being tracked.`);
          return true;
        }

        case "/remove_exchange": {
          const addr = argStr.trim();
          if (!addr) { addMessage("system", "Usage: /remove_exchange <address>"); return true; }
          const removed = exchangeDb.removeWallet(addr);
          addMessage("system", removed ? `🗑️ Removed exchange wallet: ${addr}` : `Wallet not found: ${addr}`);
          return true;
        }

        case "/pause_exchange": {
          const addr = argStr.trim();
          if (!addr) { addMessage("system", "Usage: /pause_exchange <address>"); return true; }
          const paused = exchangeDb.pauseWallet(addr);
          addMessage("system", paused ? `⏸️ Paused exchange tracking for ${addr}` : `${addr} is not tracked or already paused.`);
          return true;
        }

        case "/resume_exchange": {
          const addr = argStr.trim();
          if (!addr) { addMessage("system", "Usage: /resume_exchange <address>"); return true; }
          const resumed = exchangeDb.resumeWallet(addr);
          if (resumed && exchangeTracker) exchangeTracker.resetAlertCount(addr);
          addMessage("system", resumed ? `▶️ Resumed exchange tracking for ${addr}` : `${addr} is not tracked or not paused.`);
          return true;
        }

        default:
          return false;
      }
    },
    [addMessage, cache, whaleDb, exchangeDb, exchangeTracker, onQuit, exit],
  );

  const handleSubmit = useCallback(
    async (text: string) => {
      // Handle commands
      if (text.startsWith("/")) {
        const spaceIdx = text.indexOf(" ");
        const cmd = spaceIdx === -1 ? text : text.slice(0, spaceIdx);
        const argStr = spaceIdx === -1 ? "" : text.slice(spaceIdx + 1);
        const handled = await handleCommand(cmd, argStr);
        if (handled) return;
        addMessage("system", `Unknown command: ${cmd}. Try /help`);
        return;
      }

      addMessage("user", text);
      setProcessing(true);

      try {
        const confirmFn: ConfirmFn = async (message: string): Promise<boolean> => {
          return new Promise<boolean>((resolve) => {
            setPendingConfirm({ message, resolve });
          });
        };

        const answer = await runAgent(
          configRef.current.geminiApiKey,
          configRef.current.geminiModel,
          router,
          text,
          historyRef.current,
          configRef.current.walletAddress,
          confirmFn,
          "cli",
          cache,
        );

        addMessage("agent", answer);
      } catch (err) {
        addMessage("system", `Error: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setProcessing(false);
        setPendingConfirm(null);
      }
    },
    [addMessage, handleCommand, router, cache],
  );

  const handleConfirmResolve = useCallback(
    (approved: boolean) => {
      if (pendingConfirm) {
        pendingConfirm.resolve(approved);
        setPendingConfirm(null);
        addMessage("system", approved ? "✅ Approved" : "❌ Declined");
      }
    },
    [pendingConfirm, addMessage],
  );

  return (
    <Box flexDirection="column" height={termHeight}>
      <Header
        walletAddress={config.walletAddress}
        modelName={config.geminiModel}
        serverCount={serverCount}
        whaleTrackerActive={whaleTracker?.isRunning() ?? false}
        watchedWalletCount={whaleDb.listWallets().length}
        termColumns={termColumns}
      />

      <Box flexDirection="row" flexGrow={1}>
        <Box flexDirection="column" flexGrow={1}>
          <MessageLog messages={messages} />

          {processing && !pendingConfirm && <Spinner />}

          {pendingConfirm && (
            <ConfirmDialog
              message={pendingConfirm.message}
              onResolve={handleConfirmResolve}
            />
          )}

          <Box borderStyle="single" borderColor="gray" borderTop borderBottom borderLeft={false} borderRight={false} flexShrink={0} marginBottom={1}>
            <InputPrompt
              onSubmit={handleSubmit}
              disabled={processing}
              commands={SLASH_COMMANDS}
            />
          </Box>
        </Box>

        {whaleAlerts.length > 0 && (
          <Box width={50} flexShrink={0}>
            <AlertPanel alerts={whaleAlerts} />
          </Box>
        )}

        {exchangeTransfers.length > 0 && (
          <Box width={50} flexShrink={0}>
            <ExchangeAlertPanel transfers={exchangeTransfers} />
          </Box>
        )}
      </Box>
    </Box>
  );
}
