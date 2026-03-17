import { createRequire } from "node:module";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { debug } from "./logger.js";

const require = createRequire(import.meta.url);
const packageJson = require("../package.json") as { version: string };

export interface LocalMcpCallOptions {
  /** Unused for local clients — kept for interface compatibility. */
  allowPayment?: boolean;
}

export interface LocalMcpClient {
  tools: Tool[];
  callTool(
    name: string,
    args: Record<string, unknown>,
    options?: LocalMcpCallOptions,
  ): Promise<string>;
  close(): Promise<void>;
}

/**
 * Spawn a local MCP server as a child process and connect via stdio.
 *
 * @param scriptPath - Absolute path to the MCP server entry point (e.g. `.../dex-trader-mcp/dist/index.js`).
 * @param env        - Environment variables forwarded to the subprocess.
 */
export async function createLocalMcpClient(
  scriptPath: string,
  env: Record<string, string>,
): Promise<LocalMcpClient> {
  const transport = new StdioClientTransport({
    command: "node",
    args: [scriptPath],
    env: { ...process.env, ...env } as Record<string, string>,
  });

  const client = new Client({
    name: "sol-trader-agent",
    version: packageJson.version,
  });

  try {
    await client.connect(transport);
    debug(`Local MCP client connected (${scriptPath})`);

    const { tools } = await client.listTools();
    debug(
      `Local MCP server provides ${tools.length} tools: ${tools.map((t) => t.name).join(", ")}`,
    );

    return {
      tools,

      async callTool(
        name: string,
        args: Record<string, unknown>,
      ): Promise<string> {
        debug(`Local MCP callTool: ${name}(${JSON.stringify(args)})`);

        const result = await client.callTool({ name, arguments: args });
        debug(`Local MCP callTool ${name} raw result: ${JSON.stringify(result)}`);

        const parts = (result.content ?? []) as Array<{
          type: string;
          text?: string;
          [key: string]: unknown;
        }>;

        return parts
          .map((p) => {
            if (p.type === "text" && typeof p.text === "string") return p.text;
            try {
              return JSON.stringify(p);
            } catch {
              return String(p);
            }
          })
          .filter((s) => s.length > 0)
          .join("\n");
      },

      async close(): Promise<void> {
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
