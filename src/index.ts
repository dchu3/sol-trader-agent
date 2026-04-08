import * as readline from "node:readline/promises";
import { loadConfig, reloadConfig } from "./config.js";
import type { Config } from "./config.js";
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

This CLI connects to a remote MCP server (svm402 token analysis, x402-paid)
and optional local MCP servers:
  • dex-trader-mcp   — Jupiter DEX trading (buy/sell/quote)
  • dex-screener-mcp — DexScreener market data (pairs, volume, liquidity)
  • dex-rugcheck-mcp — RugCheck safety reports (rug risk, contract analysis)
  • solana-rpc-mcp   — Solana RPC queries (supply, holders, transactions)

Example prompts:
  Analyse the token <mint-address>
  Buy 0.1 SOL worth of <token-address>
  Get a quote for swapping 1 SOL to <token-address>
  What's my balance?
  Search for tokens named "bonk"
  Check the rug score for <mint-address>

Commands:
  /help       Show this help message
  /configure  View and update settings (.env)
  /clear      Clear conversation history
  /quit       Exit the application

Token analysis is paid via x402 — you'll be asked to confirm before any
funds are spent. Trading actions (buy/sell) also require confirmation.
`);
}

async function main(): Promise<void> {
  const verbose =
    process.argv.includes("--verbose") || process.argv.includes("-v");
  let config: Config = loadConfig();
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

  let screenerClient: LocalMcpClient | undefined;
  if (config.dexScreenerMcpPath) {
    console.log("Connecting to local dex-screener-mcp server...");
    try {
      // Empty env: dex-screener-mcp is a stateless public API wrapper, no secrets needed
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

  let router;
  try {
    router = createToolRouter(mcpClient, localClients);
  } catch (err) {
    // Clean up spawned subprocesses before re-throwing
    for (const client of localClients) {
      await client.close().catch(() => {});
    }
    throw err;
  }
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
    if (rpcClient) {
      await rpcClient.close().catch(() => {});
    }
    if (rugcheckClient) {
      await rugcheckClient.close().catch(() => {});
    }
    if (screenerClient) {
      await screenerClient.close().catch(() => {});
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
      if (trimmed === "/clear") {
        conversationHistory.length = 0;
        console.log("Conversation history cleared.");
        continue;
      }
      if (trimmed === "/configure") {
        try {
          const changed = await runConfigure(rl);
          if (changed) {
            try {
              const prev = { ...config };
              const reloaded = reloadConfig();

              // Connection-level changes still need a restart to recreate clients
              const connectionChanged =
                prev.remoteMcpUrl !== reloaded.remoteMcpUrl ||
                prev.solanaPrivateKey !== reloaded.solanaPrivateKey ||
                prev.dexTraderMcpPath !== reloaded.dexTraderMcpPath ||
                prev.dexScreenerMcpPath !== reloaded.dexScreenerMcpPath ||
                prev.dexRugcheckMcpPath !== reloaded.dexRugcheckMcpPath ||
                prev.solanaRpcMcpPath !== reloaded.solanaRpcMcpPath ||
                prev.solanaRpcUrl !== reloaded.solanaRpcUrl ||
                prev.jupiterApiBase !== reloaded.jupiterApiBase ||
                prev.jupiterApiKey !== reloaded.jupiterApiKey;

              const telegramTokenChanged = prev.telegramBotToken !== reloaded.telegramBotToken;

              // Always-safe live updates: Gemini API + model + verbosity + Telegram Chat ID
              config.geminiApiKey = reloaded.geminiApiKey;
              config.geminiModel = reloaded.geminiModel;
              config.verbose = reloaded.verbose;
              config.telegramChatId = reloaded.telegramChatId;
              setVerbose(verbose || reloaded.verbose);

              if (connectionChanged || telegramTokenChanged) {
                if (connectionChanged) {
                  console.log(
                    "  ⚠️  Connection settings changed — restart with /quit && npm start to apply.",
                  );
                }
                if (telegramTokenChanged) {
                  console.log(
                    "  ⚠️  TELEGRAM_BOT_TOKEN changed — restart required to bind to the new token.",
                  );
                }
              } else {
                // No critical changes: apply everything else (e.g. walletAddress update)
                Object.assign(config, reloaded);
              }
            } catch (err) {
              console.error(
                "  Warning: could not reload config:",
                err instanceof Error ? err.message : String(err),
              );
              console.error("  The old config will remain active until restart.");
            }
          }
        } catch (err) {
          console.error(
            "Configuration error:",
            err instanceof Error ? err.message : String(err),
          );
        }
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
