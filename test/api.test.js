import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createApiRouter } from '../routes/api.js';

test('protects status and queues normalized message requests using bearer auth', async (context) => {
  const queued = [];
  const queue = {
    enqueue(message) {
      const item = { id: 'job-1', status: 'queued', ...message };
      queued.push(item);
      return item;
    },
    getMessages: () => [],
  };
  const waClient = { getStatus: () => ({ status: 'open', connected: true }) };
  const app = express();
  app.use(express.json());
  app.use('/api', createApiRouter({ apiKey: 'test-secret', queue, waClient }));
  const server = app.listen(0, '127.0.0.1');
  context.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const unauthorized = await fetch(`${baseUrl}/api/status`);
  assert.equal(unauthorized.status, 401);

  const response = await fetch(`${baseUrl}/api/send-message`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-secret',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ target: '081234567890', message: 'Halo' }),
  });
  assert.equal(response.status, 202);
  assert.equal(queued[0].phone, '6281234567890');
  assert.equal(queued[0].message, 'Halo');
});
