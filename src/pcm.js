'use strict';
/*
 * PCM helpers: the sink format, a streaming converter to it, and a small WAV reader.
 *
 * The sink (ptts) plays raw signed 16-bit little-endian, mono, 44100 Hz. Home Assistant sends
 * other rates (usually 22050 Hz), so everything that is played goes through a Converter.
 */

const SINK = { rate: 44100, width: 2, channels: 1 };

// Converts chunks of s16le audio of any rate and channel count to SINK, keeping state between
// chunks (linear interpolation, channels averaged). push(Buffer) returns a Buffer.
class Converter {
  constructor(format) {
    const f = format || {};
    this.rate = Number(f.rate) || SINK.rate;
    this.width = Number(f.width) || 2;
    this.channels = Number(f.channels) || 1;
    if (this.width !== 2) throw new Error('only 16-bit audio is supported, got width ' + this.width);
    if (this.rate < 4000 || this.rate > 192000) throw new Error('unsupported sample rate ' + this.rate);
    if (this.channels < 1 || this.channels > 8) throw new Error('unsupported channel count ' + this.channels);
    this.step = this.rate / SINK.rate;  // input samples per output sample
    this.carry = Buffer.alloc(0);       // bytes of an incomplete frame
    this.prev = null;                   // last input sample of the previous chunk
    this.pos = 0;                       // next output position, in input samples, relative to `prev`
  }

  push(buf) {
    if (this.carry.length) buf = Buffer.concat([this.carry, buf]);
    const frame = 2 * this.channels;
    const frames = Math.floor(buf.length / frame);
    this.carry = buf.slice(frames * frame);
    if (frames === 0) return Buffer.alloc(0);
    // mono samples of this chunk, preceded by the last one of the previous chunk
    const base = this.prev === null ? 0 : 1;
    const x = new Float64Array(frames + base);
    if (base) x[0] = this.prev;
    for (let i = 0; i < frames; i++) {
      let sum = 0;
      for (let c = 0; c < this.channels; c++) sum += buf.readInt16LE(i * frame + c * 2);
      x[i + base] = sum / this.channels;
    }
    const last = x.length - 1;
    const outs = [];
    let pos = this.prev === null ? 0 : this.pos;   // index into x of the next output sample
    while (pos <= last) {
      const i = Math.floor(pos);
      const a = x[i];
      const b = i + 1 <= last ? x[i + 1] : a;
      outs.push(Math.round(a + (b - a) * (pos - i)));
      pos += this.step;
    }
    this.pos = pos - last;      // relative to the new `prev`, which is x[last]
    this.prev = x[last];
    const out = Buffer.alloc(outs.length * 2);
    for (let i = 0; i < outs.length; i++) out.writeInt16LE(Math.max(-32768, Math.min(32767, outs[i])), i * 2);
    return out;
  }
}

// { rate, width, channels, data } from a PCM WAV file; throws on anything else.
function parseWav(buf) {
  if (buf.length < 12 || buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WAVE') {
    throw new Error('not a WAV file');
  }
  let fmt = null;
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString('latin1', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ') {
      fmt = { tag: buf.readUInt16LE(body), channels: buf.readUInt16LE(body + 2), rate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) };
    } else if (id === 'data') {
      if (!fmt) throw new Error('WAV data before fmt');
      if ((fmt.tag !== 1 && fmt.tag !== 0xfffe) || fmt.bits !== 16) throw new Error('only 16-bit PCM WAV files are supported');
      const end = Math.min(buf.length, body + size);
      return { rate: fmt.rate, width: 2, channels: fmt.channels, data: buf.slice(body, end) };
    }
    off = body + size + (size & 1);
  }
  throw new Error('WAV without data');
}

// A WAV file (Buffer) as a Buffer in the sink format.
function wavToSink(buf) {
  const w = parseWav(buf);
  return new Converter(w).push(w.data);
}

module.exports = { SINK, Converter, parseWav, wavToSink };
