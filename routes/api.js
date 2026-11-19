import { timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { Router } from 'express';
import multer from 'multer';
import readXlsxFile from 'read-excel-file/node';
import { normalizePhone } from '../services/phone.js';

function readApiKey(request) {
  const authorization = request.get('authorization');
  const bearer = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  return request.get('x-api-key') ?? bearer ?? authorization;
}

function matchesSecret(suppliedKey, expectedKey) {
  if (typeof suppliedKey !== 'string' || typeof expectedKey !== 'string') return false;
  const supplied = Buffer.from(suppliedKey);
  const expected = Buffer.from(expectedKey);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function authenticate(expectedKey, waManager) {
  return (request, response, next) => {
    const suppliedKey = readApiKey(request);
    if (!suppliedKey) {
      return response.status(401).json({ error: 'API key wajib dikirim.' });
    }

    if (matchesSecret(suppliedKey, expectedKey)) {
      request.authType = 'admin';
      return next();
    }

    const deviceId = waManager?.getDeviceIdForToken?.(suppliedKey);
    if (deviceId) {
      request.authType = 'device';
      request.authDeviceId = deviceId;
      return next();
    }
    return response.status(401).json({ error: 'API key tidak valid.' });
  };
}

function restrictDeviceTokens(request, response, next) {
  const isSending = request.method === 'POST'
    && ['/send-message', '/send-bulk'].includes(request.path);
  if (request.authType === 'device' && !isSending) {
    return response.status(403).json({ error: 'Token device hanya dapat digunakan untuk mengirim pesan.' });
  }
  return next();
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 16 * 1024 * 1024, files: 1 },
  fileFilter: (_request, file, callback) => {
    if (file.mimetype.startsWith('image/') || file.mimetype === 'application/pdf') {
      callback(null, true);
    } else {
      callback(new Error('Lampiran hanya mendukung gambar atau PDF.'));
    }
  },
});

const uploadExcel = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 16 * 1024 * 1024, files: 1 },
  fileFilter: (_request, file, callback) => {
    if (path.extname(file.originalname).toLowerCase() === '.xlsx') {
      callback(null, true);
    } else {
      callback(new Error('Impor hanya mendukung file Excel .xlsx.'));
    }
  },
});

function parseTargets(input) {
  let values = input;
  if (typeof input === 'string') {
    try {
      values = JSON.parse(input);
    } catch {
      values = input.split(/[\n,;]+/).map((value) => value.trim()).filter(Boolean);
    }
  }
  if (!Array.isArray(values)) {
    throw new Error('Daftar tujuan harus berupa array nomor atau grup.');
  }
  if (!values.length || values.length > 500) {
    throw new Error('Jumlah tujuan harus antara 1 dan 500.');
  }

  const recipients = values.map((value) => {
    const raw = typeof value === 'string'
      ? value.trim()
      : value?.id ?? value?.phone ?? value?.target ?? value?.number;
    if (typeof raw !== 'string' || !raw.trim()) {
      throw new Error('Ada tujuan kosong atau tidak valid.');
    }
    const target = raw.trim();
    if (target.endsWith('@g.us')) {
      return { id: target, label: typeof value === 'object' ? value.name ?? target : target };
    }
    if (target.endsWith('@s.whatsapp.net')) {
      const phone = normalizePhone(target.slice(0, -'@s.whatsapp.net'.length));
      return { id: `${phone}@s.whatsapp.net`, label: typeof value === 'object' ? value.name ?? phone : phone };
    }
    const phone = normalizePhone(target);
    return { id: phone, label: typeof value === 'object' ? value.name ?? phone : phone };
  });
  return [...new Map(recipients.map((item) => [item.id, item])).values()];
}

function delayRange(request) {
  const minSeconds = Number(request.body?.minDelaySeconds ?? 4);
  const maxSeconds = Number(request.body?.maxDelaySeconds ?? 8);
  if (!Number.isFinite(minSeconds) || !Number.isFinite(maxSeconds)
      || minSeconds < 0 || maxSeconds < minSeconds || maxSeconds > 3600) {
    throw new Error('Jeda harus antara 0 sampai 3600 detik, dan batas minimum tidak boleh melebihi maksimum.');
  }
  return { minDelayMs: Math.round(minSeconds * 1000), maxDelayMs: Math.round(maxSeconds * 1000) };
}

function getDeviceId(request) {
  const requested = typeof request.body?.deviceId === 'string'
    ? request.body.deviceId
    : typeof request.query.deviceId === 'string' ? request.query.deviceId : null;
  if (request.authDeviceId && requested && requested !== request.authDeviceId) {
    const error = new Error('Token ini hanya dapat mengirim melalui device pemiliknya.');
    error.statusCode = 403;
    throw error;
  }
  return request.authDeviceId ?? requested ?? 'primary';
}

function getStatus(waManager, waClient, deviceId) {
  return waManager?.getStatus(deviceId) ?? waClient.getStatus();
}

