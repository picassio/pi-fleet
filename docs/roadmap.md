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

- Tools: `remote_spawn`, `remote_prompt` (blocking-until-settled and async variants), `remote_output`, `remote_abort`, `remote_stop`, `fleet_status`
- Live worker events surfaced through `onUpdate()` during blocking calls
- `setWidget("fleet", ...)` dashboard: workers, states, current activity
- Reconnect with backoff; workers survive server pi restarts (agent keeps them alive); snapshot-on-reattach

**Exit:** one natural-language prompt on the server delegates a task to a remote worker and reports the result.

## Phase 4 — Runtime control & custom bundles

**Goal:** live retargeting without respawn.

- `/fleet-use <bundle>` on workers: re-sync + `ctx.reload()` hot-swap
- `/fleet-tools <list>`: narrow/expand active tools mid-session
- Multiple named bundles; `remote_spawn(bundle: "...")`; `platforms` enforcement (refuse mismatched spawns)
- Bundle versioning + pinned-hash spawns

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
