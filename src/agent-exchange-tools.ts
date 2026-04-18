import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ExchangeDb } from "./exchange-db.js";
import type { ExchangeWalletType } from "./exchange-db.js";
import { debug } from "./logger.js";

export interface ExchangeTools {
  tools: Tool[];
  callTool(name: string, args: Record<string, unknown>): Promise<string>;
}

export function createExchangeTools(db: ExchangeDb): ExchangeTools {
  const tools: Tool[] = [
    {
      name: "add_exchange_wallet",
      description:
        "Add a Solana exchange wallet to the exchange hot wallet tracker. " +
        "Specify whether it is a hot wallet (actively used for deposits/withdrawals) " +
        "or cold wallet (long-term storage). The tracker will monitor for large SOL " +
        "transfers (≥1000 SOL) between known exchange wallets and alert when cold→hot " +
        "movements are detected, which may signal anticipated selling pressure.",
      inputSchema: {
        type: "object",
        properties: {
          address: {
            type: "string",
            description: "The Solana wallet public address.",
          },
          exchange_name: {
            type: "string",
            description: "The exchange this wallet belongs to (e.g. 'Binance', 'Coinbase').",
          },
          wallet_type: {
            type: "string",
            enum: ["hot", "cold"],
            description:
              "Whether this is a hot wallet (active trading) or cold wallet (cold storage).",
          },
          label: {
            type: "string",
            description:
              "Optional human-readable label (e.g. 'Binance Hot Wallet 3').",
          },
        },
        required: ["address", "exchange_name", "wallet_type"],
      },
    },
    {
      name: "remove_exchange_wallet",
      description:
        "Remove a Solana exchange wallet from the exchange hot wallet tracker. " +
        "Stops monitoring this wallet for large SOL transfers.",
      inputSchema: {
        type: "object",
        properties: {
          address: {
            type: "string",
            description: "The Solana wallet public address to stop tracking.",
          },
        },
        required: ["address"],
      },
    },
    {
      name: "list_exchange_wallets",
      description:
        "List all exchange wallets currently being tracked, grouped by exchange. " +
        "Shows each wallet's type (hot/cold), label, and tracking status.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "get_exchange_transfers",
      description:
        "Get recent large SOL transfers detected between exchange wallets. " +
        "Focus on cold_to_hot transfers as these signal exchanges moving funds " +
        "into hot wallets in preparation for anticipated selling activity. " +
        "Optionally filter by exchange name.",
      inputSchema: {
        type: "object",
        properties: {
          limit: {
            type: "number",
            description: "Maximum number of transfers to return (default: 10).",
          },
          exchange_name: {
            type: "string",
            description:
              "Optional: filter to a specific exchange (e.g. 'Binance').",
          },
        },
      },
    },
  ];

  return {
    tools,

    async callTool(name: string, args: Record<string, unknown>): Promise<string> {
      debug(`Exchange tool call: ${name}(${JSON.stringify(args)})`);

      switch (name) {
        case "add_exchange_wallet": {
          const address = args.address as string;
          const exchangeName = args.exchange_name as string;
          const walletType = args.wallet_type as ExchangeWalletType;
          const label = (args.label as string | undefined) ?? "";

          if (!address || address.length < 32) {
            return "Error: invalid wallet address.";
          }
          if (!exchangeName) {
            return "Error: exchange_name is required.";
          }
          if (walletType !== "hot" && walletType !== "cold") {
            return "Error: wallet_type must be 'hot' or 'cold'.";
          }

          const added = db.addWallet(address, exchangeName, walletType, label);
          if (added) {
            return (
              `✅ Now tracking ${walletType} wallet for ${exchangeName}` +
              (label ? ` (${label})` : "") +
              `. The exchange tracker will alert you to large SOL transfers (≥1000 SOL) involving this wallet.`
            );
          }
          return `Wallet ${address} is already being tracked.`;
        }

        case "remove_exchange_wallet": {
          const address = args.address as string;
          if (!address) {
            return "Error: address is required.";
          }
          const removed = db.removeWallet(address);
          if (removed) {
            return `✅ Stopped tracking exchange wallet ${address}.`;
          }
          return `Wallet ${address} was not in the exchange tracker.`;
        }

        case "list_exchange_wallets": {
          const wallets = db.listWallets();
          if (wallets.length === 0) {
            return "No exchange wallets are being tracked. Use add_exchange_wallet to add one.";
          }

          // Group by exchange
          const byExchange = new Map<string, typeof wallets>();
          for (const w of wallets) {
            const group = byExchange.get(w.exchangeName) ?? [];
            group.push(w);
            byExchange.set(w.exchangeName, group);
          }

          const lines: string[] = [`Tracking ${wallets.length} exchange wallet(s):\n`];
          for (const [exchange, group] of [...byExchange.entries()].sort()) {
            lines.push(`${exchange}:`);
            for (const w of group) {
              const typeIcon = w.walletType === "hot" ? "🔥" : "🧊";
              const pausedTag = w.paused ? " [PAUSED]" : "";
              const labelPart = w.label ? ` — ${w.label}` : "";
              lines.push(`  ${typeIcon} ${w.walletType.toUpperCase()}${labelPart}${pausedTag}: ${w.address}`);
            }
          }
          return lines.join("\n");
        }

        case "get_exchange_transfers": {
          const limit = (args.limit as number | undefined) ?? 10;
          const exchangeFilter = args.exchange_name as string | undefined;

          const transfers = exchangeFilter
            ? db.recentTransfersByExchange(exchangeFilter, limit)
            : db.recentTransfers(limit);

          if (transfers.length === 0) {
            return (
              "No large SOL transfers detected yet. The exchange tracker monitors for " +
              "transfers ≥1000 SOL between known exchange wallets. Alerts will appear when detected."
            );
          }

          const lines = transfers.map((t) => {
            const typeLabel = formatTransferType(t.transferType);
            const time = new Date(t.timestamp).toLocaleString();
            return (
              `${typeLabel} ${t.exchangeName}: ${t.solAmount.toFixed(0)} SOL ` +
              `(${t.fromType}→${t.toType}) at ${time}\n` +
              `  sig: ${t.signature.slice(0, 16)}...`
            );
          });

          return `Recent exchange transfers (${transfers.length}):\n${lines.join("\n\n")}`;
        }

        default:
          return `Unknown exchange tool: ${name}`;
      }
    },
  };
}

function formatTransferType(type: string): string {
  switch (type) {
    case "cold_to_hot":
      return "🔴 COLD→HOT";
    case "hot_to_cold":
      return "🟢 HOT→COLD";
    case "exchange_to_exchange":
      return "🔄 EXCHANGE→EXCHANGE";
    case "external_to_hot":
      return "🟡 EXT→HOT";
    case "hot_to_external":
      return "⚪ HOT→EXT";
    default:
      return "⚫ UNKNOWN";
  }
}
