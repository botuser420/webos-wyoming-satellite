'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Satellite } = require('../src');
const { createFakeTv } = require('./helpers/fake-tv');
const { FakeHa } = require('./helpers/fake-ha');
const { sleep, until, samples } = require('./helpers/util');

const tv = createFakeTv();
test.after(() => tv.cleanup());

const live = [];
let logs;
async function makeSat(extra = {}) {
  logs = [];
  const sat = new Satellite({
    port: 0, allowedHosts: ['127.0.0.1'], lunaSend: tv.lunaSend,
    log: (level, msg) => logs.push({ level, msg }),
    micGainDb: 20, bufferSeconds: 2, micPollMs: 100, micRestartMs: 100,
    ...extra,
  });
  live.push(sat);
  const events = [];
  for (const name of ['connected', 'disconnected', 'run-start', 'run-stop', 'stt-start', 'stt-stop', 'mic-status', 'refused', 'warning', 'paused', 'resumed']) {
    sat.on(name, (e) => events.push({ name, e }));
  }
  sat.events = events;
  sat.names = () => events.map((x) => x.name);
  await sat.start();
  return sat;
}
const clients = [];
async function ha(sat) { const c = await FakeHa.connect(sat.port); clients.push(c); return c; }
test.beforeEach(() => tv.setState({ power: 'Active', output: 'tv_speaker', die: false, timeoutMs: 0 }));
test.afterEach(async () => {
  clients.splice(0).forEach((c) => c.close());
  await Promise.all(live.splice(0).map((s) => s.stop()));
  await sleep(150);
});

test('describe is answered with an info that makes Home Assistant create an assist_satellite', async () => {
  const sat = await makeSat({ name: 'Living room TV' });
  const c = await ha(sat);
  c.send('describe');
  const info = (await c.waitFor('info')).data;
  assert.equal(info.satellite.name, 'Living room TV');
  assert.equal(info.satellite.installed, true);
  assert.ok(info.satellite.attribution && 'name' in info.satellite.attribution && 'url' in info.satellite.attribution);
  for (const k of ['asr', 'tts', 'handle', 'intent', 'wake']) assert.deepEqual(info[k], []);
  assert.deepEqual(info.mic[0].mic_format, { rate: 16000, width: 2, channels: 1 });
});

test('the port is configurable', async () => {
  const sat = await makeSat();
  assert.ok(sat.port > 0);
  const c = await ha(sat);
  c.send('describe');
  await c.waitFor('info');
});

test('a connection from outside allowedHosts is closed and logged with its address', async () => {
  const sat = await makeSat({ allowedHosts: ['10.9.8.7'] });
  const c = await FakeHa.connect(sat.port);
  clients.push(c);
  await c.waitClosed();
  assert.deepEqual(c.events, [], 'nothing is answered');
  const line = logs.find((l) => /refused/i.test(l.msg));
  assert.ok(line && line.msg.includes('127.0.0.1'), JSON.stringify(logs));
  assert.equal(sat.events.find((x) => x.name === 'refused').e.address, '127.0.0.1');
});

test('an IPv4-mapped IPv6 peer address matches an IPv4 entry', async () => {
  const sat = await makeSat({ host: '::', allowedHosts: ['127.0.0.1'] });
  const c = await ha(sat);
  c.send('describe');
  await c.waitFor('info');
});

test('an empty allowedHosts gives a clear warning and lets everybody in', async () => {
  const sat = await makeSat({ allowedHosts: [] });
  const w = logs.find((l) => l.level === 'warn' && /allowedHosts/.test(l.msg));
  assert.ok(w, JSON.stringify(logs));
  assert.ok(sat.names().includes('warning'));
  const c = await ha(sat);
  c.send('describe');
  await c.waitFor('info');
});

test('ping is answered with pong at once, echoing the text, while idle and while streaming', async () => {
  const sat = await makeSat();
  const c = await ha(sat);
  await c.takeSatellite();
  c.send('ping', { text: 'abc' });
  assert.equal((await c.waitFor('pong')).data.text, 'abc');
  await until('mic on', () => sat.micStatus().on);
  assert.equal(sat.startRun().started, true);
  const t0 = Date.now();
  c.send('ping', { text: 'busy' });
  await c.waitFor('pong', 2);
  assert.ok(Date.now() - t0 < 500);
});

