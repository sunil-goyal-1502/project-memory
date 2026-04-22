#!/usr/bin/env node
"use strict";

/**
 * Entry point — runs server.js in foreground.
 */

const { start } = require('./server.js');
const wire = require('./wire.js');

wire.install();

start().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Failed to start ai-router:', err && err.stack || err);
  process.exit(1);
});

function shutdown(sig) {
  // eslint-disable-next-line no-console
  console.log(`\nReceived ${sig}, shutting down.`);
  process.exit(0);
}
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
