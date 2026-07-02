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

## Layout & working directory

- The **git repo root is the parent directory** (`tokenmaxxing/`): `.github/`, `.githooks/`, `.opencode/`, and the fendo `.npmrc` live there, but there is **no `package.json` at the repo root**.
- All code lives under **`skillmaxx/`**, which is the OpenCode working directory — treat `skillmaxx/` as the project root for every command below.
- Two **independent** pnpm projects (no shared workspace), each with its own `pnpm-lock.yaml` and `node_modules` — install in **both**:
  - `skillmaxx/` — the Astro docs/marketing site (`src/`, `public/`, `astro.config.mjs`).
  - `skillmaxx/packages/skillmaxx/` — the publishable CLI (`index.mjs`, `main.ts`, `skills-registry/`, `tests/`).
- Run CLI scripts from the project root with `pnpm --dir packages/skillmaxx <script>` — this is the pattern every opencode command uses.
- `esbuild`'s build script is the only install script allowlisted (via `allowBuilds` in `packages/skillmaxx/pnpm-workspace.yaml`); that file is not a real workspace manifest.

## Commands

Site (cwd `skillmaxx/`):

- `pnpm dev` / `pnpm build` / `pnpm preview` — Astro site.
- `pnpm og` — regenerate OG images via `scripts/generate-og.mjs`.
- `pnpm lint` / `pnpm lint:fix` — **oxlint** (not eslint).
- `pnpm fmt` / `pnpm fmt:check` — **oxfmt** (not prettier). `skills-registry/**` is excluded via `skillmaxx/.prettierignore` (registry files are SHA-256-hashed, so they must not be reformatted — see **Skill registry** below).

CLI (cwd `skillmaxx/`, via `pnpm --dir packages/skillmaxx`):

- `pnpm --dir packages/skillmaxx test` — `node --test 'tests/*.test.ts'` (Node built-in runner).
- Single test: `pnpm --dir packages/skillmaxx exec node --test tests/<name>.test.ts` (or `node --test tests/<name>.test.ts` if your cwd is already `packages/skillmaxx/`).
- `pnpm --dir packages/skillmaxx build` — **esbuild** bundles `main.ts` → `dist/main.js` (not tsc). Only needed for publishing; the CLI runs from source without it.
- `pnpm --dir packages/skillmaxx typecheck` — `tsc --noEmit` (separate from `build`).
- `pnpm --dir packages/skillmaxx validate:registry` — verify skill-registry hashes (also runs in `prepublishOnly` and `release`).
- `pnpm --dir packages/skillmaxx sync:skills` — sync skills into the local registry from upstream.
- `pnpm --dir packages/skillmaxx release <patch|minor|major>` — guards on `main` + clean tree, then validate:registry → tests → changelog → commit/tag → `npm publish` → `gh release create`. Only from `main` with a clean tree.

Full local verification (the `check` opencode command):

1. `pnpm lint`
2. `pnpm fmt:check`
3. `pnpm --dir packages/skillmaxx build`
4. `pnpm --dir packages/skillmaxx test`
5. `pnpm --dir packages/skillmaxx validate:registry`

CI (`.github/workflows/`): `ci.yml` runs **lint → fmt:check** (from `skillmaxx/`) then **tests** (from `skillmaxx/packages/skillmaxx/`) on Node 22; `compat.yml` re-runs tests plus an E2E install on Win/macOS/Linux. Both install with `--frozen-lockfile` and set `cache-dependency-path` to the lockfile in each subdir. The local `check` opencode command mirrors the lint + test steps.

## Node & TypeScript

- Node **>= 22.6.0** for the CLI (runs `.ts` via `--experimental-strip-types`); **>= 22.12.0** for the site. CI uses Node 22.
- `index.mjs` runs `dist/main.js` if present, else imports `./main.ts` via type stripping (re-spawning with `--experimental-strip-types` on older Node). **No build needed to run or test.**
- CLI `tsconfig` enforces `verbatimModuleSyntax` (use `import type` for type-only imports) and `rewriteRelativeImportExtensions` (relative imports use the **`.ts`** extension in source, e.g. `from "./colors.ts"`; tsc rewrites to `.js` under `dist/`). `erasableSyntaxOnly` and `strict` are also on.

## Testing

- Uses `node:test` and `node:assert/strict`. **Destructure** the assert functions you need — do not import the default `assert`:

```js
import { ok, strictEqual } from "node:assert/strict"; // ✅
// import assert from "node:assert/strict"; assert.ok(value); // ❌
```

- Reuse the shared helpers in `tests/helpers.ts` (`useTmpDir`, `writePackageJson`, `writeJson`, `writeFile`, `addWorkspace`) instead of redoing filesystem setup.

## Output helpers (CLI package only)

- In `packages/skillmaxx`, never use `console.log` or `process.stdout.write` directly. Import `log` and `write` (plus color helpers) from `./colors.ts`:

```js
import { log, write } from "./colors.ts";
```

## Skill registry

- `packages/skillmaxx/skills-registry/` holds ~220 curated skill payloads, each with its own `AGENTS.md` (e.g. `react-best-practices/AGENTS.md`). Those are **skill content delivered to end users, not instructions for working in this repo** — do not treat them as repo guidance.
- Maintain the registry with `sync:skills` then `validate:registry`. Don't hand-edit skill files or manifest hashes: `skills-registry/index.json` carries SHA-256 entries that must match, and `validate:registry` fails otherwise.
- `dist/` and `scripts/sync-skills.report.json` are gitignored build/report artifacts.
- ⚠️ The registry is excluded from oxfmt via `skillmaxx/.prettierignore`. oxfmt reformats embedded JS inside the registry `.md` files, and every skill's files are SHA-256-hashed in the manifest — so **do not remove that ignore** (or `pnpm fmt` would break `validate:registry`), and don't hand-format registry files. The pre-commit hook skips the registry via the same ignore.

## Git workflow

- A pre-commit hook (`.githooks/pre-commit` at the repo root) resolves the repo root, filters staged files to `skillmaxx/`, runs `pnpm run fmt:staged` (oxfmt) from `skillmaxx/` (so `.prettierignore` excludes the registry), then re-stages. Install it once with `pnpm run hooks:install`.
- No `--no-verify`, no amending, no force-push. Group unrelated changes into separate semantic commits.

## OpenCode commands

`.opencode/command/` wraps the workflows above: `check` (full verification), `test` (filtered/hinted run), `fix` (fmt + lint:fix), `registry` (sync + validate), `publish` (release), `commit-all` (semantic commits + push). Prefer them for interactive runs.
