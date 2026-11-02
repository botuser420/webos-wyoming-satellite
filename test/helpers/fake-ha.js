'use strict';
/* A fake Home Assistant Wyoming client over a real TCP socket. */
const net = require('node:net');
const { encode, Parser } = require('../../src/wyoming');
const { until } = require('./util');

class FakeHa {
  constructor() { this.events = []; this.closed = false; this.times = []; }

  static connect(port, opts = {}) {
    const ha = new FakeHa();
    return new Promise((resolve, reject) => {
      ha.sock = net.connect({ port, host: '127.0.0.1', localAddress: opts.localAddress }, () => resolve(ha));
      ha.sock.on('error', (e) => { ha.error = e; if (!ha.sock.connecting) return; reject(e); });
      ha.sock.on('close', () => { ha.closed = true; });
      const parser = new Parser((e) => { ha.times.push(Date.now()); ha.events.push(e); });
      ha.sock.on('data', (b) => parser.push(b));
    });
  }

  send(type, data, payload) { this.sock.write(encode(type, data, payload)); }
  types() { return this.events.map((e) => e.type); }
  of(type) { return this.events.filter((e) => e.type === type); }
  async waitFor(type, n = 1, ms = 3000) {
    await until(`event ${type} x${n}`, () => this.of(type).length >= n, ms);
    return this.of(type)[n - 1];
  }
  close() { this.sock.destroy(); }
  async waitClosed(ms = 2000) { await until('connection closed', () => this.closed, ms); }

  // What HA sends when it takes a satellite: run-satellite, describe.
  async takeSatellite() {
    this.send('run-satellite');
    this.send('describe');
    await this.waitFor('info');
  }
}

module.exports = { FakeHa };
