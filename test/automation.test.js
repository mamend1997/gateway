import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { AutoReplyService } from '../services/autoReply.js';
import { MessageScheduler } from '../services/scheduler.js';
import { WhatsAppManager } from '../services/waManager.js';

test('auto-reply queues one matching rule once per incoming message', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gateway-auto-reply-'));
  try {
    const manager = new EventEmitter();
    const queued = [];
    const service = new AutoReplyService({
      dataDir,
      waManager: manager,
      queueManager: { enqueue: (item) => queued.push(item) },
    });
    await service.start();
    await service.add({ deviceId: 'primary', keyword: 'Harga', reply: 'Silakan cek katalog.' });
    const incoming = {
      key: { id: 'message-1', remoteJid: '6281234567890@s.whatsapp.net' },
      message: { conversation: 'Info HARGA dong' },
    };

    await service.handleMessage('primary', incoming);
    await service.handleMessage('primary', incoming);

    assert.equal(queued.length, 1);
    assert.equal(queued[0].target, '6281234567890@s.whatsapp.net');
    assert.equal(queued[0].message, 'Silakan cek katalog.');
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test('scheduled jobs survive a scheduler restart', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gateway-schedules-'));
  const queueManager = { enqueue() {} };
  const first = new MessageScheduler({ dataDir, queueManager });
  try {
    await first.start();
    const job = await first.add({
      deviceId: 'primary',
      targets: [{ id: '6281234567890' }],
      message: 'Pengingat',
      runAt: new Date(Date.now() + 60_000).toISOString(),
      minDelayMs: 1000,
      maxDelayMs: 2000,
    });
    await first.stop();

    const restarted = new MessageScheduler({ dataDir, queueManager });
    await restarted.start();
    assert.equal(restarted.getJobs()[0].id, job.id);
    assert.equal(restarted.getJobs()[0].status, 'scheduled');
    await restarted.stop();
  } finally {
    await first.stop();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test('rotating a device token persists the new secret and invalidates the old one', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gateway-device-token-'));
  try {
    const manager = new WhatsAppManager({ authDir: dataDir, dataDir });
    manager.devices.set('device-1', {
      device: { id: 'device-1', name: 'Test' },
      client: {},
    });
    manager.deviceTokens.set('device-1', 'a'.repeat(64));

    const token = await manager.rotateDeviceToken('device-1');
    const savedTokens = JSON.parse(await fs.readFile(path.join(dataDir, 'device-tokens.json'), 'utf8'));

    assert.equal(token.length, 64);
    assert.notEqual(token, 'a'.repeat(64));
    assert.equal(savedTokens['device-1'], token);
    assert.equal(manager.getDeviceIdForToken(token), 'device-1');
    assert.equal(manager.getDeviceIdForToken('a'.repeat(64)), null);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
