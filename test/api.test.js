import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
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

  const attachmentsForm = new FormData();
  attachmentsForm.append('targets', JSON.stringify(['081234567890']));
  attachmentsForm.append('message', 'Dokumen untuk {name}');
  attachmentsForm.append('attachments', new Blob(['image-one'], { type: 'image/png' }), 'one.png');
  attachmentsForm.append('attachments', new Blob(['file-two'], { type: 'application/pdf' }), 'two.pdf');
  const attachmentsResponse = await fetch(`${baseUrl}/api/send-bulk`, {
    method: 'POST',
    headers: { 'X-API-Key': 'test-secret' },
    body: attachmentsForm,
  });
  assert.equal(attachmentsResponse.status, 202);
  assert.equal(queued[3].attachment.length, 2);
  assert.equal(queued[3].attachment[1].originalName, 'two.pdf');
  assert.equal(queued[3].message, 'Dokumen untuk 6281234567890');

  const formResponse = await fetch(`${baseUrl}/api/send-message`, {
    method: 'POST',
    headers: {
      Authorization: 'test-secret',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ target: '081234567890', message: 'Kode OTP 1234' }),
  });
  assert.equal(formResponse.status, 202);
  assert.equal(queued[4].phone, '6281234567890');
  assert.equal(queued[4].message, 'Kode OTP 1234');

  const form = new FormData();
  form.append('file', new Blob(['not an Excel file'], { type: 'text/plain' }), 'numbers.csv');
  const importResponse = await fetch(`${baseUrl}/api/import-excel`, {
    method: 'POST',
    headers: { 'X-API-Key': 'test-secret' },
    body: form,
  });
  assert.equal(importResponse.status, 400);
});

test('device token sends only through its owner device and cannot read admin endpoints', async (context) => {
  const queued = [];
  const waManager = {
    getDeviceIdForToken: (token) => token === 'device-secret' ? 'device-1' : null,
    getDeviceToken: (id) => id === 'device-1' ? 'device-secret' : null,
    listDevices: () => [],
    getStatus: () => ({ status: 'open', connected: true }),
  };
  const queue = {
    enqueue(message) {
      const item = { id: 'device-job', status: 'queued', ...message };
      queued.push(item);
      return item;
    },
    getMessages: () => [],
  };
  const app = express();
  app.use(express.json());
  app.use('/api', createApiRouter({
    apiKey: 'admin-secret',
    queue,
    waClient: { getStatus: () => ({ status: 'open', connected: true }) },
    waManager,
  }));
  const server = app.listen(0, '127.0.0.1');
  context.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const response = await fetch(`${baseUrl}/api/send-message`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer device-secret',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ target: '081234567890', message: 'OTP 1234' }),
  });
  assert.equal(response.status, 202);
  assert.equal(queued[0].deviceId, 'device-1');

  const forbidden = await fetch(`${baseUrl}/api/send-message`, {
    method: 'POST',
    headers: {
      Authorization: 'device-secret',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ target: '081234567890', message: 'OTP', deviceId: 'device-2' }),
  });
  assert.equal(forbidden.status, 403);
  assert.equal(queued.length, 1);

  const adminOnly = await fetch(`${baseUrl}/api/devices`, {
    headers: { Authorization: 'device-secret' },
  });
  assert.equal(adminOnly.status, 403);

  const token = await fetch(`${baseUrl}/api/devices/device-1/token`, {
    headers: { 'X-API-Key': 'admin-secret' },
  });
  assert.equal((await token.json()).token, 'device-secret');
});

test('admin can save and reset a persisted dashboard favicon', async (context) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gateway-favicon-'));
  const app = express();
  app.use('/api', createApiRouter({
    apiKey: 'favicon-secret',
    queue: { enqueue() {}, getMessages: () => [] },
    waClient: { getStatus: () => ({ status: 'open', connected: true }) },
    dataDir,
  }));
  const server = app.listen(0, '127.0.0.1');
  context.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}/api/settings/favicon`;
  const form = new FormData();
  form.append('favicon', new Blob(['fake-png'], { type: 'image/png' }), 'logo.png');
  const saved = await fetch(baseUrl, {
    method: 'POST',
    headers: { 'X-API-Key': 'favicon-secret' },
    body: form,
  });
  assert.equal(saved.status, 200);
  assert.equal(JSON.parse(await fs.readFile(path.join(dataDir, 'favicon.json'), 'utf8')).mimetype, 'image/png');

  const reset = await fetch(baseUrl, {
    method: 'DELETE',
    headers: { 'X-API-Key': 'favicon-secret' },
  });
  assert.equal(reset.status, 200);
  await assert.rejects(fs.access(path.join(dataDir, 'favicon.json')));
});
