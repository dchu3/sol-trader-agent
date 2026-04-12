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
import type { TokenCache } from "./token-cache.js";
import { CACHEABLE_TOOLS } from "./token-cache.js";

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
    options?: { allowPayment?: boolean; skipUnpaidProbe?: boolean },
  ): Promise<string>;
  /** Get payment info from the last remote MCP 402 probe (if any). */
  getLastPaymentInfo(): { amount: string; asset: string } | null;
}

/**
 * Build a ToolRouter that merges tools from a remote MCP client and zero or
 * more local MCP clients, routing calls to the correct backend.
 */
export function createToolRouter(
  remoteMcpClient: McpClient,
  localMcpClients: LocalMcpClient[] = [],
): ToolRouter {
  // Map each tool name → the local client that owns it
  const localToolOwner = new Map<string, LocalMcpClient>();
  const localToolNames = new Set<string>();

  for (const client of localMcpClients) {
    for (const tool of client.tools) {
      if (localToolNames.has(tool.name)) {
        throw new Error(
          `Tool name collision between local MCP servers: ${tool.name}. ` +
            "Each tool name must be unique across all connected MCP servers.",
        );
      }
      localToolNames.add(tool.name);
      localToolOwner.set(tool.name, client);
    }
  }

  const remoteToolNames = new Set(remoteMcpClient.tools.map((t) => t.name));
  const collisions = [...localToolNames].filter((n) => remoteToolNames.has(n));
  if (collisions.length > 0) {
    throw new Error(
      `Tool name collision between remote and local MCP servers: ${collisions.join(", ")}. ` +
        "Each tool name must be unique across all connected MCP servers.",
    );
  }

  const allTools: Tool[] = [
    ...remoteMcpClient.tools,
    ...localMcpClients.flatMap((c) => c.tools),
  ];

  return {
    tools: allTools,

    async callTool(name, args, options) {
      const localClient = localToolOwner.get(name);
      if (localClient) {
        return localClient.callTool(name, args);
      }
      return remoteMcpClient.callTool(name, args, options);
    },

    getLastPaymentInfo() {
      return remoteMcpClient.getLastPaymentInfo();
    },
  };
}

/** Output channel so the system prompt can request channel-appropriate formatting. */
export type Channel = "cli" | "telegram";

const TELEGRAM_FORMAT_ADDENDUM = `

FORMATTING RULES (you MUST follow these for every response):
- Use Telegram HTML: <b>bold</b>, <i>italic</i>, <code>code</code>. Do NOT use Markdown (**bold**, *italic*, \`code\`).
- Use emoji section headers for visual hierarchy (e.g. 📊 Summary, ⚠️ Risks, 💡 Verdict).
- Keep bullet points short — one line each, no filler sentences.
- Separate sections with a blank line for readability.
- Never wrap the whole message in a code block.
- Do NOT escape special characters like <, >, or & — they will be escaped automatically.`;

