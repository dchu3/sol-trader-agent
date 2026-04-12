#!/usr/bin/env node
import { WhaleDb } from "./whale-db.js";

function main(): void {
  const address = process.argv[2];
  const db = new WhaleDb();

  try {
    if (!address) {
      console.log("Usage: npx tsx src/db-cleanup.ts <wallet-address>\n");
      const wallets = db.listWallets();
      if (wallets.length === 0) {
        console.log("No wallets in the database.");
      } else {
        console.log("Wallets in the database:");
        for (const w of wallets) {
          const status = w.paused ? " (paused)" : "";
          console.log(`  ${w.address}  ${w.label}${status}`);
        }
      }
      process.exitCode = 1;
      return;
    }

    const removed = db.removeWallet(address);
    if (removed) {
      console.log(`Removed wallet ${address} (watched_wallets, whale_tx_cursor, whale_alerts).`);
    } else {
      console.log(`Wallet ${address} not found in the database.`);
      process.exitCode = 1;
    }
  } catch (err) {
    console.error(
      "Error:",
      err instanceof Error ? err.message : String(err)
    );
    process.exitCode = 1;
  } finally {
    db.close();
  }
}

main();
