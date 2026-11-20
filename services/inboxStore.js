import path from 'node:path';
import { normalizeMessageContent } from '@whiskeysockets/baileys';
import { getMessageText } from './autoReply.js';
import { readJson, writeJson } from './jsonStore.js';

const messageLabels = {
  imageMessage: '[Gambar]',
  videoMessage: '[Video]',
  audioMessage: '[Audio]',
  stickerMessage: '[Stiker]',
  documentMessage: '[Dokumen]',
  locationMessage: '[Lokasi]',
  contactMessage: '[Kontak]',
};

function getTimestamp(message) {
  const timestamp = typeof message.messageTimestamp?.toNumber === 'function'
    ? message.messageTimestamp.toNumber()
    : Number(message.messageTimestamp);
  return Number.isFinite(timestamp) && timestamp > 0
    ? new Date(timestamp * 1000).toISOString()
    : new Date().toISOString();
}

function getMessagePreview(message) {
  const text = getMessageText(message).trim();
  if (text) return text.slice(0, 4000);
  const content = normalizeMessageContent(message.message) ?? {};
  const type = Object.keys(content).find((key) => key === 'conversation' || key.endsWith('Message'));
  return messageLabels[type] ?? '[Pesan tanpa teks]';
}

export class InboxStore {
  constructor({ dataDir, waManager, limit = 1000 }) {
    this.filePath = path.join(dataDir, 'inbox.json');
    this.waManager = waManager;
    this.limit = limit;
    this.messages = [];
    this.persistTimer = null;
    this.pendingPersist = Promise.resolve();
    this.onMessage = ({ deviceId, message }) => {
      this.record(deviceId, message);
    };
    this.waManager.on('message', this.onMessage);
  }

  async start() {
    const savedMessages = await readJson(this.filePath, []);
    if (!Array.isArray(savedMessages)) {
      throw new Error('Data kotak masuk tidak valid.');
    }
    this.messages = savedMessages.slice(0, this.limit);
  }

  record(deviceId, message) {
    const id = message.key?.id;
    const remoteJid = message.key?.remoteJid;
    if (!id || !remoteJid || remoteJid.endsWith('@broadcast') || message.key?.fromMe) return;
    if (this.messages.some((item) => item.deviceId === deviceId && item.id === id)) return;

    const contacts = this.waManager.getClient(deviceId)?.getContacts?.() ?? [];
    const contactName = contacts
      .find((contact) => contact.id === remoteJid)?.name;
    this.messages.unshift({
      id,
      deviceId,
      remoteJid,
      senderName: message.pushName?.trim() || contactName || remoteJid,
      text: getMessagePreview(message),
      createdAt: getTimestamp(message),
    });
    this.messages = this.messages.slice(0, this.limit);
    this.schedulePersist();
  }

  getMessages() {
    return this.messages.map((message) => ({ ...message }));
  }

  getMessage(id) {
    return this.messages.find((message) => message.id === id) ?? null;
  }

  schedulePersist() {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.persistNow().catch((error) => console.error('Gagal menyimpan kotak masuk:', error));
    }, 250);
    this.persistTimer.unref();
  }

  persistNow() {
    const snapshot = this.getMessages();
    this.pendingPersist = this.pendingPersist
      .catch(() => {})
      .then(() => writeJson(this.filePath, snapshot));
    return this.pendingPersist;
  }

  async stop() {
    this.waManager.off('message', this.onMessage);
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = null;
    await this.persistNow();
  }
}
