import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { InboxStore } from '../services/inboxStore.js';

test('stores and restores incoming messages including wrapped text', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gateway-inbox-'));
  const waManager = new EventEmitter();
  waManager.getClient = () => ({ getContacts: () => [] });
  const inbox = new InboxStore({ dataDir, waManager });
  try {
    await inbox.start();
    const message = {
      key: { id: 'incoming-1', remoteJid: '6281234567890@s.whatsapp.net' },
      pushName: 'Rina',
      messageTimestamp: 1_800_000_000,
      message: { ephemeralMessage: { message: { conversation: 'Halo, saya perlu bantuan.' } } },
    };
    waManager.emit('message', { deviceId: 'primary', message });
    waManager.emit('message', { deviceId: 'primary', message });

    assert.deepEqual(inbox.getMessages().map((item) => ({
      id: item.id,
      deviceId: item.deviceId,
      remoteJid: item.remoteJid,
      senderName: item.senderName,
      text: item.text,
    })), [{
      id: 'incoming-1',
      deviceId: 'primary',
      remoteJid: '6281234567890@s.whatsapp.net',
      senderName: 'Rina',
      text: 'Halo, saya perlu bantuan.',
    }]);

    await inbox.stop();
    const restored = new InboxStore({ dataDir, waManager });
    await restored.start();
    assert.equal(restored.getMessage('incoming-1').text, 'Halo, saya perlu bantuan.');
    await restored.stop();
  } finally {
    await inbox.stop();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
