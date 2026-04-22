"use strict";

/**
 * router/circuit-breaker.js — per-provider health gate.
 *
 * States:
 *   CLOSED     normal operation; requests flow.
 *   OPEN       blocked; cooldown ticking. isAvailable() → false.
 *   HALF_OPEN  cooldown elapsed; allow exactly ONE probe in flight.
 *              Success → CLOSED, Failure → OPEN with renewed cooldown.
 *
 * Singleton-style: one Map<provider, state> per process. Tests can call
 * resetAll() to wipe state between cases.
 */

const THRESHOLD  = parseInt(process.env.ROUTER_BREAKER_THRESHOLD || "5", 10);
const COOLDOWN_MS = parseInt(process.env.ROUTER_BREAKER_COOLDOWN_MS || "30000", 10);

const STATES = Object.freeze({ CLOSED: "CLOSED", OPEN: "OPEN", HALF_OPEN: "HALF_OPEN" });

const _breakers = new Map();

function _get(provider) {
  let s = _breakers.get(provider);
  if (!s) {
    s = {
      state: STATES.CLOSED,
      failures: 0,
      lastFailureTs: 0,
      halfOpenProbeInFlight: false,
    };
    _breakers.set(provider, s);
  }
  return s;
}

function state(provider) {
  return _get(provider).state;
}

/**
 * Returns true if the caller may attempt a request against this provider.
 *
 * Side effect: if state is OPEN and cooldown has elapsed, transitions to
 * HALF_OPEN and reserves the probe slot — so the very next caller gets
 * the probe and any concurrent caller sees the slot already in flight.
 */
function isAvailable(provider) {
  const s = _get(provider);
  if (s.state === STATES.CLOSED) return true;
  if (s.state === STATES.OPEN) {
    if (Date.now() - s.lastFailureTs >= COOLDOWN_MS) {
      // Promote to half-open and hand out the single probe slot.
      s.state = STATES.HALF_OPEN;
      s.halfOpenProbeInFlight = true;
      return true;
    }
    return false;
  }
  // HALF_OPEN: allow only one probe concurrently.
  if (!s.halfOpenProbeInFlight) {
    s.halfOpenProbeInFlight = true;
    return true;
  }
  return false;
}

function recordSuccess(provider) {
  const s = _get(provider);
  s.failures = 0;
  s.halfOpenProbeInFlight = false;
  s.state = STATES.CLOSED;
}

function recordFailure(provider) {
  const s = _get(provider);
  s.lastFailureTs = Date.now();
  if (s.state === STATES.HALF_OPEN) {
    // Probe failed → re-open with renewed cooldown.
    s.halfOpenProbeInFlight = false;
    s.state = STATES.OPEN;
    return;
  }
  s.failures++;
  if (s.failures >= THRESHOLD) {
    s.state = STATES.OPEN;
  }
}

function snapshot() {
  const out = {};
  for (const [k, v] of _breakers.entries()) {
    out[k] = { ...v };
  }
  return out;
}

function resetAll() {
  _breakers.clear();
}

function reset(provider) {
  _breakers.delete(provider);
}

module.exports = {
  STATES,
  THRESHOLD,
  COOLDOWN_MS,
  isAvailable,
  recordSuccess,
  recordFailure,
  state,
  snapshot,
  resetAll,
  reset,
};
