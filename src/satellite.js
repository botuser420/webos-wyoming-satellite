'use strict';
const net = require('node:net');
const { EventEmitter } = require('node:events');
const { encode, Parser } = require('./wyoming');
const { createLuna } = require('./luna');
const { Mic } = require('./mic');
const pkg = require('../package.json');

const MIC_FORMAT = { rate: 16000, width: 2, channels: 1 };
const MAX_QUEUED_BYTES = 4 * 1024 * 1024;

function normalizeAddress(a) {
  return String(a || '').replace(/^::ffff:/i, '');
}

class Satellite extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.opts = {
      port: 10700,
      host: '0.0.0.0',
      allowedHosts: [],
      name: 'webOS TV',
      area: null,
      maxRunSeconds: 15,
      chunkBytes: 2048,
      ...opts,
    };
    this.log = (level, msg) => (opts.log || defaultLog)(level, msg);
    this.allowed = new Set((this.opts.allowedHosts || []).map(normalizeAddress));
    this.luna = createLuna({ lunaSend: opts.lunaSend });
    this.mic = new Mic({
      luna: this.luna,
      log: (m) => this.log('info', m),
      channel: opts.micChannel,
      gainDb: opts.micGainDb,
      bufferSeconds: opts.bufferSeconds,
      pollMs: opts.micPollMs,
      restartMs: opts.micRestartMs,
      keepAliveMs: opts.micKeepAliveMs,
      onChange: (s) => {
        if (!s.on) this.endRun('mic-lost', { tell: false });
        this.emit('mic-status', s);
      },
    });
    this.server = null;
    this.conns = new Set();
    this.owner = null;      // the connection that ran `run-satellite`
    this.paused = false;
    this.run = null;        // { conn, unfollow, timer, pending, sent }
  }

  get port() { return this.server ? this.server.address().port : this.opts.port; }

  // Listens, warns about an open port, starts the microphone.
  start() {
    if (this.allowed.size === 0) {
      const msg = 'allowedHosts is empty: any device on the network can connect and open the microphone';
      this.log('warn', msg);
      this.emit('warning', { message: msg });
    }
    this.server = net.createServer((sock) => this.accept(sock));
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.opts.port, this.opts.host, () => {
        this.server.removeListener('error', reject);
        this.server.on('error', (e) => this.fail(e));
        this.log('info', 'listening on ' + this.opts.host + ':' + this.port);
        this.mic.start();
        resolve();
      });
    });
  }

  async stop() {
    this.endRun('stopped', { tell: false });
    this.mic.stop();
    for (const c of this.conns) c.sock.destroy();
    if (this.server) {
      const s = this.server;
      this.server = null;
      await new Promise((r) => s.close(r));
    }
  }

  // ---- commands from the host ----

  startRun() {
    if (!this.owner) return { started: false, reason: 'not-connected' };
    if (this.paused) return { started: false, reason: 'paused' };
    if (this.run) return { started: false, reason: 'run-active' };
    if (!this.mic.status().on) return { started: false, reason: 'mic-off' };
    const conn = this.owner;
    const buffer = this.mic.take();
    const run = this.run = { conn, unfollow: null, timer: null, pending: Buffer.alloc(0), sentBytes: 0 };
    this.write(conn, 'run-pipeline', { start_stage: 'asr', end_stage: 'tts', restart_on_end: false });
    this.write(conn, 'audio-start', Object.assign({ timestamp: 0 }, MIC_FORMAT));
    this.stream(run, buffer);
    run.unfollow = this.mic.follow((b) => this.stream(run, b));
    run.timer = setTimeout(() => this.endRun('timeout'), this.opts.maxRunSeconds * 1000);
    this.emit('run-start', { bufferMs: Math.round(buffer.length / 32) });
    return { started: true };
  }

  stopRun() {
    if (!this.run) return false;
    this.endRun('stopped');
    return true;
  }

  // Calls fn(Buffer) with the processed microphone audio (S16 LE, 16 kHz, mono) until the returned function is called.
  followMic(fn) { return this.mic.follow(fn); }

  clearMic() { this.mic.clear(); }

  micStatus() { return this.mic.status(); }

  // Live settings: micChannel, micGainDb, bufferSeconds.
  configure(o) {
    this.mic.configure({ channel: o.micChannel, gainDb: o.micGainDb, bufferSeconds: o.bufferSeconds });
  }

  status() {
    return { listening: !!this.server, connected: !!this.owner, paused: this.paused, running: !!this.run, mic: this.mic.status() };
  }

  // ---- connections ----

  accept(sock) {
    const address = normalizeAddress(sock.remoteAddress);
    if (this.allowed.size && !this.allowed.has(address)) {
      this.log('warn', 'refused connection from ' + address + ' (not in allowedHosts)');
      this.emit('refused', { address });
      sock.destroy();
      return;
    }
    sock.setNoDelay(true);
    const conn = { sock, address };
    this.conns.add(conn);
    const parser = new Parser((ev) => this.onEvent(conn, ev));
    sock.on('data', (b) => {
      try { parser.push(b); } catch (e) {
        this.log('warn', 'dropping connection from ' + address + ': ' + e.message);
        sock.destroy();
      }
    });
    sock.on('error', () => {});
    sock.on('close', () => this.closed(conn));
  }

  closed(conn) {
    this.conns.delete(conn);
    if (this.owner !== conn) return;
    this.endRun('disconnected', { tell: false });
    this.owner = null;
    this.paused = false;
    this.emit('disconnected', { address: conn.address, reason: 'closed' });
  }

  write(conn, type, data, payload) {
    if (conn.sock.destroyed) return;
    conn.sock.write(encode(type, data, payload));
  }

  onEvent(conn, ev) {
    const d = ev.data || {};
    switch (ev.type) {
      case 'describe': return this.write(conn, 'info', this.info());
      case 'ping': return this.write(conn, 'pong', d.text === undefined ? {} : { text: d.text });
      case 'run-satellite': return this.claim(conn);
      default: break;
    }
    if (this.owner !== conn) return; // only the satellite connection drives anything else
    switch (ev.type) {
      case 'pause-satellite':
        if (!this.paused) {
          this.paused = true;
          this.endRun('paused', { tell: false });
          this.emit('paused', {});
        }
        break;
      case 'transcribe': this.emit('stt-start', { language: d.language }); break;
      case 'transcript':
        this.emit('stt-stop', { text: d.text === undefined ? '' : d.text });
        this.endRun('transcript', { tell: false });
        break;
      case 'voice-started': this.emit('voice-start', d); break;
      case 'voice-stopped': this.emit('voice-stop', d); break;
      case 'error':
        this.endRun('error', { tell: false, error: { text: d.text, code: d.code } });
        break;
      default: break; // unknown or not yet handled events are ignored, as HA does
    }
  }

  claim(conn) {
    if (this.owner && this.owner !== conn) {
      const old = this.owner;
      this.log('info', 'new satellite connection from ' + conn.address + ' replaces the one from ' + old.address);
      this.endRun('disconnected', { tell: false });
      this.owner = null;
      old.sock.destroy();
      this.conns.delete(old);
      this.emit('disconnected', { address: old.address, reason: 'replaced' });
    }
    if (!this.owner) {
      this.owner = conn;
      this.paused = false;
      this.log('info', 'satellite connection from ' + conn.address);
      this.emit('connected', { address: conn.address });
    } else if (this.paused) {
      this.paused = false;
      this.emit('resumed', {});
    }
  }

  info() {
    return {
      asr: [], tts: [], handle: [], intent: [], wake: [],
      mic: [{ name: 'internal1', description: 'webOS TV microphone', attribution: { name: '', url: '' }, installed: true, version: null, mic_format: MIC_FORMAT }],
      snd: [],
      satellite: {
        name: this.opts.name, description: 'webOS Wyoming satellite', attribution: { name: '', url: '' },
        installed: true, version: pkg.version, area: this.opts.area, has_vad: false, supports_trigger: false,
      },
    };
  }

  // ---- runs ----

  stream(run, buf) {
    if (this.run !== run) return;
    run.pending = run.pending.length ? Buffer.concat([run.pending, buf]) : buf;
    const size = this.opts.chunkBytes;
    while (run.pending.length >= size) this.chunk(run, run.pending.slice(0, size)), run.pending = run.pending.slice(size);
    if (run.conn.sock.writableLength > MAX_QUEUED_BYTES) this.endRun('backpressure', { tell: false });
  }

  chunk(run, payload) {
    const timestamp = Math.round(run.sentBytes / 32);
    run.sentBytes += payload.length;
    this.write(run.conn, 'audio-chunk', Object.assign({ timestamp }, MIC_FORMAT), payload);
  }

  // Ends the audio of the current run. `tell`: flush the rest and send audio-stop to HA.
  endRun(reason, o = {}) {
    const run = this.run;
    if (!run) return;
    this.run = null;
    clearTimeout(run.timer);
    if (run.unfollow) run.unfollow();
    if (o.tell !== false) {
      if (run.pending.length) this.chunk(run, run.pending);
      this.write(run.conn, 'audio-stop', { timestamp: Math.round(run.sentBytes / 32) });
    }
    const info = { reason };
    if (o.error) info.error = o.error;
    this.emit('run-stop', info);
  }

  fail(e) {
    this.log('error', String(e && e.message || e));
    if (this.listenerCount('error')) this.emit('error', e);
  }
}

function defaultLog(level, msg) {
  console.error('[webos-wyoming-satellite] ' + level + ': ' + msg);
}

module.exports = { Satellite };
