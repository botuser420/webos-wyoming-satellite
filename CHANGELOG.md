# Changelog

## 0.1.0

- Standalone service: `bin/webos-wyoming-satellite.js` runs from one JSON configuration file (`--config`, `--check`), with
  validation that reports every problem, and `init/webos-wyoming-satellite.sh` to start it at boot on a rooted TV.
- `alwaysListen`: continuous mic stream from the wake stage for a wake word detected in Home Assistant (event `wake`).
- `startMic` option and `setMic(on)`: the host decides when the microphone opens.
- `warmUp()` while already warm plays the wake sound again.
- `play(stream, { signal })`: an `AbortSignal` cancels that play only.
- Fix: stopping right after starting no longer leaves the duck guard running.

Earlier work in this release:

- Playback on `ptts`: `warmUp()` / `stopWarmUp()`, one continuous stream from warm-up to the end of the answer with a
  paced silence, wake and done sounds (WAV options), the answer of a run, `announce` from Home Assistant with `played`,
  `play(stream)`, and the events `warm-up-start/stop`, `tts-start/end`, `played`, `announce-start/end`, `no-answer`, `sink-lost`.
- Ducking by `TTSMixingRatio` only (`duckLevel`, `duckApps`) with a duck guard for apps that write their own value;
  the library never sets a volume.

- Wyoming server: `describe`/`info`, `ping`/`pong`, `run-satellite`/`pause-satellite`, `allowedHosts`.
- TV microphone (`internal1`) with pre-roll buffer, restart rules and `restartTimer`.
- `startRun()` / `stopRun()` / `followMic()` and the event set described in the README.
