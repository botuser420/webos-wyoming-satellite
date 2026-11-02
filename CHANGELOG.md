# Changelog

## Unreleased

- Playback on `ptts`: `warmUp()` / `stopWarmUp()`, one continuous stream from warm-up to the end of the answer with a
  paced silence, wake and done sounds (WAV options), the answer of a run, `announce` from Home Assistant with `played`,
  `play(stream)`, and the events `warm-up-start/stop`, `tts-start/end`, `played`, `announce-start/end`, `no-answer`, `sink-lost`.
- Ducking by `TTSMixingRatio` only (`duckLevel`, `duckApps`) with a duck guard for apps that write their own value;
  the library never sets a volume.

- Wyoming server: `describe`/`info`, `ping`/`pong`, `run-satellite`/`pause-satellite`, `allowedHosts`.
- TV microphone (`internal1`) with pre-roll buffer, restart rules and `restartTimer`.
- `startRun()` / `stopRun()` / `followMic()` and the event set described in the README.
