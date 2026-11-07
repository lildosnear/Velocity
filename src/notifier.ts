/**
 * Outbound Telegram messages from background jobs (watcher, copy engine).
 * The senders are wired once at boot in index.ts. Keeping them here avoids
 * circular imports between commands.ts and the background modules.
 */
import type { InlineKeyboard } from "grammy";

type Sender = (telegramId: number, text: string) => Promise<void>;

let sender: Sender | undefined;

export function setSender(fn: Sender): void {
  sender = fn;
}

export async function notify(telegramId: number, text: string): Promise<void> {
  if (!sender) {
    console.warn("notify() called before sender was set, dropping message:", text.slice(0, 80));
    return;
  }
  try {
    await sender(telegramId, text);
  } catch (err: any) {
    console.error(`Failed to notify ${telegramId}:`, err?.message ?? err);
  }
}

/** Where a sent message lives, so button taps can edit it later. */
export interface SentMessageRef {
  chatId: number;
  messageId: number;
}

type AlertSender = (
  telegramId: number,
  text: string,
  keyboard: InlineKeyboard,
) => Promise<SentMessageRef | undefined>;

let alertSender: AlertSender | undefined;

export function setAlertSender(fn: AlertSender): void {
  alertSender = fn;
}

/**
 * Send a message with an inline keyboard (trader alerts with Buy and
 * Ignore buttons) and report where it landed. When no alert sender is
 * wired, falls back to a plain text notify and reports no location.
 */
export async function notifyAlert(
  telegramId: number,
  text: string,
  keyboard: InlineKeyboard,
): Promise<SentMessageRef | undefined> {
  if (!alertSender) {
    await notify(telegramId, text);
    return undefined;
  }
  try {
    return await alertSender(telegramId, text, keyboard);
  } catch (err: any) {
    console.error(`Failed to notify ${telegramId}:`, err?.message ?? err);
    return undefined;
  }
}
