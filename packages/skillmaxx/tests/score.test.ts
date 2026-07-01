import { describe, it } from "node:test";
import { ok, strictEqual } from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  computeScore,
  computeFreshness,
  computeTamanoSnr,
  dedupSkills,
  dedupSkillsV2,
  starCountToScore,
  SCORE_THRESHOLD,
} from "../score.ts";
import type { SkillEntry } from "../lib.ts";

function makeEntry(
  skill: string,
  sources: string[],
  installed = false,
): SkillEntry {
  return { skill, sources, installed };
}

describe("computeScore", () => {
  it("calculates cobertura signal from sources count", () => {
    const entry = computeScore(makeEntry("vercel-labs/react-best-practices", ["React"]));
    strictEqual(entry.signals.cobertura, 33);
  });

  it("gives 99 cobertura for 3 sources", () => {
    const entry = computeScore(
      makeEntry("vercel-labs/react-best-practices", ["React", "Next.js", "Vue"]),
    );
    strictEqual(entry.signals.cobertura, 99);
  });

  it("caps cobertura at 100 for 4+ sources", () => {
    const entry = computeScore(
      makeEntry("vercel-labs/react-best-practices", ["React", "Next.js", "Vue", "Svelte"]),
    );
    strictEqual(entry.signals.cobertura, 100);
  });

  it("uses author reputation for reputacion signal", () => {
    const entry = computeScore(makeEntry("vercel-labs/react-best-practices", ["React"]));
    strictEqual(entry.signals.reputacion, 90);
  });

  it("defaults to neutral 50 for unknown authors", () => {
    const entry = computeScore(makeEntry("unknown-author/some-skill", ["React"]));
    strictEqual(entry.signals.reputacion, 50);
  });

  it("sets neutral 50 for signals without registry", () => {
    const entry = computeScore(makeEntry("vercel-labs/react-best-practices", ["React"]));
    strictEqual(entry.signals.calidadLlm, 50);
  });

  it("returns 50 for usoReal without registry", () => {
    const entry = computeScore(makeEntry("vercel-labs/react-best-practices", ["React"]));
    strictEqual(entry.signals.usoReal, 50);
  });

  it("computes composite score between 0 and 100", () => {
    const entry = computeScore(makeEntry("vercel-labs/react-best-practices", ["React"]));
    ok(entry.score >= 0);
    ok(entry.score <= 100);
  });

  it("preserves original SkillEntry fields", () => {
    const entry = computeScore(makeEntry("addyosmani/web-quality-skills/accessibility", ["React"]));
    strictEqual(entry.skill, "addyosmani/web-quality-skills/accessibility");
    strictEqual(entry.installed, false);
    ok(entry.sources.includes("React"));
  });

  it("starCountToScore maps stars to 0-100", () => {
    strictEqual(starCountToScore(null), 50);
    strictEqual(starCountToScore(0), 0);
    strictEqual(starCountToScore(2500), 50);
    strictEqual(starCountToScore(5000), 100);
  });

  it("cobertura dominates composite score", () => {
    const twoSources = computeScore(makeEntry("vercel-labs/react-best-practices", ["React", "Next.js"]));
    const oneSource = computeScore(makeEntry("vercel-labs/react-best-practices", ["React"]));
    ok(twoSources.score > oneSource.score);
  });

  it("more sources yields higher score", () => {
    const single = computeScore(makeEntry("vercel-labs/react-best-practices", ["React"]));
    const multi = computeScore(makeEntry("vercel-labs/react-best-practices", ["React", "Next.js"]));
    ok(multi.score >= single.score);
  });
});

describe("dedupSkills", () => {
  it("returns same entries when no duplicates", () => {
    const skills: SkillEntry[] = [
      { skill: "vercel-labs/react-best-practices", sources: ["React"], installed: false },
      { skill: "addyosmani/web-quality-skills/accessibility", sources: ["Frontend"], installed: false },
    ];
    const scored = skills.map(computeScore);
    const { entries, removed } = dedupSkills(scored);
    strictEqual(removed, 0);
    strictEqual(entries.length, 2);
  });

  it("deduplicates skills with same name, keeping highest score", () => {
    const skills: SkillEntry[] = [
      { skill: "vercel-labs/react-best-practices", sources: ["React"], installed: false },
      { skill: "addyosmani/react-best-practices", sources: ["React"], installed: false },
    ];
    const scored = skills.map(computeScore);
    const { entries, removed } = dedupSkills(scored);
    strictEqual(removed, 1);
    strictEqual(entries.length, 1);
    strictEqual(entries[0].skill, "vercel-labs/react-best-practices");
  });

  it("handles empty input", () => {
    const { entries, removed } = dedupSkills([]);
    strictEqual(removed, 0);
    strictEqual(entries.length, 0);
  });
});

