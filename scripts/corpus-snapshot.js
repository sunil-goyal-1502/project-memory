#!/usr/bin/env node
"use strict";

const path = require("path");
const fs = require("fs");
const shared = require(path.join(__dirname, "shared.js"));
const { readEmbeddings, cosineSimilarity } = require(path.join(__dirname, "embeddings.js"));

// ── K-means++ clustering on embedding vectors ──

/**
 * Pick initial centroids via k-means++ strategy.
 * First centroid chosen randomly; subsequent chosen proportional to squared
 * distance from nearest existing centroid.
 */
function kmeansppInit(vectors, k) {
  const n = vectors.length;
  const dim = vectors[0].length;
  const centroids = [];

  // First centroid: random
  centroids.push(vectors[Math.floor(Math.random() * n)].slice());

  for (let c = 1; c < k; c++) {
    // Compute squared distance from each vector to its nearest centroid
    const dists = new Float64Array(n);
    let totalDist = 0;
    for (let i = 0; i < n; i++) {
      let minDist = Infinity;
      for (const centroid of centroids) {
        let d = 0;
        for (let j = 0; j < dim; j++) {
          const diff = vectors[i][j] - centroid[j];
          d += diff * diff;
        }
        if (d < minDist) minDist = d;
      }
      dists[i] = minDist;
      totalDist += minDist;
    }

    // Weighted random selection
    if (totalDist === 0) {
      centroids.push(vectors[Math.floor(Math.random() * n)].slice());
      continue;
    }
    let r = Math.random() * totalDist;
    for (let i = 0; i < n; i++) {
      r -= dists[i];
      if (r <= 0) {
        centroids.push(vectors[i].slice());
        break;
      }
    }
    // Edge case: rounding pushed us past the end
    if (centroids.length <= c) {
      centroids.push(vectors[n - 1].slice());
    }
  }
  return centroids;
}

/**
 * Run k-means on embedding vectors. Returns array of assignment indices (0..k-1).
 */
function kmeans(vectors, k, maxIter) {
  const n = vectors.length;
  const dim = vectors[0].length;
  const centroids = kmeansppInit(vectors, k);
  const assignments = new Int32Array(n);

  for (let iter = 0; iter < maxIter; iter++) {
    let changed = false;
    // Assign each vector to nearest centroid
    for (let i = 0; i < n; i++) {
      let bestCluster = 0;
      let bestDist = Infinity;
      for (let c = 0; c < k; c++) {
        let d = 0;
        for (let j = 0; j < dim; j++) {
          const diff = vectors[i][j] - centroids[c][j];
          d += diff * diff;
        }
        if (d < bestDist) {
          bestDist = d;
          bestCluster = c;
        }
      }
      if (assignments[i] !== bestCluster) {
        assignments[i] = bestCluster;
        changed = true;
      }
    }
    if (!changed) break;

    // Recompute centroids
    const counts = new Int32Array(k);
    for (let c = 0; c < k; c++) {
      for (let j = 0; j < dim; j++) centroids[c][j] = 0;
    }
    for (let i = 0; i < n; i++) {
      const c = assignments[i];
      counts[c]++;
      for (let j = 0; j < dim; j++) centroids[c][j] += vectors[i][j];
    }
    for (let c = 0; c < k; c++) {
      if (counts[c] > 0) {
        for (let j = 0; j < dim; j++) centroids[c][j] /= counts[c];
      }
    }
  }
  return assignments;
}

// ── Tag-based fallback clustering ──

function clusterByTag(entries) {
  // Count tag frequencies
  const tagFreq = {};
  for (const e of entries) {
    for (const tag of (e.tags || [])) {
      tagFreq[tag] = (tagFreq[tag] || 0) + 1;
    }
  }

  // For each entry pick its most-frequent tag as the cluster key
  const groups = {};
  const unclustered = [];
  for (const e of entries) {
    const tags = e.tags || [];
    if (tags.length === 0) {
      unclustered.push(e);
      continue;
    }
    let bestTag = tags[0];
    let bestFreq = tagFreq[bestTag] || 0;
    for (const tag of tags) {
      if ((tagFreq[tag] || 0) > bestFreq) {
        bestFreq = tagFreq[tag];
        bestTag = tag;
      }
    }
    if (!groups[bestTag]) groups[bestTag] = [];
    groups[bestTag].push(e);
  }

  if (unclustered.length > 0) {
    groups["uncategorized"] = (groups["uncategorized"] || []).concat(unclustered);
  }
  return groups;
}

// ── Build cluster label from top tags ──

