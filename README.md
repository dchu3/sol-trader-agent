# Solana Pay Agent

A demo of **AI agent-to-agent payments** using the [x402](https://x402.org) protocol. Talk to a Gemini-powered CLI agent in plain English — it discovers token-analysis tools on the [svm402.com/mcp](https://svm402.com/mcp) remote [MCP](https://modelcontextprotocol.io) server and automatically pays for them with Solana USDC when the server returns HTTP 402.

## What This Demo Shows

1. **Agent → Remote MCP** — The CLI agent connects to a remote MCP server over HTTP, discovers available tools, and calls them based on your natural-language input.
2. **Automatic x402 Payments** — When a tool call returns HTTP 402, the agent signs a Solana USDC payment and retries — no manual intervention needed.
3. **Confirmation Before Paying** — All tool calls on a remote server require user confirmation, so you always approve before spending.

## Prerequisites

- Node.js 20.18.0+ (required by `@solana/kit`)
- The [svm402.com/mcp](https://svm402.com/mcp) remote MCP server (provides Solana token-analysis tools gated by x402 payments)
- A [Google AI Studio](https://aistudio.google.com/) API key
- A Solana wallet private key (base58-encoded) funded with USDC

## Setup

```bash
git clone https://github.com/dchu3/solana-pay-agent.git
cd solana-pay-agent
npm install
cp .env.example .env   # then fill in your keys
npm run build
```

## Configuration

Edit `.env` with your values:

- `GEMINI_API_KEY` (required): Google Gemini API key
- `REMOTE_MCP_URL` (required): URL of the remote MCP server (recommended: `https://svm402.com/mcp`). x402 payments are handled automatically.
- `SOLANA_PRIVATE_KEY` (required): Base58-encoded Solana wallet private key
- `GEMINI_MODEL` (optional): Gemini model (default: `gemini-3.1-flash-lite-preview`)
- `SOLANA_RPC_URL` (optional): Custom Solana RPC endpoint (avoids public rate limits)
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
> What tokens can you analyse?
> Tell me about <token-name>
> /quit
```

The agent connects to the MCP server, discovers available tools, and uses Gemini to decide which tools to call based on your input. Payments are made automatically via x402 — you'll be asked to confirm before any funds are spent. Type `/quit` or press Ctrl+C to exit.

## Architecture

```
                       ┌─────────────┐        ┌──────────────────┐
  User (CLI) ─────────▶│ Gemini Agent │──HTTP──▶│  Remote MCP Server│
    readline  ◀─────────│  tool loop   │◀───────│  (x402-gated)    │
                       └─────────────┘        └──────────────────┘
                                                      │
                                               402? ──┤
                                                      ▼
                                               Sign USDC payment
                                               (x402 SDK + Solana)
                                               Retry with X-PAYMENT
```

- **`src/index.ts`** — Interactive readline CLI entrypoint
- **`src/agent.ts`** — Gemini agentic loop with function calling
- **`src/mcp-client.ts`** — Remote MCP client over StreamableHTTP with x402 payment support
- **`src/x402-fetch.ts`** — Fetch wrapper that handles x402 payment challenges transparently
- **`src/config.ts`** — Environment variable loading and validation
- **`src/logger.ts`** — Debug logging utility (verbose mode)

## License

MIT
