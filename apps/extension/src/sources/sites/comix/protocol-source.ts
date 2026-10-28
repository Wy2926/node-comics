import {SourceProtocolError} from '../../contracts/network';
import type {ComixProtocol} from './protocol';

const identifier = '[$\\w]+';
const boundary = '(?<![$\\w])';
const number = '(?:0x[\\da-f]+|\\d+(?:e\\d+)?)';
const quoted = '"(?:[^"\\\\]|\\\\.)*"';
const numbers = '\\[(?:' + number + '(?:,' + number + ')*,?)?\\]';
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const protocolChanged = () => new SourceProtocolError('Comix 接口协议已变化，无法安全读取目录或章节；请稍后重试或在来源标签页阅读。');

/** Read literals from the observed public bundle layout. Never evaluate source or its rotation loop. */
export function parseProtocolSource(source: string): ComixProtocol {
  try { return parse(source); }
  catch { throw protocolChanged(); }
}

function parse(source: string): ComixProtocol {
  if (source.length > 1024 * 1024 || !source.includes('new Uint8Array(1088)') ||
      !source.includes('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/=')) throw Error();
  const alias = new RegExp('^const (' + identifier + ')=(' + identifier + ');').exec(source);
  if (!alias) throw Error();
  const call = escape(alias[1]);
  const decoder = new RegExp('function ' + escape(alias[2]) + '\\([^)]*\\)\\{(' + identifier + ')-=(' + number + ');const (' + identifier + ')=(' + identifier + ')\\(\\);').exec(source);
  if (!decoder) throw Error();
  const tableMatch = new RegExp('function ' + escape(decoder[4]) + '\\(\\)\\{const (' + identifier + ')=(\\[(?:"[A-Za-z0-9+/=]*",?)+\\]);').exec(source);
  if (!tableMatch) throw Error();
  const encoded: unknown = JSON.parse(tableMatch[2]);
  if (!Array.isArray(encoded) || encoded.length < 16 || encoded.length > 8192) throw Error();
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/';
  const standard = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const utf8 = new TextDecoder('utf-8', {fatal: true});
  const table = encoded.map(value => {
    if (typeof value !== 'string' || value.length > 32768) throw Error();
    const text = value.replace(/[A-Za-z]/g, char => standard[alphabet.indexOf(char)]);
    return utf8.decode(Uint8Array.from(atob(text), char => char.charCodeAt(0)));
  });
  // kid/material identify the rotation without running the bundle's arithmetic or browser checks.
  const metadata = new RegExp('const (' + identifier + ')=\\{\\};\\1\\[' + call + '\\((' + number + ')\\)\\]=' + call + '\\((' + number + ')\\),\\1\\[' + call + '\\((' + number + ')\\)\\]=function\\(\\)\\{[^{}]{0,200}new Uint8Array\\(1088\\)').exec(source);
  if (!metadata) throw Error();
  const base = Number(decoder[2]);
  const index = (value: number, rotation: number) => ((value - base + rotation) % table.length + table.length) % table.length;
  const rotations = table.flatMap((_, rotation) => table[index(Number(metadata[2]), rotation)] === 'kid' &&
    table[index(Number(metadata[4]), rotation)] === 'material' ? [rotation] : []);
  if (rotations.length !== 1) throw Error();
  const lookup = (value: string) => {
    const position = Number(value) - base;
    if (!Number.isSafeInteger(position) || position < 0 || position >= table.length) throw Error();
    return table[index(Number(value), rotations[0])];
  };
  const version = lookup(metadata[3]);
  if (!/^[a-zA-Z0-9_-]{1,32}$/.test(version)) throw Error();
  const literalSource = source.slice(0, metadata.index).replace(new RegExp(boundary + call + '\\((' + number + ')\\)', 'g'), (_, value: string) => JSON.stringify(lookup(value)));
  const lists = [...literalSource.matchAll(new RegExp('(?:var|const|let) (' + identifier + ')=\\[(' + identifier + '(?:,' + identifier + ')*)\\];', 'g'))];
  const list = lists.at(-1);
  if (!list) throw Error();
  const descriptors = list[2].split(',');
  if (descriptors.length < 1 || descriptors.length > 64 || new Set(descriptors).size !== descriptors.length) throw Error();
  const chunks = descriptors.map(name => {
    const fields = [...literalSource.matchAll(new RegExp(boundary + escape(name) + '(?:\\.id|\\[(' + quoted + ')\\])=(' + quoted + '|' + number + ')', 'g'))];
    const values = new Map<string, unknown>();
    for (const field of fields) {
      const key = field[1] ? JSON.parse(field[1]) : 'id';
      if (!['id', 'start', 'mask', 'enc'].includes(key) || values.has(key)) throw Error();
      values.set(key, field[2].startsWith('"') ? JSON.parse(field[2]) : Number(field[2]));
    }
    const id = values.get('id'), start = values.get('start'), mask = values.get('mask'), mode = values.get('enc');
    if (values.size !== 4 || typeof id !== 'string' || typeof start !== 'number' || !Number.isSafeInteger(start) || start < 0 || start >= 1088 ||
        typeof mask !== 'number' || !Number.isInteger(mask) || mask < 0 || mask > 255 || typeof mode !== 'number' || ![0, 1, 2].includes(mode)) throw Error();
    return {id, start, mask, mode};
  });
  const pools = new Map<string, Map<string, string | number[]>>();
  for (const match of literalSource.matchAll(new RegExp(boundary + '(' + identifier + ')\\[(' + quoted + ')\\]=(' + quoted + '|' + numbers + ')', 'g'))) {
    const key: unknown = JSON.parse(match[2]);
    if (typeof key !== 'string' || !chunks.some(chunk => chunk.id === key)) continue;
    const pool = pools.get(match[1]) ?? new Map<string, string | number[]>();
    if (pool.has(key)) throw Error();
    const value = match[3].startsWith('"') ? JSON.parse(match[3]) : match[3].slice(1, -1).split(',').filter(Boolean).map(Number);
    pool.set(key, value); pools.set(match[1], pool);
  }
  const candidates = [...pools.values()].filter(pool => chunks.every(chunk => pool.has(chunk.id)));
  if (candidates.length !== 1) throw Error();
  const data = new Uint8Array(1088), coverage = new Uint8Array(1088);
  for (const chunk of chunks) {
    const value = candidates[0].get(chunk.id)!;
    if (chunk.mode === 1 ? typeof value !== 'string' : !Array.isArray(value)) throw Error();
    const bytes = typeof value === 'string' ? Array.from(value, char => char.charCodeAt(0) - 33) : chunk.mode === 2 ? value.slice(1) : value;
    if (!bytes.length || chunk.start + bytes.length > data.length) throw Error();
    for (const [offset, byte] of bytes.entries()) {
      const at = chunk.start + offset;
      if (!Number.isInteger(byte) || byte < 0 || byte > 255 || coverage[at]) throw Error();
      coverage[at] = 1; data[at] = byte ^ chunk.mask;
    }
  }
  if (coverage.some(value => value !== 1)) throw Error();
  return {version, data};
}
