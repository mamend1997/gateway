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
  app.use(express.urlencoded({ extended: false }));
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

  const bulkResponse = await fetch(`${baseUrl}/api/send-bulk`, {
    method: 'POST',
    headers: {
      'X-API-Key': 'test-secret',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      targets: ['081234567890', '085712345678'],
      message: 'Info',
      minDelaySeconds: 4,
      maxDelaySeconds: 8,
    }),
  });
  assert.equal(bulkResponse.status, 202);
  assert.equal((await bulkResponse.json()).queued, 2);
  assert.equal(queued[1].target, '6281234567890');
  assert.equal(queued[1].minDelayMs, 4000);
  assert.equal(queued[1].maxDelayMs, 8000);

  const formResponse = await fetch(`${baseUrl}/api/send-message`, {
    method: 'POST',
    headers: {
      Authorization: 'test-secret',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ target: '081234567890', message: 'Kode OTP 1234' }),
  });
  assert.equal(formResponse.status, 202);
  assert.equal(queued[3].phone, '6281234567890');
  assert.equal(queued[3].message, 'Kode OTP 1234');

  const form = new FormData();
  form.append('file', new Blob(['not an Excel file'], { type: 'text/plain' }), 'numbers.csv');
  const importResponse = await fetch(`${baseUrl}/api/import-excel`, {
    method: 'POST',
    headers: { 'X-API-Key': 'test-secret' },
    body: form,
  });
  assert.equal(importResponse.status, 400);
});
