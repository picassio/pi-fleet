# Gap Resolution Plan

Open issues from the 2026-07-10 edge-case audit, each with a concrete resolution design. Ordered by severity.

## 1. Orphan handling on agent restart (AC-3.13, rescoped)

**Why full re-adoption is impossible:** workers speak pi RPC over stdio pipes owned by the agent process. When the agent dies, the pipes die; a new agent process cannot re-attach to a running child's stdin/stdout. No patch fixes this — it is a property of the transport.

**Honest resolution — "lost but resumable":**
1. Supervisor persists `~/.pi/agent/fleet-agent/instances.json` on every spawn/exit: `{instanceId, pid, cwd, bundle, taskId?, sessionPath?}`. Capture `sessionPath` by issuing `get_state` once after worker startup (agent-side, cheap).
2. On agent start: read the file. For each entry, check pid liveness (`process.kill(pid, 0)`).
   - Alive → the worker is orphaned (unreachable): send SIGTERM (POSIX) / `taskkill` (win32) so it doesn't burn tokens invisibly, then record as `lost`.
   - Dead → record as `lost`.
3. For entries with a pending `taskId`: emit `task_done { status: "aborted" }` through the existing outbox (reuses the crash-mid-task path).
4. `instances` frame gains `lost` entries with `sessionPath`, so the orchestrator can `remote_spawn(fromSession: <sessionPath>)` to resume the work warm.

**ACs:** restart with 2 running workers → both terminated + reported `lost` with session paths; pending task produces durable `aborted`; resume via fromSession works.
**Effort:** ~1 session. No protocol changes (InstanceInfo already optional-fields).

## 2. Double-review with two orchestrator connections

**Problem:** the agent broadcasts events and `task_done` to all connections; two server pis on the pinned machine both wake and may both review.

**Resolution — task ownership, not global leases:**
1. Agent tracks `taskId → owning connection` (set when the tagged `rpc` prompt arrives).
2. `task_done` delivery: try the owning connection first; only if closed, fall back to broadcast (preserves durability — the outbox+ack loop is unchanged).
3. Events keep broadcasting (watching is harmless); review responsibility follows task ownership.
4. Server-side belt-and-braces already exists (dedupe by taskId+seq per manager) — add a `reviewedBy` note in `remote_accept/reject` results for visibility.

**ACs:** two connected clients, task submitted by A → only A receives task_done while A lives; kill A before settle → B receives it (fallback).
**Effort:** ~half session. ~30 lines in daemon.

## 3. Tailscale IP rebind

**Problem:** listeners (agent, registry) bind the tailnet IP at start; tailscale re-auth/IP change strands them.

**Resolution:** poll `tailscale ip -4` every 60s in agent daemon and registry server; on change, close and re-listen on the new IP (workers unaffected — they're child processes, not connections). Log loudly. Server side reconnect-with-backoff already recovers the client end.
**ACs:** simulated by injecting an ip provider in tests: change ip → listener rebinds, old socket refused, fleet-ctl reconnects.
**Effort:** ~half session.

## 4. Windows service automation

**Problem:** `/fleet-service` prints the schtasks command instead of running it.

**Resolution:** execute `schtasks /create /f ...` directly (no elevation needed for per-user onlogon tasks), then `schtasks /run /tn pi-fleet-agent` for immediate start. Bootstrap parity via a `bootstrap-agent.ps1`. Verify on windows-latest CI with a dry-run flag (schtasks exists on runners), full manual test on a real machine.
**Effort:** ~half session + one manual Windows validation.

## 5. cc-patch worker live E2E

**Problem:** pi-cc-patch installs and loads on the VM, but a real subscription-billed worker prompt was never completed.

**Resolution (validation, not code):** ensure Claude Code credentials exist on the VM (`claude` login or cc-token-sync), then: spawn worker → `remote_prompt(instanceId, "Say exactly: ok", wait: true)` → expect "ok". If the 400 "out of extra usage" persists, the account tier is the blocker, not the plumbing — document the requirement.
**Effort:** minutes, once credentials/tier are available.

## 6. fs chunking (parked, WONTFIX for now)

Caps are the design: 50KB text pages / 700KB binary (frame-safe). If a real need appears (reviewing large images/logs), the design is already sketched: `fs_result { done: false }` continuation frames keyed by request id, assembled client-side with a total cap. Do not build speculatively.

## Suggested order

1 (orphans) → 2 (ownership) in one session; 3 + 4 in a platform-polish session; 5 whenever credentials allow; 6 on demand.
