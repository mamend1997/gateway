import fs from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { WhatsAppClient } from './waClient.js';
import { readJson, writeJson } from './jsonStore.js';

const primaryDevice = { id: 'primary', name: 'Perangkat utama', primary: true };

export class WhatsAppManager extends EventEmitter {
  constructor({ authDir, dataDir, adminPhone }) {
    super();
    this.authDir = authDir;
    this.dataDir = dataDir;
    this.adminPhone = adminPhone;
    this.registryPath = path.join(dataDir, 'devices.json');
    this.tokensPath = path.join(dataDir, 'device-tokens.json');
    this.devices = new Map();
    this.deviceTokens = new Map();
    this.stopped = false;
  }

  async start() {
    await fs.mkdir(this.authDir, { recursive: true });
    const savedDevices = await readJson(this.registryPath, [primaryDevice]);
    const devices = savedDevices.length ? savedDevices : [primaryDevice];
    const savedTokens = await readJson(this.tokensPath, {});
    const deviceIds = new Set(devices.map((device) => device.id));
    for (const [id, token] of Object.entries(savedTokens)) {
      if (deviceIds.has(id) && typeof token === 'string' && token.length >= 32) {
        this.deviceTokens.set(id, token);
      }
    }
    for (const device of devices) {
      await this.startDevice(device);
      if (!this.deviceTokens.has(device.id)) {
        this.deviceTokens.set(device.id, randomBytes(32).toString('hex'));
      }
    }
    await this.persistRegistry();
    await this.persistTokens();
  }

  async startDevice(device) {
    const authPath = device.id === primaryDevice.id
      ? this.authDir
      : path.join(this.authDir, device.id);
    const client = new WhatsAppClient({
      ...device,
      authDir: authPath,
      dataDir: this.dataDir,
      adminPhone: this.adminPhone,
    });
    this.devices.set(device.id, { device, client });
    client.on('status', (status) => this.emit('status', { deviceId: device.id, ...status }));
    client.on('message', (message) => this.emit('message', { deviceId: device.id, message }));
    client.on('contacts', (contacts) => this.emit('contacts', { deviceId: device.id, contacts }));
    try {
      await client.start();
    } catch (error) {
      console.error(`Gagal memulai device ${device.id}:`, error);
    }
    return client;
  }

  async addDevice(name) {
    const cleanName = name.trim();
    if (!cleanName || cleanName.length > 64) {
      throw new Error('Nama device wajib diisi (maksimal 64 karakter).');
    }
    const device = { id: randomUUID(), name: cleanName, primary: false };
    const client = await this.startDevice(device);
    this.deviceTokens.set(device.id, randomBytes(32).toString('hex'));
    await this.persistRegistry();
    await this.persistTokens();
    return { device, client };
  }

  async renameDevice(id, name) {
    const cleanName = name.trim();
    if (!cleanName || cleanName.length > 64) {
      throw new Error('Nama device wajib diisi (maksimal 64 karakter).');
    }
    const entry = this.devices.get(id);
    if (!entry) return null;
    entry.device.name = cleanName;
    entry.client.name = cleanName;
    await this.persistRegistry();
    return entry.device;
  }

  async disconnectDevice(id) {
    const entry = this.devices.get(id);
    if (!entry) return null;
    await entry.client.stop();
    return entry.client.getStatus();
  }

  async reconnectDevice(id) {
    const entry = this.devices.get(id);
    if (!entry) return null;
    await entry.client.stop();
    await entry.client.start();
    return entry.client.getStatus();
  }

  async removeDevice(id) {
    if (id === primaryDevice.id) {
      throw new Error('Perangkat utama tidak dapat dihapus.');
    }
    const entry = this.devices.get(id);
    if (!entry) return false;
    await entry.client.stop();
    await fs.rm(path.join(this.authDir, id), { recursive: true, force: true });
    this.devices.delete(id);
    this.deviceTokens.delete(id);
    await this.persistRegistry();
    await this.persistTokens();
    this.emit('deviceRemoved', id);
    return true;
  }

  getDeviceToken(id) {
    return this.deviceTokens.get(id) ?? null;
  }

  async rotateDeviceToken(id) {
    if (!this.devices.has(id)) return null;
    const previousToken = this.deviceTokens.get(id);
    const token = randomBytes(32).toString('hex');
    this.deviceTokens.set(id, token);
    try {
      await this.persistTokens();
    } catch (error) {
      if (previousToken) this.deviceTokens.set(id, previousToken);
      else this.deviceTokens.delete(id);
      throw error;
    }
    return token;
  }

  getDeviceIdForToken(token) {
    if (typeof token !== 'string') return null;
    const supplied = Buffer.from(token);
    for (const [id, storedToken] of this.deviceTokens) {
      const expected = Buffer.from(storedToken);
      if (supplied.length === expected.length && timingSafeEqual(supplied, expected)) return id;
    }
    return null;
  }

  getClient(id = primaryDevice.id) {
    return this.devices.get(id)?.client;
  }

  listDevices() {
    return [...this.devices.values()].map(({ device, client }) => ({
      ...device,
      ...client.getStatus(),
    }));
  }

  getStatus(id = primaryDevice.id) {
    const client = this.getClient(id);
    return client?.getStatus() ?? {
      status: 'close',
      connected: false,
      qr: null,
      error: 'Device tidak ditemukan.',
      updatedAt: new Date().toISOString(),
    };
  }

  async persistRegistry() {
    const devices = [...this.devices.values()].map(({ device }) => device);
    await writeJson(this.registryPath, devices);
  }

  async persistTokens() {
    await writeJson(this.tokensPath, Object.fromEntries(this.deviceTokens));
  }

  async stop() {
    this.stopped = true;
    await Promise.all([...this.devices.values()].map(({ client }) => client.stop()));
  }
}
