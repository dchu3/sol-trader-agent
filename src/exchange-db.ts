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
const DEFAULT_DB_NAME = "exchange-tracker.db";

export type ExchangeWalletType = "hot" | "cold";

export interface ExchangeWallet {
  address: string;
  exchangeName: string;
  walletType: ExchangeWalletType;
  label: string;
  addedAt: number;
  paused: boolean;
}

export type TransferType =
  | "cold_to_hot"
  | "hot_to_cold"
  | "exchange_to_exchange"
  | "external_to_hot"
  | "hot_to_external"
  | "unknown";

export interface ExchangeTransfer {
  signature: string;
  fromAddress: string;
  toAddress: string;
  exchangeName: string;
  fromType: ExchangeWalletType | "external";
  toType: ExchangeWalletType | "external";
  transferType: TransferType;
  solAmount: number;
  timestamp: number;
  alertedAt: number;
}

export class ExchangeDb {
  private db: Database.Database;

  constructor(dbPath?: string) {
    const resolvedPath =
      dbPath ?? path.join(findProjectRoot(), DEFAULT_DB_DIR, DEFAULT_DB_NAME);
    const dir = path.dirname(resolvedPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(resolvedPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS exchange_wallets (
        address       TEXT PRIMARY KEY,
        exchange_name TEXT NOT NULL,
        wallet_type   TEXT NOT NULL CHECK(wallet_type IN ('hot', 'cold')),
        label         TEXT NOT NULL DEFAULT '',
        added_at      INTEGER NOT NULL,
        paused        INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS exchange_transfers (
        signature     TEXT PRIMARY KEY,
        from_address  TEXT NOT NULL,
        to_address    TEXT NOT NULL,
        exchange_name TEXT NOT NULL,
        from_type     TEXT NOT NULL,
        to_type       TEXT NOT NULL,
        transfer_type TEXT NOT NULL,
        sol_amount    REAL NOT NULL,
        timestamp     INTEGER NOT NULL,
        alerted_at    INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_exchange_transfers_time
        ON exchange_transfers(alerted_at DESC);
      CREATE INDEX IF NOT EXISTS idx_exchange_transfers_exchange
        ON exchange_transfers(exchange_name);

      CREATE TABLE IF NOT EXISTS exchange_tx_cursor (
        wallet_address TEXT PRIMARY KEY,
        last_signature TEXT NOT NULL
      );
    `);

    debug(`Exchange DB opened at ${resolvedPath}`);
  }

  /** Returns true if no exchange wallets have been added yet (used by seeder). */
  isEmpty(): boolean {
    const row = this.db
      .prepare("SELECT COUNT(*) as cnt FROM exchange_wallets")
      .get() as { cnt: number };
    return row.cnt === 0;
  }

  addWallet(
    address: string,
    exchangeName: string,
    walletType: ExchangeWalletType,
    label: string = "",
  ): boolean {
    const now = Date.now();
    const info = this.db
      .prepare(
        `INSERT OR IGNORE INTO exchange_wallets
         (address, exchange_name, wallet_type, label, added_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(address, exchangeName, walletType, label, now);
    if (info.changes > 0) {
      debug(`Exchange DB: added ${walletType} wallet for ${exchangeName} (${address})`);
      return true;
    }
    return false;
  }

  removeWallet(address: string): boolean {
    const info = this.db
      .prepare("DELETE FROM exchange_wallets WHERE address = ?")
      .run(address);
    if (info.changes > 0) {
      this.db
        .prepare("DELETE FROM exchange_tx_cursor WHERE wallet_address = ?")
        .run(address);
      debug(`Exchange DB: removed wallet ${address}`);
      return true;
    }
    return false;
  }

  listWallets(): ExchangeWallet[] {
    const rows = this.db
      .prepare(
        `SELECT address, exchange_name, wallet_type, label, added_at, paused
         FROM exchange_wallets ORDER BY exchange_name ASC, wallet_type ASC`,
      )
      .all() as Array<{
      address: string;
      exchange_name: string;
      wallet_type: string;
      label: string;
      added_at: number;
      paused: number;
    }>;
    return rows.map((r) => ({
      address: r.address,
      exchangeName: r.exchange_name,
      walletType: r.wallet_type as ExchangeWalletType,
      label: r.label,
      addedAt: r.added_at,
      paused: r.paused === 1,
    }));
  }

  listActiveWallets(): ExchangeWallet[] {
    return this.listWallets().filter((w) => !w.paused);
  }

  getWallet(address: string): ExchangeWallet | null {
    const row = this.db
      .prepare(
        `SELECT address, exchange_name, wallet_type, label, added_at, paused
         FROM exchange_wallets WHERE address = ?`,
      )
      .get(address) as
      | {
          address: string;
          exchange_name: string;
          wallet_type: string;
          label: string;
          added_at: number;
          paused: number;
        }
      | undefined;
    if (!row) return null;
    return {
      address: row.address,
      exchangeName: row.exchange_name,
      walletType: row.wallet_type as ExchangeWalletType,
      label: row.label,
      addedAt: row.added_at,
      paused: row.paused === 1,
    };
  }

  pauseWallet(address: string): boolean {
    const info = this.db
      .prepare("UPDATE exchange_wallets SET paused = 1 WHERE address = ? AND paused = 0")
      .run(address);
    if (info.changes > 0) {
      debug(`Exchange DB: paused wallet ${address}`);
      return true;
    }
    return false;
  }

  resumeWallet(address: string): boolean {
    const info = this.db
      .prepare("UPDATE exchange_wallets SET paused = 0 WHERE address = ? AND paused = 1")
      .run(address);
    if (info.changes > 0) {
      debug(`Exchange DB: resumed wallet ${address}`);
      return true;
    }
    return false;
  }

  getCursor(walletAddress: string): string | null {
    const row = this.db
      .prepare("SELECT last_signature FROM exchange_tx_cursor WHERE wallet_address = ?")
      .get(walletAddress) as { last_signature: string } | undefined;
    return row?.last_signature ?? null;
  }

  setCursor(walletAddress: string, lastSignature: string): void {
    this.db
      .prepare(
        "INSERT OR REPLACE INTO exchange_tx_cursor (wallet_address, last_signature) VALUES (?, ?)",
      )
      .run(walletAddress, lastSignature);
  }

  hasTransfer(signature: string): boolean {
    const row = this.db
      .prepare("SELECT 1 FROM exchange_transfers WHERE signature = ?")
      .get(signature);
    return row !== undefined;
  }

  addTransfer(transfer: Omit<ExchangeTransfer, "alertedAt">): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO exchange_transfers
         (signature, from_address, to_address, exchange_name, from_type, to_type,
          transfer_type, sol_amount, timestamp, alerted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        transfer.signature,
        transfer.fromAddress,
        transfer.toAddress,
        transfer.exchangeName,
        transfer.fromType,
        transfer.toType,
        transfer.transferType,
        transfer.solAmount,
        transfer.timestamp,
        now,
      );
  }

  recentTransfers(limit: number = 20): ExchangeTransfer[] {
    const rows = this.db
      .prepare(
        `SELECT signature, from_address, to_address, exchange_name, from_type, to_type,
                transfer_type, sol_amount, timestamp, alerted_at
         FROM exchange_transfers ORDER BY alerted_at DESC LIMIT ?`,
      )
      .all(limit) as Array<{
      signature: string;
      from_address: string;
      to_address: string;
      exchange_name: string;
      from_type: string;
      to_type: string;
      transfer_type: string;
      sol_amount: number;
      timestamp: number;
      alerted_at: number;
    }>;
    return rows.map((r) => ({
      signature: r.signature,
      fromAddress: r.from_address,
      toAddress: r.to_address,
      exchangeName: r.exchange_name,
      fromType: r.from_type as ExchangeTransfer["fromType"],
      toType: r.to_type as ExchangeTransfer["toType"],
      transferType: r.transfer_type as TransferType,
      solAmount: r.sol_amount,
      timestamp: r.timestamp,
      alertedAt: r.alerted_at,
    }));
  }

  recentTransfersByExchange(exchangeName: string, limit: number = 10): ExchangeTransfer[] {
    const rows = this.db
      .prepare(
        `SELECT signature, from_address, to_address, exchange_name, from_type, to_type,
                transfer_type, sol_amount, timestamp, alerted_at
         FROM exchange_transfers WHERE exchange_name = ?
         ORDER BY alerted_at DESC LIMIT ?`,
      )
      .all(exchangeName, limit) as Array<{
      signature: string;
      from_address: string;
      to_address: string;
      exchange_name: string;
      from_type: string;
      to_type: string;
      transfer_type: string;
      sol_amount: number;
      timestamp: number;
      alerted_at: number;
    }>;
    return rows.map((r) => ({
      signature: r.signature,
      fromAddress: r.from_address,
      toAddress: r.to_address,
      exchangeName: r.exchange_name,
      fromType: r.from_type as ExchangeTransfer["fromType"],
      toType: r.to_type as ExchangeTransfer["toType"],
      transferType: r.transfer_type as TransferType,
      solAmount: r.sol_amount,
      timestamp: r.timestamp,
      alertedAt: r.alerted_at,
    }));
  }

  /** Purge transfers older than the given age in milliseconds. */
  purgeOldTransfers(maxAgeMs: number = 30 * 24 * 60 * 60 * 1000): number {
    const cutoff = Date.now() - maxAgeMs;
    const info = this.db
      .prepare("DELETE FROM exchange_transfers WHERE alerted_at < ?")
      .run(cutoff);
    return info.changes;
  }

  close(): void {
    this.db.close();
    debug("Exchange DB closed");
  }
}
