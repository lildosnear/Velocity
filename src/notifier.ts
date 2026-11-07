/**
 * Outbound Telegram messages from background jobs (watcher, copy engine).
 * The sender is wired once at boot in index.ts. Keeping it here avoids
 * circular imports between commands.ts and the background modules.
 */

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
