import fs from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import makeWASocket, { DisconnectReason, useMultiFileAuthState } from '@whiskeysockets/baileys';
import pino from 'pino';
import QRCode from 'qrcode';
import { normalizePhone } from './phone.js';
import { readJson, writeJson } from './jsonStore.js';

export class WhatsAppClient extends EventEmitter {
  constructor({ id, name, authDir, dataDir, adminPhone }) {
    super();
    this.id = id;
    this.name = name;
    this.authDir = authDir;
    const safeId = id.replace(/[^a-zA-Z0-9_-]/g, '_');
    this.inactiveTargetsPath = dataDir ? path.join(dataDir, 'inactive-targets', `${safeId}.json`) : null;
    this.adminPhone = adminPhone?.trim();
    this.socket = null;
    this.status = 'connecting';
    this.statusUpdatedAt = new Date().toISOString();
    this.qr = null;
    this.lastError = null;
    this.reconnectTimer = null;
    this.stopped = false;
    this.wasConnected = false;
    this.disconnectNotice = null;
    this.contacts = new Map();
    this.inactiveTargets = new Map();
    this.verifiedTargets = new Map();
    this.pendingCredsSave = Promise.resolve();
    this.saveCreds = null;
    this.logger = pino({ level: process.env.LOG_LEVEL ?? 'warn' });
  }

  async start() {
    this.stopped = false;
    await fs.mkdir(this.authDir, { recursive: true });
    const hasCredentials = await fs.access(path.join(this.authDir, 'creds.json'))
      .then(() => true)
      .catch((error) => {
        if (error.code === 'ENOENT') return false;
        throw error;
      });
    console.log(`WhatsApp device ${this.id}: AUTH_DIR=${this.authDir}; creds.json=${hasCredentials ? 'ada' : 'tidak ada'}.`);
    if (this.inactiveTargetsPath) {
      const savedTargets = await readJson(this.inactiveTargetsPath, {});
      const entries = Array.isArray(savedTargets)
        ? savedTargets.map((phone) => [phone, Date.now()])
        : Object.entries(savedTargets);
      const cutoff = Date.now() - 24 * 60 * 60 * 1000;
      this.inactiveTargets = new Map(entries.filter(([phone, checkedAt]) => (
        typeof phone === 'string' && Number.isFinite(checkedAt) && checkedAt > cutoff
      )));
    }
    try {
      await this.connect();
    } catch (error) {
      this.lastError = error.message;
      this.scheduleReconnect();
      throw error;
    }
  }

