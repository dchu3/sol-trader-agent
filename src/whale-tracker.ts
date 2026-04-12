import { EventEmitter } from "node:events";
import { debug } from "./logger.js";
import type { WhaleDb, WhaleAlert } from "./whale-db.js";

/** Known Solana DEX program IDs for swap detection. */
const DEX_PROGRAMS = new Set([
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",  // Jupiter v6
  "JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB",  // Jupiter v4
  "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc",  // Orca Whirlpool
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8", // Raydium AMM
  "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK", // Raydium CLMM
  "routeUGWgWzqBWFcrCfv8tritsqukccJPu3q5GPP3xS",  // Raydium route
]);

/** SOL token mint for identifying SOL in swap parsing. */
const SOL_MINT = "So11111111111111111111111111111111111111112";

const DEFAULT_POLL_INTERVAL_MS = 30_000;
const BACKOFF_MULTIPLIER = 2;
const MAX_BACKOFF_MS = 5 * 60 * 1000;

export interface WhaleTrackerConfig {
  pollIntervalMs?: number;
  /** Callback to call a tool via ToolRouter (used for getSignaturesForAddress / getTransaction). */
  callTool: (name: string, args: Record<string, unknown>) => Promise<string>;
  /** Check if a given tool is available. */
  hasTool: (name: string) => boolean;
}

export interface WhaleSwapEvent {
  alert: Omit<WhaleAlert, "alertedAt">;
}

export class WhaleTracker extends EventEmitter {
  private db: WhaleDb;
  private config: WhaleTrackerConfig;
  private pollIntervalMs: number;
  private currentBackoff: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private polling = false;

  constructor(db: WhaleDb, config: WhaleTrackerConfig) {
    super();
    this.db = db;
    this.config = config;
    this.pollIntervalMs = config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.currentBackoff = this.pollIntervalMs;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.currentBackoff = this.pollIntervalMs;
    debug("Whale tracker started");
    this.schedulePoll(0);
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    debug("Whale tracker stopped");
  }

  isRunning(): boolean {
    return this.running;
  }

