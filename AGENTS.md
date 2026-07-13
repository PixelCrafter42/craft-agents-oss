# Craft Agents repository guidance

## Scope and communication

- This file applies repository-wide. A closer `AGENTS.md` or package guide may add or override rules for its subtree.
- Default to Chinese with this maintainer. Lead with outcomes, keep progress updates concise, and explain material trade-offs or blockers plainly.
- Historical sessions are context, not truth. Verify against current code, tests, `package.json`, and Git history.
- The app's Claude/Pi agents load this file only when the Session `workingDirectory` is this repo. If it is missed, check that first; loading lives in `packages/shared/src/prompts/system.ts`.
- Keep this document durable and below 10 KiB. Do not add task logs, temporary failure counts, model prices, or other fast-changing facts.
- Nested guide bodies are not all injected automatically; read the relevant one before package work. `packages/shared/CLAUDE.md`, `packages/core/CLAUDE.md`, and `apps/electron/resources/AGENTS.md` contain hard rules. `apps/electron/README.md` is a historical overview, so current code and scripts win.

## Product, fork, and repository map

- Craft Agents is a Bun + TypeScript monorepo. Electron is the primary UI, alongside headless, WebUI, CLI, agent-runtime, session-tool, and messaging packages.
- `origin` is the maintainer's customized repository; `upstream` is `craft-ai-agents/craft-agents-oss`. Preserve local behavior during upstream merges and resolve conflicts semantically, never by blindly choosing all of `ours` or `theirs`.
- Preserve local tray, model-fallback, automation/webhook/messaging, browser-cookie, Project/Employee, usage, xAI/Grok, and app-asset behavior.
- Work normally lands on the maintainer's `main`. Commit only when asked and audit the staged scope. Never push, open a PR, rewrite refs, or modify `upstream` without explicit authorization.
- Key paths:
  - `apps/electron`: main/preload/renderer, BrowserPane, packaging; other `apps/*` are secondary clients.
  - `packages/core`: stable types; `shared`: business logic; `server-core`: `SessionManager`, RPC, tasks, services.
  - `packages/pi-agent-server`: Pi/xAI subprocess; `session-*`: tools/MCP; `messaging-*`: gateways/workers; `ui`: shared React.
- App config defaults to `~/.craft-agent/` but `CRAFT_CONFIG_DIR` can override it, and Workspace data may use a custom path. Never commit credentials, workspace/session data, cookies, local `.env`, or generated packaging artifacts.

## Core invariants

### Sessions, Projects, Employees, and Tasks

- Projects and Employees are workspace-scoped; Sessions bind them independently. Projects supply context/assets/memory/Kanban; Employees supply identity/memory/default skills and sources.
- Bound prompts must receive the right Project/Employee context without crossing workspace boundaries.
- `spawn_session` inherits the parent Employee or resolves an explicit ID, slug, or unambiguous name. Keep old callers compatible.
- Use `send_agent_message` for inter-session cooperation instead of silently reading another Employee's whole history. Its accepted-first semantics release the sender once the target accepts/queues; never wait for the target's full turn.
- `SessionManager` owns lifecycle. Restarts, retries, fallback, cancellation, and handoff must prevent stale generations or late complete/error callbacks from overwriting current state.

### Models and fallback

- Fallback candidates are ordered `{ connectionSlug, model }`. Success changes only the active Session, not workspace/global defaults.
- Refresh expired OAuth before fallback. Retry only eligible provider/auth/network/rate-limit/model-availability errors.
- Never replay after assistant text, plans, tool calls, or other side-effect-capable output begins, and never duplicate the persisted user message.
- Cross-connection fallback clears provider resume/session IDs and uses bounded recovery context; same-connection changes may retain compatible state.
- Prefer the Pi path for new vendors unless a distinct backend is required. Preserve explicit per-model capability overrides end to end.
- Model IDs, prices, payloads, and SDK behavior are time-sensitive; verify primary docs and installed versions.

### Automations, webhooks, and messaging