const SYSTEM_INSTRUCTION = (walletAddress: string, toolNames: string[], channel: Channel = "cli") => {
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

  if (toolSet.has("search_pairs"))
    capabilities.push(
      "- Search for token pairs on DexScreener by name, symbol, or address (search_pairs)",
    );
  if (toolSet.has("get_latest_token_profiles"))
    capabilities.push("- Get the latest token profiles from DexScreener (get_latest_token_profiles)");
  if (toolSet.has("get_latest_boosted_tokens"))
    capabilities.push("- Get the latest boosted tokens on DexScreener (get_latest_boosted_tokens)");
  if (toolSet.has("get_top_boosted_tokens"))
    capabilities.push("- Get the most actively boosted tokens on DexScreener (get_top_boosted_tokens)");
  if (toolSet.has("get_token_pools"))
    capabilities.push("- Get pools/pairs for a token on a specific chain (get_token_pools)");
  if (toolSet.has("get_tokens_by_address"))
    capabilities.push("- Look up token data by address on a specific chain (get_tokens_by_address)");
  if (toolSet.has("get_pairs_by_chain_and_pair"))
    capabilities.push("- Get pair data by chain and pair address (get_pairs_by_chain_and_pair)");
  if (toolSet.has("get_token_orders"))
    capabilities.push("- Check paid orders for a token on DexScreener (get_token_orders)");
  if (toolSet.has("get_latest_community_takeovers"))
    capabilities.push("- Get the latest community takeover tokens on DexScreener (get_latest_community_takeovers)");
  if (toolSet.has("get_latest_ads"))
    capabilities.push("- Get the latest promoted/advertised tokens on DexScreener (get_latest_ads)");

  // dex-rugcheck-mcp tools
  if (toolSet.has("get_token_summary"))
    capabilities.push(
      "- Get a RugCheck safety report for a Solana token: rug risk score, contract analysis, liquidity assessment (get_token_summary) — FREE, no payment required",
    );

  // solana-rpc-mcp tools
  if (toolSet.has("getTokenSupply"))
    capabilities.push("- Query Solana token supply (getTokenSupply)");
  if (toolSet.has("getTokenLargestAccounts"))
    capabilities.push("- Get the largest token holders for a mint (getTokenLargestAccounts)");
  if (toolSet.has("getTokenAccountBalance"))
    capabilities.push("- Get token account balance (getTokenAccountBalance)");
  if (toolSet.has("getTokenAccountsByOwner"))
    capabilities.push("- Get all token accounts for a wallet (getTokenAccountsByOwner)");
  if (toolSet.has("getSignaturesForAddress"))
    capabilities.push("- Get recent transaction signatures for an address (getSignaturesForAddress)");
  if (toolSet.has("getTransaction"))
    capabilities.push("- Get full transaction details by signature (getTransaction)");
  if (toolSet.has("getAccountInfo"))
    capabilities.push("- Get account info (owner, lamports, data) for a public key (getAccountInfo)");
  if (toolSet.has("getBalance"))
    capabilities.push("- Query raw SOL balance in lamports for any arbitrary public key via Solana RPC (getBalance — use get_balance for your own wallet)");
  if (toolSet.has("getBlock"))
    capabilities.push("- Get block data by slot (getBlock)");
  if (toolSet.has("getBlockHeight"))
    capabilities.push("- Get current block height (getBlockHeight)");
  if (toolSet.has("getLatestBlockhash"))
    capabilities.push("- Get latest blockhash (getLatestBlockhash)");
  if (toolSet.has("getEpochInfo"))
    capabilities.push("- Get current epoch info (getEpochInfo)");
  if (toolSet.has("getMultipleAccounts"))
    capabilities.push("- Get info for multiple accounts in one call (getMultipleAccounts)");
  if (toolSet.has("getProgramAccounts"))
    capabilities.push("- Get all accounts owned by a program (getProgramAccounts)");
  if (toolSet.has("getSignatureStatuses"))
    capabilities.push("- Get confirmation status of transactions (getSignatureStatuses)");
  if (toolSet.has("getBlockTime"))
    capabilities.push("- Get estimated production time for a block (getBlockTime)");
  if (toolSet.has("getClusterNodes"))
    capabilities.push("- Get info about cluster validator nodes (getClusterNodes)");
  if (toolSet.has("getVersion"))
    capabilities.push("- Get Solana node software version (getVersion)");
  if (toolSet.has("getHealth"))
    capabilities.push("- Check Solana cluster health (getHealth)");

  // whale tracking tools
  if (toolSet.has("watch_wallet"))
    capabilities.push(
      "- Add a wallet to the whale watch list for real-time DEX swap monitoring (watch_wallet)",
    );
  if (toolSet.has("unwatch_wallet"))
    capabilities.push("- Remove a wallet from the whale watch list (unwatch_wallet)");
  if (toolSet.has("list_watched_wallets"))
    capabilities.push("- List all currently watched whale wallets (list_watched_wallets)");
  if (toolSet.has("get_whale_alerts"))
    capabilities.push("- Get recent whale alerts — DEX swaps from watched wallets (get_whale_alerts)");

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
    // dex-screener-mcp tools
    "search_pairs",
    "get_latest_token_profiles",
    "get_latest_boosted_tokens",
    "get_top_boosted_tokens",
    "get_token_pools",
    "get_tokens_by_address",
    "get_pairs_by_chain_and_pair",
    "get_token_orders",
    "get_latest_community_takeovers",
    "get_latest_ads",
    // dex-rugcheck-mcp tools
    "get_token_summary",
    // solana-rpc-mcp tools
    "getBalance",
    "getAccountInfo",
    "getMultipleAccounts",
    "getProgramAccounts",
    "getTransaction",
    "getSignaturesForAddress",
    "getSignatureStatuses",
    "getBlock",
    "getBlockHeight",
    "getLatestBlockhash",
    "getBlockTime",
    "getTokenAccountBalance",
    "getTokenAccountsByOwner",
    "getTokenSupply",
    "getTokenLargestAccounts",
    "getClusterNodes",
    "getEpochInfo",
    "getVersion",
    "getHealth",
    // whale tracking tools
    "watch_wallet",
    "unwatch_wallet",
    "list_watched_wallets",
    "get_whale_alerts",
  ]);
  const unknownTools = toolNames.filter((t) => !knownTools.has(t));
  if (unknownTools.length > 0) {
    capabilities.push(`- Use these tools: ${unknownTools.join(", ")}`);
  }

  return `You are a helpful Solana trading assistant. The user's wallet address is: ${walletAddress}

You have access to tools that let you:
${capabilities.join("\n")}

When the user refers to "my wallet", "my balance", or similar, use their wallet address shown above. When the user asks you to perform an action, use the appropriate tool. Always confirm amounts and addresses before executing transactions. Report results clearly.

IMPORTANT: Only use tools that are explicitly available to you. Do NOT attempt to call tools that are not in your function declarations. If analyze_token requires payment, it is handled automatically — never send USDC manually to pay for tool access. When the user wants to trade (buy/sell tokens), use the Jupiter-powered trading tools. Always suggest previewing a trade with get_quote before executing buy_token or sell_token.

TOKEN ANALYSIS WORKFLOW: When a user asks you to analyse or research a token, gather FREE data first before suggesting the paid analyze_token tool. Follow this order when the tools are available:
1. DexScreener (search_pairs, get_token_pools, get_tokens_by_address) — market data, pairs, volume, liquidity
2. RugCheck (get_token_summary) — safety report, rug risk score, contract analysis
3. Solana RPC (getTokenSupply, getTokenLargestAccounts, getSignaturesForAddress) — on-chain supply, top holders, recent activity
4. Jupiter quote (get_quote) — current price and route
Present this free data as an initial summary, then offer to run analyze_token for a deeper paid analysis via svm402 if the user wants more detail.

ORGANIC TOKEN HUNTING: When a user asks you to find organic tokens, hunt for fresh gems, or vet tokens for wash trading / manipulation, follow this methodology:

Core Criteria (evaluate in order):
1. Transaction Density — Organic tokens have many individual transactions relative to market cap. High organic: >5,000 txs in 24h for a sub-$1M MC token. Manipulated: high dollar volume ($5M+) but very low tx count (<500).
2. Unique Wallet Count — Use analyze_token or getSignaturesForAddress to verify unique wallet participation. Organic: hundreds or thousands of unique wallets. Wash traded: very few wallets (1-30) responsible for millions in volume.
3. Volume-to-Liquidity Ratio — Healthy: volume is 1x-5x the liquidity. Danger: volume >50x the liquidity (likely a liquidity trap or wash trading).
4. Narrative & Longevity — Favour tokens tied to real-world events or established viral trends. Favour tokens that have held a price floor for >48 hours over brand-new tokens.

Workflow:
1. Discovery: Call get_top_boosted_tokens and get_latest_community_takeovers to find candidates.
2. Filtering: Filter results by the user's preferred market cap range. If not specified, default to $100K-$5M.
3. Primary Vetting: Use DexScreener data (search_pairs, get_token_pools) to check transaction count, volume, liquidity, and volume-to-liquidity ratio.
4. Deep Analysis: Call analyze_token for the single most promising candidate first.
   Present the result and ask the user whether to analyse additional candidates.
   Do NOT call analyze_token for multiple tokens in a single response — wait for explicit user approval per token.
   Also call get_token_summary for each candidate before suggesting paid analysis.
5. Reporting: Present each candidate with a clear Organic Score (1-10) based on the criteria above, along with key metrics.

EFFICIENCY: Batch multiple independent tool calls into a single turn whenever possible (e.g. search_pairs + get_token_summary together) to minimize round-trips.

CACHED DATA: Some tool results are cached locally to avoid duplicate API calls and save costs. When you receive a tool result prefixed with [CACHED — fetched X minutes ago], this means the data was retrieved previously and served from cache. Present the cached data to the user, clearly noting how old it is, and ask if they would like you to fetch fresh data. If they say yes, simply call the same tool again — the cache will automatically serve fresh data on the second request.

SAFETY (hard rules — NEVER recommend a token with any of these):
- Less than 90% LP locked
- A "High Risk" score from svm402 analyze_token
- Active distribution / whale dumping signals
If a token fails any safety check, explicitly flag it as unsafe and explain why.

WHALE TRACKING: When analysing a token, after checking top holders via getTokenLargestAccounts:
1. Identify wallets holding >2% of supply — these are significant holders worth monitoring.
2. Suggest the user watch interesting whale wallets using watch_wallet with a descriptive label (e.g. "Top Holder #1 — 5.2% supply").
3. When the user asks to follow, track, or copy-trade a wallet, use watch_wallet to add it.
4. The whale tracker runs in the background and will alert the user when watched wallets make DEX swaps.
5. Use get_whale_alerts to show recent whale activity when asked.${channel === "telegram" ? TELEGRAM_FORMAT_ADDENDUM : ""}`;
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
  // dex-screener-mcp tools (all read-only, public DexScreener API)
  "search_pairs",
  "get_latest_token_profiles",
  "get_latest_boosted_tokens",
  "get_top_boosted_tokens",
  "get_token_pools",
  "get_tokens_by_address",
  "get_pairs_by_chain_and_pair",
  "get_token_orders",
  "get_latest_community_takeovers",
  "get_latest_ads",
  // dex-rugcheck-mcp tools (read-only, public RugCheck API)
  "get_token_summary",
  // solana-rpc-mcp tools (all read-only RPC queries)
  "getBalance",
  "getAccountInfo",
  "getMultipleAccounts",
  "getProgramAccounts",
  "getTransaction",
  "getSignaturesForAddress",
  "getSignatureStatuses",
  "getBlock",
  "getBlockHeight",
  "getLatestBlockhash",
  "getBlockTime",
  "getTokenAccountBalance",
  "getTokenAccountsByOwner",
  "getTokenSupply",
  "getTokenLargestAccounts",
  "getClusterNodes",
  "getEpochInfo",
  "getVersion",
  "getHealth",
  // whale tracking tools (read-only: watch/unwatch modify the local DB, not the blockchain)
  "watch_wallet",
  "unwatch_wallet",
  "list_watched_wallets",
  "get_whale_alerts",
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

