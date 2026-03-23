import dotenv from "dotenv";
import { z } from "zod";
import bs58 from "bs58";
import * as path from "node:path";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";

/** All env keys managed by the config system. */
const CONFIG_KEYS = [
  "GEMINI_API_KEY", "REMOTE_MCP_URL", "SOLANA_PRIVATE_KEY", "GEMINI_MODEL",
  "SOLANA_RPC_URL", "DEX_TRADER_MCP_PATH", "JUPITER_API_BASE", "JUPITER_API_KEY",
  "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "VERBOSE",
] as const;

/** Find the .env file by walking up from the compiled output to the project root. */
function findEnvPath(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    if (fs.existsSync(path.join(dir, "package.json"))) {
      return path.join(dir, ".env");
    }
    dir = path.dirname(dir);
  }
  return path.join(process.cwd(), ".env");
}

// Load .env into process.env on first import, using the same path resolution as reloadConfig().
dotenv.config({ path: findEnvPath() });

export interface Config {
  geminiApiKey: string;
  geminiModel: string;
  /** URL of the remote MCP server (StreamableHTTP). */
  remoteMcpUrl: string;
  /** The user's Solana wallet public address (derived from SOLANA_PRIVATE_KEY). */
  walletAddress: string;
  /** Base58-encoded Solana private key (needed for x402 payments to remote MCP). */
  solanaPrivateKey: string;
  /** Custom Solana RPC URL. Used by the x402 SDK to avoid public mainnet rate limits. */
  solanaRpcUrl?: string;
  /** Path to the dex-trader-mcp dist/index.js entry point (enables local trading tools). */
  dexTraderMcpPath?: string;
  /** Jupiter API base URL forwarded to dex-trader-mcp subprocess. */
  jupiterApiBase?: string;
  /** Jupiter API key forwarded to dex-trader-mcp subprocess. */
  jupiterApiKey?: string;
  /** Telegram bot token from @BotFather. Enables the Telegram interface when set. */
  telegramBotToken?: string;
  /** Telegram chat ID of the authorised private user. Only this chat can interact with the bot. */
  telegramChatId?: number;
  verbose: boolean;
}

const EnvSchema = z.object({
  GEMINI_API_KEY: z
    .string({ required_error: "GEMINI_API_KEY environment variable is required" })
    .min(1, "GEMINI_API_KEY environment variable is required"),
  REMOTE_MCP_URL: z
    .string({ required_error: "REMOTE_MCP_URL environment variable is required" })
    .url("REMOTE_MCP_URL must be a valid URL")
    .refine(
      (value) => {
        const parsed = new URL(value);
        if (parsed.protocol === "https:") {
          return true;
        }
        return (
          parsed.protocol === "http:" &&
          (parsed.hostname === "localhost" ||
            parsed.hostname === "127.0.0.1" ||
            parsed.hostname === "[::1]")
        );
      },
      "REMOTE_MCP_URL must use https://; http:// is only allowed for localhost/127.0.0.1/[::1]",
    ),
  SOLANA_PRIVATE_KEY: z
    .string({ required_error: "SOLANA_PRIVATE_KEY environment variable is required" })
    .min(1, "SOLANA_PRIVATE_KEY environment variable is required"),
  GEMINI_MODEL: z.string().optional(),
  SOLANA_RPC_URL: z.string().optional(),
  DEX_TRADER_MCP_PATH: z.string().optional(),
  JUPITER_API_BASE: z.string().optional(),
  JUPITER_API_KEY: z.string().optional(),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z
    .string()
    .optional()
    .refine(
      (v) => v === undefined || (Number.isInteger(Number(v)) && Number(v) !== 0),
      "TELEGRAM_CHAT_ID must be a valid non-zero integer chat ID",
    ),
  NODE_ENV: z.string().optional(),
  VERBOSE: z.string().optional(),
});

export function loadConfig(): Config {
  const env = EnvSchema.parse(process.env);

  // Derive the wallet public address from the private key.
  // Solana keypairs are 64 bytes: first 32 = secret key, last 32 = public key.
  const keypairBytes = bs58.decode(env.SOLANA_PRIVATE_KEY);
  if (keypairBytes.length !== 64) {
    throw new Error(
      `SOLANA_PRIVATE_KEY must decode to a 64-byte keypair (got ${keypairBytes.length} bytes)`,
    );
  }
  const walletAddress = bs58.encode(keypairBytes.slice(32));

  return {
    geminiApiKey: env.GEMINI_API_KEY,
    geminiModel: env.GEMINI_MODEL ?? "gemini-3.1-flash-lite-preview",
    remoteMcpUrl: env.REMOTE_MCP_URL,
    walletAddress,
    solanaPrivateKey: env.SOLANA_PRIVATE_KEY,
    solanaRpcUrl: env.SOLANA_RPC_URL,
    dexTraderMcpPath: env.DEX_TRADER_MCP_PATH,
    jupiterApiBase: env.JUPITER_API_BASE,
    jupiterApiKey: env.JUPITER_API_KEY,
    telegramBotToken: env.TELEGRAM_BOT_TOKEN,
    telegramChatId: env.TELEGRAM_CHAT_ID !== undefined ? Number(env.TELEGRAM_CHAT_ID) : undefined,
    verbose: env.VERBOSE === "true" || env.VERBOSE === "1",
  };
}

/**
 * Re-read .env from disk, update process.env, and return a fresh Config.
 * Clears known config keys from process.env first so that values removed
 * or commented out in .env don't linger from a previous load.
 */
export function reloadConfig(): Config {
  for (const key of CONFIG_KEYS) {
    delete process.env[key];
  }
  const envPath = findEnvPath();
  dotenv.config({ path: envPath, override: true });
  return loadConfig();
}
