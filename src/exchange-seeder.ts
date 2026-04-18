import type { ExchangeDb } from "./exchange-db.js";
import { debug } from "./logger.js";

/**
 * Known exchange Solana wallet addresses.
 *
 * These are publicly identified on-chain via blockchain explorers (Solscan, SolanaFM).
 * Source: publicly available labelled accounts from Solscan and community-maintained lists.
 * These addresses carry no privacy risk — they are high-volume exchange deposit/withdrawal
 * wallets well-known to the Solana community.
 *
 * Users should verify and supplement this list using /add_exchange or the agent tool.
 */
const KNOWN_EXCHANGE_WALLETS: Array<{
  address: string;
  exchangeName: string;
  walletType: "hot" | "cold";
  label: string;
}> = [
  // ── Binance ──────────────────────────────────────────────────────────
  {
    address: "2ojv9BAiHUrvsm9gxDe7fJSzbNZSJcxZvf8dqmWGHG8S",
    exchangeName: "Binance",
    walletType: "hot",
    label: "Binance Hot Wallet 1",
  },
  {
    address: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
    exchangeName: "Binance",
    walletType: "hot",
    label: "Binance Hot Wallet 2",
  },
  {
    address: "AC5RDfQFmDS1deWZos921JfqscXdByf8BKHs5ACWjtW2",
    exchangeName: "Binance",
    walletType: "cold",
    label: "Binance Cold Wallet",
  },
  // ── Coinbase ─────────────────────────────────────────────────────────
  {
    address: "H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS",
    exchangeName: "Coinbase",
    walletType: "hot",
    label: "Coinbase Hot Wallet 1",
  },
  {
    address: "GJRs4FwHtemZ5ZE9x3FNvJ8TMwitKTh21yxdRPqn7npE",
    exchangeName: "Coinbase",
    walletType: "hot",
    label: "Coinbase Hot Wallet 2",
  },
  // ── Kraken ───────────────────────────────────────────────────────────
  {
    address: "FWznbcNXWQuHTawe9RxvQ2LdCyNxGxHBgJindT6n25M9",
    exchangeName: "Kraken",
    walletType: "hot",
    label: "Kraken Hot Wallet 1",
  },
  {
    address: "BeAHe9gGNHqtGW2pRDeKVSb9bJyNdmr6MaaAtE4kCrLQ",
    exchangeName: "Kraken",
    walletType: "hot",
    label: "Kraken Hot Wallet 2",
  },
  // ── OKX ──────────────────────────────────────────────────────────────
  {
    address: "5VCwKtCXgCJ6kit5FybXjvriW3xELsFDhYrPSqtJNmcD",
    exchangeName: "OKX",
    walletType: "hot",
    label: "OKX Hot Wallet 1",
  },
  {
    address: "HinckBGPTSVaXBhKzVRTzm9RxfWMuJkDcbzDKbRjMV3C",
    exchangeName: "OKX",
    walletType: "hot",
    label: "OKX Hot Wallet 2",
  },
  // ── Bybit ────────────────────────────────────────────────────────────
  {
    address: "A77HErqtfN1hLLpvZ9pCtu66FEtM68WNa5HMBHzPiQMd",
    exchangeName: "Bybit",
    walletType: "hot",
    label: "Bybit Hot Wallet 1",
  },
  {
    address: "2AQdpHJ2JpcEgPiATUXjQxA8QmafFegfQwSLWSprPicm",
    exchangeName: "Bybit",
    walletType: "hot",
    label: "Bybit Hot Wallet 2",
  },
  // ── Bitfinex ─────────────────────────────────────────────────────────
  {
    address: "4CNXG4bCjC6vSdbHGLGkGCFm5CrMiMaPMQNhnnM9FPHM",
    exchangeName: "Bitfinex",
    walletType: "hot",
    label: "Bitfinex Hot Wallet",
  },
  // ── HTX (Huobi) ──────────────────────────────────────────────────────
  {
    address: "ASTyfSima4LLAdDgoFGkgqoKowG1LZFDr9fAQrg7iaJZ",
    exchangeName: "HTX",
    walletType: "hot",
    label: "HTX Hot Wallet 1",
  },
  // ── KuCoin ───────────────────────────────────────────────────────────
  {
    address: "BmFdpraQhkiDnE9SmkWgsSBoHMnQ7PGMgQ5FQQBR1Nbw",
    exchangeName: "KuCoin",
    walletType: "hot",
    label: "KuCoin Hot Wallet 1",
  },
  // ── Gate.io ──────────────────────────────────────────────────────────
  {
    address: "FDiM32T9KiGXMbFPuMBuJaJfLMHnPfPCBnr9mq1yEhGm",
    exchangeName: "Gate.io",
    walletType: "hot",
    label: "Gate.io Hot Wallet",
  },
];

/**
 * Seeds the exchange database with known exchange wallet addresses.
 * Only runs if the DB is empty (i.e., no wallets have been added yet).
 * Returns the number of wallets seeded.
 */
export function seedExchangeWallets(db: ExchangeDb): number {
  if (!db.isEmpty()) {
    debug("Exchange seeder: DB already has wallets, skipping seed");
    return 0;
  }

  let seeded = 0;
  for (const entry of KNOWN_EXCHANGE_WALLETS) {
    const added = db.addWallet(
      entry.address,
      entry.exchangeName,
      entry.walletType,
      entry.label,
    );
    if (added) seeded++;
  }

  debug(`Exchange seeder: seeded ${seeded} known exchange wallets`);
  return seeded;
}
