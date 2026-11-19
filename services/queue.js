import { randomUUID } from 'node:crypto';

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export class MessageQueue {
  constructor({ waClient, minDelayMs, maxDelayMs, maxRetries }) {
    this.waClient = waClient;
    this.minDelayMs = minDelayMs;
    this.maxDelayMs = maxDelayMs;
    this.maxRetries = maxRetries;
    this.messages = [];
    this.pending = [];
    this.stopped = false;
    this.isProcessing = false;
  }

  enqueue({ phone, message }) {
    const item = {
      id: randomUUID(),
      phone,
      message,
      status: 'queued',
      attempts: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      error: null,
    };
    this.messages.unshift(item);
    this.messages = this.messages.slice(0, 500);
    this.pending.push(item);
    void this.process();
    return this.toPublicMessage(item);
  }

  getMessages() {
    return this.messages.map((item) => this.toPublicMessage(item));
  }

  stop() {
    this.stopped = true;
  }

  async process() {
    if (this.isProcessing) return;
    this.isProcessing = true;

    try {
      while (this.pending.length > 0 && !this.stopped) {
        const item = this.pending.shift();
        while (!this.waClient.isConnected() && !this.stopped) {
          await sleep(1000);
        }
        if (this.stopped) break;

        const delay = this.minDelayMs
          + Math.floor(Math.random() * (this.maxDelayMs - this.minDelayMs + 1));
        if (delay > 0) await sleep(delay);
        if (this.stopped) break;

        item.status = 'sending';
        item.updatedAt = new Date().toISOString();
        let finished = false;

        while (!finished && !this.stopped) {
          item.attempts += 1;
          try {
            await this.waClient.sendText(item.phone, item.message);
            item.status = 'sent';
            item.error = null;
            item.updatedAt = new Date().toISOString();
            finished = true;
          } catch (error) {
            item.error = error.message || 'Pengiriman gagal.';
            item.updatedAt = new Date().toISOString();
            if (error.permanent || item.attempts > this.maxRetries) {
              item.status = 'failed';
              finished = true;
            } else {
              item.status = 'queued';
              await sleep(1000 * item.attempts);
            }
          }
        }
      }
    } finally {
      this.isProcessing = false;
      if (this.pending.length > 0 && !this.stopped) void this.process();
    }
  }

  toPublicMessage(item) {
    const { message, ...publicItem } = item;
    return {
      ...publicItem,
      preview: message.length > 120 ? `${message.slice(0, 117)}...` : message,
    };
  }
}
