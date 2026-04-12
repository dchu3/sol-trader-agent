import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { WhaleDb } from "./whale-db.js";
import { debug } from "./logger.js";

/** Pseudo-MCP tools for whale wallet management that the agent can call. */
export interface WhaleTools {
  tools: Tool[];
  callTool(name: string, args: Record<string, unknown>): Promise<string>;
}

export function createWhaleTools(db: WhaleDb): WhaleTools {
  const tools: Tool[] = [
    {
      name: "watch_wallet",
      description:
        "Add a Solana wallet to the whale watch list for real-time monitoring. " +
        "The whale tracker will poll for new DEX transactions from this wallet " +
        "and alert the user via CLI and Telegram.",
      inputSchema: {
        type: "object",
        properties: {
          address: {
            type: "string",
            description: "The Solana wallet public address to watch.",
          },
          label: {
            type: "string",
            description: "Optional human-readable label for this wallet (e.g. 'Whale #1', 'Smart Money').",
          },
        },
        required: ["address"],
      },
    },
    {
      name: "unwatch_wallet",
      description:
        "Remove a Solana wallet from the whale watch list. Stops monitoring this wallet for DEX transactions.",
      inputSchema: {
        type: "object",
        properties: {
          address: {
            type: "string",
            description: "The Solana wallet public address to stop watching.",
          },
        },
        required: ["address"],
      },
    },
    {
      name: "list_watched_wallets",
      description:
        "List all wallets currently being watched by the whale tracker, with their labels.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "get_whale_alerts",
      description:
        "Get recent whale alerts — DEX swap transactions detected from watched wallets. " +
        "Shows the action (buy/sell), token, and SOL amount.",
      inputSchema: {
        type: "object",
        properties: {
          limit: {
            type: "number",
            description: "Maximum number of alerts to return (default: 10).",
          },
        },
      },
    },
  ];

  return {
    tools,

    async callTool(name: string, args: Record<string, unknown>): Promise<string> {
      debug(`Whale tool call: ${name}(${JSON.stringify(args)})`);

      switch (name) {
        case "watch_wallet": {
          const address = args.address as string;
          const label = (args.label as string) ?? "";
          if (!address || address.length < 32) {
            return "Error: invalid wallet address.";
          }
          const added = db.addWallet(address, label);
          if (added) {
            return `✅ Now watching wallet ${label ? `"${label}" (${address})` : address}. The whale tracker will alert you to any DEX swaps from this wallet.`;
          }
          return `Wallet ${address} is already being watched.`;
        }

        case "unwatch_wallet": {
          const address = args.address as string;
          if (!address) {
            return "Error: address is required.";
          }
          const removed = db.removeWallet(address);
          if (removed) {
            return `✅ Stopped watching wallet ${address}.`;
          }
          return `Wallet ${address} was not in the watch list.`;
        }

        case "list_watched_wallets": {
          const wallets = db.listWallets();
          if (wallets.length === 0) {
            return "No wallets are currently being watched. Use watch_wallet to add one.";
          }
          const lines = wallets.map((w) => {
            const label = w.label ? ` (${w.label})` : "";
            const since = new Date(w.addedAt).toLocaleString();
            return `• ${w.address}${label} — watching since ${since}`;
          });
          return `Watching ${wallets.length} wallet(s):\n${lines.join("\n")}`;
        }

        case "get_whale_alerts": {
          const limit = (args.limit as number) ?? 10;
          const alerts = db.recentAlerts(limit);
          if (alerts.length === 0) {
            return "No whale alerts yet. Alerts will appear when watched wallets make DEX swaps.";
          }
          const lines = alerts.map((a) => {
            const label = a.walletLabel || a.walletAddress.slice(0, 8) + "...";
            const token = a.tokenSymbol || a.tokenAddress.slice(0, 8) + "...";
            const action = a.action === "buy" ? "🟢 BUY" : a.action === "sell" ? "🔴 SELL" : "⚪ ???";
            const time = new Date(a.timestamp).toLocaleString();
            return `${action} ${label} → ${token} (${a.solAmount} SOL) at ${time}`;
          });
          return `Recent whale alerts (${alerts.length}):\n${lines.join("\n")}`;
        }

        default:
          return `Unknown whale tool: ${name}`;
      }
    },
  };
}