  private schedulePoll(delayMs: number): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      this.pollAll().catch((err) => {
        debug(`Whale tracker poll error: ${err instanceof Error ? err.message : String(err)}`);
      });
    }, delayMs);
  }

  private async pollAll(): Promise<void> {
    if (!this.running || this.polling) return;
    this.polling = true;

    try {
      const wallets = this.db.listWallets();
      if (wallets.length === 0) {
        this.currentBackoff = this.pollIntervalMs;
        return;
      }

      if (!this.config.hasTool("getSignaturesForAddress")) {
        debug("Whale tracker: getSignaturesForAddress not available, skipping poll");
        this.currentBackoff = this.pollIntervalMs;
        return;
      }

      let hadError = false;
      for (const wallet of wallets) {
        if (!this.running) break;
        try {
          await this.pollWallet(wallet.address, wallet.label);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes("429") || msg.toLowerCase().includes("rate limit")) {
            debug(`Whale tracker rate limited, backing off`);
            hadError = true;
            break;
          }
          debug(`Whale tracker error for ${wallet.address}: ${msg}`);
        }
      }

      if (hadError) {
        this.currentBackoff = Math.min(this.currentBackoff * BACKOFF_MULTIPLIER, MAX_BACKOFF_MS);
        debug(`Whale tracker backoff: ${this.currentBackoff}ms`);
      } else {
        this.currentBackoff = this.pollIntervalMs;
      }

      // Purge old alerts periodically
      this.db.purgeOldAlerts();
    } finally {
      this.polling = false;
      this.schedulePoll(this.currentBackoff);
    }
  }

  private async pollWallet(address: string, label: string): Promise<void> {
    const cursor = this.db.getCursor(address);
    const args: Record<string, unknown> = {
      address,
      limit: 20,
    };
    if (cursor) {
      args.until = cursor;
    }

    const resultText = await this.config.callTool("getSignaturesForAddress", args);

    let signatures: Array<{ signature: string; blockTime?: number }>;
    try {
      const parsed = JSON.parse(resultText);
      signatures = Array.isArray(parsed) ? parsed : [];
    } catch {
      // Try to extract signatures from text format
      const sigMatches = resultText.match(/[A-Za-z0-9]{87,88}/g);
      signatures = (sigMatches ?? []).map((s) => ({ signature: s }));
    }

    if (signatures.length === 0) return;

    // Update cursor to newest signature
    this.db.setCursor(address, signatures[0].signature);

    // Process each new signature
    for (const sig of signatures) {
      if (this.db.hasAlert(sig.signature)) continue;

      try {
        const swap = await this.parseSwapTransaction(sig.signature, address, label);
        if (swap) {
          this.db.addAlert(swap);
          this.emit("alert", {
            alert: swap,
          } satisfies WhaleSwapEvent);
        }
      } catch (err) {
        debug(`Failed to parse tx ${sig.signature}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  private async parseSwapTransaction(
    signature: string,
    walletAddress: string,
    walletLabel: string,
  ): Promise<Omit<WhaleAlert, "alertedAt"> | null> {
    if (!this.config.hasTool("getTransaction")) {
      // Without getTransaction, we can't parse — emit a generic alert
      return {
        signature,
        walletAddress,
        walletLabel,
        tokenAddress: "unknown",
        tokenSymbol: "",
        action: "unknown",
        solAmount: "0",
        timestamp: Date.now(),
      };
    }

    const txText = await this.config.callTool("getTransaction", {
      signature,
      maxSupportedTransactionVersion: 0,
    });

    let tx: Record<string, unknown>;
    try {
      tx = JSON.parse(txText);
    } catch {
      return null;
    }

    // Check if transaction interacts with known DEX programs
    const meta = tx.meta as Record<string, unknown> | undefined;
    const message = (tx.transaction as Record<string, unknown>)?.message as Record<string, unknown> | undefined;

    if (!meta || !message) return null;

    // Check for DEX program invocations in log messages
    const logMessages = (meta.logMessages ?? []) as string[];
    const isDexTx = logMessages.some((log) =>
      [...DEX_PROGRAMS].some((prog) => log.includes(prog)),
    );

    if (!isDexTx) return null;

    // Parse pre/post token balances to determine action and token
    const preBalances = (meta.preTokenBalances ?? []) as Array<Record<string, unknown>>;
    const postBalances = (meta.postTokenBalances ?? []) as Array<Record<string, unknown>>;

    // Find token balance changes for the wallet
    let tokenAddress = "unknown";
    let action: "buy" | "sell" | "unknown" = "unknown";
    let solAmount = "0";

    // Check SOL balance change (pre/postBalances are lamport arrays)
    const preSolBalances = (meta.preBalances ?? []) as number[];
    const postSolBalances = (meta.postBalances ?? []) as number[];
    const accountKeys = ((message.accountKeys ?? []) as Array<string | Record<string, unknown>>);

    const walletIdx = accountKeys.findIndex((k) => {
      const key = typeof k === "string" ? k : (k as Record<string, unknown>).pubkey;
      return key === walletAddress;
    });

    if (walletIdx >= 0 && preSolBalances[walletIdx] !== undefined) {
      const solDiff = (postSolBalances[walletIdx] ?? 0) - preSolBalances[walletIdx];
      solAmount = Math.abs(solDiff / 1e9).toFixed(4);
    }

    // Find non-SOL token changes to determine what was bought/sold
    for (const post of postBalances) {
      const mint = post.mint as string;
      if (mint === SOL_MINT) continue;

      const owner = post.owner as string;
      if (owner !== walletAddress) continue;

      const postAmount = parseFloat((post.uiTokenAmount as Record<string, unknown>)?.uiAmountString as string ?? "0");
      const pre = preBalances.find((p) => (p.mint as string) === mint && (p.owner as string) === walletAddress);
      const preAmount = pre
        ? parseFloat((pre.uiTokenAmount as Record<string, unknown>)?.uiAmountString as string ?? "0")
        : 0;

      if (postAmount > preAmount) {
        action = "buy";
        tokenAddress = mint;
        break;
      } else if (postAmount < preAmount) {
        action = "sell";
        tokenAddress = mint;
        break;
      }
    }

    if (tokenAddress === "unknown") return null;

    const blockTime = (tx.blockTime as number) ?? 0;

    return {
      signature,
      walletAddress,
      walletLabel,
      tokenAddress,
      tokenSymbol: "",
      action,
      solAmount,
      timestamp: blockTime ? blockTime * 1000 : Date.now(),
    };
  }
}
