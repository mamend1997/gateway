import fs from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
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
    this.devices = new Map();
    this.stopped = false;
  }

  async start() {
    await fs.mkdir(this.authDir, { recursive: true });
    const savedDevices = await readJson(this.registryPath, [primaryDevice]);
    const devices = savedDevices.length ? savedDevices : [primaryDevice];
    for (const device of devices) {
      await this.startDevice(device);
    }
    await this.persistRegistry();
  }

  async startDevice(device) {
    const authPath = device.id === primaryDevice.id
      ? this.authDir
      : path.join(this.authDir, device.id);
    const client = new WhatsAppClient({
      ...device,
      authDir: authPath,
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
    await this.persistRegistry();
    return { device, client };
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
    await this.persistRegistry();
    this.emit('deviceRemoved', id);
    return true;
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

  async stop() {
    this.stopped = true;
    await Promise.all([...this.devices.values()].map(({ client }) => client.stop()));
  }
}
