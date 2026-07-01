import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import type { Technology } from "./skills-map.ts";

export interface Scanner {
  name: string;
  description: string;
  scan: (dir: string) => Technology[];
}

function rg(pattern: string, dir: string): boolean {
  try {
    const result = spawnSync("rg", ["-l", pattern, "--glob", "!node_modules", "--glob", "!.git", dir], {
      encoding: "utf-8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return (result.stdout ?? "").trim().length > 0;
  } catch {
    return false;
  }
}

const workflowScanner: Scanner = {
  name: "workflows",
  description: "GitHub Actions workflow files",
  scan(dir: string): Technology[] {
    const workflowsDir = join(dir, ".github", "workflows");
    if (!existsSync(workflowsDir)) return [];
    try {
      const files = readdirSync(workflowsDir);
      const hasYml = files.some((f) => f.endsWith(".yml") || f.endsWith(".yaml"));
      if (!hasYml) return [];
      return [
        {
          id: "github-actions",
          name: "GitHub Actions",
          detect: {},
          skills: [],
        },
      ];
    } catch {
      return [];
    }
  },
};

const dockerScanner: Scanner = {
  name: "docker",
  description: "Dockerfile and docker-compose",
  scan(dir: string): Technology[] {
    const files = ["Dockerfile", "docker-compose.yml", "docker-compose.yaml", "compose.yaml", "Dockerfile.*"];
    for (const f of files) {
      if (f.includes("*")) {
        try {
          const dirEntries = readdirSync(dir);
          if (dirEntries.some((e) => e.startsWith("Dockerfile."))) {
            return [{ id: "docker", name: "Docker", detect: {}, skills: [] }];
          }
        } catch {}
      } else if (existsSync(join(dir, f))) {
        return [{ id: "docker", name: "Docker", detect: {}, skills: [] }];
      }
    }
    return [];
  },
};

const makefileScanner: Scanner = {
  name: "makefile",
  description: "Makefile / CMakeLists.txt",
  scan(dir: string): Technology[] {
    if (existsSync(join(dir, "Makefile")) || existsSync(join(dir, "CMakeLists.txt"))) {
      return [{ id: "make", name: "Make", detect: {}, skills: [] }];
    }
    return [];
  },
};

const importScanner: Scanner = {
  name: "deep-imports",
  description: "Source-level import analysis (rg)",
  scan(dir: string): Technology[] {
    const found: Technology[] = [];

    if (rg('from "react"', dir) || rg("from 'react'", dir) || rg('require("react")', dir)) {
      found.push({ id: "react", name: "React", detect: {}, skills: [] });
    }
    if (rg('from "next"', dir) || rg("from 'next'", dir) || rg('from "next/', dir)) {
      found.push({ id: "nextjs", name: "Next.js", detect: {}, skills: [] });
    }
    if (rg('from "vue"', dir) || rg("from 'vue'", dir)) {
      found.push({ id: "vue", name: "Vue", detect: {}, skills: [] });
    }
    if (rg('from "@nestjs/', dir)) {
      found.push({ id: "nestjs", name: "NestJS", detect: {}, skills: [] });
    }
    if (rg('from "express"', dir) || rg("from 'express'", dir)) {
      found.push({ id: "express", name: "Express", detect: {}, skills: [] });
    }
    if (rg('from "hono"', dir) || rg("from 'hono'", dir)) {
      found.push({ id: "hono", name: "Hono", detect: {}, skills: [] });
    }
    if (rg('from "zod"', dir) || rg("from 'zod'", dir)) {
      found.push({ id: "zod", name: "Zod", detect: {}, skills: [] });
    }

    return found;
  },
};

export const DEEP_SCANNERS: Scanner[] = [
  workflowScanner,
  dockerScanner,
  makefileScanner,
  importScanner,
];

export function runDeepScanners(dir: string): Technology[] {
  const seen = new Set<string>();
  const result: Technology[] = [];

  for (const scanner of DEEP_SCANNERS) {
    try {
      const techs = scanner.scan(dir);
      for (const tech of techs) {
        if (!seen.has(tech.id)) {
          seen.add(tech.id);
          result.push(tech);
        }
      }
    } catch {}
  }

  return result;
}
