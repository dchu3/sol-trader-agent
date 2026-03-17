# Sol Trader Agent

A Gemini-powered CLI agent that **analyses Solana tokens** and **trades on DEXs** via MCP servers. Talk to it in plain English — it discovers tools on a remote [MCP](https://modelcontextprotocol.io) server ([svm402.com/mcp](https://svm402.com/mcp)) for token analysis (paid via [x402](https://x402.org)), and connects to a local [dex-trader-mcp](https://github.com/dchu3/dex-trader-mcp) server for Jupiter DEX trading.

## What This Shows

1. **Token Analysis** — Analyse any Solana token via the remote MCP server. Payments are handled automatically via the x402 protocol.
2. **DEX Trading** — Buy and sell tokens using Jupiter aggregator for best prices across all Solana DEXs.
3. **Multi-MCP Architecture** — The agent connects to multiple MCP servers (remote HTTP + local stdio) and merges their tools into a single unified interface.
4. **Confirmation Before Acting** — All paid and destructive tool calls require user confirmation.

## Prerequisites

- Node.js 20.18.0+ (required by `@solana/kit`)
- The [svm402.com/mcp](https://svm402.com/mcp) remote MCP server (provides Solana token-analysis tools gated by x402 payments)
- A [Google AI Studio](https://aistudio.google.com/) API key
- A Solana wallet private key (base58-encoded) funded with SOL and/or USDC
- (Optional) [dex-trader-mcp](https://github.com/dchu3/dex-trader-mcp) — clone, `npm install && npm run build`, then point `DEX_TRADER_MCP_PATH` at its `dist/index.js`

## Setup

```bash
git clone https://github.com/dchu3/sol-trader-agent.git
cd sol-trader-agent
npm install
cp .env.example .env   # then fill in your keys
npm run build
```

### Setting up dex-trader-mcp (optional)

```bash
git clone https://github.com/dchu3/dex-trader-mcp.git
cd dex-trader-mcp
npm install
npm run build
```

Then set `DEX_TRADER_MCP_PATH` in your `.env` to the absolute path of `dex-trader-mcp/dist/index.js`.

## Configuration

Edit `.env` with your values:

- `GEMINI_API_KEY` (required): Google Gemini API key
- `REMOTE_MCP_URL` (required): URL of the remote MCP server (recommended: `https://svm402.com/mcp`). x402 payments are handled automatically.
- `SOLANA_PRIVATE_KEY` (required): Base58-encoded Solana wallet private key
- `GEMINI_MODEL` (optional): Gemini model (default: `gemini-3.1-flash-lite-preview`)
- `SOLANA_RPC_URL` (optional): Custom Solana RPC endpoint (avoids public rate limits)
- `DEX_TRADER_MCP_PATH` (optional): Path to `dex-trader-mcp/dist/index.js` (enables trading tools)
- `JUPITER_API_BASE` (optional): Jupiter API base URL (forwarded to dex-trader-mcp)
- `JUPITER_API_KEY` (optional): Jupiter API key (forwarded to dex-trader-mcp)
- `VERBOSE` (optional): Set to `true` or `1` to enable debug logging

## Usage

```bash
npm start
```

To enable debug logging (tool calls, MCP responses, errors), use the `--verbose` flag:

```bash
npm start -- --verbose
```

Or set the `VERBOSE` env var:

```bash
VERBOSE=true npm start
```

Debug output is written to stderr so it won't interfere with normal conversation output.

Example prompts:

```
> Analyse the token <mint-address>
> Buy 0.1 SOL worth of <token-address>
> Get a quote for swapping 1 SOL to <token-address>
> Sell all my <token-name>
> What's my balance?
> /quit
```

The agent connects to the MCP servers, discovers available tools, and uses Gemini to decide which tools to call based on your input. Token analysis payments are made automatically via x402 — you'll be asked to confirm. Trading actions (buy/sell) also require confirmation. Type `/quit` or press Ctrl+C to exit.

## Architecture

```
                       ┌─────────────┐        ┌──────────────────┐
  User (CLI) ─────────▶│ Gemini Agent │──HTTP──▶│  Remote MCP Server│
    readline  ◀─────────│  tool loop   │◀───────│  (x402-gated)    │
                       └──────┬──────┘        └──────────────────┘
                              │                       │
                              │                402? ──┤
                              │                       ▼
                              │                Sign USDC payment
                              │                (x402 SDK + Solana)
                              │
                         stdio │
                              │
                       ┌──────▼──────┐
                       │ dex-trader  │
                       │ MCP server  │──── Jupiter API
                       │  (local)    │     (DEX trading)
                       └─────────────┘
```

- **`src/index.ts`** — Interactive readline CLI entrypoint
- **`src/agent.ts`** — Gemini agentic loop with function calling; merges tools from all MCP clients via `ToolRouter`
- **`src/mcp-client.ts`** — Remote MCP client over StreamableHTTP with x402 payment support
- **`src/local-mcp-client.ts`** — Local MCP client that spawns a subprocess and connects via stdio
- **`src/x402-fetch.ts`** — Fetch wrapper that handles x402 payment challenges transparently
- **`src/config.ts`** — Environment variable loading and validation
- **`src/logger.ts`** — Debug logging utility (verbose mode)

## License

MIT
