import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readJson, writeJson } from './jsonStore.js';

function getMessageText(message) {
  const content = message.message ?? {};
  return content.conversation
    ?? content.extendedTextMessage?.text
    ?? content.imageMessage?.caption
    ?? content.videoMessage?.caption
    ?? content.documentMessage?.caption
    ?? '';
}

export class AutoReplyService {
  constructor({ dataDir, waManager, queueManager }) {
    this.filePath = path.join(dataDir, 'auto-replies.json');
    this.waManager = waManager;
    this.queueManager = queueManager;
    this.rules = [];
    this.recentMessages = new Set();
    this.waManager.on('message', ({ deviceId, message }) => {
      this.handleMessage(deviceId, message).catch((error) => {
        console.error('Gagal memproses auto-reply:', error);
      });
    });
  }

  async start() {
    this.rules = await readJson(this.filePath, []);
  }

  async add({ deviceId, keyword, reply }) {
    const normalizedKeyword = keyword.trim();
    const text = reply.trim();
    if (!normalizedKeyword || !text) {
      throw new Error('Kata kunci dan balasan wajib diisi.');
    }
    if (normalizedKeyword.length > 200 || text.length > 4000) {
      throw new Error('Kata kunci maksimal 200 karakter dan balasan maksimal 4000 karakter.');
    }
    const rule = {
      id: randomUUID(),
      deviceId: deviceId || null,
      keyword: normalizedKeyword,
      reply: text,
      enabled: true,
      createdAt: new Date().toISOString(),
    };
    this.rules.unshift(rule);
    await this.persist();
    return rule;
  }

  async update(id, changes) {
    const rule = this.rules.find((item) => item.id === id);
    if (!rule) return null;
    if (typeof changes.keyword === 'string'
        && (changes.keyword.trim().length === 0 || changes.keyword.trim().length > 200)) {
      throw new Error('Kata kunci harus berisi 1 sampai 200 karakter.');
    }
    if (typeof changes.reply === 'string'
        && (changes.reply.trim().length === 0 || changes.reply.trim().length > 4000)) {
      throw new Error('Balasan harus berisi 1 sampai 4000 karakter.');
    }
    if (typeof changes.enabled === 'boolean') rule.enabled = changes.enabled;
    if (typeof changes.keyword === 'string' && changes.keyword.trim()) {
      rule.keyword = changes.keyword.trim();
    }
    if (typeof changes.reply === 'string' && changes.reply.trim()) {
      rule.reply = changes.reply.trim();
    }
    await this.persist();
    return rule;
  }

  async remove(id) {
    const length = this.rules.length;
    this.rules = this.rules.filter((rule) => rule.id !== id);
    if (this.rules.length === length) return false;
    await this.persist();
    return true;
  }

  getRules() {
    return this.rules;
  }

  async handleMessage(deviceId, message) {
    const messageId = message.key?.id;
    const remoteJid = message.key?.remoteJid;
    if (!messageId || !remoteJid || remoteJid.endsWith('@broadcast') || message.key?.fromMe) return;
    const text = getMessageText(message).trim().toLocaleLowerCase();
    if (!text) return;
    const dedupeKey = `${deviceId}:${messageId}`;
    if (this.recentMessages.has(dedupeKey)) return;
    this.recentMessages.add(dedupeKey);
    if (this.recentMessages.size > 2000) {
      this.recentMessages.delete(this.recentMessages.values().next().value);
    }
    const rule = this.rules.find((item) => (
      item.enabled
      && (!item.deviceId || item.deviceId === deviceId)
      && text.includes(item.keyword.toLocaleLowerCase())
    ));
    if (!rule) return;
    this.queueManager.enqueue({
      deviceId,
      target: remoteJid,
      message: rule.reply,
      autoReplyRuleId: rule.id,
    });
  }

  async persist() {
    await writeJson(this.filePath, this.rules);
  }
}
