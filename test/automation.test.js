import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { AutoReplyService } from '../services/autoReply.js';
import { GeminiAutoReplyService } from '../services/aiAutoReply.js';
import { MessageHistoryStore } from '../services/historyStore.js';
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
      queueManager: { enqueue: (item) => { queued.push(item); return { status: 'queued' }; } },
    });
    await service.start();
    await service.add({ deviceId: 'primary', keyword: 'Harga', reply: 'Silakan cek katalog.' });
    const incoming = {
      key: { id: 'message-1', remoteJid: '6281234567890@s.whatsapp.net' },
      message: { conversation: 'Info HARGA dong' },
    };

    await service.handleMessage('primary', incoming);
    await service.handleMessage('primary', incoming);
    await service.handleMessage('primary', {
      ...incoming,
      key: { ...incoming.key, id: 'message-2' },
    });

    assert.equal(queued.length, 1);
    assert.equal(queued[0].target, '6281234567890@s.whatsapp.net');
    assert.equal(queued[0].message, 'Silakan cek katalog.');
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test('Gemini auto-reply sends one private-chat reply and respects keyword rules', async () => {
  const manager = new EventEmitter();
  const queued = [];
  let requests = 0;
  const service = new GeminiAutoReplyService({
    apiKey: 'test-gemini-key',
    enabled: true,
    waManager: manager,
    autoReply: {
      findMatchingRule: (_deviceId, text) => text.includes('human'),
      canReply: () => true,
      recordReply() {},
    },
    queueManager: {
      enqueue(item) {
        queued.push(item);
        return { status: 'queued' };
      },
    },
    fetchImpl: async (url, options) => {
      requests += 1;
      assert.match(url, /models\/gemini-2\.5-flash:generateContent$/);
      assert.equal(options.headers['x-goog-api-key'], 'test-gemini-key');
      return Response.json({
        candidates: [{ content: { parts: [{ text: 'Tentu, saya bantu.' }] } }],
      });
    },
  });

  await service.handleMessage('device-1', {
    key: { id: 'inbound-1', remoteJid: '6281234567890@s.whatsapp.net' },
    message: { conversation: 'Halo' },
  });
  await service.handleMessage('device-1', {
    key: { id: 'inbound-2', remoteJid: '6281234567890@s.whatsapp.net' },
    message: { conversation: 'Need a human' },
  });
  await service.handleMessage('device-1', {
    key: { id: 'inbound-group', remoteJid: 'group@g.us' },
    message: { conversation: 'Halo' },
  });

  assert.equal(requests, 1);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].message, 'Tentu, saya bantu.');
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
      attachments: [
        { buffer: Buffer.from('one'), mimetype: 'image/png', originalName: 'one.png' },
        { buffer: Buffer.from('two'), mimetype: 'application/pdf', originalName: 'two.pdf' },
      ],
    });
    await first.stop();

    const restarted = new MessageScheduler({ dataDir, queueManager });
    await restarted.start();
    assert.equal(restarted.getJobs()[0].id, job.id);
    assert.equal(restarted.getJobs()[0].status, 'scheduled');
    assert.equal(JSON.parse(await fs.readFile(path.join(dataDir, 'schedules.json'), 'utf8'))[0].attachments.length, 2);
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

test('message history survives restart and marks in-flight sends as interrupted', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gateway-history-'));
  try {
    const history = new MessageHistoryStore({ dataDir });
    await history.start();
    history.upsert({
      id: 'sent-1',
      phone: '6281234567890',
      deviceId: 'primary',
      preview: 'OTP terkirim',
      status: 'sent',
      attempts: 1,
      createdAt: '2026-11-20T00:00:00.000Z',
      updatedAt: '2026-11-20T00:00:01.000Z',
      error: null,
    });
    history.upsert({
      id: 'queued-1',
      phone: '6285712345678',
      deviceId: 'primary',
      preview: 'OTP antre',
      status: 'sending',
      attempts: 1,
      createdAt: '2026-11-20T00:00:02.000Z',
      updatedAt: '2026-11-20T00:00:03.000Z',
      error: null,
    });
    await history.persist();

    const restarted = new MessageHistoryStore({ dataDir });
    await restarted.start();
    const messages = restarted.getMessages();

    assert.equal(messages.find((item) => item.id === 'sent-1').status, 'sent');
    assert.equal(messages.find((item) => item.id === 'queued-1').status, 'failed');
    assert.match(messages.find((item) => item.id === 'queued-1').error, /dimulai ulang/);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