function buildClusterLabel(entries) {
  const tagFreq = {};
  for (const e of entries) {
    for (const tag of (e.tags || [])) {
      tagFreq[tag] = (tagFreq[tag] || 0) + 1;
    }
  }
  const sorted = Object.entries(tagFreq).sort((a, b) => b[1] - a[1]);
  return sorted.slice(0, 3).map(([t]) => t).join(", ") || "misc";
}

function topTags(entries, n) {
  const tagFreq = {};
  for (const e of entries) {
    for (const tag of (e.tags || [])) {
      tagFreq[tag] = (tagFreq[tag] || 0) + 1;
    }
  }
  return Object.entries(tagFreq).sort((a, b) => b[1] - a[1]).slice(0, n).map(([t]) => t);
}

// ── Public API ──

/**
 * Cluster research entries by topic similarity.
 *
 * @param {Array} entries - research entries (objects with id, topic, tags, finding, ...)
 * @param {Object} embeddings - map of entry id → embedding vector (may be empty)
 * @param {number} k - desired number of clusters
 * @returns {Array<{label: string, entries: Array}>} sorted by cluster size desc
 */
function clusterEntries(entries, embeddings, k) {
  if (entries.length === 0) return [];
  k = Math.max(1, Math.min(k, 30, entries.length));

  // Try embedding-based k-means if enough entries have embeddings
  const entriesWithEmbedding = entries.filter(function (e) {
    return embeddings[e.id] && Array.isArray(embeddings[e.id]);
  });

  if (entriesWithEmbedding.length >= k * 2) {
    // Use k-means on embedding vectors
    const vectors = entriesWithEmbedding.map(function (e) { return embeddings[e.id]; });
    const assignments = kmeans(vectors, k, 20);

    const groups = {};
    for (let i = 0; i < entriesWithEmbedding.length; i++) {
      const c = assignments[i];
      if (!groups[c]) groups[c] = [];
      groups[c].push(entriesWithEmbedding[i]);
    }

    // Add entries without embeddings to nearest cluster by tag overlap
    const entriesWithout = entries.filter(function (e) {
      return !embeddings[e.id] || !Array.isArray(embeddings[e.id]);
    });
    for (const e of entriesWithout) {
      let bestCluster = 0;
      let bestOverlap = -1;
      const eTags = new Set(e.tags || []);
      for (const [cIdx, cEntries] of Object.entries(groups)) {
        let overlap = 0;
        for (const ce of cEntries) {
          for (const t of (ce.tags || [])) {
            if (eTags.has(t)) overlap++;
          }
        }
        if (overlap > bestOverlap) {
          bestOverlap = overlap;
          bestCluster = parseInt(cIdx, 10);
        }
      }
      if (!groups[bestCluster]) groups[bestCluster] = [];
      groups[bestCluster].push(e);
    }

    const result = Object.values(groups).map(function (clusterEntries) {
      return { label: buildClusterLabel(clusterEntries), entries: clusterEntries };
    });
    result.sort(function (a, b) { return b.entries.length - a.entries.length; });
    return result;
  }

  // Fallback: cluster by most-frequent shared tag
  const tagGroups = clusterByTag(entries);
  const result = Object.entries(tagGroups).map(function ([tag, tagEntries]) {
    return { label: buildClusterLabel(tagEntries), entries: tagEntries };
  });
  result.sort(function (a, b) { return b.entries.length - a.entries.length; });
  return result;
}

/**
 * Format one cluster as a markdown section.
 *
 * @param {Object} cluster - { label, entries }
 * @param {number} charBudget - max characters for this cluster's output
 * @returns {string} markdown text
 */
function formatCluster(cluster, charBudget) {
  const tags = topTags(cluster.entries, 5);
  let header = "## Cluster: " + cluster.label + "\n";
  header += cluster.entries.length + " entries | Top tags: " + tags.join(", ") + "\n\n";

  let remaining = charBudget - header.length;
  if (remaining <= 0) return header;

  // Sort entries: stable first, then by date desc
  const sorted = cluster.entries.slice().sort(function (a, b) {
    const stalenessOrder = { stable: 0, versioned: 1, volatile: 2 };
    const sa = stalenessOrder[a.staleness] !== undefined ? stalenessOrder[a.staleness] : 1;
    const sb = stalenessOrder[b.staleness] !== undefined ? stalenessOrder[b.staleness] : 1;
    if (sa !== sb) return sa - sb;
    return (b.ts || "").localeCompare(a.ts || "");
  });

  const lines = [];
  for (const e of sorted) {
    const date = (e.ts || "").substring(0, 10);
    const staleness = e.staleness || "unknown";
    const entryTags = (e.tags || []).join(", ");

    // Skeleton: always included
    let skeleton = "### " + (e.topic || "(no topic)") + " [" + staleness + "] (" + date + ")\n";

    // Finding text — will be trimmed by budget enforcement in generateSnapshot
    const finding = e.finding || "";
    let entryText = skeleton;
    if (finding.length > 0) {
      entryText += finding + "\n";
    }
    if (entryTags.length > 0) {
      entryText += "Tags: " + entryTags + "\n";
    }
    entryText += "\n";

    if (remaining - entryText.length < 0) {
      // Truncate finding to fit
      const availForFinding = remaining - skeleton.length - (entryTags.length > 0 ? entryTags.length + 7 : 0) - 6;
      if (availForFinding > 20) {
        entryText = skeleton + finding.substring(0, availForFinding) + "...\n";
        if (entryTags.length > 0) entryText += "Tags: " + entryTags + "\n";
        entryText += "\n";
      } else {
        // Just skeleton
        entryText = skeleton;
        if (entryTags.length > 0) entryText += "Tags: " + entryTags + "\n";
        entryText += "\n";
      }
    }

    remaining -= entryText.length;
    lines.push(entryText);
    if (remaining <= 0) break;
  }

  return header + lines.join("");
}

