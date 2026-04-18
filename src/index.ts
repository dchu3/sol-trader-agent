import React from "react";
import { render } from "ink";
import { loadConfig } from "./config.js";
import type { Config } from "./config.js";
import { createRemoteMcpClient } from "./mcp-client.js";
import type { McpClient } from "./mcp-client.js";
import { createLocalMcpClient } from "./local-mcp-client.js";
import type { LocalMcpClient } from "./local-mcp-client.js";
import { createToolRouter, runAgent } from "./agent.js";
import type { ToolRouter } from "./agent.js";
import { setVerbose } from "./logger.js";
import { startTelegramBot } from "./telegram.js";
import { TokenCache } from "./token-cache.js";
import { WhaleDb } from "./whale-db.js";
import { WhaleTracker } from "./whale-tracker.js";
import { createWhaleTools } from "./agent-whale-tools.js";
import { ExchangeDb } from "./exchange-db.js";
import { ExchangeTracker } from "./exchange-tracker.js";
import type { ExchangeTransferEvent } from "./exchange-tracker.js";
import { createExchangeTools } from "./agent-exchange-tools.js";
import { seedExchangeWallets } from "./exchange-seeder.js";
import { App } from "./ui/App.js";
import { runPlainUi } from "./plain-ui.js";

async function main(): Promise<void> {
  const verbose =
    process.argv.includes("--verbose") || process.argv.includes("-v");
  const plain = process.argv.includes("--plain");
  const headless =
    process.argv.includes("--headless") || !process.stdin.isTTY || !process.stdout.isTTY;
  const config: Config = loadConfig();
  setVerbose(verbose || config.verbose);

  const cache = new TokenCache();
  const whaleDb = new WhaleDb();
  const exchangeDb = new ExchangeDb();

  // Seed known exchange wallets on first run
  const seeded = seedExchangeWallets(exchangeDb);
  if (seeded > 0) {
    console.log(`Exchange tracker: seeded ${seeded} known exchange wallets.`);
  }

  console.log("Connecting to remote MCP server...");
  const mcpClient: McpClient = await createRemoteMcpClient(
    config.remoteMcpUrl,
    config.solanaPrivateKey,
    config.solanaRpcUrl,
  );

  const remoteToolNames = mcpClient.tools.map((t) => t.name).join(", ");
  console.log(`Remote MCP connected. Tools: ${remoteToolNames}`);

  let localClient: LocalMcpClient | undefined;
  if (config.dexTraderMcpPath) {
    console.log("Connecting to local dex-trader-mcp server...");
    const localEnv: Record<string, string> = {};
    if (config.solanaPrivateKey) localEnv.SOLANA_PRIVATE_KEY = config.solanaPrivateKey;
    if (config.solanaRpcUrl) localEnv.SOLANA_RPC_URL = config.solanaRpcUrl;
    if (config.jupiterApiBase) localEnv.JUPITER_API_BASE = config.jupiterApiBase;
    if (config.jupiterApiKey) localEnv.JUPITER_API_KEY = config.jupiterApiKey;

    try {
      localClient = await createLocalMcpClient(config.dexTraderMcpPath, localEnv);
      const localToolNames = localClient.tools.map((t) => t.name).join(", ");
      console.log(`Local dex-trader-mcp connected. Tools: ${localToolNames}`);
    } catch (err) {
      console.error(
        "Warning: failed to connect to dex-trader-mcp:",
        err instanceof Error ? err.message : String(err),
      );
      console.error("Trading tools will not be available.");
    }
  }

  let screenerClient: LocalMcpClient | undefined;
  if (config.dexScreenerMcpPath) {
    console.log("Connecting to local dex-screener-mcp server...");
    try {
      screenerClient = await createLocalMcpClient(config.dexScreenerMcpPath, {});
      const screenerToolNames = screenerClient.tools.map((t) => t.name).join(", ");
      console.log(`Local dex-screener-mcp connected. Tools: ${screenerToolNames}`);
    } catch (err) {
      console.error(
        "Warning: failed to connect to dex-screener-mcp:",
        err instanceof Error ? err.message : String(err),
      );
      console.error("DexScreener tools will not be available.");
    }
  }

  let rugcheckClient: LocalMcpClient | undefined;
  if (config.dexRugcheckMcpPath) {
    console.log("Connecting to local dex-rugcheck-mcp server...");
    try {
      rugcheckClient = await createLocalMcpClient(config.dexRugcheckMcpPath, {});
      const rugcheckToolNames = rugcheckClient.tools.map((t) => t.name).join(", ");
      console.log(`Local dex-rugcheck-mcp connected. Tools: ${rugcheckToolNames}`);
    } catch (err) {
      console.error(
        "Warning: failed to connect to dex-rugcheck-mcp:",
        err instanceof Error ? err.message : String(err),
      );
      console.error("RugCheck tools will not be available.");
    }
  }

  let rpcClient: LocalMcpClient | undefined;
  if (config.solanaRpcMcpPath) {
    console.log("Connecting to local solana-rpc-mcp server...");
    const rpcEnv: Record<string, string> = {};
    if (config.solanaRpcUrl) rpcEnv.SOLANA_RPC_URL = config.solanaRpcUrl;
    try {
      rpcClient = await createLocalMcpClient(config.solanaRpcMcpPath, rpcEnv);
      const rpcToolNames = rpcClient.tools.map((t) => t.name).join(", ");
      console.log(`Local solana-rpc-mcp connected. Tools: ${rpcToolNames}`);
    } catch (err) {
      console.error(
        "Warning: failed to connect to solana-rpc-mcp:",
        err instanceof Error ? err.message : String(err),
      );
      console.error("Solana RPC tools will not be available.");
    }
  }

  const localClients: LocalMcpClient[] = [];
  if (localClient) localClients.push(localClient);
  if (screenerClient) localClients.push(screenerClient);
  if (rugcheckClient) localClients.push(rugcheckClient);
  if (rpcClient) localClients.push(rpcClient);

  let router: ToolRouter;
  try {
    router = createToolRouter(mcpClient, localClients);
  } catch (err) {
    for (const client of localClients) {
      await client.close().catch(() => {});
    }
    throw err;
  }

  // Register whale pseudo-tools into the router
  const whaleTools = createWhaleTools(whaleDb);
  const exchangeTools = createExchangeTools(
    exchangeDb,
    (address) => exchangeTracker?.resetAlertCount(address),
  );
  const allToolNames = new Set(router.tools.map((t) => t.name));
  const whaleToolNames = new Set(whaleTools.tools.map((t) => t.name));
  const exchangeToolNames = new Set(exchangeTools.tools.map((t) => t.name));

  const whaleToolRouter: ToolRouter = {
    tools: [...router.tools, ...whaleTools.tools, ...exchangeTools.tools],

    async callTool(name, args, options) {
      if (!allToolNames.has(name)) {
        if (whaleToolNames.has(name)) {
          return whaleTools.callTool(name, args);
        }
        if (exchangeToolNames.has(name)) {
          return exchangeTools.callTool(name, args);
        }
      }
      return router.callTool(name, args, options);
    },

    getLastPaymentInfo() {
      return router.getLastPaymentInfo();
    },
  };

  const serverCount = 1 + localClients.length; // remote + locals
  console.log(`All available tools: ${whaleToolRouter.tools.map((t) => t.name).join(", ")}`);
  console.log(`Using model: ${config.geminiModel}`);

  // ── Start whale tracker ────────────────────────────────────────────
  let whaleTracker: WhaleTracker | null = null;
  const toolNameSet = new Set(whaleToolRouter.tools.map((t) => t.name));
  if (toolNameSet.has("getSignaturesForAddress")) {
    whaleTracker = new WhaleTracker(whaleDb, {
      callTool: (name, args) => whaleToolRouter.callTool(name, args, { allowPayment: false }),
      hasTool: (name) => toolNameSet.has(name),
    });
    whaleTracker.start();
    console.log("Whale tracker started.");
  }

  // ── Start exchange tracker ─────────────────────────────────────────
  let exchangeTracker: ExchangeTracker | null = null;
  if (toolNameSet.has("getSignaturesForAddress")) {
    exchangeTracker = new ExchangeTracker(exchangeDb, {
      callTool: (name, args) => whaleToolRouter.callTool(name, args, { allowPayment: false }),
      hasTool: (name) => toolNameSet.has(name),
    });
    exchangeTracker.start();
    console.log("Exchange tracker started.");
  }

  /**
   * Proactive Gemini analysis callback — fired when a large exchange transfer is detected.
   * Runs a fresh agent call (no shared user history) and returns the analysis text.
   */
  async function analyzeExchangeTransfer(event: ExchangeTransferEvent): Promise<string> {
    const t = event.transfer;
    const recentHistory = exchangeDb.recentTransfersByExchange(t.exchangeName, 5);
    const historyLines = recentHistory
      .filter((r) => r.signature !== t.signature)
      .map((r) => {
        const ts = new Date(r.timestamp).toLocaleString();
        return `- ${r.transferType} ${r.solAmount.toFixed(0)} SOL at ${ts}`;
      });

    const prompt =
      `EXCHANGE HOT WALLET ALERT: ${t.exchangeName} has moved ${t.solAmount.toFixed(0)} SOL ` +
      `(${t.transferType.replace(/_/g, " ")}) from wallet ${t.fromAddress} to ${t.toAddress}.\n\n` +
      (historyLines.length > 0
        ? `Recent ${t.exchangeName} transfer history:\n${historyLines.join("\n")}\n\n`
        : "") +
      `Based on this on-chain data, analyse the market implications for SOL. ` +
      `Consider: (1) Is this a sign that ${t.exchangeName} is preparing for anticipated selling pressure? ` +
      `(2) What does this pattern suggest about near-term exchange flows? ` +
      `(3) What should a SOL trader watch out for? ` +
      `Keep the analysis concise (3-5 bullet points).`;

    try {
      const analysis = await runAgent(
        config.geminiApiKey,
        config.geminiModel,
        whaleToolRouter,
        prompt,
        [], // fresh history per analysis — no contamination of user conversations
        config.walletAddress,
        async () => false, // never approve — background analysis must not execute trades
        "cli",
        cache,
      );
      return analysis;
    } catch (err) {
      return `Analysis unavailable: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  // ── Start Telegram bot (optional) ──────────────────────────────────
  let stopTelegramBot: (() => void) | undefined;
  if (config.telegramBotToken) {
    try {
      stopTelegramBot = await startTelegramBot(
        config,
        whaleToolRouter,
        cache,
        whaleDb,
        whaleTracker,
        exchangeDb,
        exchangeTracker,
        analyzeExchangeTransfer,
      );
    } catch (err) {
      console.error(
        "Warning: failed to start Telegram bot:",
        err instanceof Error ? err.message : String(err),
      );
      console.error("Telegram interface will not be available.");
    }
  }

  // ── Shutdown cleanup ───────────────────────────────────────────────
  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (whaleTracker) await whaleTracker.drain();
    if (exchangeTracker) await exchangeTracker.drain();
    if (stopTelegramBot) stopTelegramBot();
    if (rpcClient) await rpcClient.close().catch(() => {});
    if (rugcheckClient) await rugcheckClient.close().catch(() => {});
    if (screenerClient) await screenerClient.close().catch(() => {});
    if (localClient) await localClient.close().catch(() => {});
    await mcpClient.close();
    cache.close();
    whaleDb.close();
    exchangeDb.close();
  };

  const handleSignal = () => {
    (async () => {
      try {
        await shutdown();
        process.exit(0);
      } catch (err) {
        console.error(
          "Error during shutdown:",
          err instanceof Error ? err.message : String(err),
        );
        process.exit(1);
      }
    })();
  };

  process.once("SIGINT", handleSignal);
  process.once("SIGTERM", handleSignal);

  // ── Render ink UI, plain UI, or run headless ────────────────────────
  if (headless) {
    console.log("Running in headless mode (no TTY detected or --headless flag set).");
    if (!stopTelegramBot && !whaleTracker && !exchangeTracker) {
      console.warn("⚠️  No Telegram bot, whale tracker, or exchange tracker active — headless mode has nothing to do.");
      console.warn("   Set TELEGRAM_BOT_TOKEN in .env or use an interactive terminal.");
      await shutdown();
      process.exit(1);
    }
    if (stopTelegramBot) console.log("Telegram bot is active. Send messages via Telegram.");
    if (whaleTracker) console.log("Whale tracker is active. Alerts will be forwarded to Telegram.");
    if (exchangeTracker) console.log("Exchange tracker is active. Transfer alerts will be forwarded to Telegram.");
    console.log("Press Ctrl+C to stop.");
    // Block until a signal terminates the process
    await new Promise<void>(() => {});
  }

  if (plain) {
    await runPlainUi({
      config,
      router: whaleToolRouter,
      cache,
      whaleDb,
      whaleTracker,
      exchangeDb,
      exchangeTracker,
      analyzeExchangeTransfer,
      serverCount,
      verbose,
      onQuit: shutdown,
    });
    return;
  }

  const { waitUntilExit } = render(
    React.createElement(App, {
      config,
      router: whaleToolRouter,
      cache,
      whaleDb,
      whaleTracker,
      exchangeDb,
      exchangeTracker,
      analyzeExchangeTransfer,
      serverCount,
      verbose,
      onQuit: shutdown,
    }),
  );

  try {
    await waitUntilExit();
  } finally {
    await shutdown();
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
