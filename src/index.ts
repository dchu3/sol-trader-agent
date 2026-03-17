import * as readline from "node:readline/promises";
import { loadConfig } from "./config.js";
import { createRemoteMcpClient } from "./mcp-client.js";
import type { McpClient } from "./mcp-client.js";
import { type Content } from "@google/genai";
import { runAgent } from "./agent.js";
import { setVerbose } from "./logger.js";

function printHelp(): void {
  console.log(`
Solana Pay Agent — an agent-to-agent x402 payment demo.

This CLI connects to a remote MCP server to analyse tokens on the Solana
blockchain. Token analysis is paid for automatically via the x402 protocol
using your Solana wallet.

Example prompts:
  Analyse the token <mint-address>
  What tokens can you analyse?
  Tell me about <token-name>

Commands:
  /help   Show this help message
  /quit   Exit the application

Payments are made automatically via x402 — you'll be asked to confirm
before any funds are spent.
`);
}

async function main(): Promise<void> {
  const verbose =
    process.argv.includes("--verbose") || process.argv.includes("-v");
  const config = loadConfig();
  setVerbose(verbose || config.verbose);

  console.log("Connecting to MCP server...");
  const mcpClient: McpClient = await createRemoteMcpClient(
    config.remoteMcpUrl,
    config.solanaPrivateKey,
    config.solanaRpcUrl,
  );

  const toolNames = mcpClient.tools.map((t) => t.name).join(", ");
  console.log(`Connected. Available tools: ${toolNames}`);
  console.log(`Using model: ${config.geminiModel}`);
  if (verbose || config.verbose) {
    console.log("Verbose logging enabled (debug output on stderr)");
  }

  console.log("Type your message, /help for usage info, or /quit to exit.\n");

  const conversationHistory: Content[] = [];

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    rl.close();
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
          mcpClient,
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
