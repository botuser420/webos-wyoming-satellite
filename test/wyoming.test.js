'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { encode, Parser } = require('../src/wyoming');

function parse(chunks) {
  const events = [];
  const p = new Parser((e) => events.push(e));
  for (const c of chunks) p.push(c);
  return events;
}

test('an event with data and payload survives a round trip', () => {
  const wire = encode('audio-chunk', { rate: 16000, width: 2, channels: 1 }, Buffer.from([1, 2, 3, 4]));
  const [e] = parse([wire]);
  assert.equal(e.type, 'audio-chunk');
  assert.deepEqual(e.data, { rate: 16000, width: 2, channels: 1 });
  assert.deepEqual([...e.payload], [1, 2, 3, 4]);
});

test('wire format: header line, data_length bytes of JSON, then the payload', () => {
  const wire = encode('audio-chunk', { rate: 16000 }, Buffer.from([9]));
  const nl = wire.indexOf(0x0a);
  const header = JSON.parse(wire.slice(0, nl).toString());
  assert.equal(header.type, 'audio-chunk');
  assert.equal(header.data_length, Buffer.byteLength('{"rate":16000}'));
  assert.equal(header.payload_length, 1);
  assert.equal(wire.length, nl + 1 + header.data_length + 1);
});

test('empty data writes no data_length', () => {
  const header = JSON.parse(encode('describe', {}).toString());
  assert.equal(header.type, 'describe');
  assert.equal('data_length' in header, false);
  assert.equal('payload_length' in header, false);
});

test('bytes may arrive in any split, including inside multi-byte text', () => {
  const wire = Buffer.concat([
    encode('transcript', { text: 'héllo ✓' }),
    encode('audio-chunk', { rate: 1 }, Buffer.alloc(10, 7)),
  ]);
  const chunks = [];
  for (let i = 0; i < wire.length; i++) chunks.push(wire.slice(i, i + 1));
  const events = parse(chunks);
  assert.equal(events.length, 2);
  assert.equal(events[0].data.text, 'héllo ✓');
  assert.equal(events[1].payload.length, 10);
});

test('data carried inline in the header is accepted, and merged with data_length data', () => {
  const inline = Buffer.from(JSON.stringify({ type: 'ping', data: { text: 'a' } }) + '\n');
  assert.equal(parse([inline])[0].data.text, 'a');
  const extra = Buffer.from('{"b":2}');
  const both = Buffer.concat([Buffer.from(JSON.stringify({ type: 'x', data: { a: 1 }, data_length: extra.length }) + '\n'), extra]);
  assert.deepEqual(parse([both])[0].data, { a: 1, b: 2 });
});

test('garbage in the header or an absurd payload length throws', () => {
  assert.throws(() => parse([Buffer.from('not json\n')]));
  assert.throws(() => parse([Buffer.from('{"type":"x","payload_length":999999999}\n')]));
});
