import Database from "better-sqlite3";
import * as path from "node:path";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import { debug } from "./logger.js";

function findProjectRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    if (fs.existsSync(path.join(dir, "package.json"))) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  return process.cwd();
}

const DEFAULT_DB_DIR = "data";
const DEFAULT_DB_NAME = "whale-tracker.db";

export interface WatchedWallet {
  address: string;
  label: string;
  addedAt: number;
  paused: boolean;
}

export interface WhaleAlert {
  signature: string;
  walletAddress: string;
  walletLabel: string;
  tokenAddress: string;
  tokenSymbol: string;
  action: "buy" | "sell" | "unknown";
  solAmount: string;
  timestamp: number;
  alertedAt: number;
}

export class WhaleDb {
  private db: Database.Database;

  constructor(dbPath?: string) {
    const resolvedPath = dbPath ?? path.join(findProjectRoot(), DEFAULT_DB_DIR, DEFAULT_DB_NAME);
    const dir = path.dirname(resolvedPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(resolvedPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS watched_wallets (
        address    TEXT PRIMARY KEY,
        label      TEXT NOT NULL DEFAULT '',
        added_at   INTEGER NOT NULL,
        paused     INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS whale_alerts (
        signature       TEXT PRIMARY KEY,
        wallet_address  TEXT NOT NULL,
        wallet_label    TEXT NOT NULL DEFAULT '',
        token_address   TEXT NOT NULL,
        token_symbol    TEXT NOT NULL DEFAULT '',
        action          TEXT NOT NULL DEFAULT 'unknown',
        sol_amount      TEXT NOT NULL DEFAULT '0',
        timestamp       INTEGER NOT NULL,
        alerted_at      INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_whale_alerts_wallet ON whale_alerts(wallet_address);
      CREATE INDEX IF NOT EXISTS idx_whale_alerts_time ON whale_alerts(alerted_at DESC);

      CREATE TABLE IF NOT EXISTS whale_tx_cursor (
        wallet_address TEXT PRIMARY KEY,
        last_signature TEXT NOT NULL
      );
    `);

    // Migrate existing DBs: add paused column if missing
    const cols = this.db.pragma("table_info(watched_wallets)") as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "paused")) {
      this.db.exec("ALTER TABLE watched_wallets ADD COLUMN paused INTEGER NOT NULL DEFAULT 0");
      debug("Whale DB: migrated watched_wallets — added paused column");
    }

    debug(`Whale DB opened at ${resolvedPath}`);
  }

  addWallet(address: string, label: string = ""): boolean {
    const now = Date.now();
    const info = this.db
      .prepare(
        "INSERT OR IGNORE INTO watched_wallets (address, label, added_at) VALUES (?, ?, ?)",
      )
      .run(address, label, now);
    if (info.changes > 0) {
      debug(`Whale DB: added wallet ${address} (${label})`);
      return true;
    }
    return false;
  }

  removeWallet(address: string): boolean {
    const info = this.db
      .prepare("DELETE FROM watched_wallets WHERE address = ?")
      .run(address);
    if (info.changes > 0) {
      this.db.prepare("DELETE FROM whale_tx_cursor WHERE wallet_address = ?").run(address);
      this.db.prepare("DELETE FROM whale_alerts WHERE wallet_address = ?").run(address);
      debug(`Whale DB: removed wallet ${address} and associated alerts`);
      return true;
    }
    return false;
  }

  listWallets(): WatchedWallet[] {
    const rows = this.db
      .prepare("SELECT address, label, added_at, paused FROM watched_wallets ORDER BY added_at DESC")
      .all() as Array<{ address: string; label: string; added_at: number; paused: number }>;
    return rows.map((r) => ({
      address: r.address,
      label: r.label,
      addedAt: r.added_at,
      paused: r.paused === 1,
    }));
  }

  listActiveWallets(): WatchedWallet[] {
    return this.listWallets().filter((w) => !w.paused);
  }

  pauseWallet(address: string): boolean {
    const info = this.db
      .prepare("UPDATE watched_wallets SET paused = 1 WHERE address = ? AND paused = 0")
      .run(address);
    if (info.changes > 0) {
      debug(`Whale DB: paused wallet ${address}`);
      return true;
    }
    return false;
  }

  resumeWallet(address: string): boolean {
    const info = this.db
      .prepare("UPDATE watched_wallets SET paused = 0 WHERE address = ? AND paused = 1")
      .run(address);
    if (info.changes > 0) {
      debug(`Whale DB: resumed wallet ${address}`);
      return true;
    }
    return false;
  }

  alertCountSince(walletAddress: string, sinceMs: number): number {
    const row = this.db
      .prepare("SELECT COUNT(*) as cnt FROM whale_alerts WHERE wallet_address = ? AND alerted_at >= ?")
      .get(walletAddress, sinceMs) as { cnt: number };
    return row.cnt;
  }

  getWalletLabel(address: string): string {
    const row = this.db
      .prepare("SELECT label FROM watched_wallets WHERE address = ?")
      .get(address) as { label: string } | undefined;
    return row?.label ?? "";
  }

  getCursor(walletAddress: string): string | null {
    const row = this.db
      .prepare("SELECT last_signature FROM whale_tx_cursor WHERE wallet_address = ?")
      .get(walletAddress) as { last_signature: string } | undefined;
    return row?.last_signature ?? null;
  }

  setCursor(walletAddress: string, lastSignature: string): void {
    this.db
      .prepare(
        "INSERT OR REPLACE INTO whale_tx_cursor (wallet_address, last_signature) VALUES (?, ?)",
      )
      .run(walletAddress, lastSignature);
  }

  hasAlert(signature: string): boolean {
    const row = this.db
      .prepare("SELECT 1 FROM whale_alerts WHERE signature = ?")
      .get(signature);
    return row !== undefined;
  }

  addAlert(alert: Omit<WhaleAlert, "alertedAt">): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO whale_alerts
         (signature, wallet_address, wallet_label, token_address, token_symbol, action, sol_amount, timestamp, alerted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        alert.signature,
        alert.walletAddress,
        alert.walletLabel,
        alert.tokenAddress,
        alert.tokenSymbol,
        alert.action,
        alert.solAmount,
        alert.timestamp,
        now,
      );
  }

  recentAlerts(limit: number = 20): WhaleAlert[] {
    const rows = this.db
      .prepare(
        `SELECT signature, wallet_address, wallet_label, token_address, token_symbol, action, sol_amount, timestamp, alerted_at
         FROM whale_alerts ORDER BY alerted_at DESC LIMIT ?`,
      )
      .all(limit) as Array<{
      signature: string;
      wallet_address: string;
      wallet_label: string;
      token_address: string;
      token_symbol: string;
      action: string;
      sol_amount: string;
      timestamp: number;
      alerted_at: number;
    }>;
    return rows.map((r) => ({
      signature: r.signature,
      walletAddress: r.wallet_address,
      walletLabel: r.wallet_label,
      tokenAddress: r.token_address,
      tokenSymbol: r.token_symbol,
      action: r.action as WhaleAlert["action"],
      solAmount: r.sol_amount,
      timestamp: r.timestamp,
      alertedAt: r.alerted_at,
    }));
  }

  /** Purge alerts older than the given age in milliseconds. */
  purgeOldAlerts(maxAgeMs: number = 7 * 24 * 60 * 60 * 1000): number {
    const cutoff = Date.now() - maxAgeMs;
    const info = this.db
      .prepare("DELETE FROM whale_alerts WHERE alerted_at < ?")
      .run(cutoff);
    return info.changes;
  }

  close(): void {
    this.db.close();
    debug("Whale DB closed");
  }
}