/** Format a payment amount for display (e.g. "0.10 USDC"). */
function formatCost(amount: string, asset: string): string {
  if (KNOWN_USDC_MINTS.has(asset)) {
    if (!/^\d+$/.test(amount)) {
      return `${amount} USDC`;
    }
    // String-based decimal shift to avoid Number exponential notation for tiny values.
    const raw = amount.replace(/^0+/, "") || "0";
    const padded = raw.padStart(USDC_DECIMALS + 1, "0");
    const whole = padded.slice(0, -USDC_DECIMALS);
    const frac = padded.slice(-USDC_DECIMALS);
    // Trim trailing zeros but keep at least 2 decimal places
    const trimmed = frac.replace(/0+$/, "").padEnd(2, "0");
    return `${whole}.${trimmed} USDC`;
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
const MAX_TOOL_CALLS_PER_MESSAGE = 30;
const MAX_FUNCTION_CALLS_PER_ROUND = 8;
const MAX_CONSECUTIVE_FAILURES = 2;
const MAX_HISTORY_ENTRIES = 100;

/**
 * Trim conversation history to prevent unbounded growth.
 * Keeps the most recent entries, inserting a marker where older entries were removed.
 */
function trimHistory(history: Content[]): void {
  if (history.length <= MAX_HISTORY_ENTRIES) return;
  const keep = MAX_HISTORY_ENTRIES - 1;
  const trimmed = [
    { role: "user" as const, parts: [{ text: "[Earlier conversation history was trimmed to save context.]" }] },
    ...history.slice(-keep),
  ];
  history.length = 0;
  history.push(...trimmed);
}

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
  channel: Channel = "cli",
  cache?: TokenCache,
): Promise<string> {
  const ai = new GoogleGenAI({ apiKey });

  const functionDeclarations = mcpToolsToGeminiDeclarations(router);
  const toolNames = router.tools.map((t) => t.name);

  trimHistory(history);
  history.push({ role: "user", parts: [{ text: userMessage }] });

  let totalToolCalls = 0;
  const toolFailureCounts = new Map<string, number>();
  const declinedTools = new Set<string>();

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    debug(`Agent loop round ${round + 1}/${MAX_TOOL_ROUNDS}`);

    // On the last round, strip tool declarations to force a text summary
    const isLastToolRound = round === MAX_TOOL_ROUNDS - 1;
    const response = await ai.models.generateContent({
      model,
      contents: history,
      config: {
        systemInstruction: SYSTEM_INSTRUCTION(walletAddress, toolNames, channel),
        tools: isLastToolRound ? [] : [{ functionDeclarations }],
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
    const cappedCalls = functionCalls.slice(0, MAX_FUNCTION_CALLS_PER_ROUND);
    if (functionCalls.length > MAX_FUNCTION_CALLS_PER_ROUND) {
      debug(`Capped function calls from ${functionCalls.length} to ${MAX_FUNCTION_CALLS_PER_ROUND}`);
    }
    const responseParts: Part[] = [];

    // Generate stub responses for dropped calls to maintain Gemini's 1:1 functionCall/functionResponse pairing
    for (const dc of functionCalls.slice(MAX_FUNCTION_CALLS_PER_ROUND)) {
      responseParts.push({
        functionResponse: {
          id: dc.id,
          name: dc.name ?? "unknown",
          response: { error: "Skipped: per-round function call cap reached." },
        },
      });
    }
    for (const fc of cappedCalls) {
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

      // Check per-message tool call budget
      totalToolCalls++;
      if (totalToolCalls > MAX_TOOL_CALLS_PER_MESSAGE) {
        debug(`Tool call budget exhausted (${MAX_TOOL_CALLS_PER_MESSAGE})`);
        responseParts.push({
          functionResponse: {
            id: fc.id,
            name: toolName,
            response: {
              error: `Tool call limit (${MAX_TOOL_CALLS_PER_MESSAGE}) reached for this request. ` +
                "Summarise what you have gathered so far and present it to the user.",
            },
          },
        });
        continue;
      }

      // Block tools the user previously declined this message
      if (declinedTools.has(toolName)) {
        responseParts.push({
          functionResponse: {
            id: fc.id,
            name: toolName,
            response: { error: "This tool was declined by the user and is blocked for this message." },
          },
        });
        continue;
      }

      // Circuit breaker: block tools that have failed too many times
      const failCount = toolFailureCounts.get(toolName) ?? 0;
      if (failCount >= MAX_CONSECUTIVE_FAILURES) {
        responseParts.push({
          functionResponse: {
            id: fc.id,
            name: toolName,
            response: {
              error: `${toolName} has failed ${failCount} times. Do NOT call it again. ` +
                "Use alternative tools or summarise what you have so far.",
            },
          },
        });
        continue;
      }

      debug(`Calling tool: ${toolName}(${JSON.stringify(toolArgs)})`);

      let output: Record<string, unknown>;
      try {
        // ── Cache check for cacheable tools ──
        if (cache && CACHEABLE_TOOLS.has(toolName)) {
          try {
            const cached = cache.get(toolName, toolArgs);
            if (cached && !cached.stale) {
              const ageMs = Date.now() - cached.createdAt;
              const ageMin = Math.round(ageMs / 60_000);
              const ageLabel = ageMin < 1 ? "less than a minute" : `${ageMin} minute${ageMin === 1 ? "" : "s"}`;
              debug(`Cache hit for ${toolName} (age: ${ageLabel}, stale: false)`);
              cache.markStale(toolName, toolArgs);
              output = { result: `[CACHED — fetched ${ageLabel} ago] ${cached.result}` };
              responseParts.push({
                functionResponse: { id: fc.id, name: toolName, response: output },
              });
              continue;
            }
            if (cached?.stale) {
              debug(`Cache hit for ${toolName} but stale — bypassing cache`);
            }
          } catch (cacheErr) {
            debug(`Cache read error for ${toolName}, falling through to live call: ${cacheErr instanceof Error ? cacheErr.message : String(cacheErr)}`);
          }
        }

        if (READ_ONLY_TOOLS.has(toolName)) {
          // ── Read-only: call directly, no confirmation, no payment ──
          const resultText = await router.callTool(toolName, toolArgs, {
            allowPayment: false,
          });
          output = { result: resultText };
          toolFailureCounts.delete(toolName);
          debug(`Tool ${toolName} result: ${resultText}`);
        } else if (PROBE_SAFE_TOOLS.has(toolName)) {
          // ── Non-destructive paid tool: probe for cost, confirm with cost ──
          try {
            const resultText = await router.callTool(toolName, toolArgs, {
              allowPayment: false,
            });
            // Succeeded without payment
            output = { result: resultText };
            toolFailureCounts.delete(toolName);
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
              declinedTools.add(toolName);
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
              skipUnpaidProbe: true,
            });
            output = { result: resultText };
            toolFailureCounts.delete(toolName);
            debug(`Tool ${toolName} result: ${resultText}`);
          }
        } else {
          // ── Destructive tool: confirm action first, then call ──
          const message = formatToolAction(toolName, toolArgs);
          const approved = await confirmFn(message);
          if (!approved) {
            declinedTools.add(toolName);
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
            toolFailureCounts.delete(toolName);
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
              declinedTools.add(toolName);
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
              skipUnpaidProbe: true,
            });
            output = { result: resultText };
            toolFailureCounts.delete(toolName);
            debug(`Tool ${toolName} result: ${resultText}`);
          }
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        const newFailCount = (toolFailureCounts.get(toolName) ?? 0) + 1;
        toolFailureCounts.set(toolName, newFailCount);
        debug(`Tool ${toolName} error (failure ${newFailCount}): ${errorMsg}`);
        output = {
          error: newFailCount >= MAX_CONSECUTIVE_FAILURES
            ? `${errorMsg} — This tool has failed ${newFailCount} times. Do NOT call it again. Summarise what you have so far.`
            : errorMsg,
        };
      }

      // Store successful results in cache for cacheable tools
      if (cache && CACHEABLE_TOOLS.has(toolName) && "result" in output) {
        try {
          cache.set(toolName, toolArgs, output.result as string);
        } catch (cacheErr) {
          debug(`Cache write error for ${toolName}: ${cacheErr instanceof Error ? cacheErr.message : String(cacheErr)}`);
        }
      }

      responseParts.push({
        functionResponse: { id: fc.id, name: toolName, response: output },
      });
    }

    // Warn the model when approaching the round budget
    if (round === MAX_TOOL_ROUNDS - 2) {
      responseParts.push({
        text: "SYSTEM: You have 1 tool-calling round remaining. You MUST produce your final text " +
          "summary on the next turn using data already gathered. Do NOT call any more tools.",
      });
    }

    history.push({ role: "user", parts: responseParts });
  }

  return "(agent reached maximum tool-calling rounds)";
}
