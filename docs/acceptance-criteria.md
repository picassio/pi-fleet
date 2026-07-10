# Acceptance Criteria

Grouped by phase (see [roadmap](roadmap.md)). Each criterion is testable; unit/integration criteria run in CI, E2E criteria are a manual pre-release checklist on a real tailnet.

## Phase 0 — Foundations

**AC-0.1 Manifest determinism.** Building a manifest twice from the same bundle directory yields byte-identical JSON and the same `bundleHash` on Linux, macOS, and Windows (path separators and file ordering normalized).

**AC-0.2 Sync correctness.** Given a cached bundle and a manifest where one file changed, one was added, one removed: sync fetches exactly the changed+added files, the resulting cache dir matches the manifest exactly, and the swap is atomic (a killed sync never leaves a half-updated active cache).

**AC-0.3 Path safety.** Sync rejects, with a named error and without writing anything: absolute paths, `..` segments, backslash separators, Windows reserved names (`CON`, `NUL`, `AUX`, `COM1`, `LPT1`, trailing dots/spaces), and any two manifest paths that collide case-insensitively.

**AC-0.4 Frame codec.** Round-trips all v1 frames; splits records on `\n` only; tolerates `\r\n`; a frame containing U+2028/U+2029 inside strings survives intact; oversized frames (> 1 MiB) are rejected with a protocol error, not a crash.

**AC-0.5 CI matrix.** Unit suite green on ubuntu-latest, macos-latest, windows-latest.

## Phase 1 — Worker bootstrap

**AC-1.1 Provision-before-start.** With `PI_FLEET_SERVER` + `PI_FLEET_BUNDLE` set and a reachable registry, a spawned `pi --mode rpc` completes bundle sync **before** `session_start`; `get_state` shows the manifest's model, and the bundle's skills appear in the system prompt.

**AC-1.2 Bundle extension hosting.** A bundle extension registering a tool and a command results in both being callable in the worker (tool via RPC prompt, command via `prompt: "/thecommand"`).

**AC-1.3 Tool allowlist.** With `tools.active: ["read","grep"]`, the worker's active tools are exactly `read` and `grep`.

**AC-1.4 Cache hit.** Re-spawning with an unchanged bundle performs zero file fetches (manifest fetch only) and provisions from cache.

**AC-1.5 Audit record.** After provisioning, the worker session contains a custom entry with bundle name and `bundleHash`.

**AC-1.6 Registry unreachable.** If the registry is unreachable and no cache exists, the worker fails fast with an actionable error; if a cache exists, it starts from cache and reports degraded provisioning.

## Phase 2 — Control plane

**AC-2.1 Tailnet-only binding.** The listener binds the tailscale interface IP; connecting via any other interface (including 127.0.0.1 from a non-exempt path) is refused.

**AC-2.2 Whois gate.** An inbound connection from an unknown tailnet machine triggers exactly one confirm dialog with machine + user identity; deny closes the connection; both decisions persist across restarts.

**AC-2.3 Spawn round-trip.** `spawn { cwd, bundle }` on the control plane returns `spawned { instanceId }`, and the agent's `list` includes the instance with state `running`.

**AC-2.4 RPC forwarding.** A `prompt` RPC command sent through the agent reaches the worker, and the resulting agent events stream back tagged with the correct `instanceId`, in order.

**AC-2.5 Heartbeat expiry.** Killing the network between server and agent marks the agent unreachable on the server within 60 s; workers keep running; reconnect restores control and delivers a fresh instance list.

**AC-2.6 Agent service install.** `/fleet-install-agent` produces a working autostart on all three OSes: after reboot (or service restart), the agent is reachable without manual action.

**AC-2.7 Graceful stop.** `stop` delivers RPC `abort`, closes stdin, and only escalates to kill after a timeout; the worker's session file is intact and resumable afterwards.

## Phase 3 — Fleet tools

**AC-3.1 Single-prompt delegation.** From an interactive server pi, one natural-language prompt causes the model to `remote_spawn` + `remote_prompt` and produce a summary containing the worker's actual result (verified against the worker's session log).

**AC-3.2 Blocking prompt.** `remote_prompt` (blocking variant) returns only after the worker emits `agent_settled`, and its result contains the worker's final assistant message.

**AC-3.3 Parallel workers.** Two workers on different machines run concurrently; `fleet_status` reports both with correct states; outputs do not interleave incorrectly in tool results.

**AC-3.4 Widget accuracy.** The fleet widget reflects worker state transitions (spawning → provisioning → idle → running → settled) within 2 s of the underlying event.

**AC-3.5 Orchestrator restart.** Restarting the server pi while a worker runs: after restart and `/serve`, `fleet_status` re-lists the worker and `remote_output` returns its buffered/settled output via snapshot catch-up.

## Phase 4 — Runtime control

**AC-4.1 Hot rebundle.** `/fleet-use rust-reviewer` on a running worker: session history is preserved, and post-reload the worker's skills/tools match the new bundle's manifest.

**AC-4.2 Live tool narrowing.** `/fleet-tools read,grep` takes effect for the very next turn without a reload.

**AC-4.3 Platform enforcement.** `remote_spawn` of a `platforms: ["linux"]` bundle onto a win32 agent is refused before any process starts, with the platform mismatch named in the error.

**AC-4.4 Pinned spawn.** `remote_spawn` with a pinned `bundleHash` refuses to run if the registry serves a different hash.

## Phase 5 — Observability

**AC-5.1 Follow view.** `/fleet` → select worker → live transcript renders new events with ≤ 1 s lag on a LAN-quality tailnet path; read-only by default.

**AC-5.2 Steer from follow.** Typing in the follow view sends a steer that the worker's log records as delivered through pi's steering queue; machines with policy `allow` (not `steer`) get a refusal instead.

**AC-5.3 Doctor.** `fleet doctor` correctly distinguishes and reports: tailscale down, agent unreachable, whois-denied, bundle cache corrupt (hash mismatch), and all-green.

## Cross-cutting (all phases)

**AC-X.1 No factory side effects.** Loading the extension without using it (plain `pi` startup on the server) opens no sockets, spawns no processes, and starts no timers.

**AC-X.2 Clean shutdown.** `session_shutdown` closes every socket and child the extension opened; repeated shutdown is a no-op; no orphan processes after pi exits (verified on all three OSes).

**AC-X.3 No secrets on the wire or in bundles.** Frames and manifests never carry API keys; workers use their own machine-local pi auth.

**AC-X.4 Version negotiation.** A v1 peer receiving a frame with `v: 2` responds with a protocol error frame and closes cleanly instead of misparsing.
