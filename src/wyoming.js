'use strict';
/*
 * Wyoming wire framing. One event is a JSON header line, then `data_length` bytes of
 * UTF-8 JSON (merged into the event's data), then `payload_length` bytes of payload.
 */

const VERSION = '1.10.2'; // protocol version we claim; Home Assistant ignores it
const MAX_HEADER = 64 * 1024;
const MAX_BODY = 16 * 1024 * 1024;

function encode(type, data, payload) {
  const header = { type, version: VERSION };
  let dataBytes = null;
  if (data && Object.keys(data).length > 0) {
    dataBytes = Buffer.from(JSON.stringify(data), 'utf8');
    header.data_length = dataBytes.length;
  }
  if (payload && payload.length > 0) header.payload_length = payload.length;
  const parts = [Buffer.from(JSON.stringify(header) + '\n', 'utf8')];
  if (dataBytes) parts.push(dataBytes);
  if (header.payload_length) parts.push(payload);
  return Buffer.concat(parts);
}

// Incremental parser over bytes (never over strings). push() throws on a malformed stream;
// the caller should then drop the connection.
class Parser {
  constructor(onEvent) {
    this.onEvent = onEvent;
    this.buf = Buffer.alloc(0);
    this.header = null;
  }

  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      if (!this.header) {
        const nl = this.buf.indexOf(0x0a);
        if (nl < 0) {
          if (this.buf.length > MAX_HEADER) throw new Error('wyoming: header line too long');
          return;
        }
        let header;
        try { header = JSON.parse(this.buf.slice(0, nl).toString('utf8')); } catch (e) { throw new Error('wyoming: bad header'); }
        if (!header || typeof header.type !== 'string') throw new Error('wyoming: header without type');
        header.data_length = Number(header.data_length) || 0;
        header.payload_length = Number(header.payload_length) || 0;
        if (header.data_length < 0 || header.payload_length < 0 || header.data_length + header.payload_length > MAX_BODY) {
          throw new Error('wyoming: bad length');
        }
        this.header = header;
        this.buf = this.buf.slice(nl + 1);
      }
      const h = this.header;
      if (this.buf.length < h.data_length + h.payload_length) return;
      let data = h.data && typeof h.data === 'object' ? h.data : {};
      if (h.data_length) {
        let extra;
        try { extra = JSON.parse(this.buf.slice(0, h.data_length).toString('utf8')); } catch (e) { throw new Error('wyoming: bad data'); }
        data = Object.assign({}, data, extra);
      }
      const payload = h.payload_length ? this.buf.slice(h.data_length, h.data_length + h.payload_length) : null;
      this.buf = this.buf.slice(h.data_length + h.payload_length);
      this.header = null;
      this.onEvent({ type: h.type, data, payload });
    }
  }
}

module.exports = { encode, Parser, VERSION };
