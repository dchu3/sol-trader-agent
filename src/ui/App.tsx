import React, { useState, useCallback, useEffect, useRef } from "react";
import { Box, useApp } from "ink";
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

import { Header } from "./Header.js";
import { MessageLog } from "./MessageLog.js";
import type { Message } from "./MessageLog.js";
import { InputPrompt } from "./InputPrompt.js";
import { ConfirmDialog } from "./ConfirmDialog.js";
import { Spinner } from "./Spinner.js";
import { AlertPanel } from "./AlertPanel.js";

export interface AppProps {
  config: Config;
  router: ToolRouter;
  cache: TokenCache;
  whaleDb: WhaleDb;
  whaleTracker: WhaleTracker | null;
  serverCount: number;
  verbose: boolean;
  onQuit: () => Promise<void>;
}

export function App({
  config,
  router,
  cache,
  whaleDb,
  whaleTracker,
  serverCount,
  verbose,
  onQuit,
}: AppProps): React.JSX.Element {
  const { exit } = useApp();
  const [messages, setMessages] = useState<Message[]>([]);
  const [processing, setProcessing] = useState(false);
  const [pendingConfirm, setPendingConfirm] = useState<{
    message: string;
    resolve: (approved: boolean) => void;
  } | null>(null);
  const [whaleAlerts, setWhaleAlerts] = useState<WhaleAlert[]>(() =>
    whaleDb.recentAlerts(10),
  );

  const historyRef = useRef<Content[]>([]);
  const configRef = useRef(config);

  const alertBufferRef = useRef<WhaleSwapEvent[]>([]);
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
            "  /pause <addr>  Pause tracking for a wallet",
            "  /resume <addr>  Resume tracking for a wallet",
            "  /configure  View/update settings",
            "  /quit       Exit",
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

        default:
          return false;
      }
    },
    [addMessage, cache, whaleDb, onQuit, exit],
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
    <Box flexDirection="column" minHeight={20}>
      <Header
        walletAddress={config.walletAddress}
        modelName={config.geminiModel}
        serverCount={serverCount}
        whaleTrackerActive={whaleTracker?.isRunning() ?? false}
        watchedWalletCount={whaleDb.listWallets().length}
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

          <Box borderStyle="single" borderColor="gray" borderTop borderBottom={false} borderLeft={false} borderRight={false}>
            <InputPrompt
              onSubmit={handleSubmit}
              disabled={processing}
            />
          </Box>
        </Box>

        {whaleAlerts.length > 0 && (
          <Box width={50} flexShrink={0}>
            <AlertPanel alerts={whaleAlerts} />
          </Box>
        )}
      </Box>
    </Box>
  );
}
