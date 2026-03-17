import { createRequire } from "node:module";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { debug } from "./logger.js";
import { createX402Fetch } from "./x402-fetch.js";

const require = createRequire(import.meta.url);
const packageJson = require("../package.json") as { version: string };

export interface McpCallOptions {
  allowPayment?: boolean;
}

export interface PaymentInfo {
  amount: string;
  asset: string;
}

export interface McpClient {
  tools: Tool[];
  requiresConfirmationForAllCalls: boolean;
  callTool(
    name: string,
    args: Record<string, unknown>,
    options?: McpCallOptions,
  ): Promise<string>;
  getLastPaymentInfo(): PaymentInfo | null;
  close(): Promise<void>;
}

/**
 * Connect to a remote MCP server over StreamableHTTP with x402 payment support.
 *
 * Plain fetch is used for the transport (connect / listTools) so that metadata
 * calls never trigger an automatic payment.
 *
 * The x402-paying fetch is only used inside callTool. If the remote server
 * returns 402 for a tool call, this client may automatically send payment.
 * This function does not enforce a confirmation flow itself; callers are
 * responsible for requiring approval before invoking paid tool calls.
 */
export async function createRemoteMcpClient(
  url: string,
  solanaPrivateKey: string,
  rpcUrl?: string,
): Promise<McpClient> {
  const paidFetch = await createX402Fetch(solanaPrivateKey, rpcUrl);

  // Intercept 402 responses on the plain transport so callers can inspect
  // the payment requirements (e.g. cost) before deciding to pay.
  let lastPaymentBody: unknown = null;

  const costProbeFetch: typeof globalThis.fetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    lastPaymentBody = null;
    const response = await globalThis.fetch(input, init);
    if (response.status === 402) {
      try {
        const cloned = response.clone();
        lastPaymentBody = await cloned.json();
      } catch {
        // Cost info is best-effort; ignore parse failures.
      }
    }
    return response;
  };

  // Use a separate transport for paid tool calls so that connect/listTools
  // go through plain fetch and never trigger x402 payments.
  const transport = new StreamableHTTPClientTransport(new URL(url), { fetch: costProbeFetch });

  const client = new Client({ name: "solana-pay-agent", version: packageJson.version });

  try {
    await client.connect(transport);
    debug(`Remote MCP client connected to ${url}`);

    const { tools } = await client.listTools();
    debug(`Remote MCP server provides ${tools.length} tools: ${tools.map((t) => t.name).join(", ")}`);
    let paidClient: Client | undefined;
    let paidClientPromise: Promise<Client> | undefined;

    const getPaidClient = async (): Promise<Client> => {
      if (!paidClientPromise) {
        paidClientPromise = (async () => {
          const paidTransport = new StreamableHTTPClientTransport(
            new URL(url),
            { fetch: paidFetch },
          );
          const nextClient = new Client({
            name: "solana-pay-agent",
            version: packageJson.version,
          });
          await nextClient.connect(paidTransport);
          paidClient = nextClient;
          return nextClient;
        })().catch((err) => {
          paidClientPromise = undefined;
          throw err;
        });
      }

      return paidClientPromise;
    };

    return {
      tools,
      requiresConfirmationForAllCalls: true,

      getLastPaymentInfo(): PaymentInfo | null {
        if (!lastPaymentBody || typeof lastPaymentBody !== "object") return null;
        const body = lastPaymentBody as Record<string, unknown>;
        const accepts = body.accepts as Array<Record<string, unknown>> | undefined;
        if (!accepts?.[0]) return null;
        const first = accepts[0];
        if (typeof first.amount !== "string" && typeof first.amount !== "number") return null;
        const parsed = Number(first.amount);
        if (!Number.isFinite(parsed) || parsed < 0) return null;
        return {
          amount: String(first.amount),
          asset: typeof first.asset === "string" ? first.asset : "",
        };
      },

      async callTool(
        name: string,
        args: Record<string, unknown>,
        options?: McpCallOptions,
      ): Promise<string> {
        debug(`MCP callTool: ${name}(${JSON.stringify(args)})`);

        // Try the plain (unpaid) client first. If the server responds with a
        // 402 Payment Required error and the caller has approved payment, retry
        // via the x402-paying transport. This avoids creating a second
        // connection unless payment is actually required.
        const invokeWithClient = async (targetClient: Client): Promise<string> => {
          const result = await targetClient.callTool({ name, arguments: args });
          debug(`MCP callTool ${name} raw result: ${JSON.stringify(result)}`);

          const parts = (result.content ?? []) as Array<{
            type: string;
            text?: string;
            [key: string]: unknown;
          }>;
          return parts
            .map((p) => {
              if (p.type === "text" && typeof p.text === "string") {
                return p.text;
              }
              try {
                return JSON.stringify(p);
              } catch {
                return String(p);
              }
            })
            .filter((s) => s.length > 0)
            .join("\n");
        };

        try {
          return await invokeWithClient(client);
        } catch (err) {
          if (!options?.allowPayment) {
            throw err;
          }
          const message = err instanceof Error ? err.message : String(err);
          const lower = message.toLowerCase();
          if (!lower.includes("402") && !lower.includes("payment required")) {
            throw err;
          }
          debug(`Tool ${name} returned 402 — retrying with x402 payment`);
          try {
            const paidClientInstance = await getPaidClient();
            return await invokeWithClient(paidClientInstance);
          } catch (paidErr) {
            const paidMsg =
              paidErr instanceof Error ? paidErr.message : String(paidErr);
            debug(`x402 paid client failed: ${paidMsg}`);
            throw new Error(
              `x402 payment failed for tool "${name}": ${paidMsg}`,
            );
          }
        }
      },

      async close(): Promise<void> {
        if (paidClientPromise) {
          await paidClientPromise.catch(() => undefined);
        }
        if (paidClient) {
          await paidClient.close().catch(() => {});
          paidClient = undefined;
        }
        paidClientPromise = undefined;
        await client.close();
      },
    };
  } catch (error) {
    try {
      await client.close();
    } catch {
      // Ignore cleanup errors to preserve the original error.
    }
    throw error;
  }
}