- Automation Prompt matchers create a new Session by default. `targetSessionId` wins; `reuseSession: true` persists matcher-to-session state and recreates missing targets.
- Automation test mode must not touch production reuse state. After restart, reused Sessions must restore messaging bindings.
- Use canonical matcher helpers; do not implement partial matching again.
- Webhook config is non-secret; secrets use encrypted credentials. Preserve one-time verification, serialize enrollment, and redact auth material.
- Connectors own platform auth/transport; Bindings map external chats to Sessions. Keep platform differences in adapters and automation routing neutral.
- Workspace is the connector/credential isolation boundary. Reconnect must remove old listeners and bindings to prevent duplicate sends.
- Multiple bindings do not imply multiple bot accounts. Check credential/registry keys, schema, and lifecycle before changing multi-account behavior.
- Automation generation and external delivery are separate outcomes; verify both Session/history and messaging delivery paths.

### Usage, storage, and credentials

- Usage is an append-only, ID-deduplicated workspace ledger at `usage/YYYY-MM.jsonl`; deleting a Session does not erase usage.
- Usage must exclude prompts, responses, titles, credentials, and message bodies. Prefer exact provider data, then versioned price-snapshot estimates, otherwise unknown; keep tool/API usage separate.
- Storage changes must be atomic, migration-safe, workspace-scoped, and backward-compatible. Validate slugs/IDs at RPC and storage boundaries; block path traversal.
- All secrets use credential-manager paths and stay redacted from logs, errors, fixtures, and UI state.
- Browser cookies come from Electron's session cookie API (including HttpOnly) and must be scoped to the bound browser plus URL/domain/name filters. Never dump a partition by default.

### Electron and UI

- Renderer code cannot import Node-only modules. Use typed preload/RPC APIs and update protocol, channels, handlers, clients/hooks, and tests together.
- All user-facing strings use i18n. Keep locales sorted and in parity; follow `packages/shared/CLAUDE.md`.
- BrowserPane toolbar state uses `toolbarView.webContents`; readiness is its valid document's `did-finish-load`. `did-create-window` is `(window, details)`, and teardown claims the instance before best-effort cleanup to prevent re-entry.
- Preserve macOS tray semantics: native close may hide, explicit Quit destroys; keep `Cmd+W`, Dock, tray, and Quit behavior distinct.
- Icon changes update macOS, Windows, and common PNG assets together; do not redesign without authorization.

## Working method

- Inspect `git status`, relevant guides, implementation, and nearby tests before editing. Preserve unrelated user changes.
- For cross-layer work trace: schema -> exports -> runtime -> RPC/channel -> preload/client -> UI/CLI -> migration/tests.
- Reuse canonical helpers for matching, filtering, usage, entity resolution, storage, credentials, and transport routing.
- Add a regression test for the observed failure, including restart/retry/cleanup when persistent state or subprocesses are involved.
- Do not normalize historical bugs as baselines. If full tests fail but isolated tests pass, report both and investigate shared state, global mocks, ports, env, and config-directory pollution.

## Commands and verification

Run from the repository root unless noted:

```bash
bun install
bun run electron:dev
bun test path/to/affected.test.ts
bun run typecheck:all
bun run test
bun run lint
git diff --check
```

- Iterate with targeted tests and package typechecks; finish proportionally to risk. `bun run test` is the canonical full script and includes `*.isolated.ts`.
- Focused checks: `cd apps/electron && bun run typecheck`, `cd packages/shared && bun run tsc --noEmit`, `cd packages/server-core && bun run typecheck`, `cd packages/pi-agent-server && bun run typecheck`.
- For i18n run `bun run lint:i18n:parity`, `bun run lint:i18n:sorted`, and `bun run lint:i18n:coverage`.
- Tests touching global Craft config need a temporary `CRAFT_CONFIG_DIR`. Bun `mock.module` can leak across suites; an isolated pass is diagnostic, not a green full run.
- Renderer/UI changes should get a relevant production build when practical.
- For Apple Silicon packaging, inspect current scripts and `.craft-agent/notes/mac-packaging.md`. Overwrite and verify the arm64 DMG; package/install/launch only when asked.
- Under `apps/electron/resources`, follow its nested guide. User-visible changes go in `apps/electron/resources/release-notes/next.md`; never invent a versioned release-note file in feature work.

## Upstream merges

- Fetch both remotes and inspect the exact range. Preserve local features and any existing worktree changes.
- Reconcile storage schemas, protocol/channel maps, `SessionManager`, navigation, i18n, packaging assets, and lockfile/workspace changes deliberately.
- Run conflict-area tests, then typechecks, lint/i18n, and the canonical full test. Summarize preserved local behavior, adopted upstream behavior, migrations, and gaps. Never push unless asked.
