'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createLuna } = require('../src/luna');
const { Mic } = require('../src/mic');
const { createFakeTv } = require('./helpers/fake-tv');
const { sleep, until, samples } = require('./helpers/util');

const tv = createFakeTv();
test.after(() => tv.cleanup());
test.beforeEach(() => tv.setState({ power: 'Active', output: 'tv_speaker', die: false, timeoutMs: 0 }));

let mic = null;
function make(extra = {}) {
  const luna = createLuna({ lunaSend: tv.lunaSend });
  mic = new Mic({ luna, log: () => {}, lunaSend: tv.lunaSend, bufferSeconds: 2, gainDb: 20, channel: 0, pollMs: 100, restartMs: 100, ...extra });
  return mic;
}
test.afterEach(async () => { if (mic) { mic.stop(); mic = null; await sleep(200); } });

test('Active: the stream runs and the buffer holds ~2 s of the chosen channel with the gain', async () => {
  make().start();
  await until('stream on', () => mic.status().on);
  await sleep(2600);
  const b = mic.take();
  assert.ok(Math.abs(b.length - 64000) <= 0.15 * 32000, `buffer ${b.length} bytes, expected ~64000`);
  assert.ok(samples(b).every((v) => v === 10000), 'channel 0 (1000) times 10 (+20 dB)');
});

test('Screen Off and Screen Saver count as on', async () => {
  for (const power of ['Screen Off', 'Screen Saver']) {
    tv.setState({ power });
    make().start();
    await until(`${power}: stream on`, () => mic.status().on);
    mic.stop(); await sleep(300);
  }
});

test('Active Standby and Suspend: no stream, and the tv is never woken', async () => {
  const before = tv.calls().length;
  for (const power of ['Active Standby', 'Suspend']) {
    tv.setState({ power });
    make().start();
    await sleep(600);
    assert.equal(mic.status().on, false, `${power}: stream on`);
    mic.stop();
  }
  const uris = tv.calls().slice(before).map((c) => c.uri).filter((u) => !/getPowerState|getVolume/.test(u));
  assert.deepEqual(uris, [], 'only reads in stand-by');
  assert.ok(!/powerOn|turnOnScreen|turnOffScreen|powerOff/.test(tv.calls().map((c) => c.uri).join(' ')));
});

test('the tv goes to stand-by while streaming: the stream stops and the buffer is emptied', async () => {
  make().start();
  await until('stream on', () => mic.status().on);
  const stops = tv.count('stopStreaming');
  tv.setState({ power: 'Active Standby' });
  await until('stream off', () => !mic.status().on);
  await until('stopStreaming called', () => tv.count('stopStreaming') > stops);
  assert.equal(mic.take().length, 0);
  tv.setState({ power: 'Active' });
  await until('stream back on', () => mic.status().on);
});

test('a change of sound output (sound1 <-> sound2) restarts the stream', async () => {
  make().start();
  await until('stream on', () => mic.status().on);
  for (const output of ['external_arc', 'tv_speaker']) {
    const starts = tv.count('startStreaming');
    tv.setState({ output });
    await until(`restart after ${output}`, () => tv.count('startStreaming') > starts && mic.status().on);
    await sleep(500);
    assert.ok(mic.take().length > 0, `data flows after ${output}`);
  }
  assert.ok(mic.status().restarts >= 2);
});

test('a stream that dies restarts by itself', async () => {
  make().start();
  await until('stream on', () => mic.status().on);
  const starts = tv.count('startStreaming');
  tv.setState({ die: true });
  await until('stream off', () => !mic.status().on);
  tv.setState({ die: false });
  await until('stream restarted', () => tv.count('startStreaming') > starts && mic.status().on);
});

test('take() empties the buffer; stop() ends the stream', async () => {
  make().start();
  await until('stream on', () => mic.status().on);
  await sleep(800);
  assert.ok(mic.take().length > 0);
  assert.ok(mic.take().length < 3200 * 3, 'a second take() right after holds almost nothing');
  mic.stop();
  assert.equal(mic.status().on, false);
  await sleep(300);
  assert.ok(tv.count('stopStreaming') > 0);
});

test('channel and gain are settable, also while running', async () => {
  make({ channel: 2, gainDb: 0 }).start();
  await until('stream on', () => mic.status().on);
  await sleep(500);
  assert.ok(samples(mic.take()).every((v) => v === 3000), 'channel 2 is 3000 at 0 dB');
  mic.configure({ channel: 1, gainDb: 20 });
  mic.clear();
  await sleep(300);
  assert.ok(samples(mic.take()).every((v) => v === 20000), 'channel 1 is 2000, times 10');
  mic.configure({ gainDb: 999 });
  assert.equal(mic.gainDb, 20, 'out-of-range keeps the old value');
});

test('follow() hands later audio to every follower until stopped; clear() empties the buffer', async () => {
  make().start();
  await until('stream on', () => mic.status().on);
  await sleep(300);
  mic.take();
  let a = 0, b = 0;
  const stopA = mic.follow((x) => { a += x.length; });
  mic.follow((x) => { b += x.length; });
  await sleep(500);
  assert.ok(a >= 10000 && a <= 24000, `follower got ${a} bytes in ~0.5 s`);
  assert.equal(a, b, 'a second follower gets the same audio');
  stopA();
  const after = a; await sleep(200);
  assert.equal(a, after, 'nothing after stop');
  assert.ok(b > after);
  assert.ok(mic.status().bufferMs > 0);
  mic.clear();
  assert.equal(mic.status().bufferMs, 0);
});

test('awake(): true while awake, false in stand-by, null when not started or stopped', async () => {
  make();
  assert.equal(mic.awake(), null);
  mic.start();
  await until('awake', () => mic.awake() === true);
  tv.setState({ power: 'Active Standby' });
  await until('stand-by', () => mic.awake() === false);
  tv.setState({ power: 'Screen Off' });
  await until('screen off is awake', () => mic.awake() === true);
  mic.stop();
  assert.equal(mic.awake(), null);
});

test('restartTimer keeps the tv from ending a silent stream; without it the stream is lost', async () => {
  tv.setState({ timeoutMs: 600, lastRestart: 0 });
  make({ keepAliveMs: 100, restartMs: 20000 }).start();
  await until('stream on', () => mic.status().on);
  await sleep(2000);
  assert.equal(mic.status().on, true, 'still on after 2 s with a tv time-out of 0.6 s');
  assert.equal(mic.status().restarts, 0);
  assert.ok(tv.count('restartTimer') >= 10);
  mic.stop(); await sleep(200);
  tv.setState({ timeoutMs: 600, lastRestart: 0 });
  make({ keepAliveMs: 0, restartMs: 20000 }).start();
  await until('stream on', () => mic.status().on);
  await until('lost by the time-out', () => !mic.status().on, 3000);
  assert.ok(mic.status().restarts >= 1);
});

test('onChange reports on, off and restarts', async () => {
  const seen = [];
  make({ onChange: (s) => seen.push(s) }).start();
  await until('on', () => seen.some((s) => s.on));
  tv.setState({ output: 'external_arc' });
  await until('off after output change', () => seen.some((s) => !s.on));
  await until('on again', () => seen.filter((s) => s.on).length >= 2);
  assert.equal(seen[seen.length - 1].output, 'external_arc');
});
