import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MessageQuota } from '../services/messageQuota.js';

test('message quota enforces minute and daily limits across restarts', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gateway-message-quota-'));
  try {
    const first = new MessageQuota({ dataDir, perMinuteLimit: 2, dailyLimit: 3 });
    await first.start();
    assert.equal(first.reserve('device-1', 2).allowed, true);
    assert.equal(first.reserve('device-1').status, 'rate_limited');
    await first.stop();
    const filePath = path.join(dataDir, 'message-quotas.json');
    const saved = JSON.parse(await fs.readFile(filePath, 'utf8'));
    saved['device-1'].minuteLog = [];
    await fs.writeFile(filePath, JSON.stringify(saved));

    const restarted = new MessageQuota({ dataDir, perMinuteLimit: 2, dailyLimit: 3 });
    await restarted.start();
    assert.equal(restarted.reserve('device-1').allowed, true);
    assert.equal(restarted.reserve('device-1').status, 'quota_exceeded');
    await restarted.stop();
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
