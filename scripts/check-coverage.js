#!/usr/bin/env node
"use strict";
const e = require("./embeddings.js");
const s = require("./shared.js");
const r = s.readJsonl(".ai-memory/research.jsonl");
const d = s.readJsonl(".ai-memory/decisions.jsonl");
const emb = e.readEmbeddings(".");
const total = r.length + d.length;
const embedded = Object.keys(emb).length;
console.log(`Entries: ${total} (research: ${r.length}, decisions: ${d.length})`);
console.log(`Embedded: ${embedded}`);
const missing = [...r, ...d].filter(x => !emb[x.id]);
if (missing.length) {
  console.log(`Missing ${missing.length}:`);
  missing.forEach(x => console.log(`  - ${x.topic || x.decision}`));
} else {
  console.log("All entries embedded ✓");
}
