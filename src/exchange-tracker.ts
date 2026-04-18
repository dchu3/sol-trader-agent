import { EventEmitter } from "node:events";
import { debug } from "./logger.js";
import type { ExchangeDb, ExchangeTransfer, ExchangeWalletType, TransferType } from "./exchange-db.js";

const DEFAULT_POLL_INTERVAL_MS = 30_000;
const BACKOFF_MULTIPLIER = 2;
const MAX_BACKOFF_MS = 5 * 60 * 1000;
const MAX_ALERTS_PER_WINDOW = 10;
const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;
const LAMPORTS_PER_SOL = 1_000_000_000;

export interface ExchangeTrackerConfig {
  /** Minimum SOL amount to trigger an alert (default: 1000). */
  minSolAmount?: number;
  pollIntervalMs?: number;
  /** Callback to call a tool via ToolRouter. */
  callTool: (name: string, args: Record<string, unknown>) => Promise<string>;
  /** Check if a given tool is available. */
  hasTool: (name: string) => boolean;
}

export interface ExchangeTransferEvent {
  transfer: Omit<ExchangeTransfer, "alertedAt">;
}

export interface ExchangeRateLimitEvent {
  address: string;
  label: string;
  count: number;
}

export interface ExchangeWalletPausedEvent {
  address: string;
  label: string;
  reason: string;
}

export class ExchangeTracker extends EventEmitter {
  private db: ExchangeDb;
  private config: ExchangeTrackerConfig;
  private pollIntervalMs: number;
  private minSolAmount: number;
  private currentBackoff: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private polling = false;
  private pollPromise: Promise<void> | null = null;
  private alertCounts = new Map<string, { count: number; windowStart: number }>();

  constructor(db: ExchangeDb, config: ExchangeTrackerConfig) {
    super();
    this.db = db;
    this.config = config;
    this.pollIntervalMs = config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.minSolAmount = config.minSolAmount ?? 1000;
    this.currentBackoff = this.pollIntervalMs;
  }