export function createApiRouter({ apiKey, queue, waClient, waManager, scheduler, autoReply }) {
  const router = Router();
  router.use(authenticate(apiKey, waManager));
  router.use(restrictDeviceTokens);

  router.get('/status', (request, response) => {
    const deviceId = getDeviceId(request);
    response.json({
      ...getStatus(waManager, waClient, deviceId),
      devices: waManager?.listDevices() ?? [],
    });
  });

  router.get('/devices', (_request, response) => {
    response.json({ devices: waManager?.listDevices() ?? [] });
  });

  router.post('/devices', async (request, response, next) => {
    try {
      if (!waManager) return response.status(501).json({ error: 'Manajemen device tidak tersedia.' });
      const result = await waManager.addDevice(String(request.body?.name ?? ''));
      return response.status(201).json({ device: { ...result.device, ...result.client.getStatus() } });
    } catch (error) {
      return next(error);
    }
  });

  router.patch('/devices/:id', async (request, response, next) => {
    try {
      if (typeof request.body?.name !== 'string') {
        return response.status(400).json({ error: 'Nama device wajib berupa teks.' });
      }
      const device = await waManager?.renameDevice(request.params.id, request.body.name);
      if (!device) return response.status(404).json({ error: 'Device tidak ditemukan.' });
      return response.json({ device });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/devices/:id/disconnect', async (request, response, next) => {
    try {
      const status = await waManager?.disconnectDevice(request.params.id);
      if (!status) return response.status(404).json({ error: 'Device tidak ditemukan.' });
      return response.json({ status });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/devices/:id/reconnect', async (request, response, next) => {
    try {
      const status = await waManager?.reconnectDevice(request.params.id);
      if (!status) return response.status(404).json({ error: 'Device tidak ditemukan.' });
      return response.json({ status });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/devices/:id/token', (request, response) => {
    const token = waManager?.getDeviceToken(request.params.id);
    if (!token) return response.status(404).json({ error: 'Token device tidak ditemukan.' });
    response.set('Cache-Control', 'no-store');
    return response.json({ token });
  });

  router.post('/devices/:id/token/rotate', async (request, response, next) => {
    try {
      const token = await waManager?.rotateDeviceToken(request.params.id);
      if (!token) return response.status(404).json({ error: 'Device tidak ditemukan.' });
      response.set('Cache-Control', 'no-store');
      return response.json({ token });
    } catch (error) {
      return next(error);
    }
  });

  router.delete('/devices/:id', async (request, response, next) => {
    try {
      if (!waManager) return response.status(501).json({ error: 'Manajemen device tidak tersedia.' });
      const removed = await waManager.removeDevice(request.params.id);
      if (!removed) return response.status(404).json({ error: 'Device tidak ditemukan.' });
      return response.json({ message: 'Device dihapus.' });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/devices/:id/contacts', async (request, response, next) => {
    try {
      const client = waManager?.getClient(request.params.id);
      if (!client) return response.status(404).json({ error: 'Device tidak ditemukan.' });
      return response.json({ contacts: client.getContacts() });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/devices/:id/groups', async (request, response, next) => {
    try {
      const client = waManager?.getClient(request.params.id);
      if (!client) return response.status(404).json({ error: 'Device tidak ditemukan.' });
      return response.json({ groups: await client.getGroups() });
    } catch (error) {
      return next(error);
    }
  });

  router.get('/messages', (_request, response) => {
    response.json({ messages: queue.getMessages() });
  });

  router.post('/send-message', (request, response) => {
    const { phone, target, number, message } = request.body ?? {};
    const rawPhone = phone ?? target ?? number;
    if (typeof rawPhone !== 'string' || typeof message !== 'string' || !message.trim()) {
      return response.status(400).json({
        error: 'Body wajib berisi phone/target/number dan message berupa teks non-kosong.',
      });
    }

    try {
      const normalizedTarget = rawPhone.endsWith('@g.us')
        ? rawPhone
        : normalizePhone(rawPhone.replace(/@s\.whatsapp\.net$/, ''));
      const item = queue.enqueue({
        phone: normalizedTarget,
        message: message.trim(),
        deviceId: getDeviceId(request),
      });
      return response.status(202).json({
        message: 'Pesan ditambahkan ke antrean.',
        id: item.id,
        status: item.status,
        phone: item.phone,
      });
    } catch (error) {
      return response.status(error.statusCode ?? 400).json({ error: error.message });
    }
  });

  router.post('/send-bulk', upload.single('attachment'), (request, response) => {
    try {
      const targets = parseTargets(request.body?.targets);
      const deviceId = getDeviceId(request);
      const message = String(request.body?.message ?? '').trim();
      if (!message && !request.file) {
        return response.status(400).json({ error: 'Pesan atau lampiran wajib diisi.' });
      }
      const { minDelayMs, maxDelayMs } = delayRange(request);
      const attachment = request.file ? {
        buffer: request.file.buffer,
        mimetype: request.file.mimetype,
        originalName: request.file.originalname,
      } : undefined;
      const queued = targets.map((target) => queue.enqueue({
        target: target.id,
        deviceId,
        message,
        attachment,
        minDelayMs,
        maxDelayMs,
      }));
      return response.status(202).json({
        message: 'Pesan massal masuk antrean.',
        queued: queued.length,
        ids: queued.map((item) => item.id),
      });
    } catch (error) {
      return response.status(error.statusCode ?? 400).json({ error: error.message });
    }
  });

  router.post('/import-excel', uploadExcel.single('file'), async (request, response) => {
    if (!request.file) return response.status(400).json({ error: 'Pilih file Excel terlebih dahulu.' });
    try {
      const rows = await readXlsxFile(request.file.buffer);
      const firstRow = rows[0] ?? [];
      const phoneColumn = firstRow.findIndex((value) => /^(phone|number|nomor|target|jid)$/i.test(String(value).trim()));
      const startRow = phoneColumn >= 0 ? 1 : 0;
      const column = phoneColumn >= 0 ? phoneColumn : 0;
      const values = rows.slice(startRow).map((row) => row[column]).filter(Boolean);
      const phoneValues = values.map((value) => {
        const text = String(value).trim();
        return /^8\d{8,11}$/.test(text) ? `0${text}` : text;
      });
      return response.json({ targets: parseTargets(phoneValues) });
    } catch (error) {
      return response.status(400).json({ error: `Gagal membaca Excel: ${error.message}` });
    }
  });

  router.get('/schedules', (_request, response) => {
    response.json({ schedules: scheduler?.getJobs() ?? [] });
  });

  router.post('/schedules', upload.single('attachment'), async (request, response) => {
    if (!scheduler) return response.status(501).json({ error: 'Penjadwalan belum aktif.' });
    try {
      const targets = parseTargets(request.body?.targets);
      const message = String(request.body?.message ?? '').trim();
      if (!message && !request.file) {
        return response.status(400).json({ error: 'Pesan atau lampiran wajib diisi.' });
      }
      const job = await scheduler.add({
        deviceId: getDeviceId(request),
        targets,
        message,
        runAt: request.body?.runAt,
        ...delayRange(request),
        attachment: request.file ? {
          buffer: request.file.buffer,
          mimetype: request.file.mimetype,
          originalName: request.file.originalname,
        } : null,
      });
      return response.status(201).json({ schedule: job });
    } catch (error) {
      return response.status(400).json({ error: error.message });
    }
  });

  router.delete('/schedules/:id', async (request, response) => {
    if (!scheduler) return response.status(501).json({ error: 'Penjadwalan belum aktif.' });
    const removed = await scheduler.remove(request.params.id);
    if (!removed) return response.status(404).json({ error: 'Jadwal tidak ditemukan atau sudah diproses.' });
    return response.json({ message: 'Jadwal dibatalkan.' });
  });

  router.get('/auto-replies', (_request, response) => {
    response.json({ rules: autoReply?.getRules() ?? [] });
  });

  router.post('/auto-replies', async (request, response) => {
    if (!autoReply) return response.status(501).json({ error: 'Auto-reply belum aktif.' });
    try {
      const rule = await autoReply.add({
        deviceId: request.body?.deviceId,
        keyword: String(request.body?.keyword ?? ''),
        reply: String(request.body?.reply ?? ''),
      });
      return response.status(201).json({ rule });
    } catch (error) {
      return response.status(400).json({ error: error.message });
    }
  });

  router.patch('/auto-replies/:id', async (request, response) => {
    try {
      const rule = await autoReply?.update(request.params.id, request.body ?? {});
      if (!rule) return response.status(404).json({ error: 'Aturan auto-reply tidak ditemukan.' });
      return response.json({ rule });
    } catch (error) {
      return response.status(400).json({ error: error.message });
    }
  });

  router.delete('/auto-replies/:id', async (request, response) => {
    const removed = await autoReply?.remove(request.params.id);
    if (!removed) return response.status(404).json({ error: 'Aturan auto-reply tidak ditemukan.' });
    return response.json({ message: 'Aturan dihapus.' });
  });

  router.use((error, _request, response, _next) => {
    if (error instanceof multer.MulterError) {
      return response.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({
        error: error.code === 'LIMIT_FILE_SIZE'
          ? 'Ukuran lampiran maksimal 16 MB.'
          : error.message,
      });
    }
    if (error.message === 'Lampiran hanya mendukung gambar atau PDF.'
        || error.message === 'Impor hanya mendukung file Excel .xlsx.') {
      return response.status(400).json({ error: error.message });
    }
    console.error('Kesalahan API:', error);
    return response.status(500).json({ error: 'Terjadi kesalahan internal.' });
  });

  return router;
}
