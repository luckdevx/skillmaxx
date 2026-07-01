import { resolve, dirname, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { Command } from "@cliffy/command";

import { detectTechnologies, collectSkills, detectAgents, getInstalledSkillNames } from "./lib.ts";
import type { SkillEntry, Technology, ComboSkill } from "./lib.ts";
import { runDeepScanners } from "./scanners.ts";
import { computeScore, dedupSkills, dedupSkillsV2, SCORE_THRESHOLD } from "./score.ts";
import type { ScoredSkillEntry } from "./score.ts";
import {
  log,
  write,
  bold,
  dim,
  green,
  yellow,
  cyan,
  magenta,
  red,
  pink,
  gray,
  muted,
  SHOW_CURSOR,
} from "./colors.ts";
import { printBanner, multiSelect, formatTime } from "./ui.ts";
import {
  clearSkillmaxxCache,
  getRegistryDir,
  installAll,
  loadRegistry,
  securityCheckForSkillPath,
} from "./installer.ts";
import type { InstallSecurityCheck } from "./installer.ts";
import { cleanupClaudeMd } from "./claude.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const VERSION: string = (() => {
  for (const base of [__dirname, resolve(__dirname, "..")]) {
    const p = join(base, "package.json");
    if (!existsSync(p)) continue;
    try {
      const pkg = JSON.parse(readFileSync(p, "utf-8"));
      if (pkg.name === "skillmaxx") return pkg.version;
    } catch {}
  }
  return "0.0.0";
})();
const ISSUES_URL = "https://github.com/tokenmaxxing/skillmaxx/issues";

process.on("SIGINT", () => {
  write(SHOW_CURSOR + "\n");
  process.exit(130);
});

// ── Display ──────────────────────────────────────────────────

function printDetected(detected: Technology[], combos: ComboSkill[], isFrontend: boolean): void {
  if (detected.length > 0) {
    const withSkills = detected.filter((t) => t.skills.length > 0);
    const withoutSkills = detected.filter((t) => t.skills.length === 0);
    const allTech = [...withSkills, ...withoutSkills];

    log(cyan("   ◆ ") + bold("Detected technologies:"));
    log();

    const COLS = 3;
    const colWidth = Math.max(...allTech.map((t) => t.name.length)) + 3;

    const formatTech = (tech: Technology): string => {
      const hasSkills = tech.skills.length > 0;
      const icon = hasSkills ? green("✔") : dim("●");
      const name = tech.name.padEnd(colWidth);
      return `${icon} ${hasSkills ? name : dim(name)}`;
    };

    for (let i = 0; i < allTech.length; i += COLS) {
      const row = allTech
        .slice(i, i + COLS)
        .map(formatTech)
        .join("");
      log(`     ${row}`);
    }

    if (combos.length > 0) {
      log();
      log(magenta("   ◆ ") + bold("Detected combos:"));
      log();
      for (const combo of combos) {
        log(magenta(`     ⚡ `) + combo.name);
      }
    }
    log();
  }

  if (isFrontend && detected.length === 0) {
    log(cyan("   ◆ ") + bold("Web frontend detected ") + dim("(from project files)"));
    log();
  }
}

function formatSkillLabel(skill: string, { styled = false }: { styled?: boolean } = {}): string {
  if (/^https?:\/\//i.test(skill)) {
    return styled ? cyan(skill) : skill;
  }

  const parts = skill.split("/");
  if (parts.length !== 3) {
    return styled ? cyan(skill) : skill;
  }

  const [author, , skillName] = parts;
  if (!styled) {
    return `${author} › ${skillName}`;
  }

  return `${muted(author)} ${gray("›")} ${cyan(bold(skillName))}`;
}

function securityWarningForSkill(skill: string): string | null {
  const check = securityCheckForSkillPath(skill);
  if (check?.status !== "warning") return null;

  const findings = check.findings.map((finding) => finding.trim()).filter(Boolean);
  const detail = [check.summary.trim(), findings.join("; ")].filter(Boolean).join(" ");
  return detail || "The sync review found issues that should be checked.";
}

