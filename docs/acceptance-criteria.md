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

**AC-2.2a Server pinning.** An agent installed with `--server laptop` refuses a connection from any other tailnet machine (including one with an `allow` policy on the server side) without prompting; only a local re-install changes the pin.

**AC-2.2b Faux-provider E2E.** The CI loopback suite drives spawn → provision → prompt → tool call → task_done → reject → revise → accept → deliver end-to-end using the faux-provider bundle, with no network LLM calls (asserted by the fake's call log) on all three OSes.

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

**AC-3.4a File service scope.** `fs_read`/`fs_list`/`fs_grep`/`fs_diff` resolve paths inside the instance cwd only: absolute paths outside it, `..` traversal, and symlinks pointing outside are refused with a named error; `fsAccess: off` disables the service for that machine.

**AC-3.4b Zero worker involvement.** A `remote_read`/`remote_diff` during review adds no entries to the worker's session file and triggers no worker LLM call (verified by comparing session bytes before/after).

**AC-3.4c Image review.** `remote_read` of a PNG in the worker cwd returns base64+mime, surfaces as `ImageContent` in the server tool result, and renders in the server TUI; files over the cap are refused with size info instead of truncated silently.

**AC-3.4d Truncation parity.** Text `remote_read` obeys pi's 50 KB / 2000-line truncation with working `offset`/`limit` paging; a 200k-line file is readable in pages without context overflow.

**AC-3.5 Durable completion.** With the server pi stopped, a worker finishing its task causes the agent to persist `task_done` in the outbox; after the server restarts and reconnects, the notification is delivered exactly once (duplicates deduped by `taskId`+`seq`) and the orchestrator LLM is woken via the injected `fleet-task-done` message.

**AC-3.6 Ack contract.** `task_done` entries remain in the agent outbox across agent restarts until `task_done_ack` is received; after ack, the entry is gone and is never re-sent.

**AC-3.7 Verification loop.** On `task_done`, the worker parks in `awaiting_review` with its process alive; `remote_reject(feedback)` delivers the feedback to the same session (history preserved) and returns it to `running`; `remote_accept` with `disposition: "stop"` gracefully stops it. Exceeding `maxRejects` (default 3) moves the task to `escalated` and notifies the user instead of re-prompting.

**AC-3.8 Orchestrator restart.** Restarting the server pi while a worker runs: after restart and `/serve`, `fleet_status` re-lists the worker and `remote_output` returns its buffered/settled output via snapshot catch-up.

**AC-3.9 Delivery modes.** `remote_accept` with `deliver: "branch"` results in a pushed `fleet/task-<id>` branch whose diff equals the worker's accepted diff; `"patch"` applies cleanly server-side for a change that touches no files modified on the server since spawn; `"pr"` on a machine without `gh` credentials fails with an actionable error before any commit is pushed.

**AC-3.10 Worktree isolation.** Two concurrent tasks in the same repo run in separate worktrees, produce independent diffs, and never see each other's uncommitted changes; worktrees are removed after delivery, and an aborted task's worktree is cleaned up on the next agent sweep.

**AC-3.11 UI forwarding.** A bundle extension calling `ctx.ui.confirm` in a worker surfaces on the server within 2 s (auto-answered if `ui.autoAnswer` matches, else human dialog); an unanswered request times out to the safe default and moves the task to `escalated` — the worker never hangs indefinitely.

**AC-3.12 Budget enforcement.** A task exceeding `maxCost` (or `maxTurns`/`maxMinutes`) is aborted; `task_done { status: "budget_exceeded" }` flows through normal review; enforcement fires within one turn of the breach.

**AC-3.13 Orphan re-adoption.** Restarting the agent while two workers run: both are re-adopted (same instanceIds, control resumes) with zero duplicate processes; a worker that died during the outage is reported `stopped` with its session path intact and resumable.

**AC-3.14 Spawn cap.** Spawns beyond `maxWorkers` are refused with the current count in the error; no process is started.

## Phase 3.5 — Sessions: baselines & registry

**AC-3.5.1 Baseline creation.** `remote_baseline(host, cwd)` produces a session that is primed (priming prompt ran), compacted, named `baseline:<repo>`, registered with `kind: baseline`, pinned, and stamped with the repo's git HEAD.

**AC-3.5.2 Clone-on-spawn.** `remote_spawn(..., fromSession: baseline)` runs the task in a **new** session file whose `parentSession` is the baseline; the baseline file's bytes are unchanged after the task completes; the clone's first context includes the baseline's compacted summary.

**AC-3.5.3 Pin protection.** `remote_resume(baseline, { mode: "attach" })` is refused for pinned sessions with a named error; `mode: "clone"` succeeds.

**AC-3.5.4 Registry reconciliation.** After an agent restart or reconnect, `sessions_report` brings the server projection to exact agreement with `SessionManager.listAll()` on the agent (no ghosts, no missing sessions), including sessions created while the server was offline.

**AC-3.5.5 Search locality.** `session_search` returns matching session refs + snippet hits; full JSONL content never crosses the wire (verified by frame inspection in tests).

**AC-3.5.6 Stale baseline.** Advancing the worker repo past the baseline's recorded git HEAD flags `baseline_stale` in `fleet_status`; spawning from a stale baseline succeeds but the spawn result carries the staleness warning.

**AC-3.5.7 Cursor catch-up.** After a server restart mid-task, reattach uses `get_entries { since: <last seen id> }` and receives exactly the entries emitted during the outage — no duplicates, no gaps (verified against the worker's session file).

## Phase 4 — Runtime control

**AC-4.1 Hot rebundle.** `/fleet-use rust-reviewer` on a running worker: session history is preserved, and post-reload the worker's skills/tools match the new bundle's manifest.

**AC-4.2 Live tool narrowing.** `/fleet-tools read,grep` takes effect for the very next turn without a reload.

**AC-4.3 Platform enforcement.** `remote_spawn` of a `platforms: ["linux"]` bundle onto a win32 agent is refused before any process starts, with the platform mismatch named in the error.

**AC-4.4 Pinned spawn.** `remote_spawn` with a pinned `bundleHash` refuses to run if the registry serves a different hash.

**AC-4.5 Model fallback.** On a machine lacking the primary model's key but holding a fallback's key, the worker boots on the fallback and its ready report names the selected model; lacking all keys, spawn fails with `no_usable_model` listing every attempted model.

**AC-4.6 Runtime model change.** `remote_model` switches a running worker's model and thinking level; the change is visible in the worker's next `get_state` and in `fleet_status` within 2 s.

**AC-4.7 Model pinning.** With `"pin": true`, an in-worker model change attempt is refused and reported; with `pin: false`, drift is allowed and `fleet_status` shows expected vs actual.

**AC-4.8 Settings precedence.** A spawn-time model override beats the bundle manifest, which beats the machine default; verified by spawning the same bundle with and without the override.

**AC-4.9 Settings TUI.** `/fleet-settings` edits persist to `~/.pi/agent/pi-fleet.json`, take effect without restarting pi (trust edits apply to the next connection; widget mode immediately), and never write secrets.

## Phase 5 — Observability

**AC-5.1 Follow view.** `/fleet` → select worker → live transcript renders new events with ≤ 1 s lag on a LAN-quality tailnet path; read-only by default.

**AC-5.2 Steer from follow.** Typing in the follow view sends a steer that the worker's log records as delivered through pi's steering queue; machines with policy `allow` (not `steer`) get a refusal instead.

**AC-5.3 Doctor.** `fleet doctor` correctly distinguishes and reports: tailscale down, agent unreachable, whois-denied, bundle cache corrupt (hash mismatch), and all-green.

## Cross-cutting (all phases)

**AC-X.1 No factory side effects.** Loading the extension without using it (plain `pi` startup on the server) opens no sockets, spawns no processes, and starts no timers.

**AC-X.2 Clean shutdown.** `session_shutdown` closes every socket and child the extension opened; repeated shutdown is a no-op; no orphan processes after pi exits (verified on all three OSes).

**AC-X.3 No secrets on the wire or in bundles.** Frames and manifests never carry API keys; workers use their own machine-local pi auth.

**AC-X.4 Trace correlation.** Every frame belonging to one task carries the same `traceId`; `fleet doctor --trace <id>` (or logs) reconstructs the full spawn→deliver timeline across server and agent.

**AC-X.5 Wire validation.** A frame that passes JSON parsing but violates its typebox schema is rejected with a protocol error naming the frame type and field; no handler observes a partially valid frame.

**AC-X.6 Version negotiation.** A v1 peer receiving a frame with `v: 2` responds with a protocol error frame and closes cleanly instead of misparsing.
