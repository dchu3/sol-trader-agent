import {
  GoogleGenAI,
  type Content,
  type FunctionDeclaration,
  type Part,
} from "@google/genai";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { McpClient } from "./mcp-client.js";
import type { LocalMcpClient } from "./local-mcp-client.js";
import { debug } from "./logger.js";

/**
 * A unified interface the agent uses to call any tool regardless of which
 * MCP client owns it.
 */
export interface ToolRouter {
  /** All tools from every connected MCP client. */
  tools: Tool[];
  /** Call a tool by name, routing to the correct client. */
  callTool(
    name: string,
    args: Record<string, unknown>,
    options?: { allowPayment?: boolean },
  ): Promise<string>;
  /** Get payment info from the last remote MCP 402 probe (if any). */
  getLastPaymentInfo(): { amount: string; asset: string } | null;
}

/**
 * Build a ToolRouter that merges tools from a remote MCP client and an
 * optional local MCP client, routing calls to the correct backend.
 */
export function createToolRouter(
  remoteMcpClient: McpClient,
  localMcpClient?: LocalMcpClient,
): ToolRouter {
  const localToolNames = new Set(
    localMcpClient?.tools.map((t) => t.name) ?? [],
  );

  const allTools: Tool[] = [
    ...remoteMcpClient.tools,
    ...(localMcpClient?.tools ?? []),
  ];

  return {
    tools: allTools,

    async callTool(name, args, options) {
      if (localToolNames.has(name) && localMcpClient) {
        return localMcpClient.callTool(name, args);
      }
      return remoteMcpClient.callTool(name, args, options);
    },

    getLastPaymentInfo() {
      return remoteMcpClient.getLastPaymentInfo();
    },
  };
}

const SYSTEM_INSTRUCTION = (walletAddress: string, toolNames: string[]) => {
  const toolSet = new Set(toolNames);
  const capabilities: string[] = [];
  if (toolSet.has("get_usdc_balance") || toolSet.has("get_sol_balance"))
    capabilities.push("- Check the wallet USDC/SOL balance");
  if (toolSet.has("send_usdc")) capabilities.push("- Send USDC payments to other wallets");
  if (toolSet.has("get_incoming_usdc_payments"))
    capabilities.push("- View recent incoming USDC payments");
  if (toolSet.has("analyze_token"))
    capabilities.push(
      "- Analyze tokens using the analyze_token tool (payment is handled automatically by the x402 protocol — do NOT send USDC manually)",
    );
  if (toolSet.has("get_quote"))
    capabilities.push(
      "- Preview swap quotes via Jupiter aggregator (get_quote) — shows price, output amount, route, and price impact without executing",
    );
  if (toolSet.has("buy_token"))
    capabilities.push("- Buy Solana tokens by spending SOL via Jupiter (buy_token)");
  if (toolSet.has("sell_token"))
    capabilities.push("- Sell Solana tokens for SOL via Jupiter (sell_token)");
  if (toolSet.has("buy_and_sell"))
    capabilities.push("- Atomically buy and immediately sell a token (buy_and_sell)");
  if (toolSet.has("get_balance"))
    capabilities.push("- Check wallet SOL balance and token balances (get_balance)");

  // Fallback for unknown tools
  const knownTools = new Set([
    "get_usdc_balance",
    "get_sol_balance",
    "send_usdc",
    "get_incoming_usdc_payments",
    "get_wallet_info",
    "get_wallet_balance",
    "analyze_token",
    "get_quote",
    "buy_token",
    "sell_token",
    "buy_and_sell",
    "get_balance",
  ]);
  const unknownTools = toolNames.filter((t) => !knownTools.has(t));
  if (unknownTools.length > 0) {
    capabilities.push(`- Use these tools: ${unknownTools.join(", ")}`);
  }

  return `You are a helpful Solana trading assistant. The user's wallet address is: ${walletAddress}

You have access to tools that let you:
${capabilities.join("\n")}

When the user refers to "my wallet", "my balance", or similar, use their wallet address shown above. When the user asks you to perform an action, use the appropriate tool. Always confirm amounts and addresses before executing transactions. Report results clearly.

IMPORTANT: Only use tools that are explicitly available to you. Do NOT attempt to call tools that are not in your function declarations. If analyze_token requires payment, it is handled automatically — never send USDC manually to pay for tool access. When the user wants to trade (buy/sell tokens), use the Jupiter-powered trading tools. Always suggest previewing a trade with get_quote before executing buy_token or sell_token.`;
};

/**
 * Read-only tools that can run without user confirmation.
 * Any tool NOT in this set is treated as destructive and requires confirmation,
 * so newly added MCP tools are safe by default.
 */
const READ_ONLY_TOOLS = new Set([
  "get_wallet_info",
  "get_wallet_balance",
  "get_sol_balance",
  "get_usdc_balance",
  "get_incoming_usdc_payments",
  "get_quote",
  "get_balance",
]);

/**
 * Non-destructive tools that may require payment. These are safe to call
 * speculatively (probe) so we can discover the cost before asking the user
 * to confirm and pay.
 */