function printSkillsList(skills: ScoredSkillEntry[]): void {
  const INSTALLED_TAG = " (installed)";
  const SECURITY_TAG = " (security check ⚠)";
  const entries = skills.map((s) => ({
    ...s,
    label: formatSkillLabel(s.skill),
    styledLabel: formatSkillLabel(s.skill, { styled: true }),
    hasSecurityWarning: Boolean(securityWarningForSkill(s.skill)),
  }));
  const maxEffective = Math.max(
    ...entries.map(
      (e) =>
        e.label.length +
        (e.installed ? INSTALLED_TAG.length : 0) +
        (e.hasSecurityWarning ? SECURITY_TAG.length : 0),
    ),
  );
  const newCount = skills.filter((s) => !s.installed).length;
  const installedCount = skills.length - newCount;
  const countLabel =
    installedCount > 0
      ? `(${skills.length}, ${installedCount} already installed)`
      : `(${skills.length})`;
  log(cyan("   ◆ ") + bold(`Skills to install `) + dim(countLabel));
  log();
  for (let i = 0; i < entries.length; i++) {
    const { label, styledLabel, sources, installed, hasSecurityWarning, score } = entries[i];
    const techSources = sources.filter((s) => !s.includes(" + "));
    const installedTag = installed ? dim(INSTALLED_TAG) : "";
    const securityTag = hasSecurityWarning ? yellow(SECURITY_TAG) : "";
    const effectiveLen =
      label.length +
      (installed ? INSTALLED_TAG.length : 0) +
      (hasSecurityWarning ? SECURITY_TAG.length : 0);
    const pad = " ".repeat(maxEffective - effectiveLen);
    const num = String(i + 1).padStart(2, " ");
    const scoreTag = score < SCORE_THRESHOLD ? dim(`[${score}%]`) : dim(`[${score}%]`);
    const sourceSuffix = techSources.length > 0 ? `  ${dim(`← ${techSources.join(", ")}`)}` : "";
    log(dim(`   ${num}.`) + ` ${scoreTag} ${styledLabel}${installedTag}${securityTag}${pad}${sourceSuffix}`);
  }
  log();
}

function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

function extractErrorLines(stderr: string, output: string): string[] {
  const raw = stderr?.trim() || output?.trim() || "";
  const noisePatterns = [
    /^npm\s+(warn|notice|http)\b/i,
    /^npm\s+error\s*$/i,
    /^\s*$/,
    /^>\s/,
    /^added\s+\d+\s+packages/i,
    /^up to date/i,
    /^npm error A complete log of this run/i,
    /^npm error\s+[\w/\\:.-]+debug-\d+\.log$/i,
  ];

  return stripAnsi(raw)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !noisePatterns.some((p) => p.test(l)));
}

function briefErrorReason(stderr: string, output: string): string {
  const lines = extractErrorLines(stderr, output);
  if (lines.length === 0) return "Unknown error";
  const line = lines[0];
  return line.length > 80 ? line.slice(0, 77) + "..." : line;
}

function visiblePad(value: string, width: number): string {
  return value + " ".repeat(Math.max(0, width - stripAnsi(value).length));
}

function truncateVisible(value: string, width: number): string {
  const plain = stripAnsi(value);
  if (plain.length <= width) return value;
  if (width <= 1) return "…";
  return plain.slice(0, width - 1) + "…";
}

function wrapText(value: string, width: number): string[] {
  if (width <= 0) return [value];
  const words = value.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [""];

  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (word.length > width) {
      if (line) {
        lines.push(line);
        line = "";
      }
      for (let i = 0; i < word.length; i += width) {
        lines.push(word.slice(i, i + width));
      }
      continue;
    }

    const next = line ? `${line} ${word}` : word;
    if (next.length > width) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }

  if (line) lines.push(line);
  return lines;
}

function formatSecurityFindings(check: InstallSecurityCheck): string | null {
  const findings = check.findings.map((finding) => finding.trim()).filter(Boolean);
  if (findings.length === 0) return null;

  const summary = check.summary.trim();
  return [summary, findings.join("; ")].filter(Boolean).join(" ");
}

