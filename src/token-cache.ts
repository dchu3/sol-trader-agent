import Database from "better-sqlite3";
import * as path from "node:path";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import { debug } from "./logger.js";

/** Resolve the project root by walking up from the compiled output to find package.json. */
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
const DEFAULT_DB_NAME = "token-cache.db";

export interface CacheEntry {
  toolName: string;
  argsJson: string;
  result: string;
  stale: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface CacheHit {
  result: string;
  createdAt: number;
  stale: boolean;
}

/**
 * Tools whose results should be cached. Keyed by token address extracted from
 * the tool arguments.
 */
export const CACHEABLE_TOOLS = new Set([
  "analyze_token",
  "get_token_summary",
  "search_pairs",
  "get_token_pools",
  "get_tokens_by_address",
]);

/**
 * Build a deterministic cache key from a tool name and its arguments.
 * Arguments are sorted by key to be order-independent.
 */
function buildCacheKey(toolName: string, args: Record<string, unknown>): string {
  const sortedArgs = Object.keys(args)
    .sort()
    .reduce<Record<string, unknown>>((acc, key) => {
      acc[key] = args[key];
      return acc;
    }, {});
  return `${toolName}:${JSON.stringify(sortedArgs)}`;
}

/**
 * Try to extract a token/mint address from tool arguments.
 * Different tools use different parameter names.
 */
export function extractTokenAddress(args: Record<string, unknown>): string | undefined {
  for (const key of ["address", "mint", "tokenAddress", "token_address", "query"]) {
    const val = args[key];
    if (typeof val === "string" && val.length > 0) {
      return val;
    }
  }
  return undefined;
}

/**
 * SQLite-backed cache for MCP tool results.
 *
 * Uses a **stale-on-read** pattern:
 * - First cache hit returns the cached result and marks the entry stale.
 * - A subsequent request for the same tool+args sees the stale flag and
 *   bypasses the cache, forcing a fresh fetch.
 */
/** Default max age for cache entries (30 minutes). */
const DEFAULT_MAX_AGE_MS = 30 * 60 * 1000;

export class TokenCache {
  private db: Database.Database;
  private maxAgeMs: number;

  constructor(dbPath?: string, maxAgeMs: number = DEFAULT_MAX_AGE_MS) {
    const resolvedPath = dbPath ?? path.join(findProjectRoot(), DEFAULT_DB_DIR, DEFAULT_DB_NAME);
    const dir = path.dirname(resolvedPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(resolvedPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS token_cache (
        cache_key  TEXT PRIMARY KEY,
        tool_name  TEXT NOT NULL,
        args_json  TEXT NOT NULL,
        result     TEXT NOT NULL,
        stale      INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    this.maxAgeMs = maxAgeMs;
    debug(`Token cache opened at ${resolvedPath} (maxAge=${Math.round(maxAgeMs / 60_000)}m)`);
  }

  /**
   * Look up a cached result. Returns `null` on miss.
   * Does NOT mark the entry stale — call `markStale()` after presenting
   * the cached data to the user.
   */
  get(toolName: string, args: Record<string, unknown>): CacheHit | null {
    const key = buildCacheKey(toolName, args);
    const row = this.db
      .prepare("SELECT result, stale, created_at FROM token_cache WHERE cache_key = ?")
      .get(key) as { result: string; stale: number; created_at: number } | undefined;

    if (!row) return null;

    // Treat entries older than maxAgeMs as expired (cache miss)
    if (Date.now() - row.created_at > this.maxAgeMs) {
      debug(`Cache expired for ${toolName} (age=${Math.round((Date.now() - row.created_at) / 60_000)}m > max ${Math.round(this.maxAgeMs / 60_000)}m)`);
      return null;
    }

    return {
      result: row.result,
      createdAt: row.created_at,
      stale: row.stale === 1,
    };
  }

  /** Store (or replace) a tool result in the cache. Resets the stale flag. */
  set(toolName: string, args: Record<string, unknown>, result: string): void {
    const key = buildCacheKey(toolName, args);
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO token_cache (cache_key, tool_name, args_json, result, stale, created_at, updated_at)
         VALUES (?, ?, ?, ?, 0, ?, ?)
         ON CONFLICT(cache_key) DO UPDATE SET
           result = excluded.result,
           stale = 0,
           created_at = excluded.created_at,
           updated_at = excluded.updated_at`,
      )
      .run(key, toolName, JSON.stringify(args), result, now, now);
    debug(`Cache set: ${toolName} (key=${key.slice(0, 60)}…)`);
  }

  /** Mark a cache entry as stale so the next request bypasses it. */
  markStale(toolName: string, args: Record<string, unknown>): void {
    const key = buildCacheKey(toolName, args);
    this.db
      .prepare("UPDATE token_cache SET stale = 1, updated_at = ? WHERE cache_key = ?")
      .run(Date.now(), key);
  }

  /**
   * Clear cache entries.
   * - No argument: clears everything.
   * - With `tokenAddress`: clears entries whose args contain that address.
   */
  clear(tokenAddress?: string): number {
    if (!tokenAddress) {
      const info = this.db.prepare("DELETE FROM token_cache").run();
      debug(`Cache cleared: ${info.changes} entries removed`);
      return info.changes;
    }
    const info = this.db
      .prepare("DELETE FROM token_cache WHERE args_json LIKE ?")
      .run(`%${tokenAddress}%`);
    debug(`Cache cleared for ${tokenAddress}: ${info.changes} entries removed`);
    return info.changes;
  }

  /** List all cache entries, ordered by most recent first. */
  list(): CacheEntry[] {
    const rows = this.db
      .prepare(
        "SELECT tool_name, args_json, result, stale, created_at, updated_at FROM token_cache ORDER BY updated_at DESC",
      )
      .all() as Array<{
      tool_name: string;
      args_json: string;
      result: string;
      stale: number;
      created_at: number;
      updated_at: number;
    }>;
    return rows.map((row) => ({
      toolName: row.tool_name,
      argsJson: row.args_json,
      result: row.result,
      stale: row.stale === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  /** Close the database connection. */
  close(): void {
    this.db.close();
    debug("Token cache closed");
  }
}
