import { timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import { normalizePhone } from '../services/phone.js';

function readApiKey(request) {
  const bearer = request.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
  return request.get('x-api-key') ?? bearer;
}

function authenticate(expectedKey) {
  return (request, response, next) => {
    const suppliedKey = readApiKey(request);
    if (!suppliedKey) {
      return response.status(401).json({ error: 'API key wajib dikirim.' });
    }

    const supplied = Buffer.from(suppliedKey);
    const expected = Buffer.from(expectedKey);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      return response.status(401).json({ error: 'API key tidak valid.' });
    }
    return next();
  };
}

export function createApiRouter({ apiKey, queue, waClient }) {
  const router = Router();
  router.use(authenticate(apiKey));

  router.get('/status', (_request, response) => {
    response.json(waClient.getStatus());
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

    let normalizedPhone;
    try {
      normalizedPhone = normalizePhone(rawPhone);
    } catch (error) {
      return response.status(400).json({ error: error.message });
    }

    const item = queue.enqueue({ phone: normalizedPhone, message: message.trim() });
    return response.status(202).json({
      message: 'Pesan ditambahkan ke antrean.',
      id: item.id,
      status: item.status,
      phone: item.phone,
    });
  });

  return router;
}