  resetAlertCount(address: string): void {
    this.alertCounts.delete(address);
    debug(`Exchange tracker: reset rate-limit counter for ${address}`);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.currentBackoff = this.pollIntervalMs;
    debug("Exchange tracker started");
    this.schedulePoll(0);
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    debug("Exchange tracker stopped");
  }

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
        debug(
          `Exchange tracker poll error: ${err instanceof Error ? err.message : String(err)}`,
        );
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
        debug("Exchange tracker: getSignaturesForAddress not available, skipping poll");
        this.currentBackoff = this.pollIntervalMs;
        return;
      }

      let hadError = false;
      for (const wallet of wallets) {
        if (!this.running) break;
        try {
          await this.pollWallet(wallet.address, wallet.exchangeName, wallet.walletType, wallet.label);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes("429") || msg.toLowerCase().includes("rate limit")) {
            debug("Exchange tracker rate limited, backing off");
            hadError = true;
            break;
          }
          debug(`Exchange tracker error for ${wallet.address}: ${msg}`);
        }
      }

      if (hadError) {
        this.currentBackoff = Math.min(
          this.currentBackoff * BACKOFF_MULTIPLIER,
          MAX_BACKOFF_MS,
        );
        debug(`Exchange tracker backoff: ${this.currentBackoff}ms`);
      } else {
        this.currentBackoff = this.pollIntervalMs;
      }

      if (this.running) this.db.purgeOldTransfers();
    } finally {
      this.polling = false;
      if (this.running) this.schedulePoll(this.currentBackoff);
    }
  }

  private async pollWallet(
    address: string,
    exchangeName: string,
    walletType: ExchangeWalletType,
    label: string,
  ): Promise<void> {
    const now = Date.now();
    const entry = this.alertCounts.get(address);
    if (entry) {
      if (now - entry.windowStart >= RATE_LIMIT_WINDOW_MS) {
        this.alertCounts.set(address, { count: 0, windowStart: now });
      } else if (entry.count >= MAX_ALERTS_PER_WINDOW) {
        this.emit("rate-limited", {
          address,
          label,
          count: entry.count,
        } satisfies ExchangeRateLimitEvent);
        this.db.pauseWallet(address);
        this.emit("wallet-paused", {
          address,
          label,
          reason: "rate-limited",
        } satisfies ExchangeWalletPausedEvent);
        return;
      }
    } else {
      this.alertCounts.set(address, { count: 0, windowStart: now });
    }

    const cursor = this.db.getCursor(address);
    const PAGE_SIZE = 100;

    // Paginate until we've fetched all signatures newer than the cursor.
    const signatures: Array<{ signature: string; blockTime?: number }> = [];
    let pageAnchor: string | undefined;

    while (true) {
      const args: Record<string, unknown> = { address, limit: PAGE_SIZE };
      if (pageAnchor) args.before = pageAnchor;
      if (cursor) args.until = cursor;

      const resultText = await this.config.callTool("getSignaturesForAddress", args);

      let page: Array<{ signature: string; blockTime?: number }>;
      try {
        const parsed = JSON.parse(resultText);
        page = Array.isArray(parsed) ? parsed : [];
      } catch {
        const sigMatches = resultText.match(/[A-Za-z0-9]{87,88}/g);
        page = (sigMatches ?? []).map((s) => ({ signature: s }));
      }

      if (page.length === 0) break;
      signatures.push(...page);
      if (page.length < PAGE_SIZE) break; // last page
      pageAnchor = page[page.length - 1].signature;
    }

    if (signatures.length === 0) return;

    // First poll: seed cursor without processing historical transactions
    if (!cursor) {
      this.db.setCursor(address, signatures[0].signature);
      debug(
        `Exchange tracker: seeded cursor for ${address}, skipping ${signatures.length} historical tx(s)`,
      );
      return;
    }

    // Update cursor to newest signature
    this.db.setCursor(address, signatures[0].signature);

    // Process each new signature
    for (const sig of signatures) {
      if (!this.running) break;

      // Enforce rate limit inside the loop to prevent a large batch from
      // emitting more than MAX_ALERTS_PER_WINDOW alerts in one sweep.
      const currentEntry = this.alertCounts.get(address);
      if (
        currentEntry &&
        Date.now() - currentEntry.windowStart < RATE_LIMIT_WINDOW_MS &&
        currentEntry.count >= MAX_ALERTS_PER_WINDOW
      ) {
        this.emit("rate-limited", {
          address,
          label,
          count: currentEntry.count,
        } satisfies ExchangeRateLimitEvent);
        this.db.pauseWallet(address);
        this.emit("wallet-paused", {
          address,
          label,
          reason: "rate-limited",
        } satisfies ExchangeWalletPausedEvent);
        break;
      }

      if (this.db.hasTransfer(sig.signature)) continue;

      try {
        const transfer = await this.parseTransfer(
          sig.signature,
          address,
          exchangeName,
          walletType,
        );
        if (transfer) {
          this.db.addTransfer(transfer);
          this.emit("transfer", {
            transfer,
          } satisfies ExchangeTransferEvent);
          const counter = this.alertCounts.get(address);
          if (counter) counter.count++;
        }
      } catch (err) {
        debug(
          `Exchange tracker: failed to parse tx ${sig.signature}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  private async parseTransfer(
    signature: string,
    watchedAddress: string,
    exchangeName: string,
    watchedType: ExchangeWalletType,
  ): Promise<Omit<ExchangeTransfer, "alertedAt"> | null> {
    if (!this.config.hasTool("getTransaction")) {
      debug("Exchange tracker: getTransaction not available, skipping tx parse");
      return null;
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

    const meta = tx.meta as Record<string, unknown> | undefined;
    const message = (tx.transaction as Record<string, unknown>)?.message as
      | Record<string, unknown>
      | undefined;

    if (!meta || !message) return null;

    // Skip failed transactions
    if (meta.err !== null && meta.err !== undefined) return null;

    const preSolBalances = (meta.preBalances ?? []) as number[];
    const postSolBalances = (meta.postBalances ?? []) as number[];
    const accountKeys = (
      (message.accountKeys ?? []) as Array<string | Record<string, unknown>>
    );

    // Find the index of the watched wallet
    const watchedIdx = accountKeys.findIndex((k) => {
      const key = typeof k === "string" ? k : (k as Record<string, unknown>).pubkey;
      return key === watchedAddress;
    });

    if (watchedIdx < 0) return null;
    if (preSolBalances[watchedIdx] === undefined) return null;

    const solDiff =
      (postSolBalances[watchedIdx] ?? 0) - preSolBalances[watchedIdx];
    const solAmount = Math.abs(solDiff) / LAMPORTS_PER_SOL;

    // Only care about large movements
    if (solAmount < this.minSolAmount) return null;

    // Determine direction: did SOL come in (+) or go out (-)?
    const isIncoming = solDiff > 0;

    // Find the counterparty: the account with the largest opposing balance change
    let counterpartyAddress = "unknown";
    let largestOpposingChange = 0;
    for (let i = 0; i < accountKeys.length; i++) {
      if (i === watchedIdx) continue;
      const change = (postSolBalances[i] ?? 0) - (preSolBalances[i] ?? 0);
      // For incoming SOL to watched wallet, counterparty should have a negative change
      const expected = isIncoming ? change < 0 : change > 0;
      if (expected && Math.abs(change) > largestOpposingChange) {
        largestOpposingChange = Math.abs(change);
        const k = accountKeys[i];
        counterpartyAddress =
          typeof k === "string" ? k : String((k as Record<string, unknown>).pubkey ?? "unknown");
      }
    }

    // Look up counterparty in our exchange wallet registry
    const counterpartyWallet = counterpartyAddress !== "unknown"
      ? this.db.getWallet(counterpartyAddress)
      : null;

    const fromAddress = isIncoming ? counterpartyAddress : watchedAddress;
    const toAddress = isIncoming ? watchedAddress : counterpartyAddress;

    const fromType: ExchangeTransfer["fromType"] = isIncoming
      ? (counterpartyWallet?.walletType ?? "external")
      : watchedType;
    const toType: ExchangeTransfer["toType"] = isIncoming
      ? watchedType
      : (counterpartyWallet?.walletType ?? "external");

    const transferType = classifyTransfer(fromType, toType, exchangeName, counterpartyWallet?.exchangeName);

    const blockTime = (tx.blockTime as number) ?? 0;

    return {
      signature,
      fromAddress,
      toAddress,
      exchangeName,
      fromType,
      toType,
      transferType,
      solAmount,
      timestamp: blockTime ? blockTime * 1000 : Date.now(),
    };
  }
}

function classifyTransfer(
  fromType: ExchangeTransfer["fromType"],
  toType: ExchangeTransfer["toType"],
  watchedExchange: string,
  counterpartyExchange?: string,
): TransferType {
  if (fromType === "cold" && toType === "hot") return "cold_to_hot";
  if (fromType === "hot" && toType === "cold") return "hot_to_cold";
  if (
    counterpartyExchange &&
    counterpartyExchange !== watchedExchange &&
    fromType !== "external" &&
    toType !== "external"
  ) {
    return "exchange_to_exchange";
  }
  if (fromType === "external" && toType === "hot") return "external_to_hot";
  if (fromType === "hot" && toType === "external") return "hot_to_external";
  return "unknown";
}