test('run-satellite makes the connection the satellite and emits connected; closing emits disconnected', async () => {
  const sat = await makeSat();
  const c = await ha(sat);
  c.send('run-satellite');
  await until('connected', () => sat.names().includes('connected'));
  assert.equal(sat.status().connected, true);
  assert.equal(sat.events.find((x) => x.name === 'connected').e.address, '127.0.0.1');
  c.close();
  await until('disconnected', () => sat.names().includes('disconnected'));
  assert.equal(sat.status().connected, false);
});

test('a describe-only probe (as HA does every 30 s) does not take over the satellite connection', async () => {
  const sat = await makeSat();
  const main = await ha(sat);
  await main.takeSatellite();
  const probe = await ha(sat);
  probe.send('describe');
  await probe.waitFor('info');
  probe.close();
  await sleep(100);
  assert.deepEqual(sat.names().filter((n) => n === 'connected' || n === 'disconnected'), ['connected']);
  await until('mic on', () => sat.micStatus().on);
  assert.equal(sat.startRun().started, true);
  await main.waitFor('run-pipeline');
});

test('a new run-satellite replaces a stale owner, which is closed', async () => {
  const sat = await makeSat();
  const old = await ha(sat);
  await old.takeSatellite();
  const fresh = await ha(sat);
  await fresh.takeSatellite();
  await old.waitClosed();
  await until('mic on', () => sat.micStatus().on);
  assert.equal(sat.startRun().started, true);
  await fresh.waitFor('run-pipeline');
  assert.deepEqual(sat.names().filter((n) => n === 'connected' || n === 'disconnected'), ['connected', 'disconnected', 'connected']);
});

test('startRun sends run-pipeline from asr first, then the pre-roll buffer, then live audio', async () => {
  const sat = await makeSat();
  const c = await ha(sat);
  await c.takeSatellite();
  await until('mic on', () => sat.micStatus().on);
  await sleep(1200);
  const r = sat.startRun();
  assert.equal(r.started, true);
  await sleep(600);
  const idx = c.types().indexOf('run-pipeline');
  const rp = c.events[idx];
  assert.equal(rp.data.start_stage, 'asr');
  assert.equal(rp.data.end_stage, 'tts');
  assert.equal(rp.data.restart_on_end, false);
  const chunks = c.events.slice(idx + 1).filter((e) => e.type === 'audio-chunk');
  assert.ok(c.events.slice(idx + 1).every((e) => e.type === 'audio-chunk' || e.type === 'audio-start'), 'only audio after run-pipeline');
  for (const ch of chunks) assert.deepEqual([ch.data.rate, ch.data.width, ch.data.channels], [16000, 2, 1]);
  const total = chunks.reduce((n, e) => n + e.payload.length, 0);
  assert.ok(total > 32000 * 1.2 + 16000 * 0.4, `buffer (~1.2 s) plus live audio (~0.6 s), got ${total} bytes`);
  assert.ok(chunks.every((e) => samples(e.payload).every((v) => v === 10000)));
  assert.ok(chunks.every((e) => e.payload.length <= 2048));
  assert.ok(sat.names().includes('run-start'));
});

test('the buffer is sent before live audio and is not sent twice', async () => {
  const sat = await makeSat({ bufferSeconds: 1 });
  const c = await ha(sat);
  await c.takeSatellite();
  await until('mic on', () => sat.micStatus().on);
  await sleep(1500);
  sat.startRun();
  const idx = c.types().indexOf('run-pipeline');
  await sleep(100);
  const early = c.events.slice(idx + 1).filter((e) => e.type === 'audio-chunk').reduce((n, e) => n + e.payload.length, 0);
  assert.ok(early >= 32000 * 0.8, `buffer (~1 s) goes out first, got ${early}`);
  assert.ok(early <= 32000 * 1.3 + 12800, `and not more than that straight away, got ${early}`);
});