  async connect() {
    if (this.stopped) return;
    this.status = 'connecting';
    this.statusUpdatedAt = new Date().toISOString();
    this.qr = null;
    this.emit('status', this.getStatus());

    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
    this.saveCreds = saveCreds;
    const socket = makeWASocket({
      auth: state,
      logger: this.logger,
      printQRInTerminal: false,
      browser: ['WhatsApp Gateway', 'Chrome', '1.0.0'],
    });
    this.socket = socket;
    socket.ev.on('creds.update', () => {
      if (this.socket === socket) this.persistCredentials(saveCreds);
    });
    socket.ev.on('contacts.upsert', (contacts) => {
      for (const contact of contacts) {
        if (contact.id) this.contacts.set(contact.id, contact);
      }
      this.emit('contacts', this.getContacts());
    });
    socket.ev.on('messaging-history.set', ({ contacts = [] }) => {
      for (const contact of contacts) {
        if (contact.id) this.contacts.set(contact.id, contact);
      }
      this.emit('contacts', this.getContacts());
    });
    socket.ev.on('contacts.update', (contacts) => {
      for (const contact of contacts) {
        if (contact.id) this.contacts.set(contact.id, {
          ...this.contacts.get(contact.id),
          ...contact,
        });
      }
      this.emit('contacts', this.getContacts());
    });
    socket.ev.on('messages.upsert', ({ type, messages }) => {
      if (type !== 'notify') return;
      for (const message of messages) {
        if (message.key?.fromMe || !message.key?.remoteJid) continue;
        this.emit('message', message);
      }
    });
    socket.ev.on('connection.update', async (update) => {
      if (this.socket !== socket) return;
      if (update.qr) {
        try {
          this.qr = await QRCode.toDataURL(update.qr);
          this.statusUpdatedAt = new Date().toISOString();
        } catch (error) {
          this.lastError = `QR gagal dibuat: ${error.message}`;
        }
        this.emit('status', this.getStatus());
      }
      if (update.connection === 'open') {
        this.status = 'open';
        this.statusUpdatedAt = new Date().toISOString();
        this.qr = null;
        this.lastError = null;
        this.wasConnected = true;
        this.emit('status', this.getStatus());
        await this.persistCredentials(saveCreds);
        try {
          await fs.access(path.join(this.authDir, 'creds.json'));
          console.log(`WhatsApp device ${this.id}: kredensial sesi tersimpan di ${this.authDir}.`);
        } catch (error) {
          this.lastError = `Gagal memverifikasi penyimpanan sesi WhatsApp: ${error.message}`;
          this.logger.error({ err: error }, `Kredensial WhatsApp device ${this.id} tidak ditemukan setelah koneksi terbuka.`);
          this.emit('status', this.getStatus());
        }
        await this.sendPendingDisconnectNotice();
      } else if (update.connection === 'close') {
        const statusCode = update.lastDisconnect?.error?.output?.statusCode;
        const loggedOut = statusCode === DisconnectReason.loggedOut;
        this.status = 'close';
        this.statusUpdatedAt = new Date().toISOString();
        this.qr = null;
        this.lastError = update.lastDisconnect?.error?.message ?? 'Koneksi terputus.';
        if (this.wasConnected && this.adminPhone) {
          this.disconnectNotice = new Date().toISOString();
        }
        this.wasConnected = false;
        this.emit('status', this.getStatus());

        if (loggedOut) {
          this.logger.error('Sesi WhatsApp logout; hapus sesi lama dan scan QR kembali.');
        } else {
          this.scheduleReconnect();
        }
      } else {
        this.status = 'connecting';
        this.statusUpdatedAt = new Date().toISOString();
        this.emit('status', this.getStatus());
      }
    });
  }

  scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch((error) => {
        this.lastError = error.message;
        this.logger.error({ err: error }, 'Gagal menyambungkan ulang WhatsApp.');
        this.scheduleReconnect();
      });
    }, 2000);
  }

  persistCredentials(saveCreds = this.saveCreds) {
    if (!saveCreds) return this.pendingCredsSave;
    this.pendingCredsSave = this.pendingCredsSave
      .then(() => saveCreds())
      .catch((error) => {
        this.lastError = `Gagal menyimpan sesi WhatsApp: ${error.message}`;
        this.logger.error({ err: error }, `Gagal menyimpan kredensial WhatsApp device ${this.id}.`);
        this.emit('status', this.getStatus());
      });
    return this.pendingCredsSave;
  }

  async sendText(phone, message) {
    return this.sendMessage(phone, message);
  }

  async sendMessage(target, message, attachments, startIndex = 0) {
    if (!this.isConnected() || !this.socket) {
      const error = new Error('WhatsApp belum terhubung.');
      error.permanent = false;
      throw error;
    }

    let jid = target;
    if (!target.endsWith('@g.us') && !target.endsWith('@lid')) {
      const rawPhone = target.replace(/@s\.whatsapp\.net$/, '');
      const phone = normalizePhone(rawPhone);
      jid = `${phone}@s.whatsapp.net`;
      const inactiveAt = this.inactiveTargets.get(phone);
      if (inactiveAt && Date.now() - inactiveAt < 24 * 60 * 60 * 1000) {
        const error = new Error('Nomor tujuan sebelumnya dinyatakan tidak terdaftar di WhatsApp.');
        error.permanent = true;
        throw error;
      }
      if (inactiveAt) this.inactiveTargets.delete(phone);
      const verifiedAt = this.verifiedTargets.get(phone);
      if (!verifiedAt || Date.now() - verifiedAt > 24 * 60 * 60 * 1000) {
        const [result] = await this.socket.onWhatsApp(phone);
        if (!result?.exists) {
          this.inactiveTargets.set(phone, Date.now());
          if (this.inactiveTargets.size > 10_000) {
            this.inactiveTargets.delete(this.inactiveTargets.keys().next().value);
          }
          if (this.inactiveTargetsPath) {
            try {
              await writeJson(this.inactiveTargetsPath, Object.fromEntries(this.inactiveTargets));
            } catch (error) {
              this.logger.error({ err: error }, 'Gagal menyimpan cache nomor WhatsApp tidak aktif.');
            }
          }
          const error = new Error('Nomor tujuan tidak terdaftar di WhatsApp.');
          error.permanent = true;
          throw error;
        }
        this.verifiedTargets.set(phone, Date.now());
        jid = result.jid ?? `${phone}@s.whatsapp.net`;
      }
    }

    const files = Array.isArray(attachments) ? attachments : attachments?.buffer ? [attachments] : [];
    if (!files.length) {
      await this.socket.sendMessage(jid, { text: message });
      return;
    }

    for (let index = startIndex; index < files.length; index += 1) {
      const attachment = files[index];
      const caption = index === 0 ? message || undefined : undefined;
      const payload = attachment.mimetype === 'application/pdf'
        ? {
            document: attachment.buffer,
            mimetype: attachment.mimetype,
            fileName: attachment.originalName,
            caption,
          }
        : {
            image: attachment.buffer,
            mimetype: attachment.mimetype,
            caption,
          };
      try {
        await this.socket.sendMessage(jid, payload);
      } catch (error) {
        error.attachmentIndex = index;
        throw error;
      }
    }
  }

  async getGroups() {
    if (!this.socket || !this.isConnected()) return [];
    const groups = await this.socket.groupFetchAllParticipating();
    return Object.entries(groups).map(([id, group]) => ({
      id,
      name: group.subject ?? id,
      participants: group.participants?.length ?? 0,
    }));
  }

  getContacts() {
    return [...this.contacts.values()]
      .filter((contact) => contact.id && !contact.id.endsWith('@g.us'))
      .map((contact) => ({
        id: contact.id,
        name: contact.name ?? contact.notify ?? contact.verifiedName ?? contact.id,
      }));
  }

  isConnected() {
    return this.status === 'open';
  }

  getStatus() {
    return {
      status: this.status,
      connected: this.isConnected(),
      phone: this.socket?.user?.id?.split(':')[0]?.split('@')[0] ?? null,
      qr: this.qr,
      error: this.lastError,
      updatedAt: this.statusUpdatedAt,
    };
  }

  async sendPendingDisconnectNotice() {
    if (!this.disconnectNotice || !this.adminPhone || !this.socket) return;
    const disconnectedAt = this.disconnectNotice;
    this.disconnectNotice = null;
    try {
      const { normalizePhone } = await import('./phone.js');
      const phone = normalizePhone(this.adminPhone);
      const [result] = await this.socket.onWhatsApp(phone);
      if (result?.exists) {
        await this.socket.sendMessage(result.jid, {
          text: `Peringatan WhatsApp Gateway: koneksi sempat terputus pada ${disconnectedAt} dan kini tersambung kembali.`,
        });
      } else {
        this.logger.warn('ADMIN_PHONE tidak terdaftar di WhatsApp; notifikasi pemulihan tidak dikirim.');
      }
    } catch (error) {
      this.logger.error({ err: error }, 'Gagal mengirim notifikasi pemulihan koneksi ke ADMIN_PHONE.');
    }
  }

  async stop() {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const socket = this.socket;
    this.socket = null;
    if (this.wasConnected) await this.persistCredentials();
    socket?.end(undefined);
    await this.pendingCredsSave;
    this.saveCreds = null;
    this.status = 'close';
    this.statusUpdatedAt = new Date().toISOString();
    this.qr = null;
    this.lastError = null;
    this.emit('status', this.getStatus());
  }
}
