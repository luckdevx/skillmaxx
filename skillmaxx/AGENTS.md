# AGENTS

<!-- fendo:start -->

## Supply Chain Security

This project has been hardened against supply chain attacks using [fendo](https://github.com/midudev/fendo).

### Rules for AI assistants and contributors

- **Never use `^` or `~`** in dependency version specifiers. Always pin exact versions.
- **Always commit the lockfile** (`pnpm-lock.yaml`). Never delete it or add it to `.gitignore`.
- **Install scripts are disabled**. If a new dependency requires a build step, it must be explicitly approved.
- **New package versions must be at least 1 day old** before they can be installed (release age gating is enabled).
- When adding a dependency, verify it on [npmjs.com](https://www.npmjs.com) before installing.
- Prefer well-maintained packages with verified publishers and provenance.
- Run `pnpm install` with the lockfile present — never bypass it.
- Do not add git-based or tarball URL dependencies unless explicitly approved.
- **Do not run `npm update`**, `npx npm-check-updates`, or any blind upgrade command. Review each update individually.
- **Use deterministic installs**: prefer `pnpm install --frozen-lockfile` over `pnpm install` in CI and scripts.
<!-- fendo:end -->

## Repository layout

- The project root holds the Astro docs/marketing site (`src/`, `public/`, `astro.config.mjs`). The publishable CLI lives in `packages/skillmaxx/`.
- These are **two independent pnpm projects, not a workspace** (no `pnpm-workspace.yaml`). Each has its own `pnpm-lock.yaml` and `node_modules` — install in both places; a root install does not cover the CLI.
- Run CLI scripts from anywhere with `pnpm --dir packages/skillmaxx <script>` (the pattern used by this repo's opencode commands).

## Commands

Site (from project root):

- `pnpm dev` / `pnpm build` / `pnpm preview` — Astro site
- `pnpm og` — regenerate OG images via `scripts/generate-og.mjs`
- `pnpm lint` / `pnpm lint:fix` — **oxlint** (not eslint)
- `pnpm fmt` / `pnpm fmt:check` — **oxfmt** (not prettier, despite the legacy `.prettierignore` file)

CLI (from `packages/skillmaxx/`, or via `pnpm --dir packages/skillmaxx`):

- `pnpm test` — `node --test 'tests/*.test.ts'` (Node built-in runner)
- Single test: `node --test tests/<name>.test.ts`
- `pnpm build` — `tsc` → `dist/`. Only needed for publishing; the CLI runs from source without it.
- `pnpm validate:registry` — verify skill-registry hashes (also runs on `prepublishOnly`)
- `pnpm sync:skills` — sync skills into the local registry from upstream
- `pnpm release <patch|minor|major>` — registry validate + tests + changelog + commit/tag + npm publish + GitHub Release; only from `main` with a clean tree

Full local verification (mirrors CI and the `check` opencode command):

1. `pnpm lint`
2. `pnpm fmt:check`
3. `pnpm --dir packages/skillmaxx build`
4. `pnpm --dir packages/skillmaxx test`
5. `pnpm --dir packages/skillmaxx validate:registry`

## Node & TypeScript

- Node **>= 22.6.0** for the CLI (it runs `.ts` via `--experimental-strip-types`). The site requires >= 22.12.0; CI uses Node 22.
- `index.mjs` runs `dist/main.js` if present, else imports `./main.ts` via type stripping (re-spawning with `--experimental-strip-types` on older Node). **No build needed to run or test.**
- CLI `tsconfig` enforces `verbatimModuleSyntax` (use `import type` for type-only imports) and `rewriteRelativeImportExtensions` (relative imports use the **`.ts`** extension in source, e.g. `from "./colors.ts"`; tsc rewrites to `.js` under `dist/`).

## Testing

- Uses `node:test` and `node:assert/strict`. **Destructure** the assert functions you need — do not import the default `assert`.

```js
// ✅
import { ok, strictEqual } from "node:assert/strict";
ok(value);
// ❌
import assert from "node:assert/strict";
assert.ok(value);
```

- Reuse the shared helpers in `tests/helpers.ts` (`useTmpDir`, `writePackageJson`, `writeJson`, `writeFile`, `addWorkspace`) instead of redoing filesystem setup.

## Output helpers (CLI package only)

- In `packages/skillmaxx`, never use `console.log` or `process.stdout.write` directly. Import `log` and `write` (plus color helpers) from `./colors.ts`.

```js
import { log, write } from "./colors.ts";
log("hello");
write("raw output\n");
```

## Skill registry

- `packages/skillmaxx/skills-registry/` contains curated skill payloads. Each skill ships its own `AGENTS.md` (e.g. `react-best-practices/AGENTS.md`). Those are **skill content delivered to end users, not instructions for working in this repo** — do not treat them as repo guidance.
- Maintain the registry with `sync:skills` then `validate:registry`. Don't hand-edit skill files or manifest hashes: the manifest's SHA-256 entries must match, and `validate:registry` fails otherwise.
- `dist/` and `scripts/sync-skills.report.json` are gitignored build/report artifacts.

## Git workflow

- A pre-commit hook (`.githooks/pre-commit`) runs `pnpm run fmt:staged` (oxfmt) on staged files and re-stages them. Install it once with `pnpm run hooks:install` (from the project root).
- No `--no-verify`, no amending, no force-push. Group unrelated changes into separate semantic commits.

## OpenCode commands

`.opencode/command/` wraps the workflows above: `check` (full verification), `test` (filtered run), `fix` (fmt + lint:fix), `registry` (sync + validate), `publish` (release), `commit-all` (semantic commits + push). Prefer them for interactive runs.