test('startRun is refused without a satellite connection, while paused, while a run is active, and with the mic off', async () => {
  const sat = await makeSat();
  assert.deepEqual(sat.startRun(), { started: false, reason: 'not-connected' });
  const c = await ha(sat);
  await c.takeSatellite();
  await until('mic on', () => sat.micStatus().on);
  c.send('pause-satellite');
  await until('paused', () => sat.names().includes('paused'));
  assert.deepEqual(sat.startRun(), { started: false, reason: 'paused' });
  c.send('run-satellite');
  await until('resumed', () => sat.names().includes('resumed'));
  assert.equal(sat.startRun().started, true);
  assert.deepEqual(sat.startRun(), { started: false, reason: 'run-active' });
  sat.stopRun();
  tv.setState({ power: 'Active Standby' });
  await until('mic off', () => !sat.micStatus().on);
  assert.deepEqual(sat.startRun(), { started: false, reason: 'mic-off' });
});

test('transcribe and transcript become stt-start and stt-stop; the run stops streaming at the transcript', async () => {
  const sat = await makeSat();
  const c = await ha(sat);
  await c.takeSatellite();
  await until('mic on', () => sat.micStatus().on);
  sat.startRun();
  c.send('transcribe', { language: 'en' });
  await until('stt-start', () => sat.names().includes('stt-start'));
  c.send('voice-started', { timestamp: 1 });
  c.send('voice-stopped', { timestamp: 2 });
  c.send('transcript', { text: 'turn on the light' });
  await until('stt-stop', () => sat.names().includes('stt-stop'));
  assert.equal(sat.events.find((x) => x.name === 'stt-stop').e.text, 'turn on the light');
  await until('run-stop', () => sat.names().includes('run-stop'));
  assert.equal(sat.events.find((x) => x.name === 'run-stop').e.reason, 'transcript');
  await sleep(100);
  const n = c.of('audio-chunk').length;
  await sleep(300);
  assert.equal(c.of('audio-chunk').length, n, 'no audio after the transcript');
  assert.equal(sat.status().running, false);
});

test('stopRun stops the audio and tells HA with audio-stop', async () => {
  const sat = await makeSat();
  const c = await ha(sat);
  await c.takeSatellite();
  await until('mic on', () => sat.micStatus().on);
  sat.startRun();
  await sleep(300);
  sat.stopRun();
  await c.waitFor('audio-stop');
  const n = c.of('audio-chunk').length;
  await sleep(300);
  assert.equal(c.of('audio-chunk').length, n);
  assert.equal(sat.events.find((x) => x.name === 'run-stop').e.reason, 'stopped');
  assert.equal(sat.stopRun(), false, 'nothing to stop');
});

test('a pipeline error, a pause, a disconnect and the safety time-out all end the run with a reason', async () => {
  const sat = await makeSat({ maxRunSeconds: 0.8 });
  const reasons = () => sat.events.filter((x) => x.name === 'run-stop').map((x) => x.e.reason);
  const c = await ha(sat);
  await c.takeSatellite();
  await until('mic on', () => sat.micStatus().on);

  sat.startRun();
  c.send('error', { text: 'nothing heard', code: 'stt-no-text-recognized' });
  await until('error stop', () => reasons().length === 1);
  const stop = sat.events.find((x) => x.name === 'run-stop').e;
  assert.deepEqual([stop.reason, stop.error.code], ['error', 'stt-no-text-recognized']);

  sat.startRun();
  c.send('pause-satellite');
  await until('pause stop', () => reasons().length === 2);
  c.send('run-satellite');
  await until('resumed', () => sat.names().includes('resumed'));

  sat.startRun();
  await until('timeout stop', () => reasons().length === 3, 3000);
  await c.waitFor('audio-stop');

  sat.startRun();
  c.close();
  await until('disconnect stop', () => reasons().length === 4);
  assert.deepEqual(reasons(), ['error', 'paused', 'timeout', 'disconnected']);
});

