import * as readline from "node:readline/promises";
import { loadConfig } from "./config.js";
import { createRemoteMcpClient } from "./mcp-client.js";
import type { McpClient } from "./mcp-client.js";
import { createLocalMcpClient } from "./local-mcp-client.js";
import type { LocalMcpClient } from "./local-mcp-client.js";
import { type Content } from "@google/genai";
import { runAgent, createToolRouter } from "./agent.js";
import { setVerbose } from "./logger.js";
import { startTelegramBot } from "./telegram.js";
import { runConfigure } from "./configure.js";

function printHelp(): void {
  console.log(`
Sol Trader Agent — analyse tokens and trade on Solana DEXs.

This CLI connects to a remote MCP server (token analysis, x402-paid) and an
optional local dex-trader-mcp server (Jupiter DEX trading). Use natural
language to analyse tokens and buy/sell them.

Example prompts:
  Analyse the token <mint-address>
  Buy 0.1 SOL worth of <token-address>
  Get a quote for swapping 1 SOL to <token-address>
  What's my balance?

Commands:
  /help       Show this help message
  /configure  View and update settings (.env)
  /quit       Exit the application

Token analysis is paid via x402 — you'll be asked to confirm before any
funds are spent. Trading actions (buy/sell) also require confirmation.
`);
}

async function main(): Promise<void> {
  const verbose =
    process.argv.includes("--verbose") || process.argv.includes("-v");
  const config = loadConfig();
  setVerbose(verbose || config.verbose);

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

  const router = createToolRouter(mcpClient, localClient);
  const allToolNames = router.tools.map((t) => t.name).join(", ");
  console.log(`All available tools: ${allToolNames}`);
  console.log(`Using model: ${config.geminiModel}`);
  if (verbose || config.verbose) {
    console.log("Verbose logging enabled (debug output on stderr)");
  }

  console.log("Type your message, /help for usage info, or /quit to exit.\n");

  const conversationHistory: Content[] = [];

  // ── Start Telegram bot (optional) ──────────────────────────────────
  let stopTelegramBot: (() => void) | undefined;
  if (config.telegramBotToken) {
    try {
      stopTelegramBot = await startTelegramBot(config, router);
    } catch (err) {
      console.error(
        "Warning: failed to start Telegram bot:",
        err instanceof Error ? err.message : String(err),
      );
      console.error("Telegram interface will not be available.");
    }
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    rl.close();
    if (stopTelegramBot) {
      stopTelegramBot();
    }
    if (localClient) {
      await localClient.close().catch(() => {});
    }
    await mcpClient.close();
  };

  const handleSignal = () => {
    (async () => {
      console.log("\nShutting down...");
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

  try {
    while (!shuttingDown) {
      let input: string;
      try {
        input = await rl.question("> ");
      } catch {
        // readline was closed (e.g., EOF or shutdown)
        break;
      }
      const trimmed = input.trim();
      if (!trimmed) continue;
      if (trimmed === "/quit") break;
      if (trimmed === "/help") {
        printHelp();
        continue;
      }
      if (trimmed === "/configure") {
        await runConfigure(rl);
        continue;
      }

      try {
        const confirmFn = async (message: string): Promise<boolean> => {
          const answer = await rl.question(`\n⚠️  ${message} (y/N) `);
          const normalised = answer.trim().toLowerCase();
          const accepted = ["y", "yes", "yeah", "yep", "sure", "ok"].includes(normalised);
          if (!accepted) {
            console.log("Cancelled.");
          }
          return accepted;
        };

        const answer = await runAgent(
          config.geminiApiKey,
          config.geminiModel,
          router,
          trimmed,
          conversationHistory,
          config.walletAddress,
          confirmFn,
        );
        console.log(`\n${answer}\n`);
      } catch (err) {
        console.error(
          "Error:",
          err instanceof Error ? err.message : String(err),
        );
      }
    }
  } finally {
    await shutdown();
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