// ── Snapshot generation ──

/**
 * Generate a complete structured markdown snapshot of the project-memory corpus.
 *
 * @param {string} projectRoot - path to the project root
 * @param {Object} opts - { maxChars: 50000, maxTokensEstimate: 12000 }
 * @returns {string} markdown snapshot
 */
function generateSnapshot(projectRoot, opts) {
  opts = opts || {};
  const maxChars = opts.maxChars || 50000;

  const memDir = path.join(projectRoot, ".ai-memory");

  // 1. Load all data
  const research = shared.readJsonl(path.join(memDir, "research.jsonl"));
  const decisions = shared.readJsonl(path.join(memDir, "decisions.jsonl"));
  const scripts = shared.readJsonl(path.join(memDir, "scripts.jsonl"));
  const graphTriples = shared.readJsonl(path.join(memDir, "graph.jsonl"));
  const embeddings = readEmbeddings(projectRoot);

  // 2. Cluster research entries
  const k = Math.min(15, 30, Math.max(1, Math.floor(research.length / 3)));
  const clusters = clusterEntries(research, embeddings, k);

  // 3. Count staleness categories
  const staleCounts = { stable: 0, versioned: 0, volatile: 0 };
  for (const e of research) {
    const s = e.staleness || "unknown";
    if (staleCounts[s] !== undefined) staleCounts[s]++;
  }

  // Count decision categories
  const decisionCats = {};
  for (const d of decisions) {
    const cat = d.category || "other";
    decisionCats[cat] = (decisionCats[cat] || 0) + 1;
  }
  const decisionCatStr = Object.entries(decisionCats)
    .map(function ([cat, count]) { return cat + ": " + count; })
    .join(", ");

  // 4. Build markdown header
  const now = new Date().toISOString();
  let md = "# Project Memory Corpus Snapshot\n";
  md += "Generated: " + now + " | Entries: " + research.length + " | Clusters: " + clusters.length + "\n\n";

  md += "## Summary\n";
  md += "- Research findings: " + research.length +
    " (stable: " + staleCounts.stable +
    ", versioned: " + staleCounts.versioned +
    ", volatile: " + staleCounts.volatile + ")\n";
  md += "- Decisions: " + decisions.length +
    (decisionCatStr ? " (" + decisionCatStr + ")" : "") + "\n";
  md += "- Script templates: " + scripts.length + "\n";
  md += "- Graph triples: " + graphTriples.length + "\n\n";

  // 5. Build decisions section
  let decisionsSection = "## Decisions\n\n";
  for (const d of decisions) {
    const cat = d.category || "other";
    const decision = d.decision || "(no decision)";
    const rationale = d.rationale || "";
    decisionsSection += "### " + cat + ": " + decision + "\n";
    if (rationale) decisionsSection += rationale + "\n";
    decisionsSection += "\n";
  }

  // 6. Build scripts section (top 10 by usage/variant count)
  let scriptsSection = "## Scripts (top 10 by usage)\n\n";
  const sortedScripts = scripts.slice().sort(function (a, b) {
    return (b.variants || 0) - (a.variants || 0);
  });
  const topScripts = sortedScripts.slice(0, 10);
  for (const s of topScripts) {
    const desc = s.description || s.name || s.topic || "(script)";
    const cmd = (s.command || s.script || s.finding || "").substring(0, 80);
    scriptsSection += "- **" + desc + "**: `" + cmd + (cmd.length >= 80 ? "..." : "") + "`\n";
  }
  scriptsSection += "\n";

  // 7. Compute budgets — trim fixed sections if needed
  let fixedLen = md.length + decisionsSection.length + scriptsSection.length;
  if (fixedLen > maxChars * 0.6) {
    // Truncate decisions and scripts sections to fit
    const availFixed = Math.floor(maxChars * 0.4);
    const halfFixed = Math.floor(availFixed / 2);
    if (decisionsSection.length > halfFixed) {
      decisionsSection = decisionsSection.substring(0, halfFixed) + "\n...(truncated)\n\n";
    }
    if (scriptsSection.length > halfFixed) {
      scriptsSection = scriptsSection.substring(0, halfFixed) + "\n...(truncated)\n\n";
    }
    fixedLen = md.length + decisionsSection.length + scriptsSection.length;
  }
  let clusterBudget = maxChars - fixedLen;
  if (clusterBudget < 500) clusterBudget = 500;

  // 8. Budget enforcement — progressive truncation
  const truncationLevels = [0, 500, 300, 200, 100];
  let clustersMd = "";
  let fitsInBudget = false;

  for (const truncateAt of truncationLevels) {
    // Apply truncation to findings if needed
    let truncatedClusters = clusters;
    if (truncateAt > 0) {
      truncatedClusters = clusters.map(function (cluster) {
        return {
          label: cluster.label,
          entries: cluster.entries.map(function (e) {
            if (e.finding && e.finding.length > truncateAt) {
              return Object.assign({}, e, {
                finding: e.finding.substring(0, truncateAt) + "..."
              });
            }
            return e;
          })
        };
      });
    }

    // Distribute budget proportionally across clusters
    const totalEntries = truncatedClusters.reduce(function (sum, c) {
      return sum + c.entries.length;
    }, 0);
    let parts = [];
    for (const cluster of truncatedClusters) {
      const proportion = totalEntries > 0 ? cluster.entries.length / totalEntries : 1 / truncatedClusters.length;
      const budget = Math.floor(clusterBudget * proportion);
      parts.push(formatCluster(cluster, Math.max(budget, 200)));
    }

    clustersMd = parts.join("");
    if (clustersMd.length <= clusterBudget) {
      fitsInBudget = true;
      break;
    }
  }

  // If still over budget after 100-char truncation, drop oldest entries from largest clusters
  if (!fitsInBudget && clustersMd.length > clusterBudget) {
    let trimmedClusters = clusters.map(function (cluster) {
      return {
        label: cluster.label,
        entries: cluster.entries.map(function (e) {
          return Object.assign({}, e, {
            finding: e.finding ? e.finding.substring(0, 100) + "..." : ""
          });
        })
      };
    });

    function renderTrimmed(cs, budget) {
      cs = cs.filter(function (c) { return c.entries.length > 0; });
      var total = cs.reduce(function (s, c) { return s + c.entries.length; }, 0);
      var parts = [];
      for (var i = 0; i < cs.length; i++) {
        var proportion = total > 0 ? cs[i].entries.length / total : 1 / cs.length;
        var b = Math.max(100, Math.floor(budget * proportion));
        parts.push(formatCluster(cs[i], b));
      }
      return parts.join("");
    }

    // Drop oldest entries from largest clusters until within budget
    var maxDrops = research.length;
    for (var drop = 0; drop < maxDrops; drop++) {
      trimmedClusters = trimmedClusters.filter(function (c) { return c.entries.length > 0; });
      if (trimmedClusters.length === 0) break;
      clustersMd = renderTrimmed(trimmedClusters, clusterBudget);
      if (clustersMd.length <= clusterBudget) break;

      // Find largest cluster and drop its oldest entry
      trimmedClusters.sort(function (a, b) { return b.entries.length - a.entries.length; });
      var largest = trimmedClusters[0];
      if (largest.entries.length <= 0) break;
      largest.entries.sort(function (a, b) {
        return (a.ts || "").localeCompare(b.ts || "");
      });
      largest.entries.shift();
    }
  }

  return md + clustersMd + decisionsSection + scriptsSection;
}

// ── CLI entry point ──

if (require.main === module) {
  let maxChars = 50000;
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--max-chars" && args[i + 1]) {
      maxChars = parseInt(args[i + 1], 10) || maxChars;
      i++;
    }
  }

  // Determine project root: use cwd if it has .ai-memory, else script's parent
  let projectRoot = process.cwd();
  if (!fs.existsSync(path.join(projectRoot, ".ai-memory"))) {
    projectRoot = path.dirname(__dirname);
  }

  const snapshot = generateSnapshot(projectRoot, { maxChars: maxChars });
  process.stdout.write(snapshot);
}

module.exports = { generateSnapshot, clusterEntries, formatCluster };
