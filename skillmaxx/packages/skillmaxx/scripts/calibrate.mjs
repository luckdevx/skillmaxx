import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { detectTechnologies, collectSkills } from "../lib.ts";
import { computeScore, WEIGHTS } from "../score.ts";

const ELECTRO_PARTS_DIR = "/home/linux/proyectos/electro-parts";
const RELEVANT_SOURCES = [
  "Bash",
  "Python",
  "Flask",
  "SQLAlchemy",
  "Pytest",
  "Docker",
  "GitHub Actions",
];

function relevanceLevel(skill) {
  const hasRelevant = skill.sources.some((s) => RELEVANT_SOURCES.includes(s));
  const hasFrontend = skill.sources.includes("Frontend");
  if (hasRelevant) return 2;
  if (hasFrontend) return 1;
  return 0;
}

function evaluateRanking(scored) {
  if (scored.length === 0) return 0;
  let sumRelevantRanks = 0;
  let relevantCount = 0;
  let irrelevantInTop5 = 0;
  for (let i = 0; i < scored.length; i++) {
    const rel = relevanceLevel(scored[i]);
    if (rel >= 2) {
      sumRelevantRanks += i + 1;
      relevantCount++;
    } else if (i < 5) {
      irrelevantInTop5++;
    }
  }
  if (relevantCount === 0) return 0;
  const mrr = relevantCount / sumRelevantRanks;
  const penalty = 1 - irrelevantInTop5 / 5;
  return mrr * 0.6 + penalty * 0.4;
}

function evaluateWeights() {
  if (!existsSync(ELECTRO_PARTS_DIR)) {
    console.error(`   Not found: ${ELECTRO_PARTS_DIR}`);
    return null;
  }
  const { detected, isFrontend, combos } = detectTechnologies(ELECTRO_PARTS_DIR);
  const skills = collectSkills({ detected, isFrontend, combos, installedNames: new Set() });
  if (skills.length === 0) return null;
  const scored = skills.map(computeScore).sort((a, b) => b.score - a.score);
  const score = evaluateRanking(scored);
  return { score, scored };
}

function summary() {
  console.log("\n  Current weights:");
  for (const [k, v] of Object.entries(WEIGHTS)) {
    console.log(`    ${k.padEnd(14)} ${(v * 100).toFixed(0)}%`);
  }
}

function run() {
  console.log("\n  Capa 3.1 — Weight Calibration");
  console.log(`  Project: ${ELECTRO_PARTS_DIR}`);
  summary();

  // Baseline
  const baseline = evaluateWeights();
  if (!baseline) {
    console.error("  ✘ Could not evaluate");
    return;
  }

  console.log(`\n  Baseline score: ${baseline.score.toFixed(4)}`);
  console.log("\n  Ranking:");
  for (let i = 0; i < baseline.scored.length; i++) {
    const s = baseline.scored[i];
    const rel = relevanceLevel(s);
    const icon = rel >= 2 ? "✓" : rel === 0 ? "✗" : "○";
    const techs = s.sources.filter((src) => RELEVANT_SOURCES.includes(src));
    const hint = techs.length > 0 ? techs.join(",") : s.sources.join(",");
    console.log(
      `    ${String(i + 1).padStart(2)}. [${String(s.score).padStart(2)}%] ${icon} ${s.skill}  (${hint})`,
    );
  }

  // Search: wider range, all individual adjustments of ±5pp to ±20pp
  const orig = { ...WEIGHTS };
  const keys = Object.keys(WEIGHTS);
  let bestScore = baseline.score;
  let bestWeights = { ...orig };

  // Phase 1: try adjusting REPUTACION down significantly and distributing elsewhere
  for (let repPct = 1; repPct <= 25; repPct++) {
    for (let cobPct = 25; cobPct <= 45; cobPct++) {
      const w = {
        COBERTURA: cobPct / 100,
        USO_REAL: 20 / 100,
        FRESHNESS: 15 / 100,
        REPUTACION: repPct / 100,
        TAMANO_SNR: 10 / 100,
        SEGURIDAD: 7 / 100,
        CALIDAD_LLM: 3 / 100,
      };
      const total = Object.values(w).reduce((s, v) => s + v, 0);
      if (Math.abs(total - 1) > 0.01) continue;
      Object.assign(WEIGHTS, w);
      const r = evaluateWeights();
      if (r && r.score > bestScore) {
        bestScore = r.score;
        bestWeights = { ...w };
        process.stdout.write(".");
      }
    }
  }

  // Phase 2: refine with ±3pp around best
  Object.assign(WEIGHTS, bestWeights);
  for (let a = 0; a < keys.length; a++) {
    for (const delta of [-0.03, -0.02, -0.01, 0.01, 0.02, 0.03]) {
      for (let b = 0; b < keys.length; b++) {
        if (a === b) continue;
        for (const delta2 of [-0.03, -0.02, -0.01, 0.01, 0.02, 0.03]) {
          const w = { ...bestWeights };
          w[keys[a]] = Math.max(0.01, Math.min(0.5, bestWeights[keys[a]] + delta));
          w[keys[b]] = Math.max(0.01, Math.min(0.5, bestWeights[keys[b]] + delta2));
          const total = Object.values(w).reduce((s, v) => s + v, 0);
          if (Math.abs(total - 1) > 0.01) {
            // Normalize
            for (const k of keys) w[k] = Math.round((w[k] / total) * 100) / 100;
          }
          if (Math.abs(Object.values(w).reduce((s, v) => s + v, 0) - 1) > 0.01) continue;
          Object.assign(WEIGHTS, w);
          const r = evaluateWeights();
          if (r && r.score > bestScore) {
            bestScore = r.score;
            bestWeights = { ...w };
          }
        }
      }
    }
    Object.assign(WEIGHTS, bestWeights);
  }

  Object.assign(WEIGHTS, orig); // restore
  console.log(`\n  Best score: ${bestScore.toFixed(4)} (baseline: ${baseline.score.toFixed(4)})`);
  console.log("\n  Optimal weights:");
  for (const k of keys) {
    const ov = orig[k];
    const bv = bestWeights[k] ?? ov;
    const d = ((bv - ov) * 100).toFixed(0);
    console.log(
      `    ${k.padEnd(14)} ${(bv * 100).toFixed(0)}%  (${d.startsWith("-") ? "" : "+"}${d}pp)`,
    );
  }

  // Show final ranking
  Object.assign(WEIGHTS, bestWeights);
  const final = evaluateWeights();
  if (final) {
    console.log("\n  Optimal ranking:");
    for (let i = 0; i < final.scored.length; i++) {
      const s = final.scored[i];
      const rel = relevanceLevel(s);
      const icon = rel >= 2 ? "✓" : rel === 0 ? "✗" : "○";
      const techs = s.sources.filter((src) => RELEVANT_SOURCES.includes(src));
      const hint = techs.length > 0 ? techs.join(",") : s.sources.join(",");
      console.log(
        `    ${String(i + 1).padStart(2)}. [${String(s.score).padStart(2)}%] ${icon} ${s.skill}  (${hint})`,
      );
    }
  }
  Object.assign(WEIGHTS, orig);
  console.log();
}

run();
