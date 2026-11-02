'use strict';
/*
 * A fake `luna-send` executable with a tiny model of the tv: power state, sound output and
 * voiceinput streams. State lives in a JSON file the tests change with setState(); every call
 * is appended to a log. No tv, no real luna-send.
 *
 * Plain calls answer from the state. `startStreaming` and `getDevices` with subscribe stay
 * running like the real ones. A stream writes 5 channels of S16 at 16 kHz, channel c constantly
 * (c + 1) * 1000, 3200 bytes per 20 ms.
 *
 * Settings model: glob (global TTSMixingRatio, a string or null), apps (own per-app values), fg (foreground app id);
 * deleteSystemSettings clears the global and every per-app value, as the real service does.
 * State keys: power, output, stopGen (bumped by stopStreaming), die (running streams exit),
 * timeoutMs (a stream ends this long after start / the last restartTimer), lastRestart.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function createFakeTv(initial) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-tv-'));
  const stateFile = path.join(dir, 'state.json');
  const logFile = path.join(dir, 'log.jsonl');
  const lunaSend = path.join(dir, 'luna-send');

  const setState = (patch) => {
    const s = Object.assign(JSON.parse(fs.readFileSync(stateFile, 'utf8')), patch);
    fs.writeFileSync(stateFile + '.tmp', JSON.stringify(s));
    fs.renameSync(stateFile + '.tmp', stateFile);
  };
  const calls = () => (fs.existsSync(logFile)
    ? fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const count = (name) => calls().filter((c) => c.uri.endsWith(name)).length;

  fs.writeFileSync(stateFile, JSON.stringify(Object.assign({ power: 'Active', output: 'tv_speaker', stopGen: 0, glob: null, apps: {}, fg: 'com.webos.app.home' }, initial)));
  fs.writeFileSync(lunaSend, `#!/usr/bin/env node
const fs = require('fs'), net = require('net');
const dir = ${JSON.stringify(dir)};
const read = () => JSON.parse(fs.readFileSync(dir + '/state.json', 'utf8'));
const write = (n) => { const f = dir + '/state.json'; fs.writeFileSync(f + '.t' + process.pid, JSON.stringify(n)); fs.renameSync(f + '.t' + process.pid, f); };
const uri = process.argv[process.argv.length - 2].replace('luna://', '');
const payload = JSON.parse(process.argv[process.argv.length - 1]);
fs.appendFileSync(dir + '/log.jsonl', JSON.stringify({ uri, payload, t: Date.now() }) + '\\n');
const out = (o) => console.log(JSON.stringify(o));
const devices = (s) => [{ deviceType: 'internal', id: 'internal1', deviceName: 'preprocessed' },
  s.output === 'external_arc' ? { deviceType: 'sound', id: 'sound2', deviceName: 'mixExt' } : { deviceType: 'sound', id: 'sound1', deviceName: 'mixInt' }];
const s = read();
if (uri.endsWith('getPowerState')) out({ returnValue: true, state: s.power });
else if (uri.endsWith('master/getVolume')) out({ returnValue: true, volumeStatus: { soundOutput: s.output, volume: 5 } });
else if (uri.endsWith('voiceinput/getDevices')) {
  let last = JSON.stringify(devices(s));
  out({ subscribed: true, returnValue: true, devices: devices(s) });
  setInterval(() => { const d = JSON.stringify(devices(read())); if (d !== last) { last = d; out({ returnValue: true, devices: JSON.parse(d) }); } }, 50);
} else if (uri.endsWith('voiceinput/startStreaming')) {
  const t0 = Date.now(), gen = s.stopGen || 0, sock = dir + '/internal1.' + process.pid + '.soc';
  const clients = [];
  const srv = net.createServer((c) => clients.push(c)).listen(sock, () => {
    out({ subscribed: true, returnValue: true, socketPath: sock });
    out({ returnValue: true, id: 'internal1', state: 'voice start' });
  });
  const frame = Buffer.alloc(3200);
  for (let i = 0; i < 320; i++) for (let c = 0; c < 5; c++) frame.writeInt16LE((c + 1) * 1000, i * 10 + c * 2);
  const stop = () => { out({ returnValue: true, id: 'internal1', state: 'voice stop' }); clients.forEach((c) => c.destroy()); srv.close(); process.exit(0); };
  setInterval(() => {
    clients.forEach((c) => c.write(frame));
    const n = read();
    if ((n.stopGen || 0) !== gen) stop();
    if (n.die) { clients.forEach((c) => c.destroy()); process.exit(0); }
    if (n.timeoutMs && Date.now() - Math.max(t0, n.lastRestart || 0) > n.timeoutMs) {
      out({ reason: 'timeout occurs', returnValue: true, id: 'internal1', state: 'voice stop' });
      clients.forEach((c) => c.destroy()); process.exit(0);
    }
  }, 20);
} else if (uri.endsWith('voiceinput/restartTimer')) {
  const n = read(); n.lastRestart = Date.now(); write(n); out({ returnValue: true });
} else if (uri.endsWith('voiceinput/stopStreaming')) {
  const n = read(); n.stopGen = (n.stopGen || 0) + 1; write(n);
  out({ returnValue: true, id: 'internal1', state: 'voice stop' });
} else if (uri.endsWith('getSystemSettings')) {
  const v = payload.app_id && payload.app_id in s.apps ? s.apps[payload.app_id] : s.glob;
  if (v === null || v === undefined) out({ returnValue: false, errorText: 'There is no matched result from DB' });
  else out({ returnValue: true, category: 'sound', settings: { TTSMixingRatio: v } });
} else if (uri.endsWith('setSystemSettings')) {
  if (payload.app_id) s.apps[payload.app_id] = payload.settings.TTSMixingRatio; else s.glob = payload.settings.TTSMixingRatio;
  write(s); out({ returnValue: true });
} else if (uri.endsWith('deleteSystemSettings')) {
  s.glob = null; s.apps = {}; write(s); out({ returnValue: true });
} else if (uri.endsWith('getForegroundAppInfo')) {
  let last = s.fg;
  out({ returnValue: true, subscribed: true, appId: last });
  setInterval(() => { const n = read().fg; if (n !== last) { last = n; out({ returnValue: true, subscribed: true, appId: n }); } }, 30);
} else out({ returnValue: false, errorText: 'unknown ' + uri });
`, { mode: 0o755 });

  return { dir, lunaSend, setState, calls, count, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

module.exports = { createFakeTv };
