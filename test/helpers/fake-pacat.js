'use strict';
/*
 * A fake `pacat` executable: records the arguments of every start, every chunk read from stdin
 * (arrival time and size) and all bytes, so tests can see what was played and when.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function createFakePacat() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-pacat-'));
  const pacat = path.join(dir, 'pacat');
  fs.writeFileSync(pacat, `#!/usr/bin/env node
const fs = require('fs');
const dir = ${JSON.stringify(dir)};
const id = process.pid;
fs.appendFileSync(dir + '/starts.jsonl', JSON.stringify({ id, args: process.argv.slice(2), t: Date.now() }) + '\\n');
process.stdin.on('data', (b) => {
  fs.appendFileSync(dir + '/chunks.jsonl', JSON.stringify({ id, t: Date.now(), n: b.length }) + '\\n');
  fs.appendFileSync(dir + '/bytes.bin', b);
});
process.stdin.on('end', () => process.exit(0));
`, { mode: 0o755 });

  const lines = (f) => (fs.existsSync(path.join(dir, f))
    ? fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  return {
    pacat,
    starts: () => lines('starts.jsonl'),
    chunks: () => lines('chunks.jsonl'),
    bytes: () => (fs.existsSync(path.join(dir, 'bytes.bin')) ? fs.readFileSync(path.join(dir, 'bytes.bin')) : Buffer.alloc(0)),
    reset: () => { for (const f of ['starts.jsonl', 'chunks.jsonl', 'bytes.bin']) fs.rmSync(path.join(dir, f), { force: true }); },
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

// Runs of non-zero samples in 44.1 kHz mono s16le: [{ start, end }] in ms from the first byte.
function spans(buf, gapMs = 20) {
  const out = [];
  const gap = gapMs * 44.1;
  let cur = null;
  let last = -Infinity;
  for (let i = 0; i + 2 <= buf.length; i += 2) {
    if (buf.readInt16LE(i) === 0) continue;
    const s = i / 2;
    if (cur && s - last <= gap) cur.end = s; else { cur = { start: s, end: s }; out.push(cur); }
    last = s;
  }
  return out.map((x) => ({ start: x.start / 44.1, end: (x.end + 1) / 44.1 }));
}

// A WAV file (Buffer): `ms` long at `rate`, every sample `level`.
function wav(rate, ms, level = 8000, channels = 1) {
  const n = Math.round(rate * ms / 1000);
  const data = Buffer.alloc(n * 2 * channels);
  for (let i = 0; i < n * channels; i++) data.writeInt16LE(level, i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2 * channels, 28); h.writeUInt16LE(2 * channels, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

// Raw s16le mono PCM of `ms` at `rate`, every sample `level`.
function pcm(rate, ms, level = 8000) {
  const n = Math.round(rate * ms / 1000);
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(level, i * 2);
  return b;
}

module.exports = { createFakePacat, spans, wav, pcm };
