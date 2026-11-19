import { parsePhoneNumberFromString } from 'libphonenumber-js';

export function normalizePhone(input) {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error('Nomor tujuan tidak boleh kosong.');
  }

  const compact = trimmed.replace(/[\s().-]/g, '');
  const candidate = /^0\d+$/.test(compact)
    ? `+62${compact.slice(1)}`
    : compact.startsWith('+')
      ? compact
      : `+${compact}`;
  const parsed = parsePhoneNumberFromString(candidate, 'ID');

  if (!parsed?.isValid()) {
    throw new Error('Nomor tujuan tidak valid. Gunakan format Indonesia seperti 08xxxxxxxxxx atau 628xxxxxxxxxx.');
  }
  return parsed.number.slice(1);
}