function printSecurityChecks(checks: InstallSecurityCheck[]): void {
  const checksWithFindings = checks
    .map((check) => ({ check, findings: formatSecurityFindings(check) }))
    .filter((entry): entry is { check: InstallSecurityCheck; findings: string } =>
      Boolean(entry.findings),
    );
  if (checksWithFindings.length === 0) return;

  const sorted = checksWithFindings.sort((a, b) => a.check.name.localeCompare(b.check.name));
  const skillWidth = Math.min(34, Math.max(5, ...sorted.map(({ check }) => check.name.length)));
  const checkWidth = 7;
  const terminalWidth = process.stdout.columns || 100;
  const findingsWidth = Math.max(40, terminalWidth - skillWidth - checkWidth - 16);

  log();
  log(cyan("   ◆ ") + bold("Security checks"));
  log();
  log(
    dim(
      `   | ${visiblePad("Skill", skillWidth)} | ${visiblePad("Check", checkWidth)} | ${visiblePad("Findings", findingsWidth)} |`,
    ),
  );
  log(
    dim(
      `   | ${"-".repeat(skillWidth)} | ${"-".repeat(checkWidth)} | ${"-".repeat(findingsWidth)} |`,
    ),
  );

  for (const { check, findings } of sorted) {
    const status = check.status === "warning" ? yellow("warning") : green("ok");
    const lines = wrapText(findings, findingsWidth);
    log(
      `   | ${visiblePad(truncateVisible(check.name, skillWidth), skillWidth)} | ${visiblePad(status, checkWidth)} | ${visiblePad(lines[0], findingsWidth)} |`,
    );
    for (const line of lines.slice(1)) {
      log(
        `   | ${visiblePad("", skillWidth)} | ${visiblePad("", checkWidth)} | ${visiblePad(line, findingsWidth)} |`,
      );
    }
  }
}

interface SummaryOptions {
  installed: number;
  failed: number;
  errors: {
    name: string;
    output: string;
    stderr: string;
    exitCode: number | null;
    command: string;
  }[];
  elapsed: number;
  verbose: boolean;
}

function printSummary({ installed, failed, errors, elapsed, verbose }: SummaryOptions): void {
  log();

  if (failed === 0) {
    log(
      green(
        bold(
          `   ✔ Done! ${installed} skill${installed !== 1 ? "s" : ""} installed in ${formatTime(elapsed)}.`,
        ),
      ),
    );
  } else {
    log(
      yellow(
        `   Done: ${green(`${installed} installed`)}, ${red(`${failed} failed`)} in ${formatTime(elapsed)}.`,
      ),
    );

    if (errors.length > 0) {
      log();
      log(bold(red("   Errors:")));
      for (const { name, output, stderr, exitCode, command } of errors) {
        log(red(`     ✘ ${name}`));

        if (verbose) {
          if (exitCode !== undefined && exitCode !== null) {
            log(dim(`       exit code ${exitCode}`));
          }

          const errorLines = extractErrorLines(stderr, output);
          if (errorLines.length > 0) {
            log();
            for (const line of errorLines.slice(0, 20)) {
              log(dim(`       ${line}`));
            }
            if (errorLines.length > 20) {
              log(dim(`       … (${errorLines.length - 20} more lines)`));
            }
          }

          if (command) {
            log();
            log(dim(`       command: ${command}`));
          }
          log();
        } else {
          const reason = briefErrorReason(stderr, output);
          log(dim(`       ${reason}`));
        }
      }
      log();
      if (!verbose) {
        log(dim("   Run again with --verbose to see the full error details."));
      }
      log(dim(`   If it looks like a skillmaxx bug, please create an issue: ${ISSUES_URL}`));
    }
  }

  log();
  log(pink("   Enjoyed skillmaxx? Consider starring → https://github.com/tokenmaxxing/skillmaxx"));
  log();
}

// ── Skill Selection ──────────────────────────────────────────

