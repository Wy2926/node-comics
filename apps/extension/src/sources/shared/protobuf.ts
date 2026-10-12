// Bounded wire primitives; message fields and protocol semantics stay in each site.
// Unknown fields are skipped, not recursively interpreted or executed.
export const invalid = () => Error('来源二进制数据不完整或读取协议已变化。');
type Value = number | Uint8Array;
export type Fields = Map<number, Value[]>;
export function decode(bytes: Uint8Array): Fields {
  if (!bytes.length || bytes.length > 8 * 1024 * 1024) throw invalid();
  let offset = 0, fieldCount = 0;
  const fields: Fields = new Map();
  function varint() {
    let value = 0, multiplier = 1;
    for (let i = 0; i < 10; i++) {
      if (offset >= bytes.length) throw invalid();
      const byte = bytes[offset++]; value += (byte & 127) * multiplier;
      if (!Number.isSafeInteger(value)) throw invalid();
      if (byte < 128) return value;
      multiplier *= 128;
    }
    throw invalid();
  }
  while (offset < bytes.length) {
    if (++fieldCount > 50000) throw invalid();
    const tag = varint(), field = Math.floor(tag / 8), wire = tag % 8;
    if (field < 1 || field > 0x1fffffff) throw invalid();
    let value: Value;
    if (wire === 0) value = varint();
    else if (wire === 1 || wire === 2 || wire === 5) {
      const length = wire === 2 ? varint() : wire === 1 ? 8 : 4;
      if (length > bytes.length - offset) throw invalid();
      value = bytes.subarray(offset, offset + length); offset += length;
      // Unknown fixed-width fields need no materialized representation.
      if (wire !== 2) continue;
    } else throw invalid();
    const values = fields.get(field) ?? []; values.push(value); fields.set(field, values);
  }
  return fields;
}
export function one(fields: Fields, field: number): Value | undefined {
  const values = fields.get(field);
  if (values && values.length !== 1) throw invalid();
  return values?.[0];
}
export function number(fields: Fields, field: number, fallback = 0): number {
  const value = one(fields, field);
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || value > 0xffffffff) throw invalid();
  return value;
}
export function bytes(fields: Fields, field: number): Uint8Array | undefined {
  const value = one(fields, field);
  if (value !== undefined && !(value instanceof Uint8Array)) throw invalid();
  return value;
}
export function text(fields: Fields, field: number): string {
  const value = bytes(fields, field);
  if (value === undefined) return '';
  if (value.length > 8192) throw invalid();
  try {return new TextDecoder('utf-8', {fatal: true}).decode(value);} catch {throw invalid();}
}
export function messages(fields: Fields, field: number, max = 1500): Fields[] {
  const values = fields.get(field) ?? [];
  if (values.length > max) throw invalid();
  return values.map(value => {if (!(value instanceof Uint8Array)) throw invalid(); return decode(value);});
}
const varint = (value: number) => {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) throw invalid();
  const out: number[] = [];
  do {const byte = value % 128; value = Math.floor(value / 128); out.push(byte | (value ? 128 : 0));} while (value);
  return out;
};
export function encode(...fields: Array<[number, number | string | Uint8Array]>): Uint8Array<ArrayBuffer> {
  const out: number[] = [];
  for (const [field, value] of fields) {
    if (typeof value === 'number') out.push(...varint(field * 8), ...varint(value));
    else {
      const data = typeof value === 'string' ? new TextEncoder().encode(value) : value;
      if (data.length > 16384) throw invalid();
      out.push(...varint(field * 8 + 2), ...varint(data.length), ...data);
    }
  }
  return new Uint8Array(out);
}
