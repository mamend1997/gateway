import path from 'node:path';
import { readJson, writeJson } from './jsonStore.js';

const interruptedStatus = new Set(['queued', 'sending', 'rate_limited']);

export class MessageHistoryStore {
  constructor({ dataDir, limit = 1000 }) {
    this.filePath = path.join(dataDir, 'messages.json');
    this.limit = limit;
    this.messages = [];
  }

  async start() {
    this.messages = await readJson(this.filePath, []);
    let recovered = false;
    for (const item of this.messages) {
      if (interruptedStatus.has(item.status)) {
        item.status = 'failed';
        item.error = 'Pengiriman terhenti saat gateway dimulai ulang.';
        item.updatedAt = new Date().toISOString();
        recovered = true;
      }
    }
    this.messages = this.messages.slice(0, this.limit);
    if (recovered) await this.persist();
  }

  upsert(item) {
    const index = this.messages.findIndex((message) => message.id === item.id);
    if (index >= 0) this.messages[index] = item;
    else this.messages.unshift(item);
    this.messages = this.messages
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, this.limit);
  }

  getMessages() {
    return this.messages.map((item) => ({ ...item }));
  }

  async persist() {
    await this.persistSnapshot(this.messages);
  }

  async persistSnapshot(snapshot) {
    await writeJson(this.filePath, snapshot);
  }
}