async function selectSkills(skills: ScoredSkillEntry[], autoYes: boolean): Promise<SkillEntry[]> {
  if (autoYes) {
    printSkillsList(skills);
    return skills;
  }

  const INSTALLED_TAG = " (installed)";
  const SECURITY_TAG = " (security check ⚠)";
  const labelCache = new Map<
    string,
    { label: string; styledLabel: string; hasSecurityWarning: boolean }
  >();
  for (const s of skills) {
    labelCache.set(s.skill, {
      label: formatSkillLabel(s.skill),
      styledLabel: formatSkillLabel(s.skill, { styled: true }),
      hasSecurityWarning: Boolean(securityWarningForSkill(s.skill)),
    });
  }
  const maxEffective = Math.max(
    ...skills.map((s) => {
      const cached = labelCache.get(s.skill)!;
      return (
        cached.label.length +
        (s.installed ? INSTALLED_TAG.length : 0) +
        (cached.hasSecurityWarning ? SECURITY_TAG.length : 0)
      );
    }),
  );

  const newCount = skills.filter((s) => !s.installed).length;
  const installedCount = skills.length - newCount;
  const countLabel =
    installedCount > 0
      ? `${skills.length} found, ${installedCount} already installed`
      : `${skills.length} found`;
  log(cyan("   ◆ ") + bold(`Select skills to install `) + dim(`(${countLabel})`));
  log();

  const selected = await multiSelect(skills, {
    labelFn: (s) => {
      const { label, styledLabel, hasSecurityWarning } = labelCache.get(s.skill)!;
      const installedTag = s.installed ? " " + dim("(installed)") : "";
      const securityTag = hasSecurityWarning ? yellow(SECURITY_TAG) : "";
      const effectiveLen =
        label.length +
        (s.installed ? INSTALLED_TAG.length : 0) +
        (hasSecurityWarning ? SECURITY_TAG.length : 0);
      return styledLabel + installedTag + securityTag + " ".repeat(maxEffective - effectiveLen);
    },
    hintFn: (s) => {
      const techSources = s.sources.filter((src) => !src.includes(" + "));
      return techSources.length > 1 ? `← ${techSources.join(", ")}` : "";
    },
    groupFn: (s) => s.sources[0],
    initialSelected: skills.map((s) => !s.installed),
    shortcuts:
      installedCount > 0
        ? [
            { key: "n", label: "new", fn: (items: SkillEntry[]) => items.map((s) => !s.installed) },
            {
              key: "i",
              label: "installed",
              fn: (items: SkillEntry[]) => items.map((s) => s.installed),
            },
          ]
        : [],
  });

  if (selected.length === 0) {
    log();
    log(dim("   Nothing selected."));
    log();
    process.exit(0);
  }

  return selected;
}

// ── Shared Logic ─────────────────────────────────────────────

interface AutoskillsFlags {
  yes?: boolean;
  dryRun?: boolean;
  verbose?: boolean;
  deepScan?: boolean;
  clearCache?: boolean;
  agent?: string[];
}

