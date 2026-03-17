# Copilot Instructions

## Build and Run

```bash
npm run build          # TypeScript → dist/ via tsc
npm start              # Run the CLI (node dist/index.js)
```

No test suite or linter is configured.

## Architecture

This is a CLI agent that bridges a user (readline), Google Gemini (LLM), and a remote MCP server (StreamableHTTP with x402 payments):

```
User (readline) → index.ts → agent.ts → Gemini API
                                 ↕
                           mcp-client.ts → Remote MCP server (HTTP + x402)
```

- **`index.ts`** — Readline loop, shutdown handling, confirmation prompts. Maintains a `conversationHistory: Content[]` across turns for multi-turn conversation.
- **`agent.ts`** — Gemini agentic tool-calling loop (max 10 rounds per user message). Converts MCP JSON-Schema to Gemini's FunctionDeclaration format. Manages the read-only allowlist for tool confirmation.
- **`mcp-client.ts`** — Connects to a remote MCP server over StreamableHTTP. Tool calls that return 402 are retried with an x402 payment via `x402-fetch.ts`.
- **`config.ts`** — Loads `.env` via dotenv, validates with Zod.

## Key Conventions

- **ESM with `.js` extensions** — All local imports use `.js` suffixes (e.g., `from "./config.js"`). Node builtins use `node:` prefix.
- **Double quotes** everywhere.
- **Type-only imports** — Use `import type { ... }` when importing only types.
- **Error coercion pattern** — `err instanceof Error ? err.message : String(err)` is used consistently.
- **Env var security** — `SOLANA_PRIVATE_KEY` is used client-side for x402 payment signing; `GEMINI_API_KEY` is never sent to the MCP server.
- **Safe-by-default confirmation** — A `READ_ONLY_TOOLS` allowlist in `agent.ts` determines which tools skip confirmation. Any tool NOT in this set requires user approval, so newly added MCP tools are safe by default.
- **Conventional commits** — Use `feat:`, `fix:`, `docs:` prefixes. Always create feature/fix branches; never push directly to `main`.

## Git Workflow

Never push directly to `main`. Always create a feature or fix branch (e.g., `feat/my-feature`, `fix/my-bug`) and open a pull request.

## Required Environment Variables

Defined in `.env` (see `.env.example`). Validated by Zod in `config.ts`:

- `GEMINI_API_KEY` — Google Gemini API key
- `REMOTE_MCP_URL` — URL of the remote MCP server (StreamableHTTP)
- `SOLANA_PRIVATE_KEY` — Base58-encoded Solana wallet private key
