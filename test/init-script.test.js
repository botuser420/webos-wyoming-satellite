'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { sleep, until } = require('./helpers/util');

const script = path.join(__dirname, '..', 'init', 'webos-wyoming-satellite.sh');
const sh = (args, env) => spawnSync('sh', [script, ...args], { env: { ...process.env, ...env }, encoding: 'utf8' });

test('the boot script is valid shell and executable', () => {
  assert.equal(spawnSync('sh', ['-n', script]).status, 0);
  assert.ok(fs.statSync(script).mode & 0o100);
});

test('the boot script starts the service from a config, reports status, and stops it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wws-init-'));
  try {
    const cfg = path.join(dir, 'config.json');
    fs.writeFileSync(cfg, JSON.stringify({ port: 0, host: '127.0.0.1', allowedHosts: ['127.0.0.1'], advanced: { lunaSend: '/nonexistent/luna-send', micPollMs: 5000 } }));
    const env = { WWS_DIR: path.join(__dirname, '..'), WWS_CONFIG: cfg, WWS_LOG: path.join(dir, 'log'), WWS_RUN: dir, WWS_NODE: process.execPath };
    assert.equal(sh([], env).status, 0);
    await until('log', () => fs.existsSync(env.WWS_LOG) && /listening on/.test(fs.readFileSync(env.WWS_LOG, 'utf8')), 6000);
    assert.match(sh(['status'], env).stdout, /running/);
    assert.match(sh([], env).stdout, /already running/);
    assert.match(sh(['stop'], env).stdout, /stopped/);
    await sleep(300);
    assert.equal(sh(['status'], env).status, 1);
  } finally {
    sh(['stop'], { WWS_RUN: dir });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a rejected configuration is not restarted in a loop', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wws-init-'));
  try {
    const cfg = path.join(dir, 'config.json');
    fs.writeFileSync(cfg, JSON.stringify({ port: 'x' }));
    const env = { WWS_DIR: path.join(__dirname, '..'), WWS_CONFIG: cfg, WWS_LOG: path.join(dir, 'log'), WWS_RUN: dir, WWS_NODE: process.execPath };
    sh([], env);
    await until('rejected', () => fs.existsSync(env.WWS_LOG) && /not restarting/.test(fs.readFileSync(env.WWS_LOG, 'utf8')), 6000);
    await sleep(200);
    assert.equal(sh(['status'], env).status, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