async function runAutoskills(flags: AutoskillsFlags, isRecommend: boolean): Promise<void> {
  const { yes, dryRun, verbose, deepScan, clearCache, agent } = flags;
  const agents = agent ?? [];

  if (clearCache) {
    const { cacheDir, removed } = clearSkillmaxxCache();
    log(
      removed
        ? green(`   ✔ Cleared skillmaxx cache: ${cacheDir}`)
        : dim(`   No skillmaxx cache found: ${cacheDir}`),
    );
    log();
    return;
  }

  await printBanner(VERSION);

  const projectDir = resolve(".");

  write(dim("   Scanning project...\r"));
  const { detected: configDetected, isFrontend, combos } = detectTechnologies(projectDir);
  let detected = configDetected;

  if (deepScan) {
    const deepTechs = runDeepScanners(projectDir);
    if (deepTechs.length > 0) {
      const seenIds = new Set(detected.map((t) => t.id));
      for (const tech of deepTechs) {
        if (!seenIds.has(tech.id)) {
          seenIds.add(tech.id);
          detected.push(tech);
        }
      }
    }
  }
  write("\x1b[K");

  if (detected.length === 0 && !isFrontend) {
    log(yellow("   ⚠ No supported technologies detected."));
    log(dim("   Make sure you run this in a project directory."));
    log();
    return;
  }

  printDetected(detected, combos, isFrontend);

  const installedNames = getInstalledSkillNames(projectDir);
  const skills = collectSkills({ detected, isFrontend, combos, installedNames });
  const scoredSkills = skills.map(computeScore).sort((a, b) => b.score - a.score);
  const prunedSkills = scoredSkills.filter((s) => s.score >= SCORE_THRESHOLD);
  const filteredCount = scoredSkills.length - prunedSkills.length;
  const nameDedup = dedupSkills(prunedSkills);
  const { entries: dedupedSkills, removed: dedupedCount } = dedupSkillsV2(nameDedup.entries, getRegistryDir());
  const removedTotal = nameDedup.removed + dedupedCount;
  const resolvedAgents = agents.length > 0 ? agents : detectAgents();

  if (isRecommend) {
    if (dedupedSkills.length > 0) {
      printSkillsList(dedupedSkills);
    }
    if (filteredCount > 0) {
      log(dim(`   ${filteredCount} skill${filteredCount !== 1 ? "s" : ""} filtered (below ${SCORE_THRESHOLD}% quality threshold)`));
    }
    if (removedTotal > 0) {
      log(dim(`   ${removedTotal} duplicate${removedTotal !== 1 ? "s" : ""} removed`));
    }
    log(dim(`   Agents: ${resolvedAgents.join(", ")}`));
    log();
    return;
  }

  if (dedupedSkills.length === 0) {
    if (filteredCount > 0) {
      log(yellow(`   ⚠ All ${filteredCount} skill${filteredCount !== 1 ? "s" : ""} filtered (below ${SCORE_THRESHOLD}% quality threshold).`));
    } else {
      log(yellow("   No skills available for your stack yet."));
    }
    log(dim("   Check https://github.com/tokenmaxxing/skillmaxx for the latest."));
    log();
    return;
  }

  if (filteredCount > 0 || removedTotal > 0) {
    const parts: string[] = [];
    if (filteredCount > 0) parts.push(`${filteredCount} filtered (below ${SCORE_THRESHOLD}% threshold)`);
    if (removedTotal > 0) parts.push(`${removedTotal} duplicate${removedTotal !== 1 ? "s" : ""} removed`);
    log(dim(`   ${parts.join(", ")}.`));
    log();
  }

  if (!dryRun) {
    setImmediate(loadRegistry);
  }

  if (dryRun) {
    printSkillsList(dedupedSkills);
    log(dim(`   Agents: ${resolvedAgents.join(", ")}`));
    log(dim("   --dry-run: nothing was installed."));
    log();
    return;
  }

  const selectedSkills = await selectSkills(dedupedSkills, yes ?? false);

  log();

  log(cyan("   ◆ ") + bold("Installing skills..."));
  log(dim(`   Agents: ${resolvedAgents.join(", ")}`));
  log();

  const startTime = Date.now();
  const { installed, failed, errors, securityChecks } = await installAll(
    selectedSkills,
    resolvedAgents,
    { verbose },
  );
  const elapsed = Date.now() - startTime;
  const claudeCleanup = cleanupClaudeMd(projectDir);

  if (process.stdout.isTTY && !verbose) {
    const up = selectedSkills.length + 2;
    write(`\x1b[${up}A\r\x1b[K`);
    log(green("   ◆ ") + bold("Done!"));
    write(`\x1b[${selectedSkills.length + 1}B`);
  }

  if (claudeCleanup.cleaned) {
    if (claudeCleanup.deleted) {
      log(dim("   Removed skillmaxx section from CLAUDE.md (file was empty, deleted)."));
    } else {
      log(dim("   Removed skillmaxx section from CLAUDE.md."));
    }
    log();
  }

  printSecurityChecks(securityChecks);
  printSummary({ installed, failed, errors, elapsed, verbose });
}

// ── CLI ──────────────────────────────────────────────────────

const cmd = new Command()
  .name("skillmaxx")
  .version(VERSION)
  .description("Auto-detect and install the best AI agent skills for your project")
  .globalOption("-a, --agent <agent:string>", "Install for specific IDEs only (e.g. cursor, claude-code)", { collect: true })
  .globalOption("--deep-scan", "Deep scan via rg import analysis (slower, more thorough)")
  .globalOption("-v, --verbose", "Show install trace and error details")
  .globalOption("--clear-cache", "Clear downloaded skills cache")
  .option("-y, --yes", "Skip confirmation prompt")
  .option("--dry-run", "Show skills without installing")
  .action((flags) => runAutoskills(flags, false))
  .command("recommend", "Show recommended skills (no install)")
  .action((flags) => runAutoskills(flags, true));

await cmd.parse(process.argv.slice(2));
