import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { MessageQuota } from '../services/messageQuota.js';
import { QueueManager } from '../services/queue.js';

test('message quota enforces minute and daily limits across restarts', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gateway-message-quota-'));
  try {
    const first = new MessageQuota({ dataDir, perMinuteLimit: 2, dailyLimit: 3 });
    await first.start();
    assert.equal(first.reserveDaily('device-1', 2).allowed, true);
    assert.equal(first.reserveMinute('device-1', 2).allowed, true);
    assert.equal(first.reserveMinute('device-1').status, 'rate_limited');
    await first.stop();
    const filePath = path.join(dataDir, 'message-quotas.json');
    const saved = JSON.parse(await fs.readFile(filePath, 'utf8'));
    saved['device-1'].minuteLog = [];
    await fs.writeFile(filePath, JSON.stringify(saved));

    const restarted = new MessageQuota({ dataDir, perMinuteLimit: 2, dailyLimit: 3 });
    await restarted.start();
    assert.equal(restarted.reserveDaily('device-1').allowed, true);
    assert.equal(restarted.reserveDaily('device-1').status, 'quota_exceeded');
    await restarted.stop();
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test('queue blocks duplicate sends and exposes per-device quota remaining', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gateway-queue-quota-'));
  const waManager = new EventEmitter();
  const client = {
    isConnected: () => false,
    sendMessage: async () => {},
  };
  waManager.getClient = () => client;
  waManager.listDevices = () => [{ id: 'device-1', name: 'Test device' }];
  const queue = new QueueManager({
    waManager,
    dataDir,
    minDelayMs: 0,
    maxDelayMs: 0,
    maxRetries: 0,
    maxMessagesPerMinute: 2,
    maxMessagesPerDay: 1,
  });
  try {
    await queue.start();
    const first = queue.enqueue({
      deviceId: 'device-1',
      target: '6281234567890',
      message: 'Pesan yang sama',
    });
    const duplicate = queue.enqueue({
      deviceId: 'device-1',
      target: '6281234567890',
      message: 'Pesan yang sama',
    });
    const overQuota = queue.enqueue({
      deviceId: 'device-1',
      target: '6285712345678',
      message: 'Pesan lainnya',
    });

    assert.equal(first.status, 'queued');
    assert.equal(first.dailyRemaining, 0);
    assert.equal(duplicate.status, 'duplicate_suppressed');
    assert.equal(overQuota.status, 'quota_exceeded');
    assert.equal(queue.getQuotaStatus().devices[0].dailyRemaining, 0);
  } finally {
    await queue.stop();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
