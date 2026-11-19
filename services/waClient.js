import fs from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import makeWASocket, { DisconnectReason, useMultiFileAuthState } from '@whiskeysockets/baileys';
import pino from 'pino';
import QRCode from 'qrcode';

export class WhatsAppClient extends EventEmitter {
  constructor({ authDir, adminPhone }) {
    super();
    this.authDir = authDir;
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
    this.logger = pino({ level: process.env.LOG_LEVEL ?? 'warn' });
  }

  async start() {
    this.stopped = false;
    await fs.mkdir(this.authDir, { recursive: true });
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
    const socket = makeWASocket({
      auth: state,
      logger: this.logger,
      printQRInTerminal: false,
      browser: ['WhatsApp Gateway', 'Chrome', '1.0.0'],
    });
    this.socket = socket;
    socket.ev.on('creds.update', saveCreds);
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

  async sendText(phone, message) {
    if (!this.isConnected() || !this.socket) {
      const error = new Error('WhatsApp belum terhubung.');
      error.permanent = false;
      throw error;
    }

    const [result] = await this.socket.onWhatsApp(phone);
    if (!result?.exists) {
      const error = new Error('Nomor tujuan tidak terdaftar di WhatsApp.');
      error.permanent = true;
      throw error;
    }
    await this.socket.sendMessage(result.jid, { text: message });
  }

  isConnected() {
    return this.status === 'open';
  }

  getStatus() {
    return {
      status: this.status,
      connected: this.isConnected(),
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
    this.socket?.end(undefined);
    this.socket = null;
  }
}
