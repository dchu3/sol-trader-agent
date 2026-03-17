import "dotenv/config";
import { z } from "zod";
import bs58 from "bs58";

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
    verbose: env.VERBOSE === "true" || env.VERBOSE === "1",
  };
}
