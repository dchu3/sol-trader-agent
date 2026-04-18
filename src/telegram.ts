import { Bot, InlineKeyboard, type Api, type Context } from "grammy";
import type { Content } from "@google/genai";
import type { Config } from "./config.js";
import type { ToolRouter, ConfirmFn, Channel } from "./agent.js";
import { runAgent } from "./agent.js";
import { debug } from "./logger.js";
import type { TokenCache } from "./token-cache.js";
import type { WhaleDb } from "./whale-db.js";
import type { WhaleTracker, WhaleSwapEvent, WhaleWalletPausedEvent } from "./whale-tracker.js";
import type { ExchangeDb } from "./exchange-db.js";
import type { ExchangeTracker, ExchangeTransferEvent } from "./exchange-tracker.js";

/** Telegram message length limit. */
const MAX_MESSAGE_LENGTH = 4096;

/** How long to wait for a user to respond to an inline-keyboard confirmation (ms). */
const CONFIRMATION_TIMEOUT_MS = 120_000;

interface PendingConfirmation {
  resolve: (approved: boolean) => void;
  /** Timeout handle so we can clear it when the user responds. */
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Start the Telegram bot. Returns a cleanup function that stops the bot.
 *
 * The bot shares the same ToolRouter (and therefore MCP clients) as the CLI.
 * Each authorised chat gets its own conversation history.
 */
export async function startTelegramBot(
  config: Config,
  router: ToolRouter,
  cache?: TokenCache,
  whaleDb?: WhaleDb,
  whaleTracker?: WhaleTracker | null,
  exchangeDb?: ExchangeDb,
  exchangeTracker?: ExchangeTracker | null,
  analyzeExchangeTransfer?: (event: ExchangeTransferEvent) => Promise<string>,
): Promise<() => void> {
  if (!config.telegramBotToken) {
    throw new Error("TELEGRAM_BOT_TOKEN is required to start the Telegram bot");
  }

  const bot = new Bot(config.telegramBotToken);

  // Per-chat conversation history (independent from CLI).
  const histories = new Map<number, Content[]>();

  // Per-chat processing lock so messages are handled sequentially.
  const locks = new Map<number, Promise<void>>();

  // Pending inline-keyboard confirmations keyed by `chatId:messageId`.
  const pendingConfirmations = new Map<string, PendingConfirmation>();

  // ── Auth middleware ──────────────────────────────────────────────────
  bot.use(async (ctx, next) => {
    const chatId = ctx.chat?.id;
    // Use !== undefined so that config.telegramChatId = 0 is never
    // treated as "no restriction configured" (0 is falsy but is a value).
    if (config.telegramChatId !== undefined && chatId !== config.telegramChatId) {
      debug(`Telegram: rejected message from unauthorised chat ${chatId}`);
      // Only reply when there is a concrete chat to reply to; some update
      // types (e.g. callback queries from inline-mode messages) have no
      // associated chat and attempting ctx.reply() would throw.
      if (chatId !== undefined) {
        await ctx.reply("⛔ You are not authorised to use this bot.");
      }
      return;
    }
    await next();
  });

  // ── Commands ─────────────────────────────────────────────────────────
  bot.command("start", async (ctx) => {
    await ctx.reply(
      "👋 Welcome to Sol Trader Agent!\n\n" +
        "Send any message to interact with the agent. " +
        "Use /help for usage info or /clear to reset conversation history.",
    );
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(
      "🤖 *Sol Trader Agent — Telegram*\n\n" +
        "Send natural language messages to analyse tokens and trade on Solana DEXs\\.\n\n" +
        "*Example prompts:*\n" +
        "• `Analyse the token <mint-address>`\n" +
        "• `Buy 0.1 SOL worth of <token-address>`\n" +
        "• `Get a quote for swapping 1 SOL to <token-address>`\n" +
        "• `What's my balance?`\n\n" +
        "*General:*\n" +
        "/help — Show this message\n" +
        "/clear — Reset conversation history\n\n" +
        "*Whale Tracker:*\n" +
        "/watch `<address> [label]` — Watch a whale wallet\n" +
        "/unwatch `<address>` — Stop watching a wallet\n" +
        "/whales — List watched wallets and recent alerts\n" +
        "/purge `<address>` — Remove wallet and all its alert data\n" +
        "/pause `<address>` — Pause alerts for a wallet\n" +
        "/resume `<address>` — Resume alerts for a wallet\n\n" +
        "*Exchange Tracker:*\n" +
        "/exchange\\_wallets — List exchange wallets and recent transfers\n" +
        "/add\\_exchange `<address> <hot|cold> <name> [label]` — Add a wallet\n" +
        "/remove\\_exchange `<address>` — Remove a wallet\n" +
        "/pause\\_exchange `<address>` — Pause tracking a wallet\n" +
        "/resume\\_exchange `<address>` — Resume tracking a wallet\n\n" +
        "Token analysis is paid via x402\\. Trading actions require confirmation\\.",
      { parse_mode: "MarkdownV2" },
    );
  });

  bot.command("clear", async (ctx) => {
    const chatId = ctx.chat.id;
    histories.delete(chatId);
    await ctx.reply("🗑️ Conversation history cleared.");
  });

  bot.command("watch", async (ctx) => {
    if (!whaleDb) {
      await ctx.reply("🐋 Whale tracking is not available.");
      return;
    }
    const text = ctx.message?.text ?? "";
    const parts = text.replace(/^\/watch\s*/, "").trim().split(/\s+/);
    const address = parts[0];
    if (!address || address.length < 32) {
      await ctx.reply("Usage: /watch <wallet_address> [label]");
      return;
    }
    const label = parts.slice(1).join(" ");
    const added = whaleDb.addWallet(address, label);
    if (added) {
      await ctx.reply(`🐋 Now watching ${label ? `"${label}" (${address})` : address}`);
    } else {
      await ctx.reply(`Already watching ${address}`);
    }
  });

  bot.command("unwatch", async (ctx) => {
    if (!whaleDb) {
      await ctx.reply("🐋 Whale tracking is not available.");
      return;
    }
    const address = (ctx.message?.text ?? "").replace(/^\/unwatch\s*/, "").trim();
    if (!address) {
      await ctx.reply("Usage: /unwatch <wallet_address>");
      return;
    }
    const removed = whaleDb.removeWallet(address);
    await ctx.reply(removed ? `Stopped watching ${address}` : `${address} was not watched`);
  });

  bot.command("purge", async (ctx) => {
    if (!whaleDb) {
      await ctx.reply("🐋 Whale tracking is not available.");
      return;
    }
    const addr = ctx.match?.trim();
    if (!addr) {
      await ctx.reply("Usage: /purge <wallet_address>");
      return;
    }
    const removed = whaleDb.removeWallet(addr);
    await ctx.reply(removed
      ? `🗑️ Purged wallet ${addr} — removed wallet, alerts, and tracking cursor.`
      : `Wallet ${addr} was not found in the watch list.`
    );
  });

  bot.command("pause", async (ctx) => {
    if (!whaleDb) {
      await ctx.reply("🐋 Whale tracking is not available.");
      return;
    }
    const addr = ctx.match?.trim();
    if (!addr) {
      await ctx.reply("Usage: /pause <wallet_address>");
      return;
    }
    const paused = whaleDb.pauseWallet(addr);
    await ctx.reply(paused ? `⏸️ Paused tracking for ${addr}` : `${addr} is not watched or already paused.`);
  });

  bot.command("resume", async (ctx) => {
    if (!whaleDb) {
      await ctx.reply("🐋 Whale tracking is not available.");
      return;
    }
    const addr = ctx.match?.trim();
    if (!addr) {
      await ctx.reply("Usage: /resume <wallet_address>");
      return;
    }
    const resumed = whaleDb.resumeWallet(addr);
    if (resumed && whaleTracker) {
      whaleTracker.resetAlertCount(addr);
    }
    await ctx.reply(resumed ? `▶️ Resumed tracking for ${addr}` : `${addr} is not watched or not paused.`);
  });

  bot.command("whales", async (ctx) => {
    if (!whaleDb) {
      await ctx.reply("🐋 Whale tracking is not available.");
      return;
    }
    const wallets = whaleDb.listWallets();
    const alerts = whaleDb.recentAlerts(5);
    let msg = `🐋 <b>Watched Wallets (${wallets.length})</b>\n`;
    if (wallets.length === 0) {
      msg += "No wallets being watched.\n";
    } else {
      for (const w of wallets) {
        const label = w.label ? ` (${w.label})` : "";
        const pausedTag = w.paused ? " [PAUSED]" : "";
        msg += `• <code>${w.address}</code>${label}${pausedTag}\n`;
      }
    }
    msg += `\n<b>Recent Alerts (${alerts.length})</b>\n`;
    if (alerts.length === 0) {
      msg += "No alerts yet.";
    } else {
      for (const a of alerts) {
        const label = a.walletLabel || a.walletAddress.slice(0, 8) + "...";
        const token = a.tokenSymbol || a.tokenAddress.slice(0, 8) + "...";
        const action = a.action === "buy" ? "🟢 BUY" : a.action === "sell" ? "🔴 SELL" : "⚪ ???";
        msg += `${action} ${label} → ${token} (${a.solAmount} SOL)\n`;
      }
    }
    try {
      await ctx.reply(msg, { parse_mode: "HTML" });
    } catch {
      await ctx.reply(msg.replace(/<[^>]*>/g, ""));
    }
  });

  // ── Exchange tracker commands ─────────────────────────────────────
  bot.command("exchange_wallets", async (ctx) => {
    if (!exchangeDb) {
      await ctx.reply("🏦 Exchange hot wallet tracking is not available.");
      return;
    }
    const wallets = exchangeDb.listWallets();
    const recentTransfers = exchangeDb.recentTransfers(5);

    // Group wallets by exchange
    const byExchange = new Map<string, typeof wallets>();
    for (const w of wallets) {
      const group = byExchange.get(w.exchangeName) ?? [];
      group.push(w);
      byExchange.set(w.exchangeName, group);
    }

    let msg = `🏦 <b>Exchange Wallets (${wallets.length})</b>\n`;
    if (wallets.length === 0) {
      msg += "No exchange wallets being tracked.\n";
    } else {
      for (const [exchange, group] of [...byExchange.entries()].sort()) {
        msg += `\n<b>${exchange}</b>\n`;
        for (const w of group) {
          const icon = w.walletType === "hot" ? "🔥" : "🧊";
          const pausedTag = w.paused ? " [PAUSED]" : "";
          msg += `${icon} ${w.walletType.toUpperCase()}${pausedTag}: <code>${w.address.slice(0, 12)}...</code>\n`;
        }
      }
    }

    msg += `\n<b>Recent Transfers (${recentTransfers.length})</b>\n`;
    if (recentTransfers.length === 0) {
      msg += "No large transfers detected yet (threshold: ≥1000 SOL).";
    } else {
      for (const t of recentTransfers) {
        const icon = t.transferType === "cold_to_hot" ? "🔴" : t.transferType === "hot_to_cold" ? "🟢" : "🔄";
        const time = new Date(t.timestamp).toLocaleDateString();
        msg += `${icon} ${t.exchangeName}: ${t.solAmount.toFixed(0)} SOL (${t.transferType.replace(/_/g, "→")}) ${time}\n`;
      }
    }

    try {
      await ctx.reply(msg, { parse_mode: "HTML" });
    } catch {
      await ctx.reply(msg.replace(/<[^>]*>/g, ""));
    }
  });

  bot.command("add_exchange", async (ctx) => {
    if (!exchangeDb) {
      await ctx.reply("🏦 Exchange hot wallet tracking is not available.");
      return;
    }
    // Usage: /add_exchange <address> <hot|cold> <exchange_name> [label]
    const text = (ctx.message?.text ?? "").replace(/^\/add_exchange\s*/, "").trim();
    const parts = text.split(/\s+/);
    const address = parts[0];
    const walletType = parts[1] as "hot" | "cold" | undefined;
    const exchangeName = parts[2];
    const label = parts.slice(3).join(" ");

    if (!address || address.length < 32) {
      await ctx.reply("Usage: /add_exchange <address> <hot|cold> <exchange_name> [label]");
      return;
    }
    if (walletType !== "hot" && walletType !== "cold") {
      await ctx.reply("Usage: /add_exchange <address> <hot|cold> <exchange_name> [label]\n\nwallet_type must be 'hot' or 'cold'.");
      return;
    }
    if (!exchangeName) {
      await ctx.reply("Usage: /add_exchange <address> <hot|cold> <exchange_name> [label]");
      return;
    }

    const added = exchangeDb.addWallet(address, exchangeName, walletType, label);
    if (added) {
      await ctx.reply(
        `🏦 Now tracking ${walletType} wallet for <b>${exchangeName}</b>${label ? ` (${label})` : ""}\n<code>${address}</code>`,
        { parse_mode: "HTML" },
      );
    } else {
      await ctx.reply(`Wallet ${address} is already being tracked.`);
    }
  });

  bot.command("remove_exchange", async (ctx) => {
    if (!exchangeDb) {
      await ctx.reply("🏦 Exchange hot wallet tracking is not available.");
      return;
    }
    const address = (ctx.message?.text ?? "").replace(/^\/remove_exchange\s*/, "").trim();
    if (!address) {
      await ctx.reply("Usage: /remove_exchange <address>");
      return;
    }
    const removed = exchangeDb.removeWallet(address);
    await ctx.reply(
      removed
        ? `✅ Removed exchange wallet ${address} from tracking.`
        : `Wallet ${address} was not found in the exchange tracker.`,
    );
  });

  bot.command("pause_exchange", async (ctx) => {
    if (!exchangeDb) {
      await ctx.reply("🏦 Exchange hot wallet tracking is not available.");
      return;
    }
    const addr = ctx.match?.trim();
    if (!addr || addr.length < 32) {
      await ctx.reply("Usage: /pause_exchange <address>");
      return;
    }
    const paused = exchangeDb.pauseWallet(addr);
    await ctx.reply(
      paused
        ? `⏸️ Paused exchange wallet tracking for ${addr}.`
        : `Wallet ${addr} was not found or is already paused.`,
    );
  });

  bot.command("resume_exchange", async (ctx) => {
    if (!exchangeDb) {
      await ctx.reply("🏦 Exchange hot wallet tracking is not available.");
      return;
    }
    const addr = ctx.match?.trim();
    if (!addr || addr.length < 32) {
      await ctx.reply("Usage: /resume_exchange <address>");
      return;
    }
    const resumed = exchangeDb.resumeWallet(addr);
    if (resumed && exchangeTracker) {
      exchangeTracker.resetAlertCount(addr);
    }
    await ctx.reply(
      resumed
        ? `▶️ Resumed exchange wallet tracking for ${addr}. Rate-limit counter reset.`
        : `Wallet ${addr} was not found or is not paused.`,
    );
  });

  // ── Callback queries (inline keyboard confirmations) ─────────────────
  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;
    const messageId = ctx.callbackQuery.message?.message_id;
    const chatId = ctx.chat?.id;
    if (!messageId || !chatId) return;

    const key = `${chatId}:${messageId}`;
    const pending = pendingConfirmations.get(key);
    if (!pending) {
      await ctx.answerCallbackQuery({ text: "This confirmation has expired." });
      return;
    }

    clearTimeout(pending.timer);
    pendingConfirmations.delete(key);

    const approved = data === "confirm_yes";
    pending.resolve(approved);

    const label = approved ? "✅ Approved" : "❌ Declined";
    await ctx.editMessageText(
      `${ctx.callbackQuery.message?.text ?? ""}\n\n${label}`,
    );
    await ctx.answerCallbackQuery({ text: label });
  });

  // ── Message handler ──────────────────────────────────────────────────
  bot.on("message:text", (ctx) => {
    const chatId = ctx.chat.id;
    const text = ctx.message.text.trim();
    if (!text) return;

    // Don't await — grammy processes updates sequentially, so blocking
    // here would prevent callback_query updates (inline keyboard taps)
    // from being delivered, deadlocking the confirmation flow.
    const previous = locks.get(chatId) ?? Promise.resolve();
    const current = previous.then(() => handleMessage(ctx, chatId, text));
    locks.set(chatId, current.catch(() => {}));
  });

  async function handleMessage(
    ctx: Context,
    chatId: number,
    text: string,
  ): Promise<void> {
    const history = histories.get(chatId) ?? [];
    histories.set(chatId, history);

    // Show a "typing" indicator while the agent is working.
    await ctx.api.sendChatAction(chatId, "typing");

    // Build a Telegram-specific confirmFn using inline keyboards.
    const confirmFn: ConfirmFn = async (message: string): Promise<boolean> => {
      const keyboard = new InlineKeyboard()
        .text("✅ Approve", "confirm_yes")
        .text("❌ Decline", "confirm_no");

      const sent = await ctx.api.sendMessage(chatId, `⚠️ ${message}`, {
        reply_markup: keyboard,
      });

      return new Promise<boolean>((resolve) => {
        const key = `${chatId}:${sent.message_id}`;

        const timer = setTimeout(() => {
          pendingConfirmations.delete(key);
          resolve(false);
          ctx.api
            .editMessageText(chatId, sent.message_id, `⚠️ ${message}\n\n⏰ Timed out — declined.`)
            .catch(() => {});
        }, CONFIRMATION_TIMEOUT_MS);

        pendingConfirmations.set(key, { resolve, timer });
      });
    };

    try {
      const answer = await runAgent(
        config.geminiApiKey,
        config.geminiModel,
        router,
        text,
        history,
        config.walletAddress,
        confirmFn,
        "telegram",
        cache,
      );

      await sendLongMessage(ctx.api, chatId, answer);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      debug(`Telegram agent error: ${errorMsg}`);
      await ctx.api.sendMessage(chatId, `❌ Error: ${errorMsg}`);
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────────

  /** Escape &, <, > in plain-text segments for Telegram HTML. */
  function escapeHtmlText(text: string): string {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  /**
   * Whitelist of tags Telegram supports.
   * Matches simple open/close tags and `<a href="...">`.
   */
  const ALLOWED_TAG_RE =
    /^<\/?(b|i|u|s|code|pre|strong|em|ins|del|strike|blockquote)\s*>$/i;
  const ALLOWED_A_OPEN_RE = /^<a\s+href="https?:\/\/[^"]*"\s*>$/i;
  const ALLOWED_A_CLOSE_RE = /^<\/a>$/i;

  function isAllowedTag(tag: string): boolean {
    return ALLOWED_TAG_RE.test(tag) || ALLOWED_A_OPEN_RE.test(tag) || ALLOWED_A_CLOSE_RE.test(tag);
  }

  /**
   * Sanitize model output for Telegram HTML.
   * Keeps whitelisted tags intact; escapes everything else.
   */
  function sanitizeHtml(text: string): string {
    const parts: string[] = [];
    let pos = 0;
    const tagRe = /<\/?[a-zA-Z][^>]*>/g;
    let match: RegExpExecArray | null;

    while ((match = tagRe.exec(text)) !== null) {
      if (match.index > pos) {
        parts.push(escapeHtmlText(text.slice(pos, match.index)));
      }
      parts.push(isAllowedTag(match[0]) ? match[0] : escapeHtmlText(match[0]));
      pos = match.index + match[0].length;
    }

    if (pos < text.length) {
      parts.push(escapeHtmlText(text.slice(pos)));
    }

    return parts.join("");
  }

  /** Strip HTML tags and unescape entities for plain-text fallback. */
  function toPlainText(html: string): string {
    return html
      .replace(/<[^>]*>/g, "")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, "\"");
  }

  /**
   * Find a safe break point that doesn't split inside an HTML tag or entity.
   * After sanitisation the only raw `<`/`>` belong to whitelisted tags,
   * and `&` starts escaped entities like `&amp;`, `&lt;`, `&gt;`.
   */
  function safeSplit(text: string, maxLen: number): number {
    const nlPos = text.lastIndexOf("\n", maxLen);
    let bp = nlPos > 0 ? nlPos : maxLen;

    // If the break falls inside a tag (unclosed `<`), move before it.
    const lastOpen = text.lastIndexOf("<", bp);
    const lastClose = text.lastIndexOf(">", bp);
    if (lastOpen > lastClose && lastOpen > 0) {
      bp = lastOpen;
    }

    // If the break falls inside an HTML entity (`&...;`), move before the `&`.
    const lastAmp = text.lastIndexOf("&", bp);
    if (lastAmp >= 0 && lastAmp < bp) {
      const semi = text.indexOf(";", lastAmp);
      if (semi >= bp) {
        bp = lastAmp;
      }
    }

    return bp;
  }

  /**
   * Track which HTML tags are open in a chunk so we can close/reopen
   * them across chunk boundaries.
   */
  const SELF_CLOSING_RE = /^<\/?(b|i|u|s|code|pre|strong|em|ins|del|strike|blockquote)\s*>$/i;

  function getTagName(tag: string): string | null {
    const m = tag.match(/^<\/?\s*([a-zA-Z]+)/);
    return m ? m[1].toLowerCase() : null;
  }

  function isClosingTag(tag: string): boolean {
    return tag.startsWith("</");
  }

  interface OpenTag {
    /** Lowercase tag name, e.g. "b", "a". */
    name: string;
    /** Full opening tag string, e.g. "<b>" or '<a href="https://...">'. */
    openTag: string;
  }

  /**
   * Compute the stack of unclosed tags in a chunk of sanitized HTML.
   * Returns full opening tag info so anchors can be reconstructed with href.
   */
  function openTagStack(html: string): OpenTag[] {
    const stack: OpenTag[] = [];
    const tagRe = /<\/?[a-zA-Z][^>]*>/g;
    let m: RegExpExecArray | null;
    while ((m = tagRe.exec(html)) !== null) {
      const name = getTagName(m[0]);
      if (!name) continue;
      if (isClosingTag(m[0])) {
        const idx = (() => { for (let i = stack.length - 1; i >= 0; i--) { if (stack[i].name === name) return i; } return -1; })();
        if (idx !== -1) stack.splice(idx, 1);
      } else if (SELF_CLOSING_RE.test(m[0]) || /^<a\s/i.test(m[0])) {
        stack.push({ name, openTag: m[0] });
      }
    }
    return stack;
  }

  /** Check if a Telegram API error is an HTML parse failure. */
  function isHtmlParseError(err: unknown): boolean {
    if (!(err instanceof Error)) return false;
    const msg = err.message.toLowerCase();
    if (!msg.includes("can't parse")) return false;
    return msg.includes("entities") || msg.includes("message text");
  }

  /** Try to send with HTML; fall back to plain text only for parse errors. */
  async function sendHtmlWithFallback(
    api: Api,
    chatId: number,
    html: string,
  ): Promise<void> {
    try {
      await api.sendMessage(chatId, html, { parse_mode: "HTML" });
    } catch (err) {
      if (isHtmlParseError(err)) {
        debug(`Telegram HTML parse error, falling back to plain text: ${err instanceof Error ? err.message : String(err)}`);
        await api.sendMessage(chatId, toPlainText(html));
      } else {
        throw err;
      }
    }
  }

  async function sendLongMessage(
    api: Api,
    chatId: number,
    rawText: string,
  ): Promise<void> {
    const text = sanitizeHtml(rawText);

    if (text.length <= MAX_MESSAGE_LENGTH) {
      await sendHtmlWithFallback(api, chatId, text);
      return;
    }

    let remaining = text;
    /** Tags left open from the previous chunk that need reopening. */
    let carryOver: OpenTag[] = [];

    while (remaining.length > 0) {
      // Prepend reopened tags from the previous chunk.
      const prefix = carryOver.map((t) => t.openTag).join("");

      let chunk: string;
      if (remaining.length + prefix.length <= MAX_MESSAGE_LENGTH) {
        chunk = remaining;
        remaining = "";
      } else {
        // Compute budget: reserve space for prefix, then select chunk,
        // then compute the actual suffix and trim if needed.
        const roughBudget = MAX_MESSAGE_LENGTH - prefix.length - 200;
        const bp = safeSplit(remaining, Math.max(roughBudget, 1));
        chunk = remaining.slice(0, bp);
        remaining = remaining.slice(bp).replace(/^\n/, "");
      }

      // Close any tags left open in this chunk.
      const open = openTagStack(prefix + chunk);
      const suffix = [...open].reverse().map((t) => `</${t.name}>`).join("");

      // If prefix + chunk + suffix exceeds the limit, trim chunk to fit.
      const maxChunkLen = MAX_MESSAGE_LENGTH - prefix.length - suffix.length;
      if (chunk.length > maxChunkLen) {
        const trimBp = safeSplit(chunk, maxChunkLen);
        remaining = chunk.slice(trimBp).replace(/^\n/, "") + remaining;
        chunk = chunk.slice(0, trimBp);
      }

      // Recompute suffix after potential trim.
      const finalOpen = openTagStack(prefix + chunk);
      const finalSuffix = [...finalOpen].reverse().map((t) => `</${t.name}>`).join("");

      await sendHtmlWithFallback(api, chatId, prefix + chunk + finalSuffix);

      // The tags we just force-closed need reopening in the next chunk.
      carryOver = finalOpen;
    }
  }

  // ── Register menu commands with Telegram ──────────────────────────────
  await bot.api.setMyCommands([
    { command: "help", description: "Show usage info" },
    { command: "clear", description: "Reset conversation history" },
    { command: "watch", description: "Watch a whale wallet" },
    { command: "unwatch", description: "Stop watching a wallet" },
    { command: "whales", description: "List watched wallets & alerts" },
    { command: "purge", description: "Remove wallet and all its data" },
    { command: "pause", description: "Pause tracking a wallet" },
    { command: "resume", description: "Resume tracking a wallet" },
    { command: "exchange_wallets", description: "List exchange wallets & recent transfers" },
    { command: "add_exchange", description: "Add an exchange wallet to track" },
    { command: "remove_exchange", description: "Remove an exchange wallet" },
    { command: "pause_exchange", description: "Pause tracking an exchange wallet" },
    { command: "resume_exchange", description: "Resume a paused exchange wallet" },
  ]);

  // ── Whale alert forwarding (throttled per wallet) ──────────────────
  const alertBuffer = new Map<string, WhaleSwapEvent[]>();
  const flushTimers = new Map<string, ReturnType<typeof setTimeout>>();

  if (whaleTracker) {
    const THROTTLE_MS = 3_000;

    const flushAlerts = (walletAddress: string) => {
      const events = alertBuffer.get(walletAddress);
      alertBuffer.delete(walletAddress);
      flushTimers.delete(walletAddress);
      if (!events || events.length === 0) return;

      const targetChatId = config.telegramChatId;
      if (!targetChatId) {
        debug("Whale alert not forwarded to Telegram: TELEGRAM_CHAT_ID is not set");
        return;
      }

      let msg: string;
      if (events.length === 1) {
        const a = events[0].alert;
        const label = a.walletLabel || a.walletAddress.slice(0, 8) + "...";
        const token = a.tokenSymbol || a.tokenAddress.slice(0, 8) + "...";
        const action = a.action === "buy" ? "🟢 BUY" : a.action === "sell" ? "🔴 SELL" : "⚪ ???";
        msg = `🐋 <b>Whale Alert</b>\n${action} <b>${label}</b> → <code>${token}</code>\nAmount: ${a.solAmount} SOL\nTx: <code>${a.signature.slice(0, 16)}...</code>`;
      } else {
        const first = events[0].alert;
        const label = first.walletLabel || first.walletAddress.slice(0, 8) + "...";
        let buyCount = 0;
        let sellCount = 0;
        let totalSol = 0;
        for (const e of events) {
          if (e.alert.action === "buy") buyCount++;
          else if (e.alert.action === "sell") sellCount++;
          totalSol += parseFloat(e.alert.solAmount) || 0;
        }
        msg = `🐋 <b>Whale Alert Batch</b>\n<b>${label}</b>: ${events.length} swaps detected\n${buyCount} buys, ${sellCount} sells\nTotal: ~${totalSol.toFixed(2)} SOL volume`;
      }

      bot.api.sendMessage(targetChatId, msg, { parse_mode: "HTML" }).catch((err) => {
        debug(`Failed to forward whale alert to Telegram: ${err instanceof Error ? err.message : String(err)}`);
      });
    };

    const forwardAlert = (event: WhaleSwapEvent) => {
      const addr = event.alert.walletAddress;
      const buffer = alertBuffer.get(addr) ?? [];
      buffer.push(event);
      alertBuffer.set(addr, buffer);

      if (!flushTimers.has(addr)) {
        flushTimers.set(addr, setTimeout(() => flushAlerts(addr), THROTTLE_MS));
      }
    };

    whaleTracker.on("alert", forwardAlert);

    whaleTracker.on("wallet-paused", (event: WhaleWalletPausedEvent) => {
      const targetChatId = config.telegramChatId;
      if (!targetChatId) return;
      const msg = `⚠️ <b>Wallet Auto-Paused</b>\n<b>${event.label}</b> (<code>${event.address}</code>) was generating too many alerts and has been automatically paused.\nUse /resume ${event.address} to re-enable tracking.`;
      bot.api.sendMessage(targetChatId, msg, { parse_mode: "HTML" }).catch((err) => {
        debug(`Failed to send wallet-paused notification: ${err instanceof Error ? err.message : String(err)}`);
      });
    });
  }

  // ── Exchange transfer alert forwarding ────────────────────────────
  if (exchangeTracker && analyzeExchangeTransfer) {
    exchangeTracker.on("transfer", (event: ExchangeTransferEvent) => {
      const targetChatId = config.telegramChatId;
      if (!targetChatId) {
        debug("Exchange transfer alert not forwarded to Telegram: TELEGRAM_CHAT_ID is not set");
        return;
      }

      const t = event.transfer;
      const safeExchangeName = escapeHtmlText(t.exchangeName);
      const typeIcon =
        t.transferType === "cold_to_hot"
          ? "🔴"
          : t.transferType === "hot_to_cold"
          ? "🟢"
          : "🔄";
      const typeLabel = t.transferType.replace(/_/g, " ").toUpperCase();

      // Send immediate raw alert
      const alertMsg =
        `🏦 <b>Exchange Transfer Alert</b>\n` +
        `${typeIcon} <b>${safeExchangeName}</b> — ${typeLabel}\n` +
        `Amount: <b>${t.solAmount.toFixed(0)} SOL</b>\n` +
        `From (${t.fromType}): <code>${t.fromAddress.slice(0, 12)}...</code>\n` +
        `To (${t.toType}): <code>${t.toAddress.slice(0, 12)}...</code>\n` +
        `Tx: <code>${t.signature.slice(0, 16)}...</code>\n\n` +
        `⏳ <i>Running Gemini market analysis...</i>`;

      bot.api
        .sendMessage(targetChatId, alertMsg, { parse_mode: "HTML" })
        .then(() => {
          // Then run the Gemini analysis asynchronously and send as follow-up
          return analyzeExchangeTransfer(event);
        })
        .then((analysis) => {
          const analysisMsg =
            `🤖 <b>Gemini Analysis — ${safeExchangeName} ${typeLabel}</b>\n\n` +
            sanitizeHtml(analysis);
          return sendLongMessage(bot.api, targetChatId, analysisMsg);
        })
        .catch((err) => {
          debug(
            `Failed to forward exchange transfer to Telegram: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
    });
  }

  // ── Start bot ────────────────────────────────────────────────────────
  // bot.start() runs long-polling in the background and returns immediately
  // after the first getUpdates call succeeds.
  bot.start({
    onStart: () => {
      console.log("Telegram bot started (long-polling).");
      if (config.telegramChatId) {
        console.log(`Telegram bot restricted to chat ID: ${config.telegramChatId}`);
      } else {
        console.log("⚠️  TELEGRAM_CHAT_ID not set — bot will accept messages from any user.");
      }
    },
  });

  return () => {
    // Clean up pending confirmations.
    for (const [, pending] of pendingConfirmations) {
      clearTimeout(pending.timer);
      pending.resolve(false);
    }
    pendingConfirmations.clear();
    // Clean up throttle flush timers.
    for (const [, timer] of flushTimers) {
      clearTimeout(timer);
    }
    flushTimers.clear();
    alertBuffer.clear();
    bot.stop();
  };
}
