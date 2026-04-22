"use strict";

process.env.ROUTER_BREAKER_COOLDOWN_MS = "50";
process.env.ROUTER_BREAKER_THRESHOLD = "5";

const cb = require("../../router/circuit-breaker.js");
const { makeAssert, sleep } = require("./_mocks.js");

const A = makeAssert();

(async function main() {
  cb.resetAll();

  {
    cb.resetAll();
    A.eq(cb.state("anthropic"), "CLOSED", "initial state is CLOSED");
    A.ok(cb.isAvailable("anthropic"), "CLOSED allows traffic");

    for (let i = 0; i < 4; i++) cb.recordFailure("anthropic");
    A.eq(cb.state("anthropic"), "CLOSED", "still CLOSED after 4 failures");
    A.ok(cb.isAvailable("anthropic"), "still allows after 4 fails");

    cb.recordFailure("anthropic");
    A.eq(cb.state("anthropic"), "OPEN", "OPEN after 5th failure");
    A.ok(!cb.isAvailable("anthropic"), "OPEN denies traffic");
  }

  {
    cb.resetAll();
    for (let i = 0; i < 3; i++) cb.recordFailure("openai");
    cb.recordSuccess("openai");
    for (let i = 0; i < 4; i++) cb.recordFailure("openai");
    A.eq(cb.state("openai"), "CLOSED",
      "success in CLOSED resets failure counter");
  }

  {
    cb.resetAll();
    for (let i = 0; i < 5; i++) cb.recordFailure("ollama");
    A.eq(cb.state("ollama"), "OPEN", "OPEN after 5 fails");
    await sleep(80);
    A.ok(cb.isAvailable("ollama"), "after cooldown HALF_OPEN allows one probe");
    A.eq(cb.state("ollama"), "HALF_OPEN", "state is HALF_OPEN");
    A.ok(!cb.isAvailable("ollama"), "second concurrent probe denied");
  }

  {
    cb.resetAll();
    for (let i = 0; i < 5; i++) cb.recordFailure("anthropic");
    await sleep(80);
    cb.isAvailable("anthropic");
    cb.recordSuccess("anthropic");
    A.eq(cb.state("anthropic"), "CLOSED", "HALF_OPEN + success → CLOSED");
    A.ok(cb.isAvailable("anthropic"), "CLOSED allows traffic again");
  }

  {
    cb.resetAll();
    for (let i = 0; i < 5; i++) cb.recordFailure("openai");
    await sleep(80);
    cb.isAvailable("openai");
    cb.recordFailure("openai");
    A.eq(cb.state("openai"), "OPEN", "HALF_OPEN + failure → OPEN");
    A.ok(!cb.isAvailable("openai"), "back to OPEN denies traffic");
  }

  {
    cb.resetAll();
    for (let i = 0; i < 5; i++) cb.recordFailure("anthropic");
    A.eq(cb.state("anthropic"), "OPEN", "anthropic OPEN");
    A.eq(cb.state("openai"), "CLOSED", "openai unaffected");
    A.eq(cb.state("ollama"), "CLOSED", "ollama unaffected");
  }

  {
    cb.resetAll();
    for (let i = 0; i < 5; i++) cb.recordFailure("anthropic");
    cb.reset("anthropic");
    A.eq(cb.state("anthropic"), "CLOSED", "per-provider reset works");
    for (let i = 0; i < 5; i++) cb.recordFailure("openai");
    cb.resetAll();
    A.eq(cb.state("openai"), "CLOSED", "resetAll clears all");
  }

  {
    cb.resetAll();
    cb.recordFailure("anthropic");
    const snap = cb.snapshot();
    A.ok(snap && typeof snap === "object", "snapshot is object");
    A.ok("anthropic" in snap, "snapshot contains touched provider");
  }

  const { fail } = A.summary("circuit-breaker.test");
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
