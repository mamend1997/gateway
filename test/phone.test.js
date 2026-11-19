import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePhone } from '../services/phone.js';

test('normalizes valid Indonesian mobile numbers to WhatsApp digits', () => {
  assert.equal(normalizePhone('0812 3456 7890'), '6281234567890');
  assert.equal(normalizePhone('+62 812-3456-7890'), '6281234567890');
});

test('rejects empty and invalid phone numbers', () => {
  assert.throws(() => normalizePhone('  '), /tidak boleh kosong/);
  assert.throws(() => normalizePhone('123'), /tidak valid/);
});
