# Roadmap

Phased so every phase ends in something usable on its own. Later phases never require redesigning earlier wire formats: the frame protocol and bundle manifest are versioned from day one.

## Phase 0 — Foundations (no network)

**Goal:** the pieces every platform shares, verifiable in CI without a tailnet.

- Bundle manifest format (`manifest.json`: name, version, content hashes, tool allowlist, model defaults, `platforms` field)
- Bundle sync engine: manifest diff → fetch changed files → atomic cache swap at `~/.pi/agent/fleet-cache/<hash>/`
- Path-safety rules: POSIX manifest paths, zip-slip rejection, Windows reserved names, case-collision detection
- Frame protocol types + JSONL codec (strict `\n`, tolerate `\r`)
- Cross-platform helpers: tailscale CLI discovery, `pi` command resolution (`.cmd` on Windows)
- Unit tests for all of the above; CI matrix: ubuntu / macos / windows

**Exit:** `npm test` green on all three OSes.

## Phase 1 — Worker bootstrap (single machine)

**Goal:** a spawned pi provisions itself from a local bundle directory.

- Worker-mode async extension factory: read `PI_FLEET_SERVER` / `PI_FLEET_BUNDLE` env, sync bundle, contribute `skillPaths`/`promptPaths` via `resources_discover`
- Bundle extension hosting: jiti-import bundle extensions, invoke their factories against the fleet extension's `ExtensionAPI`
- Apply manifest tool allowlist via `setActiveTools()`, model/thinking defaults
- Provisioning record persisted with `appendEntry` (bundle name + hash) for auditability

**Exit:** `PI_FLEET_BUNDLE=default pi --mode rpc` starts with the bundle's skills, extensions, and tools active — bundle served from a local `file://` registry.

## Phase 2 — Server mode + control plane (tailnet)

**Goal:** two machines, manual control.

- `/serve` command: TCP + HTTP listener bound to the tailscale IP only
- `tailscale whois` gate on every inbound connection; per-machine allow/deny persisted in `~/.pi/agent/pi-fleet.json`; first-contact confirm dialog
- Bundle registry served over HTTP (manifest + per-file fetch)
- Fleet agent daemon: `spawn` / `stop` / `list` for `pi --mode rpc` child processes, RPC stream multiplexing
- `/fleet-install-agent`: generate systemd unit / launchd plist / scheduled task

**Exit:** from machine A, spawn a provisioned worker on machine B and drive it with raw RPC JSON.

## Phase 3 — pi as orchestrator (LLM fleet tools)

**Goal:** the local pi's model drives the fleet.

- Tools: `remote_spawn`, `remote_prompt` (blocking-until-settled and async variants), `remote_output`, `remote_abort`, `remote_stop`, `remote_accept`, `remote_reject`, `fleet_status`
- Review file channel: `remote_diff`, `remote_read` (text + images as `ImageContent`), `remote_ls`, `remote_grep` — agent-answered, zero worker tokens, cwd-scoped, read-only
- Task completion layer: `task_done` with agent-side disk outbox (at-least-once + ack + dedupe), orchestrator wake-up via injected `fleet-task-done` message (`triggerTurn`), `awaiting_review` → verify → accept/reject revision loop with `maxRejects` escalation
- Work delivery: `remote_accept { deliver: branch | pr | patch | none }`; worktree-per-task isolation (agent-managed `git worktree`, cleanup after delivery)
- Extension-UI forwarding: `ui_request`/`ui_response`, bundle `ui.autoAnswer` policy, human escalation, timeout → safe default + `escalated`
- Budgets: manifest `budget {maxCost, maxTurns, maxMinutes}` enforced by the agent; machine `maxWorkers`; cost burn in `fleet_status`
- Agent resilience: disk instance registry, orphan re-adoption on agent restart, version-skew reporting in `hello` + doctor
- Live worker events surfaced through `onUpdate()` during blocking calls
- `setWidget("fleet", ...)` dashboard: workers, states, current activity
- Reconnect with backoff; workers survive server pi restarts (agent keeps them alive); snapshot-on-reattach

**Exit:** one natural-language prompt on the server delegates a task to a remote worker and reports the result.

## Phase 3.5 — Sessions: baselines & registry

**Goal:** warm-context task starts and fleet-wide session discovery.

- Session registry: `sessions_report` reconciliation, server-side projection, auto-naming (`baseline:<repo>`, `task:<taskId>:<slug>`), `parentSession` lineage
- Baseline workflow: `remote_baseline` (prime → compact → name → pin), clone-on-spawn via `fromSession`, `baseline_stale` detection against git HEAD
- `remote_resume` (clone-by-default, attach for unpinned), `fleet_sessions` tool, `/fleet-sessions` picker, `session_search` (agent-local grep)
- Durable event cursor: reattach catch-up via `get_entries { since }`

**Exit:** two tasks spawned from one compacted baseline start with the repo already "understood"; after a server restart, `/fleet-sessions` finds and resumes the right session.

## Phase 4 — Runtime control & custom bundles

**Goal:** live retargeting without respawn.

- `/fleet-use <bundle>` on workers: re-sync + `ctx.reload()` hot-swap
- `/fleet-tools <list>`: narrow/expand active tools mid-session
- Multiple named bundles; `remote_spawn(bundle: "...")`; `platforms` enforcement (refuse mismatched spawns)
- Bundle versioning + pinned-hash spawns
- Model control: manifest `model.primary`/`fallbacks`/`pin` resolution at bootstrap, `remote_model` runtime tool, `model_select` drift reporting, per-machine model availability in `fleet_status`
- `/fleet-settings` TUI (SettingsList): serving, trust table, default bundle, review, widget mode; config precedence spawn > bundle > machine

**Exit:** switch a running worker from `default` to `rust-reviewer` from the server without losing its session.

## Phase 5 — Observability & polish

- `/fleet` interactive TUI view (worker list → attach → live transcript, read-only follow)
- Steering from the follow view (typed input → `steer` frames)
- Structured logs; `fleet doctor` diagnostics (tailscale up? agent reachable? bundle hash match?)
- Docs: bundle authoring guide, mixed-OS fleet guide

## Explicit non-goals (for now)

- Public-internet relay (tailnet only; a relay can be added later behind the same frame protocol)
- Multi-user fleets / ACLs beyond tailnet + whois allowlist
- Web/phone viewer (possible later: HTTP page on the server listener)
- Windows workers running Unix-assuming bundles (mitigated by `platforms` manifest field, not solved)

## Backlog (acknowledged, not scheduled)

- Task queueing/scheduling when `maxWorkers` is hit (v1 refuses)
- Off-TUI notifications (ntfy/telegram/webhook) for task_done/escalations while away
- Crash-log collection from dead workers (`stderr` capture shipping)
- Self-update of the fleet package across machines
