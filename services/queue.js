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

  enqueue({ phone, target, deviceId = 'primary', message, attachment, minDelayMs, maxDelayMs }) {
    const recipient = target ?? phone;
    const item = {
      id: randomUUID(),
      phone: recipient,
      deviceId,
      attachment,
      hasAttachment: Boolean(attachment),
      minDelayMs: minDelayMs ?? this.minDelayMs,
      maxDelayMs: maxDelayMs ?? this.maxDelayMs,
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

        const delay = item.minDelayMs
          + Math.floor(Math.random() * (item.maxDelayMs - item.minDelayMs + 1));
        if (delay > 0) await sleep(delay);
        if (this.stopped) break;

        item.status = 'sending';
        item.updatedAt = new Date().toISOString();
        let finished = false;

        while (!finished && !this.stopped) {
          item.attempts += 1;
          try {
            await this.waClient.sendMessage(item.phone, item.message, item.attachment);
            item.status = 'sent';
            item.error = null;
            item.attachment = null;
            item.updatedAt = new Date().toISOString();
            finished = true;
          } catch (error) {
            item.error = error.message || 'Pengiriman gagal.';
            item.updatedAt = new Date().toISOString();
            if (error.permanent || item.attempts > this.maxRetries) {
              item.status = 'failed';
              item.attachment = null;
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
    const { message, attachment, minDelayMs, maxDelayMs, ...publicItem } = item;
    return {
      ...publicItem,
      hasAttachment: publicItem.hasAttachment ?? Boolean(attachment),
      preview: message.length > 120 ? `${message.slice(0, 117)}...` : message,
    };
  }
}

export class QueueManager {
  constructor({ waManager, minDelayMs, maxDelayMs, maxRetries }) {
    this.waManager = waManager;
    this.options = { minDelayMs, maxDelayMs, maxRetries };
    this.queues = new Map();
    this.stopped = false;
    this.waManager.on('deviceRemoved', (deviceId) => {
      this.queues.get(deviceId)?.stop();
      this.queues.delete(deviceId);
    });
  }

  getQueue(deviceId = 'primary') {
    const client = this.waManager.getClient(deviceId);
    if (!client) throw new Error('Device pengirim tidak ditemukan.');
    if (!this.queues.has(deviceId)) {
      this.queues.set(deviceId, new MessageQueue({ ...this.options, waClient: client }));
    }
    return this.queues.get(deviceId);
  }

  enqueue(item) {
    if (this.stopped) throw new Error('Antrean sedang ditutup.');
    return this.getQueue(item.deviceId).enqueue(item);
  }

  getMessages() {
    return [...this.queues.values()]
      .flatMap((queue) => queue.getMessages())
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  stop() {
    this.stopped = true;
    for (const queue of this.queues.values()) queue.stop();
  }
}
