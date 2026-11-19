import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readJson, writeJson } from './jsonStore.js';

export class MessageScheduler {
  constructor({ dataDir, queueManager }) {
    this.filePath = path.join(dataDir, 'schedules.json');
    this.queueManager = queueManager;
    this.jobs = [];
    this.timer = null;
    this.processing = false;
  }

  async start() {
    this.jobs = await readJson(this.filePath, []);
    let recovered = false;
    for (const job of this.jobs) {
      if (job.status === 'processing') {
        job.status = 'scheduled';
        recovered = true;
      }
    }
    if (recovered) await this.persist();
    this.timer = setInterval(() => {
      this.processDue().catch((error) => console.error('Gagal memproses jadwal pesan:', error));
    }, 1000);
    this.timer.unref();
    await this.processDue();
  }

  async add({ deviceId, targets, message, runAt, minDelayMs, maxDelayMs, attachment }) {
    const time = Date.parse(runAt);
    if (!Number.isFinite(time) || time <= Date.now()) {
      throw new Error('Waktu jadwal harus berada di masa depan.');
    }
    const job = {
      id: randomUUID(),
      deviceId,
      targets,
      message,
      runAt: new Date(time).toISOString(),
      minDelayMs,
      maxDelayMs,
      attachment: attachment ? {
        base64: attachment.buffer.toString('base64'),
        mimetype: attachment.mimetype,
        originalName: attachment.originalName,
      } : null,
      status: 'scheduled',
      createdAt: new Date().toISOString(),
      error: null,
    };
    this.jobs.unshift(job);
    this.jobs = this.jobs.slice(0, 500);
    await this.persist();
    return this.toPublicJob(job);
  }

  async remove(id) {
    const job = this.jobs.find((item) => item.id === id);
    if (!job || job.status !== 'scheduled') return false;
    this.jobs = this.jobs.filter((item) => item.id !== id);
    await this.persist();
    return true;
  }

  getJobs() {
    return this.jobs.map((job) => this.toPublicJob(job));
  }

  async processDue() {
    if (this.processing) return;
    this.processing = true;
    try {
      for (const job of this.jobs) {
        if (job.status !== 'scheduled' || Date.parse(job.runAt) > Date.now()) continue;
        job.status = 'processing';
        await this.persist();
        try {
          const attachment = job.attachment
            ? {
                ...job.attachment,
                buffer: Buffer.from(job.attachment.base64, 'base64'),
              }
            : undefined;
          for (const target of job.targets) {
            this.queueManager.enqueue({
              deviceId: job.deviceId,
              target: target.id,
              message: job.message,
              attachment,
              minDelayMs: job.minDelayMs,
              maxDelayMs: job.maxDelayMs,
            });
          }
          job.status = 'queued';
        } catch (error) {
          job.status = 'failed';
          job.error = error.message || 'Jadwal gagal dimasukkan ke antrean.';
        }
        await this.persist();
      }
    } finally {
      this.processing = false;
    }
  }

  async persist() {
    await writeJson(this.filePath, this.jobs);
  }

  toPublicJob(job) {
    const { attachment, ...publicJob } = job;
    return { ...publicJob, hasAttachment: Boolean(attachment) };
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.persist();
  }
}
