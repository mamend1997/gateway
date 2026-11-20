import path from 'node:path';
import { readJson, writeJson } from './jsonStore.js';

export class MessageQuota {
  constructor({ dataDir, perMinuteLimit = 10, dailyLimit = 100 }) {
    this.filePath = path.join(dataDir, 'message-quotas.json');
    this.perMinuteLimit = perMinuteLimit;
    this.dailyLimit = dailyLimit;
    this.usage = new Map();
    this.persistTimer = null;
    this.pendingPersist = Promise.resolve();
  }

  async start() {
    const saved = await readJson(this.filePath, {});
    for (const [deviceId, usage] of Object.entries(saved)) {
      if (typeof usage.day === 'string' && Number.isInteger(usage.dailyCount) && Array.isArray(usage.minuteLog)) {
        this.usage.set(deviceId, usage);
      }
    }
  }

  current(deviceId, now = Date.now()) {
    const day = new Date(now).toISOString().slice(0, 10);
    let usage = this.usage.get(deviceId);
    if (!usage || usage.day !== day) {
      usage = { day, dailyCount: 0, minuteLog: [] };
      this.usage.set(deviceId, usage);
    }
    usage.minuteLog = usage.minuteLog.filter((timestamp) => Number.isFinite(timestamp) && timestamp > now - 60_000);
    return usage;
  }

  reserveDaily(deviceId, units = 1) {
    const usage = this.current(deviceId);
    if (usage.dailyCount + units > this.dailyLimit) {
      this.schedulePersist();
      return {
        allowed: false,
        status: 'quota_exceeded',
        error: 'Batas kuota harian device tercapai.',
        dailyRemaining: Math.max(0, this.dailyLimit - usage.dailyCount),
      };
    }
    usage.dailyCount += units;
    this.schedulePersist();
    return {
      allowed: true,
      dailyRemaining: Math.max(0, this.dailyLimit - usage.dailyCount),
    };
  }

  reserveMinute(deviceId, units = 1) {
    const now = Date.now();
    const usage = this.current(deviceId, now);
    if (usage.minuteLog.length + units > this.perMinuteLimit) {
      const retryAfterMs = Math.max(1000, usage.minuteLog[0] + 60_000 - now);
      this.schedulePersist();
      return {
        allowed: false,
        status: 'rate_limited',
        error: 'Batas pengiriman per menit device tercapai.',
        retryAfterMs,
        dailyRemaining: Math.max(0, this.dailyLimit - usage.dailyCount),
      };
    }
    for (let index = 0; index < units; index += 1) usage.minuteLog.push(now);
    this.schedulePersist();
    return {
      allowed: true,
      dailyRemaining: Math.max(0, this.dailyLimit - usage.dailyCount),
    };
  }

  getStatus(deviceId) {
    const usage = this.current(deviceId);
    return {
      deviceId,
      dailyLimit: this.dailyLimit,
      dailyUsed: usage.dailyCount,
      dailyRemaining: Math.max(0, this.dailyLimit - usage.dailyCount),
      perMinuteLimit: this.perMinuteLimit,
      minuteUsed: usage.minuteLog.length,
      minuteRemaining: Math.max(0, this.perMinuteLimit - usage.minuteLog.length),
      resetsAt: `${usage.day}T23:59:59.999Z`,
    };
  }

  schedulePersist() {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.persistNow();
    }, 100);
    this.persistTimer.unref();
  }

  persistNow() {
    const snapshot = Object.fromEntries(this.usage);
    this.pendingPersist = this.pendingPersist
      .catch(() => {})
      .then(() => writeJson(this.filePath, snapshot))
      .catch((error) => console.error('Gagal menyimpan kuota pengiriman:', error));
    return this.pendingPersist;
  }

  async stop() {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = null;
    await this.persistNow();
  }
}
