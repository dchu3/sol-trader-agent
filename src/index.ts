import React from "react";
import { render } from "ink";
import { loadConfig } from "./config.js";
import type { Config } from "./config.js";
import { createRemoteMcpClient } from "./mcp-client.js";
import type { McpClient } from "./mcp-client.js";
import { createLocalMcpClient } from "./local-mcp-client.js";
import type { LocalMcpClient } from "./local-mcp-client.js";
import { createToolRouter } from "./agent.js";
import type { ToolRouter } from "./agent.js";
import { setVerbose } from "./logger.js";
import { startTelegramBot } from "./telegram.js";
import { TokenCache } from "./token-cache.js";
import { WhaleDb } from "./whale-db.js";
import { WhaleTracker } from "./whale-tracker.js";
import { createWhaleTools } from "./agent-whale-tools.js";
import { App } from "./ui/App.js";

async function main(): Promise<void> {
  const verbose =
    process.argv.includes("--verbose") || process.argv.includes("-v");
  const config: Config = loadConfig();
  setVerbose(verbose || config.verbose);

  const cache = new TokenCache();
  const whaleDb = new WhaleDb();

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
  const allToolNames = new Set(router.tools.map((t) => t.name));
  const whaleToolRouter: ToolRouter = {
    tools: [...router.tools, ...whaleTools.tools],

    async callTool(name, args, options) {
      if (!allToolNames.has(name)) {
        // Check if it's a whale tool
        const whaleToolNames = new Set(whaleTools.tools.map((t) => t.name));
        if (whaleToolNames.has(name)) {
          return whaleTools.callTool(name, args);
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

  // ── Start Telegram bot (optional) ──────────────────────────────────
  let stopTelegramBot: (() => void) | undefined;
  if (config.telegramBotToken) {
    try {
      stopTelegramBot = await startTelegramBot(config, whaleToolRouter, cache, whaleDb, whaleTracker);
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
    if (whaleTracker) whaleTracker.stop();
    if (stopTelegramBot) stopTelegramBot();
    if (rpcClient) await rpcClient.close().catch(() => {});
    if (rugcheckClient) await rugcheckClient.close().catch(() => {});
    if (screenerClient) await screenerClient.close().catch(() => {});
    if (localClient) await localClient.close().catch(() => {});
    await mcpClient.close();
    cache.close();
    whaleDb.close();
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

  // ── Render ink UI ──────────────────────────────────────────────────
  const { waitUntilExit } = render(
    React.createElement(App, {
      config,
      router: whaleToolRouter,
      cache,
      whaleDb,
      whaleTracker,
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
