import { Bot, InlineKeyboard, type Context } from "grammy";
import type { Content } from "@google/genai";
import type { Config } from "./config.js";
import type { ToolRouter, ConfirmFn, Channel } from "./agent.js";
import { runAgent } from "./agent.js";
import { debug } from "./logger.js";

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
        "*Commands:*\n" +
        "/help — Show this message\n" +
        "/clear — Reset conversation history\n\n" +
        "Token analysis is paid via x402\\. Trading actions require confirmation\\.",
      { parse_mode: "MarkdownV2" },
    );
  });

  bot.command("clear", async (ctx) => {
    const chatId = ctx.chat.id;
    histories.delete(chatId);
    await ctx.reply("🗑️ Conversation history cleared.");
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
      );

      await sendLongMessage(ctx, chatId, answer);
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
  const ALLOWED_A_OPEN_RE = /^<a\s+href="[^"]*"\s*>$/i;
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
   * Find a safe break point that doesn't split inside an HTML tag.
   * After sanitisation the only raw `<`/`>` belong to whitelisted tags.
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

    return bp;
  }

  async function sendLongMessage(
    ctx: Context,
    chatId: number,
    rawText: string,
  ): Promise<void> {
    const text = sanitizeHtml(rawText);

    if (text.length <= MAX_MESSAGE_LENGTH) {
      try {
        await ctx.api.sendMessage(chatId, text, { parse_mode: "HTML" });
      } catch {
        await ctx.api.sendMessage(chatId, toPlainText(text));
      }
      return;
    }

    let remaining = text;
    while (remaining.length > 0) {
      let chunk: string;
      if (remaining.length <= MAX_MESSAGE_LENGTH) {
        chunk = remaining;
        remaining = "";
      } else {
        const bp = safeSplit(remaining, MAX_MESSAGE_LENGTH);
        chunk = remaining.slice(0, bp);
        remaining = remaining.slice(bp).replace(/^\n/, "");
      }
      try {
        await ctx.api.sendMessage(chatId, chunk, { parse_mode: "HTML" });
      } catch {
        await ctx.api.sendMessage(chatId, toPlainText(chunk));
      }
    }
  }

  // ── Register menu commands with Telegram ──────────────────────────────
  await bot.api.setMyCommands([
    { command: "help", description: "Show usage info" },
    { command: "clear", description: "Reset conversation history" },
  ]);

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
    bot.stop();
  };
}
