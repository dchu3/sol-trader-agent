import { Bot, InlineKeyboard, type Context } from "grammy";
import type { Content } from "@google/genai";
import type { Config } from "./config.js";
import type { ToolRouter, ConfirmFn } from "./agent.js";
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
    if (config.telegramChatId && chatId !== config.telegramChatId) {
      debug(`Telegram: rejected message from unauthorised chat ${chatId}`);
      await ctx.reply("⛔ You are not authorised to use this bot.");
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
      );

      await sendLongMessage(ctx, chatId, answer);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      debug(`Telegram agent error: ${errorMsg}`);
      await ctx.api.sendMessage(chatId, `❌ Error: ${errorMsg}`);
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────────
  async function sendLongMessage(
    ctx: Context,
    chatId: number,
    text: string,
  ): Promise<void> {
    if (text.length <= MAX_MESSAGE_LENGTH) {
      await ctx.api.sendMessage(chatId, text);
      return;
    }

    // Split on newlines where possible, falling back to hard splits.
    let remaining = text;
    while (remaining.length > 0) {
      let chunk: string;
      if (remaining.length <= MAX_MESSAGE_LENGTH) {
        chunk = remaining;
        remaining = "";
      } else {
        const splitAt = remaining.lastIndexOf("\n", MAX_MESSAGE_LENGTH);
        const breakPoint = splitAt > 0 ? splitAt : MAX_MESSAGE_LENGTH;
        chunk = remaining.slice(0, breakPoint);
        remaining = remaining.slice(breakPoint).replace(/^\n/, "");
      }
      await ctx.api.sendMessage(chatId, chunk);
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
