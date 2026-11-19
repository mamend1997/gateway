import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cors from 'cors';
import express from 'express';
import { createApiRouter } from './routes/api.js';
import { MessageQueue } from './services/queue.js';
import { WhatsAppClient } from './services/waClient.js';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const port = Number.parseInt(process.env.PORT ?? '3000', 10);
const apiKey = process.env.API_KEY?.trim();
const authDir = path.resolve(currentDir, process.env.AUTH_DIR ?? './auth_info');
const minDelayMs = Number.parseInt(process.env.MIN_SEND_DELAY_MS ?? '2000', 10);
const maxDelayMs = Number.parseInt(process.env.MAX_SEND_DELAY_MS ?? '4000', 10);
const maxRetries = Number.parseInt(process.env.MAX_RETRIES ?? '2', 10);

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

const app = express();
const corsOrigins = (process.env.CORS_ORIGIN ?? '*')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

app.disable('x-powered-by');
app.use(cors({
  origin: corsOrigins.includes('*') ? '*' : corsOrigins,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key'],
}));
app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.join(currentDir, 'public')));

const waClient = new WhatsAppClient({
  authDir,
  adminPhone: process.env.ADMIN_PHONE,
});
const queue = new MessageQueue({
  waClient,
  minDelayMs,
  maxDelayMs,
  maxRetries,
});

app.use('/api', createApiRouter({ apiKey, queue, waClient }));
app.get('/', (_request, response) => {
  response.sendFile(path.join(currentDir, 'public', 'index.html'));
});

const server = app.listen(port, '0.0.0.0', () => {
  console.log(`WhatsApp Gateway berjalan di http://0.0.0.0:${port}`);
  waClient.start().catch((error) => {
    console.error('Gagal memulai klien WhatsApp:', error);
  });
});

let isShuttingDown = false;
async function shutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`Menerima ${signal}; menutup aplikasi...`);
  queue.stop();
  await new Promise((resolve) => server.close(resolve));
  await waClient.stop();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
