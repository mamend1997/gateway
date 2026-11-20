import 'dotenv/config';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import cors from 'cors';
import express from 'express';
import { createApiRouter } from './routes/api.js';
import { QueueManager } from './services/queue.js';
import { WhatsAppManager } from './services/waManager.js';
import { MessageScheduler } from './services/scheduler.js';
import { AutoReplyService } from './services/autoReply.js';
import { GeminiAutoReplyService } from './services/aiAutoReply.js';
import { InboxStore } from './services/inboxStore.js';
import { readJson } from './services/jsonStore.js';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const port = Number.parseInt(process.env.PORT ?? '3000', 10);
const apiKey = process.env.API_KEY?.trim();
const authDir = path.resolve(currentDir, process.env.AUTH_DIR ?? './auth_info');
const dataDir = path.resolve(currentDir, process.env.DATA_DIR ?? './data');
const minDelayMs = Number.parseInt(process.env.MIN_SEND_DELAY_MS ?? '3000', 10);
const maxDelayMs = Number.parseInt(process.env.MAX_SEND_DELAY_MS ?? '7000', 10);
const maxRetries = Number.parseInt(process.env.MAX_RETRIES ?? '2', 10);
const aiReplyEnabled = process.env.AI_AUTO_REPLY === 'true';
const maxMessagesPerMinute = Number.parseInt(process.env.MAX_MESSAGES_PER_MINUTE ?? '10', 10);
const maxMessagesPerDay = Number.parseInt(process.env.MAX_MESSAGES_PER_DAY ?? '100', 10);
const duplicateWindowMs = Number.parseInt(process.env.DUPLICATE_WINDOW_MS ?? '300000', 10);
const batchCooldownEvery = Number.parseInt(process.env.BATCH_COOLDOWN_EVERY ?? '25', 10);
const batchCooldownMinMs = Number.parseInt(process.env.BATCH_COOLDOWN_MIN_MS ?? '25000', 10);
const batchCooldownMaxMs = Number.parseInt(process.env.BATCH_COOLDOWN_MAX_MS ?? '45000', 10);
const autoReplyCooldownMs = Number.parseInt(process.env.AUTO_REPLY_COOLDOWN_MS ?? '600000', 10);

if (!apiKey || apiKey === 'ganti-dengan-token-acak-yang-panjang') {
  throw new Error('API_KEY wajib diatur di environment sebelum aplikasi dijalankan.');
}
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT harus berupa angka antara 1 dan 65535.');
}
if (!Number.isInteger(minDelayMs) || !Number.isInteger(maxDelayMs) || minDelayMs < 0 || maxDelayMs < minDelayMs) {
  throw new Error('MIN_SEND_DELAY_MS dan MAX_SEND_DELAY_MS tidak valid.');
}
if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 10) {
  throw new Error('MAX_RETRIES harus berupa angka antara 0 dan 10.');
}
if (!Number.isInteger(maxMessagesPerMinute) || maxMessagesPerMinute < 1
    || !Number.isInteger(maxMessagesPerDay) || maxMessagesPerDay < 1) {
  throw new Error('Batas pengiriman per menit dan per hari harus berupa bilangan bulat positif.');
}
if (!Number.isInteger(duplicateWindowMs) || duplicateWindowMs < 0
    || !Number.isInteger(batchCooldownEvery) || batchCooldownEvery < 0
    || !Number.isInteger(batchCooldownMinMs) || !Number.isInteger(batchCooldownMaxMs)
    || batchCooldownMinMs < 0 || batchCooldownMaxMs < batchCooldownMinMs
    || !Number.isInteger(autoReplyCooldownMs) || autoReplyCooldownMs < 0) {
  throw new Error('Pengaturan cooldown, deduplikasi, atau jeda batch tidak valid.');
}

const app = express();
const corsOrigins = (process.env.CORS_ORIGIN ?? '*')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

app.disable('x-powered-by');
app.use(cors({
  origin: corsOrigins.includes('*') ? '*' : corsOrigins,
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key'],
}));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));
app.use(express.static(path.join(currentDir, 'public')));

const waManager = new WhatsAppManager({
  authDir,
  dataDir,
  adminPhone: process.env.ADMIN_PHONE,
});
const queue = new QueueManager({
  waManager,
  dataDir,
  minDelayMs,
  maxDelayMs,
  maxRetries,
  maxMessagesPerMinute,
  maxMessagesPerDay,
  duplicateWindowMs,
  batchCooldownEvery,
  batchCooldownMinMs,
  batchCooldownMaxMs,
});
const scheduler = new MessageScheduler({ dataDir, queueManager: queue });
const inbox = new InboxStore({ dataDir, waManager });
const autoReply = new AutoReplyService({
  dataDir,
  waManager,
  queueManager: queue,
  replyCooldownMs: autoReplyCooldownMs,
});
const aiReply = new GeminiAutoReplyService({
  apiKey: process.env.GEMINI_API_KEY,
  model: process.env.GEMINI_MODEL ?? 'gemini-2.5-flash',
  systemPrompt: process.env.AI_SYSTEM_PROMPT,
  enabled: aiReplyEnabled,
  waManager,
  queueManager: queue,
  autoReply,
});

app.use('/api', createApiRouter({ apiKey, queue, waManager, scheduler, autoReply, aiReply, inbox, dataDir }));
app.get('/', (_request, response) => {
  response.sendFile(path.join(currentDir, 'public', 'index.html'));
});
app.get('/favicon', async (_request, response, next) => {
  try {
    const favicon = await readJson(path.join(dataDir, 'favicon.json'), null);
    if (!favicon?.mimetype || !favicon?.base64) return response.sendStatus(404);
    response.set('Cache-Control', 'no-store');
    return response.type(favicon.mimetype).send(Buffer.from(favicon.base64, 'base64'));
  } catch (error) {
    return next(error);
  }
});

await queue.start();

const server = app.listen(port, '0.0.0.0', () => {
  console.log(`WhatsApp Gateway berjalan di http://0.0.0.0:${port}`);
  void (async () => {
    await autoReply.start();
    await inbox.start();
    await waManager.start();
    await scheduler.start();
  })().catch((error) => {
    console.error('Gagal memulai layanan gateway:', error);
    server.close(() => process.exit(1));
  });
});

let isShuttingDown = false;
async function shutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`Menerima ${signal}; menutup aplikasi...`);
  await scheduler.stop();
  await queue.stop();
  await new Promise((resolve) => server.close(resolve));
  await waManager.stop();
  await inbox.stop();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
