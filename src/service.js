'use strict';
const { Satellite } = require('./satellite');
const { loadConfig } = require('./config');

const RANK = { info: 0, warn: 1, error: 2 };

function stderrLog(level, message) {
  process.stderr.write(new Date().toISOString() + ' ' + level + ' ' + message + '\n');
}

// Starts the satellite from a configuration file. `log(level, message)` defaults to stderr lines.
// Resolves { satellite, config, stop() }; rejects with a ConfigError (bad file) or the listen error.
async function startService({ configPath, log = stderrLog } = {}) {
  const { options, logLevel } = loadConfig(configPath);
  const min = RANK[logLevel];
  const satellite = new Satellite(Object.assign({}, options, {
    log: (level, message) => { if (RANK[level] >= min) log(level, message); },
  }));
  await satellite.start();
  return { satellite, config: options, stop: () => satellite.stop() };
}

module.exports = { startService };