describe("dedupSkillsV2", () => {
  function makeRegistryDir(skillName: string, content: string): string {
    const dir = mkdtempSync(join(tmpdir(), "dedup-test-"));
    const skillDir = join(dir, skillName);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), content);
    return dir;
  }

  it("returns same entries when no registry dir", () => {
    const skills: SkillEntry[] = [
      { skill: "vercel-labs/react-best-practices", sources: ["React"], installed: false },
    ];
    const { entries, removed } = dedupSkillsV2(skills.map(computeScore));
    strictEqual(removed, 0);
    strictEqual(entries.length, 1);
  });

  it("does not dedup skills with different content", () => {
    const skills: SkillEntry[] = [
      { skill: "vercel-labs/react-best-practices", sources: ["React"], installed: false },
      { skill: "addyosmani/web-quality-skills/accessibility", sources: ["Frontend"], installed: false },
    ];
    const regDir = makeRegistryDir("react-best-practices", "React hooks and patterns");
    const regDir2 = makeRegistryDir("accessibility", "Web accessibility guidelines");
    // Use the first registry dir and manually write the second
    mkdirSync(join(regDir, "accessibility"), { recursive: true });
    writeFileSync(join(regDir, "accessibility", "SKILL.md"), "Web accessibility guidelines");
    const { entries, removed } = dedupSkillsV2(skills.map(computeScore), regDir);
    strictEqual(removed, 0);
    strictEqual(entries.length, 2);
  });

  it("deduplicates skills with similar content", () => {
    const skills: SkillEntry[] = [
      { skill: "vercel-labs/react-best-practices", sources: ["React"], installed: false },
      { skill: "addyosmani/react-hooks-guide", sources: ["React"], installed: false },
    ];
    const content = "React hooks are functions that let you use state and lifecycle features in functional components.";
    const regDir = makeRegistryDir("react-best-practices", content);
    mkdirSync(join(regDir, "react-hooks-guide"), { recursive: true });
    writeFileSync(join(regDir, "react-hooks-guide", "SKILL.md"), content);
    const { entries, removed } = dedupSkillsV2(skills.map(computeScore), regDir);
    strictEqual(removed, 1);
    strictEqual(entries.length, 1);
    strictEqual(entries[0].skill, "vercel-labs/react-best-practices");
  });

  it("keeps higher-scored skill when deduplicating", () => {
    const skills: SkillEntry[] = [
      { skill: "v2/skill-a", sources: ["React"], installed: false },
      { skill: "v1/skill-b", sources: ["React", "Next.js"], installed: false },
    ];
    const content = "Working with React and modern JavaScript";
    const regDir = makeRegistryDir("skill-a", content);
    mkdirSync(join(regDir, "skill-b"), { recursive: true });
    writeFileSync(join(regDir, "skill-b", "SKILL.md"), content);
    const { entries } = dedupSkillsV2(skills.map(computeScore), regDir);
    strictEqual(entries.length, 1);
    strictEqual(entries[0].skill, "v1/skill-b");
  });
});

describe("starCountToScore", () => {
  it("returns 50 for null", () => {
    strictEqual(starCountToScore(null), 50);
  });

  it("returns 50 for undefined", () => {
    strictEqual(starCountToScore(undefined), 50);
  });

  it("returns 0 for 0 stars", () => {
    strictEqual(starCountToScore(0), 0);
  });

  it("returns 100 for 5000+ stars", () => {
    strictEqual(starCountToScore(5000), 100);
    strictEqual(starCountToScore(10_000), 100);
  });

  it("returns proportional score between 0 and 100", () => {
    strictEqual(starCountToScore(1250), 25);
    strictEqual(starCountToScore(2500), 50);
    strictEqual(starCountToScore(3750), 75);
  });
});

describe("computeFreshness", () => {
  it("returns 100 for pushed less than 30 days ago", () => {
    const recent = new Date(Date.now() - 15 * 86_400_000).toISOString();
    strictEqual(computeFreshness(recent), 100);
  });

  it("returns 70 for pushed 30-180 days ago", () => {
    const mid = new Date(Date.now() - 90 * 86_400_000).toISOString();
    strictEqual(computeFreshness(mid), 70);
  });

  it("returns 40 for pushed 180-365 days ago", () => {
    const old = new Date(Date.now() - 250 * 86_400_000).toISOString();
    strictEqual(computeFreshness(old), 40);
  });

  it("returns 20 for pushed more than 365 days ago", () => {
    const ancient = new Date(Date.now() - 500 * 86_400_000).toISOString();
    strictEqual(computeFreshness(ancient), 20);
  });

  it("returns 50 for null or undefined", () => {
    strictEqual(computeFreshness(null), 50);
    strictEqual(computeFreshness(undefined), 50);
  });
});

describe("computeTamanoSnr", () => {
  it("returns 90 for repos ≤500 KB", () => {
    strictEqual(computeTamanoSnr(100), 90);
    strictEqual(computeTamanoSnr(500), 90);
  });

  it("returns 70 for repos ≤5 MB", () => {
    strictEqual(computeTamanoSnr(3000), 70);
    strictEqual(computeTamanoSnr(5000), 70);
  });

  it("returns 40 for repos ≤50 MB", () => {
    strictEqual(computeTamanoSnr(10000), 40);
    strictEqual(computeTamanoSnr(50000), 40);
  });

  it("returns 20 for repos >50 MB", () => {
    strictEqual(computeTamanoSnr(100000), 20);
  });

  it("returns 50 for null or undefined", () => {
    strictEqual(computeTamanoSnr(null), 50);
    strictEqual(computeTamanoSnr(undefined), 50);
  });
});

describe("SCORE_THRESHOLD", () => {
  it("is set to 40", () => {
    strictEqual(SCORE_THRESHOLD, 40);
  });

  it("filters skills below threshold", () => {
    const skills: SkillEntry[] = [
      { skill: "vercel-labs/react-best-practices", sources: ["React"], installed: false },
      { skill: "pluginagentmarketplace/custom-plugin-python/pandas-data-analysis", sources: ["pandas"], installed: false },
      { skill: "addyosmani/web-quality-skills/accessibility", sources: ["Frontend"], installed: false },
    ];
    const scored = skills.map(computeScore);
    const pruned = scored.filter((s) => s.score >= SCORE_THRESHOLD);
    ok(pruned.length <= scored.length);
    for (const s of pruned) {
      ok(s.score >= SCORE_THRESHOLD);
    }
  });
});
