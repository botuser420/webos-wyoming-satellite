'use strict';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, fn, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return; await sleep(25); }
  throw new Error(`${what}: not within ${ms / 1000} s`);
}
const samples = (b) => { const a = []; for (let i = 0; i + 2 <= b.length; i += 2) a.push(b.readInt16LE(i)); return a; };
module.exports = { sleep, until, samples };
