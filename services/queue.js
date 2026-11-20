import { randomUUID } from 'node:crypto';
import { MessageHistoryStore } from './historyStore.js';
import { MessageQuota } from './messageQuota.js';

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export class MessageQueue {
  constructor({
    waClient,
    minDelayMs,
    maxDelayMs,
    maxRetries,
    batchCooldownEvery,
    batchCooldownMinMs,
    batchCooldownMaxMs,
    quota,
    onChange,
  }) {
    this.waClient = waClient;
    this.minDelayMs = minDelayMs;
    this.maxDelayMs = maxDelayMs;
    this.maxRetries = maxRetries;
    this.onChange = onChange;
    this.batchCooldownEvery = batchCooldownEvery;
    this.batchCooldownMinMs = batchCooldownMinMs;
    this.batchCooldownMaxMs = batchCooldownMaxMs;
    this.quota = quota;
    this.messages = [];
    this.pending = [];
    this.stopped = false;
    this.isProcessing = false;
    this.batchSentCount = 0;
  }

  enqueue({
    phone,
    target,
    deviceId = 'primary',
    message,
    attachment,
    minDelayMs,
    maxDelayMs,
    isBulk = false,
    blocked,
    quotaUnits = 1,
    dailyRemaining,
  }) {
    const recipient = target ?? phone;
    const item = {
      id: randomUUID(),
      phone: recipient,
      deviceId,
      attachment: Array.isArray(attachment) ? attachment : attachment ? [attachment] : [],
      attachmentIndex: 0,
      attachmentCount: Array.isArray(attachment) ? attachment.length : Number(Boolean(attachment)),
      hasAttachment: Array.isArray(attachment) ? attachment.length > 0 : Boolean(attachment),
      minDelayMs: minDelayMs ?? this.minDelayMs,
      maxDelayMs: maxDelayMs ?? this.maxDelayMs,
      message,
      status: blocked?.status ?? 'queued',
      attempts: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      error: blocked?.error ?? null,
      retryAfterMs: blocked?.retryAfterMs,
      dailyRemaining: blocked?.dailyRemaining ?? dailyRemaining,
      quotaUnits,
      isBulk,
    };
    this.messages.unshift(item);
    this.messages = this.messages.slice(0, 500);
    if (!blocked) this.pending.push(item);
    this.onChange?.(this.toPublicMessage(item));
    if (!blocked) void this.process();
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

        let rateAllowed = false;
        while (!rateAllowed && !this.stopped) {
          const rate = this.quota?.reserveMinute(item.deviceId, item.quotaUnits) ?? { allowed: true };
          if (rate.allowed) {
            rateAllowed = true;
            item.error = null;
            item.retryAfterMs = null;
            item.dailyRemaining = rate.dailyRemaining ?? item.dailyRemaining;
          } else {
            item.status = rate.status;
            item.error = rate.error;
            item.retryAfterMs = rate.retryAfterMs;
            item.updatedAt = new Date().toISOString();
            this.onChange?.(this.toPublicMessage(item));
            await sleep(rate.retryAfterMs);
          }
        }
        if (this.stopped) break;

        item.status = 'sending';
        item.updatedAt = new Date().toISOString();
        this.onChange?.(this.toPublicMessage(item));
        let finished = false;

        while (!finished && !this.stopped) {
          item.attempts += 1;
          item.updatedAt = new Date().toISOString();
          this.onChange?.(this.toPublicMessage(item));
          try {
            await this.waClient.sendMessage(item.phone, item.message, item.attachment, item.attachmentIndex);
            item.status = 'sent';
            item.error = null;
            item.attachment = [];
            item.attachmentIndex = 0;
            item.updatedAt = new Date().toISOString();
            this.onChange?.(this.toPublicMessage(item));
            finished = true;
            if (item.isBulk && this.batchCooldownEvery > 0) {
              this.batchSentCount += 1;
              if (this.batchSentCount >= this.batchCooldownEvery) {
                this.batchSentCount = 0;
                const cooldown = this.batchCooldownMinMs
                  + Math.floor(Math.random() * (this.batchCooldownMaxMs - this.batchCooldownMinMs + 1));
                await sleep(cooldown);
              }
            }
          } catch (error) {
            item.error = error.message || 'Pengiriman gagal.';
            if (Number.isInteger(error.attachmentIndex)) item.attachmentIndex = error.attachmentIndex;
            item.updatedAt = new Date().toISOString();
            if (error.permanent || item.attempts > this.maxRetries) {
              item.status = 'failed';
              item.attachment = [];
              item.attachmentIndex = 0;
              finished = true;
            } else {
              item.status = 'queued';
              await sleep(1000 * item.attempts);
            }
            this.onChange?.(this.toPublicMessage(item));
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
      hasAttachment: publicItem.hasAttachment ?? (Array.isArray(attachment) ? attachment.length > 0 : Boolean(attachment)),
      attachmentCount: publicItem.attachmentCount ?? (Array.isArray(attachment) ? attachment.length : Number(Boolean(attachment))),
      preview: message.length > 120 ? `${message.slice(0, 117)}...` : message,
    };
  }
}

export class QueueManager {
  constructor({
    waManager,
    dataDir,
    minDelayMs,
    maxDelayMs,
    maxRetries,
    maxMessagesPerMinute = 10,
    maxMessagesPerDay = 100,
    duplicateWindowMs = 300_000,
    batchCooldownEvery = 25,
    batchCooldownMinMs = 25_000,
    batchCooldownMaxMs = 45_000,
  }) {
    this.waManager = waManager;
    this.options = {
      minDelayMs,
      maxDelayMs,
      maxRetries,
      batchCooldownEvery,
      batchCooldownMinMs,
      batchCooldownMaxMs,
    };
    this.queues = new Map();
    this.stopped = false;
    this.history = new MessageHistoryStore({ dataDir });
    this.pendingPersist = Promise.resolve();
    this.persistTimer = null;
    this.quota = new MessageQuota({
      dataDir,
      perMinuteLimit: maxMessagesPerMinute,
      dailyLimit: maxMessagesPerDay,
    });
    this.duplicateWindowMs = duplicateWindowMs;
    this.recentSends = new Map();
    this.waManager.on('deviceRemoved', (deviceId) => {
      this.queues.get(deviceId)?.stop();
      this.queues.delete(deviceId);
    });
  }

  async start() {
    await this.history.start();
    await this.quota.start();
  }

  getQueue(deviceId = 'primary') {
    const client = this.waManager.getClient(deviceId);
    if (!client) throw new Error('Device pengirim tidak ditemukan.');
    if (!this.queues.has(deviceId)) {
      this.queues.set(deviceId, new MessageQueue({
        ...this.options,
        waClient: client,
        quota: this.quota,
        onChange: (item) => this.record(item),
      }));
    }
    return this.queues.get(deviceId);
  }

  enqueue(item) {
    if (this.stopped) throw new Error('Antrean sedang ditutup.');
    const queue = this.getQueue(item.deviceId);
    const target = item.target ?? item.phone;
    const attachments = Array.isArray(item.attachment) ? item.attachment : item.attachment ? [item.attachment] : [];
    const duplicateKey = `${item.deviceId}:${target}:${item.message}:${attachments.map((file) => `${file.originalName}:${file.buffer?.length ?? 0}`).join(',')}`;
    const now = Date.now();
    for (const [key, timestamp] of this.recentSends) {
      if (timestamp <= now - this.duplicateWindowMs) this.recentSends.delete(key);
    }
    let blocked;
    if (this.recentSends.has(duplicateKey)) {
      blocked = { status: 'duplicate_suppressed', error: 'Pesan yang sama untuk tujuan ini baru saja dikirim.' };
    } else {
      blocked = this.quota.reserveDaily(item.deviceId, Math.max(1, attachments.length));
      if (blocked.allowed) {
        blocked = null;
        this.recentSends.set(duplicateKey, now);
        if (this.recentSends.size > 10_000) {
          this.recentSends.delete(this.recentSends.keys().next().value);
        }
      }
    }
    const quotaUnits = Math.max(1, attachments.length);
    return queue.enqueue({
      ...item,
      attachment: attachments,
      blocked,
      quotaUnits,
      dailyRemaining: blocked?.dailyRemaining,
    });
  }

  getMessages() {
    return this.history.getMessages();
  }

  getQuotaStatus() {
    const devices = (this.waManager.listDevices?.() ?? []).map((device) => {
      const queue = this.queues.get(device.id);
      const pendingCount = queue?.messages.filter((item) => ['queued', 'sending'].includes(item.status)).length ?? 0;
      return {
        ...this.quota.getStatus(device.id),
        name: device.name,
        pendingCount,
      };
    });
    return {
      devices,
      limits: {
        perMinute: this.quota.perMinuteLimit,
        perDay: this.quota.dailyLimit,
        duplicateWindowMs: this.duplicateWindowMs,
        batchCooldownEvery: this.options.batchCooldownEvery,
        batchCooldownMinMs: this.options.batchCooldownMinMs,
        batchCooldownMaxMs: this.options.batchCooldownMaxMs,
      },
      warnings: devices
        .flatMap((device) => [
          ...(device.dailyRemaining === 0 ? [`${device.name}: kuota harian tercapai.`] : []),
          ...(device.dailyUsed > 0 && device.dailyRemaining > 0
              && device.dailyRemaining <= Math.ceil(device.dailyLimit * 0.1)
            ? [`${device.name}: kuota harian hampir habis.`]
            : []),
          ...(device.pendingCount > 100 ? [`${device.name}: antrean besar (${device.pendingCount} pesan).`] : []),
        ]),
    };
  }

  record(item) {
    this.history.upsert(item);
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.persistNow();
    }, 250);
    this.persistTimer.unref();
  }

  persistNow() {
    const snapshot = this.history.getMessages();
    this.pendingPersist = this.pendingPersist
      .catch(() => {})
      .then(() => this.history.persistSnapshot(snapshot))
      .catch((error) => {
        console.error('Gagal menyimpan riwayat pesan:', error);
      });
    return this.pendingPersist;
  }

  async stop() {
    this.stopped = true;
    for (const queue of this.queues.values()) queue.stop();
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = null;
    await this.persistNow();
    await this.quota.stop();
  }
}
