# webos-wyoming-satellite

A [Wyoming](https://github.com/OHF-Voice/wyoming) satellite for rooted LG webOS TVs. Home Assistant
connects to the TV and sees an `assist_satellite`, fed by the TV's own microphone (`internal1`).
It is a Node library (and, in later releases, a standalone service).

Status: early. This version provides the Wyoming server, the microphone, and playing answers and
announcements on the TV with ducking of the running programme.

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

Everything is exported from the package root: `Satellite` (plus `Mic`, `Player`, `createLuna`, `wyoming`,
`pcm`, `duck` for building blocks and tests). `Satellite` is an `EventEmitter`.

### Options (`new Satellite(options)`)

| option | default | meaning |
|---|---|---|
| `port` | `10700` | TCP port HA connects to (`0` = pick a free one, see `sat.port`) |
| `host` | `'0.0.0.0'` | listen address |
| `allowedHosts` | `[]` | IPs allowed to connect; empty = open, with a warning |
| `name` | `'webOS TV'` | satellite and device name shown in HA |
| `area` | `null` | suggested HA area |
| `startMic` | `true` | open the microphone at `start()`; `false` leaves it closed until `setMic(true)` |
| `alwaysListen` | `false` | stream the mic continuously and let Home Assistant run the wake word (see below); `startRun` is then not available |
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
| `wakeSound` | `null` | WAV file (path or Buffer, 16-bit PCM, any rate) written into the stream at the start of a warm-up |
| `doneSound` | `null` | WAV file written into the stream by `stopWarmUp({ done: true })` |
| `wakeSoundMaxDelayMs` | `500` | no wake sound when the warm-up starts later than this after the `warmUp()` call (a late sound lands in the command) |
| `duckLevel` | `null` | percent (0-100) the foreground app is turned down to while anything plays; `null` = do not touch the tv settings |
| `duckApps` | `[]` | app ids whose own ducking value is checked by the duck guard (the foreground app is always checked) |
| `warmUpMaxSeconds` | `15` | longest warm-up; a call's `maxSeconds` can only shorten it |
| `answerTimeoutSeconds` | `10` | how long after a run (or its transcript) audio from Home Assistant still counts as its answer |
| `holdMs` | `350` | the sink stays open this long after the last sound or warm-up, so the programme does not jump back before the receiver is ready |
| `maxQueueSeconds` | `120` | audio from Home Assistant queued further ahead than this is dropped |
| `pacat` | `/usr/bin/pacat` | path of `pacat` (tests point this at a fake) |
| `sink` | `ptts` | PulseAudio sink for voice |
| `playLeadMs` | `120` | how far ahead of the play clock audio is written; sounds start at most this late |
| `duckPollMs`, `duckAfterMs`, `duckWaitMs`, `duckMinMs` | `60000`, `3000`, `1000`, `10000` | duck guard timing: periodic check, check after a foreground change, retry while audio plays, minimum gap between warm-up checks |

### Commands

- `await sat.start()` / `await sat.stop()`: listen and start the mic / close everything.
- `sat.startRun()` returns `{ started: true }` or `{ started: false, reason }` with reason
  `not-connected`, `paused`, `run-active` or `mic-off`. A run sends `run-pipeline`
  (`start_stage: asr`, `end_stage: tts`), the buffer, then live audio (16 kHz, 16-bit, mono).
- `sat.stopRun()` ends the audio (sends `audio-stop`); returns false when no run is active.
- `sat.followMic(fn)` calls `fn(Buffer)` for every processed mic chunk and returns a function to
  stop. Several followers get the same audio (for other mic users next to the satellite).
- `sat.configure({ micChannel, micGainDb, bufferSeconds, duckLevel })` changes these settings while running;
  out-of-range values keep the old one. `sat.clearMic()` empties the buffer.
- `sat.status()` is `{ listening, wakeStream, connected, paused, running, mic, warm, playing, duckLevel }`; `sat.micStatus()` is
  `{ on, output, since, restarts, bufferMs }`.
- `await sat.warmUp({ maxSeconds, wakeSound })` plays silence on `ptts` (ducking), with the wake sound first; resolves
  `{ started: true }` or `{ started: false, reason }` (`tv-off`, `sink-lost`, or the luna error). Calling it again
  while warm moves the limit and plays the wake sound again (unless `wakeSound: false`), so a new wake word during the
  hold still gets its ping. It works without a run of its own.
- `sat.stopWarmUp({ done })` ends it (with `done: true` the done sound is written first); returns false when none runs.
- `await sat.play(bufferOrStream, { format, signal })` plays raw s16le audio (`format`: `{ rate, width: 2, channels }`, default
  44100 Hz mono) and resolves `{ ok }` when it has been heard. Abort the optional `signal` (`AbortSignal`) to cancel: that
  play's queued audio is dropped (other audio is untouched), a stream stops being read, and it resolves
  `{ ok: false, aborted: true }`. Roughly `playLeadMs` of audio already written to the sink still sounds.
- `sat.setMic(on)` opens or closes the microphone (a running run ends with `mic-lost`). Use it with `startMic: false`.

### Events

| event | payload | when |
|---|---|---|
| `connected` | `{ address }` | Home Assistant took the satellite connection (`run-satellite`) |
| `disconnected` | `{ address, reason }` | it closed, or a newer connection replaced it (`replaced`) |
| `paused` / `resumed` | | HA muted (`pause-satellite`) / unmuted the satellite |
| `run-start` | `{ bufferMs }` | `startRun` began streaming |
| `run-stop` | `{ reason, error? }` | `transcript`, `error`, `paused`, `disconnected`, `mic-lost`, `timeout`, `backpressure`, `stopped`, `announce` |
| `stt-start` / `stt-stop` | `{ language }` / `{ text }` | HA started / finished speech to text |
| `voice-start` / `voice-stop` | `{ timestamp }` | HA's speech detection heard speech start / end |
| `mic-status` | `{ on, output, since, restarts, bufferMs }` | the mic stream went on or off (output change, TV on/off, lost stream) |
| `refused` | `{ address }` | a connection outside `allowedHosts` |
| `warning` | `{ message }` | empty `allowedHosts` |
| `error` | `Error` | server error (only emitted when someone listens) |
| `warm-up-start` | `{ maxSeconds }` | the warm-up plays |
| `warm-up-stop` | `{ reason }` | `stopped`, `timeout` or `sink-lost` |
| `tts-start` | `{ text, voice }` | the audio of an answer begins to arrive |
| `tts-end` | | Home Assistant has sent all of the answer (it may still be playing) |
| `announce-start` | | an announcement begins to arrive |
| `played` | `{ kind, ok }` | the answer (`tts`) or announcement was heard and `played` went to Home Assistant; `ok` is false when the sink failed |
| `announce-end` | `{ ok }` | the announcement was heard (together with `played`) |
| `no-answer` | `{ transcript }` | no audio came for the run in `answerTimeoutSeconds` |
| `sink-lost` | `{ reason }` | `pacat` ended or failed |

## Sound and ducking

One `pacat` process on the `ptts` sink carries everything that is played: the warm-up silence, the wake sound, the
answer, the done sound, announcements and `play()` audio. It opens at the start of a warm-up (or at the first
sound) and closes `holdMs` after the last one, so the sink never goes idle in between. That keeps the programme
ducked and keeps an ARC path to a sound bar from dropping out.

- The silence is paced in Node. Piping `/dev/zero` into `pacat` would let it read ahead about 0.7 s, which delays
  the sounds written after it.
- Home Assistant sends audio (usually 22050 Hz, 16-bit mono) faster than real time. It is queued, converted to
  44100 Hz mono and played at its own pace; `played` goes back when the end has been heard.
- Ducking is only the system setting `TTSMixingRatio` (`duckLevel`): the tv lowers the foreground app by that
  percentage while `ptts` plays. At `start()` the global value is set and every per-app value cleared; the duck
  guard then checks the foreground app (and `duckApps`) and writes the level back for an app that has its own,
  deviating value. The library never changes the volume of the tv or the receiver (no `setVolume` call anywhere).
- Audio from Home Assistant is an answer when it follows a transcript or `synthesize` of a run started by
  `startRun()`; otherwise it is an announcement (`assist_satellite.announce`). An announcement that arrives while
  a run is still streaming cancels that run (`run-stop` with reason `announce`, no `audio-stop`).
- A warm-up ends on `stopWarmUp()`, on its maximum, when the answer or a cancelling announcement has been played,
  or when the sink is lost. A run whose answer never comes (for example when another satellite won) gets a
  `no-answer` event after `answerTimeoutSeconds`; the warm-up is then up to the host (`stopWarmUp()`) or its maximum.

## Wake word in Home Assistant (`alwaysListen`)

With `alwaysListen: true` the satellite sends `run-pipeline` from the `wake` stage with `restart_on_end` and streams the
microphone continuously once Home Assistant has taken the connection, the mic is on and the satellite is not muted.
Home Assistant runs the wake word (openWakeWord) on that stream. A `detection` from Home Assistant emits `wake`
({ name }) and starts the warm-up (ducking and wake sound); the answer then plays as usual and ends the warm-up. After
an `error` (for example no speech recognised) the warm-up ends and the satellite asks for a new pipeline. The stream
stops while muted or when the mic is lost, and restarts by itself.

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

No TV needed: the tests run a fake Home Assistant client over a real TCP socket, a fake
`luna-send` executable with a small TV model (power state, sound output, voice-input streams, the
`TTSMixingRatio` setting, the foreground app) and a fake `pacat` that records what is played and when.

## License

MIT
