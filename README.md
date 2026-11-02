# webos-wyoming-satellite

A [Wyoming](https://github.com/OHF-Voice/wyoming) satellite for rooted LG webOS TVs. Home Assistant
connects to the TV and sees an `assist_satellite`, fed by the TV's own microphone (`internal1`).
It is a Node library (and, in later releases, a standalone service).

Status: early. This version provides the Wyoming server and the microphone. Playing answers and
announcements on the TV (ticket "playback") is not in it yet.

## Requirements

- An LG webOS TV with root access (the library calls `luna-send` and reads the voice-input socket).
- Node 20.12 or newer on the TV. No npm, no dependencies: Node built-ins only. The code is
  CommonJS (`require`), so it also loads from a plain script on a TV without a package manager.
- Home Assistant with the Wyoming integration (add the TV by host and port). For a wake word in
  Home Assistant, run openWakeWord there; this library does not detect wake words itself.

## Install and use

Copy the directory to the TV (or add it as a git submodule) and:

```js
const { Satellite } = require('./webos-wyoming-satellite');

const sat = new Satellite({
  port: 10700,
  allowedHosts: ['192.0.2.10'],       // the address of Home Assistant
  name: 'Living room TV',
  micChannel: 0, micGainDb: 15, bufferSeconds: 2,
  log: (level, message) => console.log(level, message),
});

sat.on('connected', ({ address }) => {});
sat.on('run-stop', ({ reason }) => {});
await sat.start();

// when something else heard the wake word:
const r = sat.startRun();             // { started: true } or { started: false, reason }
```

## Security: `allowedHosts`

The Wyoming protocol has no authentication. `allowedHosts` is the only gate: a list of IP
addresses (exact match; IPv4-mapped IPv6 addresses are compared as IPv4). A connection from any
other address is closed and logged with its address (`log('warn', 'refused connection from ...')`,
event `refused`). **An empty list lets every device on the network in** and logs a warning at
`start()` (event `warning`): any device on your LAN could open the TV microphone.

## API

Everything is exported from the package root: `Satellite` (plus `Mic`, `createLuna`, `wyoming`
for building blocks and tests). `Satellite` is an `EventEmitter`.

### Options (`new Satellite(options)`)

| option | default | meaning |
|---|---|---|
| `port` | `10700` | TCP port HA connects to (`0` = pick a free one, see `sat.port`) |
| `host` | `'0.0.0.0'` | listen address |
| `allowedHosts` | `[]` | IPs allowed to connect; empty = open, with a warning |
| `name` | `'webOS TV'` | satellite and device name shown in HA |
| `area` | `null` | suggested HA area |
| `micChannel` | `0` | which of the 5 mic channels (0-4) |
| `micGainDb` | `15` | gain in dB (-20..40) |
| `bufferSeconds` | `2` | pre-wake-word buffer kept in memory (0..10 s), sent first by `startRun` |
| `micPollMs` | `3000` | how often the power state and sound output are read |
| `micRestartMs` | `5000` | pause before reopening a lost mic stream |
| `micKeepAliveMs` | `4000` | `restartTimer` interval (the TV ends a silent stream after ~10 s); 0 = off |
| `maxRunSeconds` | `15` | safety limit for the audio of one run |
| `chunkBytes` | `2048` | size of the `audio-chunk` payloads sent to HA |
| `lunaSend` | `/usr/bin/luna-send` | path of `luna-send` (tests point this at a fake) |
| `log` | stderr | `log(level, message)`, level `info`, `warn` or `error` |

Reserved for the playback ticket (not implemented yet): wake and end sounds, duck level, warm-up limits.

### Commands

- `await sat.start()` / `await sat.stop()`: listen and start the mic / close everything.
- `sat.startRun()` returns `{ started: true }` or `{ started: false, reason }` with reason
  `not-connected`, `paused`, `run-active` or `mic-off`. A run sends `run-pipeline`
  (`start_stage: asr`, `end_stage: tts`), the buffer, then live audio (16 kHz, 16-bit, mono).
- `sat.stopRun()` ends the audio (sends `audio-stop`); returns false when no run is active.
- `sat.followMic(fn)` calls `fn(Buffer)` for every processed mic chunk and returns a function to
  stop. Several followers get the same audio (for other mic users next to the satellite).
- `sat.configure({ micChannel, micGainDb, bufferSeconds })` changes mic settings while running;
  out-of-range values keep the old one. `sat.clearMic()` empties the buffer.
- `sat.status()` is `{ listening, connected, paused, running, mic }`; `sat.micStatus()` is
  `{ on, output, since, restarts, bufferMs }`.
- Planned for the playback ticket: `warmUp`, `stopWarmUp`, `play(stream)`, announce handling.

### Events

| event | payload | when |
|---|---|---|
| `connected` | `{ address }` | Home Assistant took the satellite connection (`run-satellite`) |
| `disconnected` | `{ address, reason }` | it closed, or a newer connection replaced it (`replaced`) |
| `paused` / `resumed` | | HA muted (`pause-satellite`) / unmuted the satellite |
| `run-start` | `{ bufferMs }` | `startRun` began streaming |
| `run-stop` | `{ reason, error? }` | `transcript`, `error`, `paused`, `disconnected`, `mic-lost`, `timeout`, `backpressure`, `stopped` |
| `stt-start` / `stt-stop` | `{ language }` / `{ text }` | HA started / finished speech to text |
| `voice-start` / `voice-stop` | `{ timestamp }` | HA's speech detection heard speech start / end |
| `mic-status` | `{ on, output, since, restarts, bufferMs }` | the mic stream went on or off (output change, TV on/off, lost stream) |
| `refused` | `{ address }` | a connection outside `allowedHosts` |
| `warning` | `{ message }` | empty `allowedHosts` |
| `error` | `Error` | server error (only emitted when someone listens) |

Reserved for the playback ticket: `tts-start`, `tts-end`, `played`, `announce-start`, `announce-end`.

## How it behaves towards Home Assistant

- Home Assistant opens several connections: a short `describe`-only probe about every 30 s, and
  one long-lived satellite connection. A probe is answered and closed; it never takes over.
  The connection that sends `run-satellite` is the satellite; a new `run-satellite` from another
  connection replaces (and closes) a stale one.
- `ping` is answered with `pong` immediately, also while streaming; HA drops the connection after
  5 s of silence.
- Unknown events are ignored.

## Microphone behaviour

The mic runs while the TV is awake (Active, Screen Off, Screen Saver) and is closed otherwise;
the TV is never woken for it. It restarts when the sound output changes (speaker/ARC), when the
device list changes, when the stream is lost, and keeps the stream alive with `restartTimer`.

## Tests

```
npm test            # node --test test/*.test.js
```

No TV needed: the tests run a fake Home Assistant client over a real TCP socket and a fake
`luna-send` executable with a small TV model (power state, sound output, voice-input streams).

## License

MIT
