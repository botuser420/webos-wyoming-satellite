'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { startService } = require('../src/service');
const { createFakeTv } = require('./helpers/fake-tv');
const { createFakePacat } = require('./helpers/fake-pacat');
const { FakeHa } = require('./helpers/fake-ha');
const { sleep, until } = require('./helpers/util');

const tv = createFakeTv();
const sink = createFakePacat();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wws-service-'));
test.after(() => { tv.cleanup(); sink.cleanup(); fs.rmSync(dir, { recursive: true, force: true }); });

function configFile(extra = {}) {
  const f = path.join(dir, 'config-' + Math.random().toString(36).slice(2) + '.json');
  fs.writeFileSync(f, JSON.stringify({
    port: 0, host: '127.0.0.1', allowedHosts: ['127.0.0.1'], name: 'Test TV', duckLevel: 70,
    mic: { gainDb: 20, bufferSeconds: 1 },
    advanced: { lunaSend: tv.lunaSend, pacat: sink.pacat, micPollMs: 100, micRestartMs: 100, holdMs: 150 },
    ...extra,
  }));
  return f;
}
const running = [];
test.afterEach(async () => { await Promise.all(running.splice(0).map((s) => s.stop())); await sleep(150); });

test('the service starts from the config file alone and answers Home Assistant', async () => {
  const lines = [];
  const svc = await startService({ configPath: configFile(), log: (l, m) => lines.push(m) });
  running.push(svc);
  const c = await FakeHa.connect(svc.satellite.port);
  c.send('describe');
  const info = (await c.waitFor('info')).data;
  assert.equal(info.satellite.name, 'Test TV');
  c.close();
  assert.ok(lines.some((l) => /listening on 127\.0\.0\.1/.test(l)));
});

test('alwaysListen is on by default: the connected satellite streams from the wake stage', async () => {
  const svc = await startService({ configPath: configFile(), log: () => {} });
  running.push(svc);
  const c = await FakeHa.connect(svc.satellite.port);
  c.send('run-satellite');
  assert.equal((await c.waitFor('run-pipeline')).data.start_stage, 'wake');
  c.close();
});

test('the duck level from the config is applied at start', async () => {
  const svc = await startService({ configPath: configFile(), log: () => {} });
  running.push(svc);
  await until('duck level', () => svc.satellite.status().duckLevel === 70);
});

test('an empty allowedHosts is allowed but warned about', async () => {
  const lines = [];
  const svc = await startService({ configPath: configFile({ allowedHosts: [] }), log: (l, m) => lines.push(l + ' ' + m) });
  running.push(svc);
  assert.ok(lines.some((l) => /allowedHosts is empty/.test(l)), lines.join('\n'));
});

test('the log level filters what is written', async () => {
  const lines = [];
  const svc = await startService({ configPath: configFile({ logLevel: 'warn', allowedHosts: [] }), log: (l, m) => lines.push(l + ' ' + m) });
  running.push(svc);
  assert.ok(lines.length > 0 && lines.every((l) => /^(warn|error) /.test(l)), lines.join('\n'));
});

const bin = path.join(__dirname, '..', 'bin', 'webos-wyoming-satellite.js');
function runBin(args, env = {}) {
  const p = spawn(process.execPath, [bin, ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  p.out = ''; p.err = '';
  p.stdout.on('data', (d) => { p.out += d; });
  p.stderr.on('data', (d) => { p.err += d; });
  p.done = new Promise((r) => p.on('close', (code, signal) => r({ code, signal })));
  return p;
}

test('bin: a broken config exits with code 2 and says what is wrong, without starting anything', async () => {
  const f = path.join(dir, 'broken.json');
  fs.writeFileSync(f, JSON.stringify({ port: 'ten', allowedHosts: ['not-an-ip'] }));
  const p = runBin(['--config', f]);
  const { code } = await p.done;
  assert.equal(code, 2);
  assert.match(p.err, /broken\.json/);
  assert.match(p.err, /port/);
  assert.match(p.err, /allowedHosts\[0\]/);
});

test('bin: --check validates and exits 0; a missing file exits 2', async () => {
  const ok = runBin(['--check', '--config', configFile()]);
  assert.equal((await ok.done).code, 0);
  assert.match(ok.out, /config ok/i);
  const missing = runBin(['--config', path.join(dir, 'nope.json')]);
  assert.equal((await missing.done).code, 2);
  assert.match(missing.err, /nope\.json/);
});

test('bin: the config path comes from --config, then the environment variable; SIGTERM stops it cleanly', async () => {
  const p = runBin([], { WEBOS_WYOMING_SATELLITE_CONFIG: configFile() });
  await until('listening', () => /listening on/.test(p.err + p.out), 6000);
  p.kill('SIGTERM');
  assert.equal((await p.done).code, 0);
});

test('bin: --help and --version', async () => {
  const h = runBin(['--help']);
  assert.equal((await h.done).code, 0);
  assert.match(h.out, /--config/);
  const v = runBin(['--version']);
  await v.done;
  assert.equal(v.out.trim(), require('../package.json').version);
});