test('a second mic follower gets the same audio as the run', async () => {
  const sat = await makeSat();
  const c = await ha(sat);
  await c.takeSatellite();
  await until('mic on', () => sat.micStatus().on);
  let other = 0;
  const stop = sat.followMic((b) => { other += b.length; });
  sat.startRun();
  await sleep(600);
  const toHa = c.of('audio-chunk').reduce((n, e) => n + e.payload.length, 0);
  stop();
  assert.ok(other >= 10000, `follower got ${other}`);
  assert.ok(toHa + 2048 >= other, 'HA got the buffer plus at least what the follower got live');
  const after = other; await sleep(150);
  assert.equal(other, after);
});

test('mic restarts (output change, stream lost, tv off and on) are reported as mic-status events', async () => {
  const sat = await makeSat();
  const states = () => sat.events.filter((x) => x.name === 'mic-status').map((x) => x.e);
  await until('on', () => states().some((s) => s.on));

  tv.setState({ output: 'external_arc' });
  await until('output restart', () => states().some((s) => s.on && s.output === 'external_arc'));
  assert.ok(sat.micStatus().restarts >= 1);

  const r = sat.micStatus().restarts;
  tv.setState({ die: true });
  await until('lost', () => !sat.micStatus().on);
  tv.setState({ die: false });
  await until('back', () => sat.micStatus().on);
  assert.ok(sat.micStatus().restarts > r);

  tv.setState({ power: 'Active Standby' });
  await until('tv off', () => !sat.micStatus().on);
  tv.setState({ power: 'Active' });
  await until('tv on', () => sat.micStatus().on);
  assert.ok(states().filter((s) => !s.on).length >= 3);
});

test('a run ends with mic-lost when the microphone stream goes away', async () => {
  const sat = await makeSat();
  const c = await ha(sat);
  await c.takeSatellite();
  await until('mic on', () => sat.micStatus().on);
  sat.startRun();
  tv.setState({ output: 'external_arc' });
  await until('run-stop', () => sat.names().includes('run-stop'));
  assert.equal(sat.events.find((x) => x.name === 'run-stop').e.reason, 'mic-lost');
});

test('mic settings can be changed while running', async () => {
  const sat = await makeSat();
  await until('mic on', () => sat.micStatus().on);
  sat.configure({ micChannel: 2, micGainDb: 0 });
  sat.clearMic();
  let got = [];
  const stop = sat.followMic((b) => got.push(...samples(b)));
  await sleep(300);
  stop();
  assert.ok(got.length && got.every((v) => v === 3000));
});

test('garbage on the socket closes that connection only', async () => {
  const sat = await makeSat();
  const good = await ha(sat);
  await good.takeSatellite();
  const bad = await ha(sat);
  bad.sock.write('this is not wyoming\n');
  await bad.waitClosed();
  good.send('ping', { text: 'still here' });
  await good.waitFor('pong');
});

test('stop() closes connections and the mic', async () => {
  const sat = await makeSat();
  const c = await ha(sat);
  await c.takeSatellite();
  await until('mic on', () => sat.micStatus().on);
  await sat.stop();
  await c.waitClosed();
  assert.equal(sat.micStatus().on, false);
});

test('startMic: false keeps the mic closed at start; setMic(true/false) opens and closes it', async () => {
  const before = tv.count('voiceinput/startStreaming');
  const sat = await makeSat({ startMic: false });
  await sleep(400);
  assert.equal(sat.micStatus().on, false);
  assert.equal(tv.count('voiceinput/startStreaming'), before, 'the mic never opened at boot');
  sat.setMic(true);
  await until('mic on', () => sat.micStatus().on);
  sat.setMic(true);   // twice is harmless
  sat.setMic(false);
  await until('mic off', () => !sat.micStatus().on);
  assert.equal(sat.status().mic.on, false);
});

test('setMic(false) ends a running run with mic-lost', async () => {
  const sat = await makeSat();
  const c = await ha(sat);
  c.send('run-satellite');
  await until('mic', () => sat.micStatus().on);
  await until('connected', () => sat.names().includes('connected'));
  assert.equal(sat.startRun().started, true);
  sat.setMic(false);
  await until('run-stop', () => sat.names().includes('run-stop'));
  assert.equal(sat.events.find((x) => x.name === 'run-stop').e.reason, 'mic-lost');
});
