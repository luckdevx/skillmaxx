import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SkillEntry } from "./lib.ts";
import { securityCheckForSkillPath, getRepoInfo } from "./installer.ts";

export const WEIGHTS = {
  COBERTURA: 0.44,
  USO_REAL: 0.2,
  FRESHNESS: 0.15,
  REPUTACION: 0.01,
  TAMANO_SNR: 0.1,
  SEGURIDAD: 0.07,
  CALIDAD_LLM: 0.03,
};

const AUTHOR_REPUTATION: Record<string, number> = {
  "vercel-labs": 90,
  anthropics: 85,
  addyosmani: 80,
  hashicorp: 80,
  clerk: 75,
  "tanstack-skills": 75,
  apollographql: 75,
  github: 75,
  instantdb: 70,
  jeffallan: 65,
  kevmoo: 60,
  "inferen-sh": 60,
  wshobson: 55,
  mindrally: 55,
  pproenca: 50,
  "affaan-m": 50,
  madteacher: 50,
  pluginagentmarketplace: 30,
};

export const SCORE_THRESHOLD = 40;

export function starCountToScore(stars: number | null | undefined): number {
  if (stars == null) return 50;
  return Math.min(100, Math.round((stars / 5000) * 100));
}

export interface ScoreSignals {
  cobertura: number;
  usoReal: number;
  freshness: number;
  reputacion: number;
  tamanoSnr: number;
  seguridad: number;
  calidadLlm: number;
}

export interface ScoredSkillEntry extends SkillEntry {
  score: number;
  signals: ScoreSignals;
}

function computeCobertura(sources: string[]): number {
  return Math.min(100, sources.length * 33);
}

function computeReputacion(skill: string): number {
  const author = skill.split("/")[0];
  return AUTHOR_REPUTATION[author] ?? 50;
}

function computeSeguridad(skill: string): number {
  const check = securityCheckForSkillPath(skill);
  if (!check) return 50;
  return check.status === "ok" ? 100 : 30;
}

function parseSkillName(skill: string): string {
  return skill.split("/").pop() ?? skill;
}

export interface DedupResult {
  entries: ScoredSkillEntry[];
  removed: number;
}

export function dedupSkills(entries: ScoredSkillEntry[]): DedupResult {
  const seen = new Map<string, ScoredSkillEntry>();
  let removed = 0;

  for (const entry of entries) {
    const name = parseSkillName(entry.skill);
    const existing = seen.get(name);
    if (!existing) {
      seen.set(name, entry);
    } else {
      removed++;
      if (entry.score > existing.score) {
        seen.set(name, entry);
      }
    }
  }

  return { entries: [...seen.values()], removed };
}

// ── Dedup V2: semantic similarity via character n-grams ──────

export const DEDUP_SIMILARITY_THRESHOLD = 0.85;

function charNGrams(text: string, n: number = 3): Set<string> {
  const grams = new Set<string>();
  const cleaned = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  for (let i = 0; i <= cleaned.length - n; i++) {
    grams.add(cleaned.slice(i, i + n));
  }
  return grams;
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const item of a) {
    if (b.has(item)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export function dedupSkillsV2(entries: ScoredSkillEntry[], registryDir?: string): DedupResult {
  if (!registryDir || entries.length <= 1) {
    return { entries, removed: 0 };
  }

  const dir: string = registryDir;
  const contentCache = new Map<string, string>();
  const gramCache = new Map<string, Set<string>>();

  function getContent(skill: string): string {
    let content = contentCache.get(skill);
    if (content !== undefined) return content;
    const skillName = skill.split("/").pop() ?? skill;
    try {
      content = readFileSync(join(dir, skillName, "SKILL.md"), "utf-8");
    } catch {
      content = "";
    }
    contentCache.set(skill, content);
    return content;
  }

  function getGrams(skill: string): Set<string> {
    let grams = gramCache.get(skill);
    if (grams) return grams;
    grams = charNGrams(getContent(skill));
    gramCache.set(skill, grams);
    return grams;
  }

  const sorted = [...entries].sort((a, b) => b.score - a.score);
  const kept = new Set<string>();
  let removed = 0;

  for (const entry of sorted) {
    const gramsA = getGrams(entry.skill);
    let isDuplicate = false;
    for (const keptSkill of kept) {
      const gramsB = getGrams(keptSkill);
      if (jaccardSimilarity(gramsA, gramsB) >= DEDUP_SIMILARITY_THRESHOLD) {
        isDuplicate = true;
        removed++;
        break;
      }
    }
    if (!isDuplicate) kept.add(entry.skill);
  }

  return { entries: entries.filter((e) => kept.has(e.skill)), removed };
}

export function computeFreshness(pushedAt: string | null | undefined): number {
  if (!pushedAt) return 50;
  const days = (Date.now() - new Date(pushedAt).getTime()) / 86_400_000;
  if (days <= 30) return 100;
  if (days <= 180) return 70;
  if (days <= 365) return 40;
  return 20;
}

export function computeTamanoSnr(sizeKB: number | null | undefined): number {
  if (sizeKB == null) return 50;
  if (sizeKB <= 500) return 90;
  if (sizeKB <= 5_000) return 70;
  if (sizeKB <= 50_000) return 40;
  return 20;
}

export function computeScore(entry: SkillEntry): ScoredSkillEntry {
  const cobertura = computeCobertura(entry.sources);
  const repoInfo = getRepoInfo(entry.skill);
  const usoReal = starCountToScore(repoInfo?.stars);
  const freshness = computeFreshness(repoInfo?.pushedAt ?? null);
  const reputacion = computeReputacion(entry.skill);
  const tamanoSnr = computeTamanoSnr(repoInfo?.sizeKB);
  const seguridad = computeSeguridad(entry.skill);
  const calidadLlm = 50;

  const score = Math.round(
    cobertura * WEIGHTS.COBERTURA +
      usoReal * WEIGHTS.USO_REAL +
      freshness * WEIGHTS.FRESHNESS +
      reputacion * WEIGHTS.REPUTACION +
      tamanoSnr * WEIGHTS.TAMANO_SNR +
      seguridad * WEIGHTS.SEGURIDAD +
      calidadLlm * WEIGHTS.CALIDAD_LLM,
  );

  return {
    ...entry,
    score,
    signals: {
      cobertura,
      usoReal,
      freshness,
      reputacion,
      tamanoSnr,
      seguridad,
      calidadLlm,
    },
  };
}
