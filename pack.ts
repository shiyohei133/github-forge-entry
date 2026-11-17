// Packfile reading/writing and pkt-line framing, pure Node (node:zlib only).

import { inflateSync, deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import type { GitObject, GitObjectType } from './store.ts';

// ---------------- pkt-line ----------------

export function pktLine(payload: Buffer | string): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  const head = Buffer.from(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');
export const PKT_RESPONSE_END = Buffer.from('0002', 'ascii');

/** Parse a buffer of pkt-lines into payloads; 'flush' | 'delim' | 'response-end' markers included. */
export function parsePktLines(buf: Buffer, offset = 0): { items: (Buffer | 'flush' | 'delim' | 'response-end')[]; next: number } {
  const items: (Buffer | 'flush' | 'delim' | 'response-end')[] = [];
  let i = offset;
  while (i + 4 <= buf.length) {
    const lenHex = buf.toString('ascii', i, i + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(lenHex)) break;
    const len = parseInt(lenHex, 16);
    if (len === 0) { items.push('flush'); i += 4; continue; }
    if (len === 1) { items.push('delim'); i += 4; continue; }
    if (len === 2) { items.push('response-end'); i += 4; continue; }
    if (len === 3) { i += 4; continue; }
    if (i + len > buf.length) break;
    items.push(buf.subarray(i + 4, i + len));
    i += len;
  }
  return { items, next: i };
}

// ---------------- packfile ----------------

const TYPE_NAMES: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const TYPE_CODES: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

export interface PackEntry extends GitObject {
  sha: string;
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let i = 0;
  const readVarint = (): number => {
    let v = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[i++];
      v |= (byte & 0x7f) << shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return v;
  };
  const srcSize = readVarint();
  if (srcSize !== base.length) throw new Error(`delta base size mismatch: ${srcSize} vs ${base.length}`);
  const dstSize = readVarint();
  const out: Buffer[] = [];
  let outLen = 0;
  while (i < delta.length) {
    const op = delta[i++];
    if (op & 0x80) {
      let cpOff = 0;
      let cpSize = 0;
      if (op & 0x01) cpOff = delta[i++];
      if (op & 0x02) cpOff |= delta[i++] << 8;
      if (op & 0x04) cpOff |= delta[i++] << 16;
      if (op & 0x08) cpOff |= delta[i++] << 24;
      if (op & 0x10) cpSize = delta[i++];
      if (op & 0x20) cpSize |= delta[i++] << 8;
      if (op & 0x40) cpSize |= delta[i++] << 16;
      if (cpSize === 0) cpSize = 0x10000;
      out.push(base.subarray(cpOff, cpOff + cpSize));
      outLen += cpSize;
    } else if (op > 0) {
      out.push(delta.subarray(i, i + op));
      outLen += op;
      i += op;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  const result = Buffer.concat(out, outLen);
  if (result.length !== dstSize) throw new Error(`delta result size mismatch: ${result.length} vs ${dstSize}`);
  return result;
}

/** Parse a whole packfile into objects (deltas resolved). Throws on malformed input. */
export function parsePack(pack: Buffer, hash: (type: GitObjectType, data: Buffer) => string): PackEntry[] {
  if (pack.length < 12 || pack.toString('ascii', 0, 4) !== 'PACK') throw new Error('not a packfile');
  const count = pack.readUInt32BE(8);
  let i = 12;
  const byOffset = new Map<number, PackEntry>();
  const entries: PackEntry[] = [];
  const pendingRefDelta: { baseSha: string; delta: Buffer; offset: number }[] = [];

  const readObjectAt = (start: number): { typeCode: number; size: number; next: number } => {
    let j = start;
    let byte = pack[j++];
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[j++];
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    return { typeCode, size, next: j };
  };

  for (let n = 0; n < count; n++) {
    const offset = i;
    const { typeCode, next } = readObjectAt(i);
    i = next;
    if (typeCode === 6) {
      // OFS_DELTA: negative offset varint
      let byte = pack[i++];
      let baseOffset = byte & 0x7f;
      while (byte & 0x80) {
        byte = pack[i++];
        baseOffset = ((baseOffset + 1) << 7) | (byte & 0x7f);
      }
      const base = byOffset.get(offset - baseOffset);
      if (!base) throw new Error('ofs-delta base missing');
      const inf = inflateAt(pack, i);
      i += inf.consumed;
      const data = applyDelta(base.data, inf.data);
      const entry: PackEntry = { type: base.type, data, sha: hash(base.type, data) };
      byOffset.set(offset, entry);
      entries.push(entry);
    } else if (typeCode === 7) {
      // REF_DELTA
      const baseSha = pack.toString('hex', i, i + 20);
      i += 20;
      const inf = inflateAt(pack, i);
      i += inf.consumed;
      pendingRefDelta.push({ baseSha, delta: inf.data, offset });
    } else {
      const type = TYPE_NAMES[typeCode];
      if (!type) throw new Error(`unknown pack object type ${typeCode}`);
      const inf = inflateAt(pack, i);
      i += inf.consumed;
      const data = inf.data;
      const entry: PackEntry = { type, data, sha: hash(type, data) };
      byOffset.set(offset, entry);
      entries.push(entry);
    }
  }

  // Resolve ref-deltas (possibly chained) against what we have plus the caller's store lookup.
  const bySha = new Map<string, PackEntry>(entries.map((e) => [e.sha, e]));
  let progress = true;
  const pending = [...pendingRefDelta];
  while (pending.length && progress) {
    progress = false;
    for (let k = pending.length - 1; k >= 0; k--) {
      const base = bySha.get(pending[k].baseSha) ?? externalLookup?.(pending[k].baseSha);
      if (base) {
        const data = applyDelta(base.data, pending[k].delta);
        const entry: PackEntry = { type: base.type, data, sha: hash(base.type, data) };
        bySha.set(entry.sha, entry);
        entries.push(entry);
        pending.splice(k, 1);
        progress = true;
      }
    }
  }
  if (pending.length) throw new Error('unresolved ref-delta in pack');
  return entries;
}

let externalLookup: ((sha: string) => GitObject | undefined) | undefined;
export function setPackExternalLookup(fn: ((sha: string) => GitObject | undefined) | undefined): void {
  externalLookup = fn;
}

/**
 * Inflate the zlib stream starting at `start` and report how many compressed bytes it
 * consumed. A truncated stream throws while a complete one (trailing bytes tolerated)
 * succeeds, so the consumed length is the smallest successful prefix: exponential
 * probe for an upper bound, then binary search.
 */
function inflateAt(buf: Buffer, start: number): { data: Buffer; consumed: number } {
  const max = buf.length - start;
  let failedMax = 0; // largest prefix known to be too short
  let hi = Math.min(max, 128);
  let data: Buffer | null = null;
  while (true) {
    try {
      data = inflateSync(buf.subarray(start, start + hi));
      break;
    } catch {
      failedMax = hi;
      if (hi >= max) throw new Error('inflate failed: stream is broken or truncated');
      hi = Math.min(max, hi * 2);
    }
  }
  // hi succeeded but may overshoot into the next object; binary-search (failedMax, hi]
  // for the smallest successful prefix, which ends exactly at the stream's end.
  let lo = failedMax + 1;
  let best = hi;
  let upper = hi;
  while (lo <= upper) {
    const mid = (lo + upper) >> 1;
    try {
      inflateSync(buf.subarray(start, start + mid));
      best = mid;
      upper = mid - 1;
    } catch {
      lo = mid + 1;
    }
  }
  return { data, consumed: best };
}

/** Write a packfile containing the given objects (no deltas; zlib level default). */
export function writePack(objects: PackEntry[]): Buffer {
  const head = Buffer.alloc(12);
  head.write('PACK', 0, 'ascii');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(objects.length, 8);
  const parts: Buffer[] = [head];
  for (const obj of objects) {
    const typeCode = TYPE_CODES[obj.type];
    let size = obj.data.length;
    const bytes: number[] = [];
    let first = true;
    do {
      let byte = size & (first ? 0x0f : 0x7f);
      size = first ? size >> 4 : size >> 7;
      if (first) byte |= typeCode << 4;
      if (size > 0) byte |= 0x80;
      bytes.push(byte);
      first = false;
    } while (size > 0);
    parts.push(Buffer.from(bytes));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}
