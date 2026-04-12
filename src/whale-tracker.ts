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
const MAX_ALERTS_PER_WINDOW = 15;
const MAX_ALERTS_PER_POLL = 20;
const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;

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

export interface WhaleRateLimitEvent {
  address: string;
  label: string;
  count: number;
}

export interface WhaleWalletPausedEvent {
  address: string;
  label: string;
  reason: string;
}

export class WhaleTracker extends EventEmitter {
  private db: WhaleDb;
  private config: WhaleTrackerConfig;
  private pollIntervalMs: number;
  private currentBackoff: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private polling = false;
  private pollPromise: Promise<void> | null = null;
  private alertCounts = new Map<string, { count: number; windowStart: number }>();

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

  /** Wait for any in-flight poll to finish before closing resources. */
  async drain(): Promise<void> {
    this.stop();
    if (this.pollPromise) {
      await this.pollPromise;
    }
  }

  isRunning(): boolean {
    return this.running;
  }

  private schedulePoll(delayMs: number): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      this.pollPromise = this.pollAll().catch((err) => {
        debug(`Whale tracker poll error: ${err instanceof Error ? err.message : String(err)}`);
      });
    }, delayMs);
  }

  private async pollAll(): Promise<void> {
    if (!this.running || this.polling) return;
    this.polling = true;

    try {
      const wallets = this.db.listActiveWallets();
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
      if (this.running) this.db.purgeOldAlerts();
    } finally {
      this.polling = false;
      if (this.running) this.schedulePoll(this.currentBackoff);
    }
  }

  private async pollWallet(address: string, label: string): Promise<void> {
    const now = Date.now();
    const entry = this.alertCounts.get(address);
    if (entry) {
      if (now - entry.windowStart >= RATE_LIMIT_WINDOW_MS) {
        this.alertCounts.set(address, { count: 0, windowStart: now });
      } else if (entry.count >= MAX_ALERTS_PER_WINDOW) {
        this.emit("rate-limited", { address, label, count: entry.count } satisfies WhaleRateLimitEvent);
        this.db.pauseWallet(address);
        this.emit("wallet-paused", { address, label, reason: "rate-limited" } satisfies WhaleWalletPausedEvent);
        return;
      }
    } else {
      this.alertCounts.set(address, { count: 0, windowStart: now });
    }

    const cursor = this.db.getCursor(address);
    const limit = 20;
    const args: Record<string, unknown> = {
      address,
      limit,
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
      const sigMatches = resultText.match(/[A-Za-z0-9]{87,88}/g);
      signatures = (sigMatches ?? []).map((s) => ({ signature: s }));
    }

    if (signatures.length === 0) return;

    // First poll: seed cursor without processing historical transactions
    if (!cursor) {
      this.db.setCursor(address, signatures[0].signature);
      debug(`Whale tracker: seeded cursor for ${address}, skipping ${signatures.length} historical tx(s)`);
      return;
    }

    // Paginate: fetch remaining signatures if we hit the limit
    while (signatures.length > 0 && signatures.length % limit === 0 && this.running) {
      const lastSig = signatures[signatures.length - 1].signature;
      const moreText = await this.config.callTool("getSignaturesForAddress", {
        address,
        limit,
        before: lastSig,
        until: cursor,
      });
      let moreSigs: Array<{ signature: string; blockTime?: number }>;
      try {
        const parsed = JSON.parse(moreText);
        moreSigs = Array.isArray(parsed) ? parsed : [];
      } catch {
        break;
      }
      if (moreSigs.length === 0) break;
      signatures.push(...moreSigs);
    }

    // Update cursor to newest signature
    this.db.setCursor(address, signatures[0].signature);

    // Process each new signature
    let alertsThisPoll = 0;
    for (const sig of signatures) {
      if (!this.running) break;
      if (alertsThisPoll >= MAX_ALERTS_PER_POLL) break;
      if (this.db.hasAlert(sig.signature)) continue;

      try {
        const swap = await this.parseSwapTransaction(sig.signature, address, label);
        if (swap) {
          this.db.addAlert(swap);
          this.emit("alert", {
            alert: swap,
          } satisfies WhaleSwapEvent);
          alertsThisPoll++;
          const entry = this.alertCounts.get(address);
          if (entry) entry.count++;
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
      const parsed = JSON.parse(txText);
      if (!parsed || typeof parsed !== "object") return null;
      tx = parsed as Record<string, unknown>;
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

    // Detect full sells: tokens in preBalances but absent from postBalances (ATA closed)
    if (tokenAddress === "unknown") {
      for (const pre of preBalances) {
        const mint = pre.mint as string;
        if (mint === SOL_MINT) continue;

        const owner = pre.owner as string;
        if (owner !== walletAddress) continue;

        const preAmount = parseFloat((pre.uiTokenAmount as Record<string, unknown>)?.uiAmountString as string ?? "0");
        if (preAmount <= 0) continue;

        const inPost = postBalances.some((p) => (p.mint as string) === mint && (p.owner as string) === walletAddress);
        if (!inPost) {
          action = "sell";
          tokenAddress = mint;
          break;
        }
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