const PROBE_SAFE_TOOLS = new Set([
  "analyze_token",
]);

// Well-known USDC mints (mainnet + devnet) for human-readable cost display.
const USDC_DECIMALS = 6;
const KNOWN_USDC_MINTS = new Set([
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
]);

/** Format a tool call as a human-readable action description. */
function formatToolAction(
  toolName: string,
  args: Record<string, unknown>,
): string {
  switch (toolName) {
    case "analyze_token":
      return `Analyze token ${args.address ?? "unknown address"}`;
    case "send_usdc": {
      const amount = args.amount ?? "?";
      const recipient = args.recipient ?? args.to ?? "unknown";
      return `Send ${amount} USDC to ${recipient}`;
    }
    case "buy_token": {
      const sol = args.sol_amount ?? "?";
      const token = args.token_address ?? "unknown";
      return `Buy token ${token} with ${sol} SOL`;
    }
    case "sell_token": {
      const amount = args.token_amount ?? "?";
      const token = args.token_address ?? "unknown";
      return `Sell ${amount} of token ${token} for SOL`;
    }
    case "buy_and_sell": {
      const sol = args.sol_amount ?? "?";
      const token = args.token_address ?? "unknown";
      return `Buy and sell token ${token} with ${sol} SOL (round-trip)`;
    }
    default: {
      const entries = Object.entries(args);
      if (entries.length === 0) return `Run ${toolName}`;
      const summary = entries
        .map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`)
        .join(", ");
      return `Run ${toolName} (${summary})`;
    }
  }
}

/** Format a payment amount for display (e.g. "0.01 USDC"). */
function formatCost(amount: string, asset: string): string {
  if (KNOWN_USDC_MINTS.has(asset)) {
    const value = Number(amount) / 10 ** USDC_DECIMALS;
    return `${value} USDC`;
  }
  return amount;
}

/**
 * Convert MCP tool JSON-Schema inputSchema to Gemini FunctionDeclaration format.
 * MCP uses standard JSON Schema types (lowercase), Gemini uses its own Type enum (uppercase).
 */
function convertSchema(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  const schemaType = schema.type;
  if (typeof schemaType === "string") {
    result.type = schemaType.toUpperCase();
  } else if (Array.isArray(schemaType)) {
    const firstStringType = schemaType.find(
      (t): t is string => typeof t === "string",
    );
    if (firstStringType) {
      result.type = firstStringType.toUpperCase();
    }
  }
  if (schema.description) {
    result.description = schema.description;
  }
  if (schema.enum) {
    result.enum = schema.enum;
  }
  if (schema.required) {
    result.required = schema.required;
  }

  if (schema.properties) {
    const props: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(
      schema.properties as Record<string, Record<string, unknown>>,
    )) {
      props[key] = convertSchema(value);
    }
    result.properties = props;
  }

  if (schema.items) {
    result.items = convertSchema(schema.items as Record<string, unknown>);
  }

  return result;
}

function mcpToolsToGeminiDeclarations(
  router: ToolRouter,
): FunctionDeclaration[] {
  return router.tools.map((tool) => {
    const decl: FunctionDeclaration = {
      name: tool.name,
      description: tool.description ?? "",
    };

    if (tool.inputSchema) {
      decl.parameters = convertSchema(
        tool.inputSchema as unknown as Record<string, unknown>,
      ) as FunctionDeclaration["parameters"];
    }

    return decl;
  });
}

const MAX_TOOL_ROUNDS = 10;

export type ConfirmFn = (message: string) => Promise<boolean>;

/** Default: reject tool calls when no confirmation callback is provided. */
const rejectByDefault: ConfirmFn = async () => false;

/**
 * Run the agent loop. Appends the new user message and all model/tool turns
 * to `history` so callers can maintain multi-turn conversation state.
 */
export async function runAgent(
  apiKey: string,
  model: string,
  router: ToolRouter,
  userMessage: string,
  history: Content[],
  walletAddress: string,
  confirmFn: ConfirmFn = rejectByDefault,
): Promise<string> {
  const ai = new GoogleGenAI({ apiKey });

  const functionDeclarations = mcpToolsToGeminiDeclarations(router);
  const toolNames = router.tools.map((t) => t.name);

  history.push({ role: "user", parts: [{ text: userMessage }] });

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    debug(`Agent loop round ${round + 1}/${MAX_TOOL_ROUNDS}`);

    const response = await ai.models.generateContent({
      model,
      contents: history,
      config: {
        systemInstruction: SYSTEM_INSTRUCTION(walletAddress, toolNames),
        tools: [{ functionDeclarations }],
      },
    });

    const functionCalls = response.functionCalls;

    if (!functionCalls || functionCalls.length === 0) {
      const text = response.text ?? "(no response)";
      debug(`Model returned final text (${text.length} chars)`);
      // Use raw content to preserve any model metadata (e.g., thought signatures)
      const modelContent = response.candidates?.[0]?.content;
      history.push(modelContent ?? { role: "model", parts: [{ text }] });
      return text;
    }

    // Push the raw model content to preserve thought signatures required by Gemini 3.x
    const modelContent = response.candidates?.[0]?.content;
    if (modelContent) {
      history.push(modelContent);
    } else {
      const modelParts: Part[] = functionCalls.map((fc) => ({ functionCall: fc }));
      history.push({ role: "model", parts: modelParts });
    }

    // Execute each function call and collect responses
    const responseParts: Part[] = [];
    for (const fc of functionCalls) {
      // Treat missing tool name as a malformed call — skip execution.
      if (!fc.name) {
        responseParts.push({
          functionResponse: {
            id: fc.id,
            name: "unknown",
            response: { error: "Missing tool name in function call." },
          },
        });
        continue;
      }

      const toolName = fc.name;
      const toolArgs = (fc.args as Record<string, unknown>) ?? {};

      debug(`Calling tool: ${toolName}(${JSON.stringify(toolArgs)})`);

      let output: Record<string, unknown>;
      try {
        if (READ_ONLY_TOOLS.has(toolName)) {
          // ── Read-only: call directly, no confirmation, no payment ──
          const resultText = await router.callTool(toolName, toolArgs, {
            allowPayment: false,
          });
          output = { result: resultText };
          debug(`Tool ${toolName} result: ${resultText}`);
        } else if (PROBE_SAFE_TOOLS.has(toolName)) {
          // ── Non-destructive paid tool: probe for cost, confirm with cost ──
          try {
            const resultText = await router.callTool(toolName, toolArgs, {
              allowPayment: false,
            });
            // Succeeded without payment
            output = { result: resultText };
            debug(`Tool ${toolName} result: ${resultText}`);
          } catch (probeErr) {
            const probeMsg =
              probeErr instanceof Error ? probeErr.message : String(probeErr);
            if (
              !probeMsg.toLowerCase().includes("402") &&
              !probeMsg.toLowerCase().includes("payment required")
            ) {
              throw probeErr;
            }

            // Build confirmation message with cost
            let message = formatToolAction(toolName, toolArgs);
            const paymentInfo = router.getLastPaymentInfo();
            if (paymentInfo) {
              message += ` (cost: ${formatCost(paymentInfo.amount, paymentInfo.asset)})`;
            } else {
              message += " (requires payment)";
            }

            const approved = await confirmFn(message);
            if (!approved) {
              output = { error: "User explicitly declined this action. Do not retry or re-request this tool call." };
              responseParts.push({
                functionResponse: {
                  id: fc.id,
                  name: toolName,
                  response: output,
                },
              });
              continue;
            }

            const resultText = await router.callTool(toolName, toolArgs, {
              allowPayment: true,
            });
            output = { result: resultText };
            debug(`Tool ${toolName} result: ${resultText}`);
          }
        } else {
          // ── Destructive tool: confirm action first, then call ──
          const message = formatToolAction(toolName, toolArgs);
          const approved = await confirmFn(message);
          if (!approved) {
            output = { error: "User explicitly declined this action. Do not retry or re-request this tool call." };
            responseParts.push({
              functionResponse: {
                id: fc.id,
                name: toolName,
                response: output,
              },
            });
            continue;
          }

          try {
            const resultText = await router.callTool(toolName, toolArgs, {
              allowPayment: false,
            });
            output = { result: resultText };
            debug(`Tool ${toolName} result: ${resultText}`);
          } catch (callErr) {
            const callMsg =
              callErr instanceof Error ? callErr.message : String(callErr);
            if (
              !callMsg.toLowerCase().includes("402") &&
              !callMsg.toLowerCase().includes("payment required")
            ) {
              throw callErr;
            }

            // Payment required after user already approved the action —
            // show a single combined prompt with cost instead of a bare
            // "requires payment" follow-up.
            let payMessage = formatToolAction(toolName, toolArgs);
            const paymentInfo = router.getLastPaymentInfo();
            if (paymentInfo) {
              payMessage += ` — this will cost ${formatCost(paymentInfo.amount, paymentInfo.asset)}. Approve payment?`;
            } else {
              payMessage += " — this requires payment. Approve?";
            }

            const payApproved = await confirmFn(payMessage);
            if (!payApproved) {
              output = { error: "User explicitly declined payment. Do not retry or re-request this tool call." };
              responseParts.push({
                functionResponse: {
                  id: fc.id,
                  name: toolName,
                  response: output,
                },
              });
              continue;
            }

            const resultText = await router.callTool(toolName, toolArgs, {
              allowPayment: true,
            });
            output = { result: resultText };
            debug(`Tool ${toolName} result: ${resultText}`);
          }
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        debug(`Tool ${toolName} error: ${errorMsg}`);
        output = {
          error: errorMsg,
        };
      }

      responseParts.push({
        functionResponse: { id: fc.id, name: toolName, response: output },
      });
    }

    history.push({ role: "user", parts: responseParts });
  }

  return "(agent reached maximum tool-calling rounds)";
}
