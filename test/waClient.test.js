import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WhatsAppClient } from '../services/waClient.js';

test('sends multiple media files in order with the text captioned once', async () => {
  const sent = [];
  const client = new WhatsAppClient({
    id: 'test',
    name: 'Test',
    authDir: '.',
  });
  client.status = 'open';
  client.socket = {
    onWhatsApp: async (phone) => [{ exists: true, jid: `${phone}@s.whatsapp.net` }],
    sendMessage: async (jid, payload) => sent.push({ jid, payload }),
  };

  await client.sendMessage('6281234567890@s.whatsapp.net', 'Halo pelanggan', [
    { buffer: Buffer.from('image'), mimetype: 'image/png', originalName: 'one.png' },
    { buffer: Buffer.from('document'), mimetype: 'application/pdf', originalName: 'two.pdf' },
  ]);

  assert.equal(sent.length, 2);
  assert.equal(sent[0].payload.image.toString(), 'image');
  assert.equal(sent[0].payload.caption, 'Halo pelanggan');
  assert.equal(sent[1].payload.document.toString(), 'document');
  assert.equal(sent[1].payload.caption, undefined);
});

test('uses a valid JID when sending to a cached bare phone number', async () => {
  const sent = [];
  let checks = 0;
  const client = new WhatsAppClient({
    id: 'test',
    name: 'Test',
    authDir: '.',
  });
  client.status = 'open';
  client.socket = {
    onWhatsApp: async (phone) => {
      checks += 1;
      return [{ exists: true, jid: `${phone}@s.whatsapp.net` }];
    },
    sendMessage: async (jid, payload) => sent.push({ jid, payload }),
  };

  await client.sendMessage('081234567890', 'Pesan pertama');
  await client.sendMessage('081234567890', 'Pesan kedua');

  assert.equal(checks, 1);
  assert.deepEqual(sent.map(({ jid }) => jid), [
    '6281234567890@s.whatsapp.net',
    '6281234567890@s.whatsapp.net',
  ]);
});

test('sends replies to WhatsApp LID addresses without treating them as phone numbers', async () => {
  const sent = [];
  let phoneChecks = 0;
  const client = new WhatsAppClient({
    id: 'test',
    name: 'Test',
    authDir: '.',
  });
  client.status = 'open';
  client.socket = {
    onWhatsApp: async () => {
      phoneChecks += 1;
      return [];
    },
    sendMessage: async (jid, payload) => sent.push({ jid, payload }),
  };

  await client.sendMessage('71880690163766@lid', 'Baik, saya bantu.');

  assert.equal(phoneChecks, 0);
  assert.equal(sent[0].jid, '71880690163766@lid');
  assert.deepEqual(sent[0].payload, { text: 'Baik, saya bantu.' });
});

test('caches an unregistered WhatsApp number to avoid repeated checks', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gateway-inactive-targets-'));
  try {
    let checks = 0;
    const client = new WhatsAppClient({
      id: 'device-1',
      name: 'Test',
      authDir: dataDir,
      dataDir,
    });
    client.status = 'open';
    client.socket = {
      onWhatsApp: async () => {
        checks += 1;
        return [{ exists: false }];
      },
      sendMessage: async () => {},
    };

    await assert.rejects(client.sendMessage('081234567890', 'Halo'), (error) => error.permanent === true);
    await assert.rejects(client.sendMessage('081234567890', 'Pesan lain'), (error) => error.permanent === true);

    assert.equal(checks, 1);
    assert.equal(JSON.parse(await fs.readFile(path.join(dataDir, 'inactive-targets', 'device-1.json'), 'utf8'))['6281234567890'] > 0, true);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test('waits for pending credential writes before stopping the socket', async () => {
  const client = new WhatsAppClient({
    id: 'device-1',
    name: 'Test',
    authDir: '.',
  });
  let credentialsSaved = false;
  client.pendingCredsSave = new Promise((resolve) => {
    setTimeout(() => {
      credentialsSaved = true;
      resolve();
    }, 10);
  });
  client.socket = { end() {} };

  await client.stop();

  assert.equal(credentialsSaved, true);
});

test('persists authenticated credentials before stopping the socket', async () => {
  const client = new WhatsAppClient({
    id: 'device-1',
    name: 'Test',
    authDir: '.',
  });
  let credentialsSaved = false;
  client.wasConnected = true;
  client.saveCreds = async () => {
    credentialsSaved = true;
  };
  client.socket = { end() {} };

  await client.stop();

  assert.equal(credentialsSaved, true);
});
