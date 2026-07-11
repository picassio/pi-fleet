# Implementation Plan

## Package layout

One pi package, three roles, shared core.

```
pi-fleet/
├── package.json              # "pi": { "extensions": ["./src/index.ts"] }
├── src/
│   ├── index.ts              # extension entry: detects role(s), registers commands/tools
│   ├── core/
│   │   ├── frames.ts         # frame types + JSONL codec (versioned)
│   │   ├── bundle.ts         # manifest types, hash, diff, sync engine
│   │   ├── pathsafety.ts     # zip-slip, reserved names, case collisions
│   │   ├── tailscale.ts      # CLI discovery, ip/status/whois wrappers
│   │   └── spawn.ts          # cross-platform `pi --mode rpc` spawning
│   ├── server/
│   │   ├── listener.ts       # TCP control plane + HTTP bundle registry
│   │   ├── registry.ts       # ~/.pi/agent/fleet/bundles/* management
│   │   ├── fleet.ts          # worker registry, reconnect, state tracking
│   │   ├── tools.ts          # remote_* LLM tools
│   │   └── widget.ts         # fleet dashboard widget
│   ├── agent/
│   │   ├── daemon.ts         # supervise pi --mode rpc children
│   │   └── install.ts        # systemd / launchd / schtasks generators
│   └── worker/
│       ├── bootstrap.ts      # async factory: env → sync → provision
│       └── host.ts           # jiti-load bundle extensions, invoke factories
├── test/                     # vitest; no tailnet needed (loopback + fakes)
└── docs/
```

## Roles and activation

`src/index.ts` decides at load time:

- `PI_FLEET_SERVER` env present → **worker mode** (async factory provisions before startup continues)
- otherwise → register server-mode commands (`/serve`, `/fleet-*`) and fleet tools; they stay inert until used
- **agent mode** is not an extension: `pi-fleet-agent` bin entry in the same package, run as OS service

Rationale: pi docs mandate no background resources from the factory; server listeners start only from `/serve` or a persisted "was serving" flag handled in `session_start`, and are torn down idempotently in `session_shutdown`.

## Frame protocol (v1)

JSONL over TCP. Every frame: `{ v: 1, type, id?, ...payload }`. Strict `\n` delimiter, tolerate trailing `\r`, never Node `readline`.

Control plane (server ⇄ agent):

| Frame | Direction | Purpose |
|---|---|---|
| `hello` | both | protocol version, machine name, capabilities |
| `spawn` | s→a | cwd, bundle name, pinned hash?, env overrides |
| `spawned` / `spawn_error` | a→s | instance id or failure reason |
| `stop`, `stopped` | s→a, a→s | graceful worker shutdown |
| `list`, `instances` | s→a, a→s | supervised instance inventory |
| `rpc` | s→a | envelope: `{ instanceId, command }` → forwarded to child stdin |
| `event` | a→s | envelope: `{ instanceId, event }` ← child stdout events |
| `heartbeat` | both | liveness, 15s interval, 45s timeout |
| `task_done` | a→s | durable completion notification: `{ taskId, instanceId, seq, summary, lastAssistantMessage, stats }` |
| `task_done_ack` | s→a | ack; agent removes the outbox entry |
| `task_accept` | s→a | verdict after verification: `{ taskId, disposition: "stop" \| "keep_idle" }` |
| `task_reject` | s→a | verdict with revision feedback: `{ taskId, feedback }` → delivered to the same worker session as a new prompt |
| `sessions_report` | a→s | session registry sync: metadata for all sessions on the agent's machine (on connect + on change) |
| `deliver` / `delivered` | s→a, a→s | land accepted work: `{ taskId, mode: "branch" \| "pr" \| "patch" }` → branch push, PR URL, or patch payload |
| `ui_request` / `ui_response` | a→s, s→a | forwarded worker extension-UI dialogs (confirm/select/input) for policy auto-answer or human escalation |
| `fs_read` / `fs_list` / `fs_grep` / `fs_diff` | s→a | read-only file service answered by the agent (no worker LLM involved): file content (text, or base64+mime for binary/image), dir listing, grep, git diff from the instance cwd; chunked responses, ~5 MB cap |
| `session_search` / `session_hits` | s→a, a→s | content search runs on the agent (local grep over JSONL); only hits cross the wire |
| `exec_start` / `exec_started` / `exec_output` / `exec_exit` | s→a, a→s | opt-in direct machine command execution with streamed stdout/stderr; no worker or LLM |
| `exec_abort` / `exec_aborted` / `exec_list` / `exec_instances` | both | terminate process trees and inspect active/recent direct commands |

Worker RPC payloads inside `rpc`/`event` are pi's native RPC commands/events — pi-fleet does not invent a second session protocol.

Bundle registry (HTTP on the same listener):

- `GET /v1/bundles/<name>/manifest` → manifest.json
- `GET /v1/bundles/<name>/file?path=<posix-path>&hash=<sha256>` → file bytes
- `GET /healthz`

## Task completion & verification

Raw RPC events are the live view; task completion is an explicit, reliable layer on top:

1. **Completion detection.** The agent watches each worker's event stream. `agent_settled` after a tracked `remote_prompt` closes the task and produces a `task_done` frame with a result digest (final assistant message, turn/tool counts, files changed).
2. **At-least-once delivery.** The agent persists `task_done` in a disk-backed outbox (`~/.pi/agent/fleet-agent/outbox/`), retries with backoff until `task_done_ack`, and replays unacked entries on reconnect. The server dedupes by `(instanceId, taskId, seq)`, so duplicates are harmless. Notifications survive server restarts, sleeping laptops, and agent restarts.
3. **Waking the orchestrator.** On `task_done` the server extension injects a `fleet-task-done` custom message into the server pi session with `{ triggerTurn: true, deliverAs: "followUp" }`. If the server pi is idle, the orchestrator LLM wakes and reviews autonomously; if busy, review queues as a follow-up. The widget and a `ctx.ui.notify` update fire regardless.
4. **Verification.** The worker parks in `awaiting_review` (process alive, context intact). The server LLM verifies via the **file service first** — `remote_diff` (git diff from the worker cwd), `remote_read` / `remote_grep` for suspicious files, image artifacts rendered directly into the orchestrator's context — none of which involves the worker's LLM or session. `remote_prompt` is reserved for evidence that requires execution (run the test suite). It then calls `remote_accept` or `remote_reject(feedback)` tools, which emit the verdict frames.
5. **Revision loop (session-tree aware).** `task_reject` feedback is delivered to the same worker session as a new prompt — no context loss; the session tree (`get_tree`) records every attempt and labels mark accepted checkpoints. The loop is capped (`maxRejects`, default 3); exceeding it moves the task to `escalated`, which notifies the human instead of consuming more tokens.

## Session persistence, baselines, and the registry

pi natively persists worker sessions (JSONL, per-cwd) and exposes `switch_session`, `fork`, `clone`, `get_fork_messages`, `get_tree`, `get_entries { since }`, `set_session_name`, and `new_session { parentSession }` over RPC. pi-fleet adds a fleet-level registry and a baseline convention:

**Baseline pattern (warm context, then work):**
1. `remote_baseline(host, cwd)` spawns a worker, runs the bundle's priming prompt (explore repo, read conventions), runs `compact` to densify, names it `baseline:<repo>`, registers it as `kind: baseline`, **pinned**.
2. Every `remote_spawn(..., fromSession: baseline)` attaches to the baseline file and immediately `clone`s — the task runs in a fresh copy; the baseline is never written.
3. Registry stores git HEAD at priming time; `fleet_status` flags `baseline_stale` when the repo moves past it → re-prime.

**Registry:** the agent is the source of truth (sessions live on its disk); the server keeps a projection reconciled from `sessions_report` on every connect. Entry shape: `{ sessionId, path, name, machine, cwd, kind: baseline|task|scratch, pinned, parentSession, bundle+hash, gitHead, taskIds, labels, updatedAt, stats, attachedInstanceId? }`. Task sessions are auto-named `task:<taskId>:<slug>` with `parentSession` pointing at their baseline, so lineage is always traceable.

**Resume semantics:** `remote_resume(sessionRef, { mode })` defaults to `clone` (continuing work never mutates the historical record); `attach` is allowed only for unpinned sessions. Discovery: `fleet_sessions(filter)` tool for the LLM, `/fleet-sessions` interactive picker for the human, `session_search` for content queries.

**Catch-up:** the server tracks the last seen entry id per session and uses `get_entries { since }` as a durable cursor — reattach after any restart fetches exactly the missed entries, no full-snapshot cost.

## Bundle manifest (v1)

```json
{
  "v": 1,
  "name": "default",
  "bundleHash": "sha256 of sorted (path,hash) pairs",
  "platforms": ["linux", "darwin", "win32"],
  "files": [{ "path": "skills/review/SKILL.md", "sha256": "...", "bytes": 1234 }],
  "extensions": ["extensions/reviewer.ts"],
  "skills": ["skills"],
  "prompts": ["prompts"],
  "tools": { "active": ["read", "grep", "bash", "edit", "write"] },
  "model": {
    "primary": { "provider": "anthropic", "id": "claude-sonnet-4-5", "thinking": "medium" },
    "fallbacks": [{ "provider": "openai", "id": "gpt-5.2" }],
    "pin": false
  },
  "review": { "maxRejects": 3 }
}
```

Sync algorithm: fetch manifest → compare `bundleHash` to cache dirs → fetch only missing/changed files into a temp dir → validate every path (POSIX, no `..`, no absolute, no reserved names, no case collisions) → atomic rename to `~/.pi/agent/fleet-cache/<bundleHash>/` → record provenance.

## Work delivery & workspace isolation

**Delivery closes the loop.** `remote_accept { disposition, deliver }` supports:
- `branch` — worker commits to `fleet/task-<id>`; agent pushes to origin (machine-local git creds)
- `pr` — branch + `gh pr create` (requires `gh` + token on the worker machine; doctor checks)
- `patch` — `fs_diff` payload applied server-side (small changes, no remote creds needed)
- `none` — leave in place (inspect later)

**Worktree-per-task.** The agent creates `git worktree` checkouts under `<repo>/.fleet-worktrees/task-<id>` from a base branch and spawns each task worker there; the worktree is removed after delivery. Two tasks on one repo never share a working directory. Baselines are primed against the main checkout; task clones run in worktrees, which also makes `remote_diff` unambiguous.

## Worker dialogs (extension UI forwarding)

Workers run headless, but bundle extensions may call `ctx.ui.confirm/select/input` — in RPC mode these emit extension-UI requests that would otherwise hang forever. Policy:
1. The agent forwards them as `ui_request` frames.
2. The server auto-answers when the bundle manifest declares a policy (`ui.autoAnswer`, e.g. permission-gate defaults).
3. Otherwise it escalates to the human (notify + dialog) on the same wake-up path as `task_done`.
4. Unanswered requests time out to a safe default (deny/cancel) and move the task to `escalated`.

## Budgets & runaway protection

- Manifest `budget: { maxCost?, maxTurns?, maxMinutes? }`; the agent aggregates pi's per-message usage and enforces — breach aborts the worker and emits `task_done { status: "budget_exceeded" }`, which flows into normal review.
- Machine config `maxWorkers` caps concurrent instances per machine; spawns beyond it are refused (no queueing in v1).
- `fleet_status` reports cost burn per worker, machine, and day.

## Agent resilience

The agent persists an instance registry (instanceId, pid, session path, task state) on disk. On restart it **re-adopts** still-running workers instead of orphaning or double-spawning them; instances whose pids are gone are reported `stopped` with their last known session path so sessions remain resumable. `hello` carries package versions alongside protocol `v`; `fleet doctor` flags server/agent/worker version skew.

## Remote file access (review channel)

The server can inspect worker files without involving the worker's LLM: `fs_*` frames are answered by the agent directly, so reviews cost zero worker tokens and never pollute worker session context.

Server-side tools: `remote_diff(instanceId, {ref?, staged?, stat?})` (primary review primitive), `remote_read(instanceId, path, {offset?, limit?})`, `remote_ls`, `remote_grep`. Text content flows through pi's standard truncation (50 KB / 2000 lines, offset/limit paging). Binary/image files return base64+mime and surface as `ImageContent` in the tool result, so the orchestrator model sees remote screenshots/design assets and the TUI renders them.

Rules:
- **Scope:** paths resolve inside the instance's cwd on the agent (`realpath` containment, symlink escapes rejected, Phase-0 path-safety module reused). Per-machine config `fsAccess: workspace | off`; no broader tier.
- **Read-only:** there is no `fs_write`. Mutations belong to workers, inside session logs, where they are auditable.
- **Policy:** file service requires machine policy ≥ `allow` (view-class access).
- **Limits:** chunked transfer, ~5 MB hard cap per file, image size hinting for downscale.

## Configuration layers & TUI settings

Three layers with one precedence rule: **spawn override > bundle manifest > machine config**.

| Layer | Location | Owner | Contents |
|---|---|---|---|
| Machine | `~/.pi/agent/pi-fleet.json` | human, per machine | trust policies, listener port, auto-serve, agent autostart, widget prefs |
| Bundle | `bundles/<name>/manifest.json` | server, versioned, synced | model+fallbacks+pin, thinking, tool allowlist, priming prompt, `review.maxRejects`, `platforms` |
| Spawn | `remote_spawn` args | task-scoped (LLM or human) | bundle, model override, `fromSession`, pinned `bundleHash` |

TUI surface on the server: `/fleet-settings` (SettingsList pattern, mirrors pi's built-in `/settings`) covering serving on/off, trust table (per-machine allow/steer/deny edit), default bundle, review, and widget mode (compact/detailed/off). Ambient UI: footer status via `setStatus("fleet", ...)` and the `setWidget` dashboard. Bundle contents are deliberately not editable in the TUI — they are versioned files; edit them with pi itself.

## Model selection control

Server expresses intent; the worker machine's locally held API keys constrain what is possible (bundles and frames never carry secrets).

- **Spawn-time (declarative):** worker bootstrap walks `model.primary` then `model.fallbacks` with `pi.setModel()` (natively returns `false` when the machine lacks a key), applies `thinking`, and reports the actually selected model in its ready report. Nothing usable → `spawn_error: no_usable_model` listing what was tried.
- **Runtime (imperative):** `remote_model(instanceId, modelRef, thinking?)` tool wraps pi RPC `set_model` / `set_thinking_level`; `get_available_models` powers validation before issuing the change.
- **Drift control:** the worker extension forwards pi's native `model_select` events. `"pin": true` makes the worker refuse out-of-band model changes; unpinned drift is surfaced in `fleet_status`.
- **Capability visibility:** agents report per-machine available models (providers with usable keys) in `hello`/`sessions_report`, so the orchestrator can choose spawn targets by model availability instead of failing spawns.
- **Centralized-key option:** a bundle extension may `registerProvider("fleet-gateway", { baseUrl, apiKey: "$FLEET_GATEWAY_KEY" })` pointing at a team gateway (LiteLLM etc.) — the bundle ships config, each machine ships only the one gateway credential in env.

## Security model

- Listener binds the tailscale interface IP only, never `0.0.0.0`
- Every inbound TCP connection: `tailscale whois --json <ip>` → identity; unknown machine → `ctx.ui.confirm` on the server; decisions persisted in `~/.pi/agent/pi-fleet.json` as `{ machine, user, policy: "allow" | "steer" | "deny" }`
- **Mutual trust, asymmetric bootstrap:** agents are headless and deny-by-default. `/fleet-install-agent --server <tailnet-machine-name>` pins the server identity at install; the agent whois-checks every inbound connection against the pin and refuses everything else — no dialog, no fallback. Re-pointing an agent is an explicit local re-install, never a remote operation. Without the pin, any tailnet peer could orchestrate every machine.
- Bundle supply chain stated plainly: a compromised server (or bundle registry) compromises the fleet — bundles execute with full permissions on workers. Mitigations: pinned-hash spawns, provisioning audit entries, version-skew reporting. A consolidated `SECURITY.md` (threat model, policy tiers, what the tailnet does and does not provide) ships with Phase 2.
- All task-scoped frames carry a `traceId` (minted at spawn) so spawn → task_done → verdict → deliver correlates across machines in logs and doctor output.
- Frames are validated at the wire boundary against the same typebox schemas that generate their TypeScript types; malformed frames are rejected with a protocol error, never partially processed.
- Bundles execute with full permissions on workers: spawns can pin `bundleHash`; workers record loaded bundle name+hash via `appendEntry`; server logs which identity spawned what
- No secrets in bundles or frames
- Direct machine execution is disabled by default and requires local `--exec-policy full`; it applies no command, sudo, administrator, absolute-path, or system-tool filtering. The OS account running the agent is the privilege boundary. Optional `--exec-root` values constrain only the initial cwd and are explicitly not a filesystem sandbox. Commands are audited without output; operators must not place secrets in command strings.

## Cross-platform commitments

| Area | Rule |
|---|---|
| Runtime | pure TS, zero native deps |
| Transport | TCP only; no Unix sockets in the cross-machine path |
| Tailscale | CLI wrappers only (`ip -4`, `status --json`, `whois --json`); binary discovered via PATH then platform fallbacks |
| Spawning pi | resolve `pi.cmd` via `where` on win32, spawn `["cmd","/c",...]`; arg arrays only, never shell-interpolated strings |
| Shutdown | RPC `abort` + stdin close first; `child.kill()` fallback; no POSIX signals assumed |
| Paths | `os.homedir()` + `path.join`; manifest paths POSIX, converted at write time |
| Services | systemd user unit / launchd plist / `schtasks onlogon`, generated by `/fleet-install-agent` |

## Testing strategy

- **Unit** (Phase 0): manifest diff/sync against a `file://` registry fake; path-safety corpus (traversal, reserved names, collisions); frame codec round-trips; spawn-command resolution per platform (mocked)
- **Integration** (loopback): agent daemon + real `pi --mode rpc` child on 127.0.0.1 — no tailnet required; whois layer faked behind an interface
- **E2E in CI, zero tokens:** the suite ships a **faux-provider test bundle** — a bundle extension that calls `registerProvider` with a scripted `streamSimple` fake LLM (deterministic responses and tool calls). Workers provisioned with it exercise the full loop (spawn → provision → prompt → tool call → task_done → reject → revise → accept → deliver) on loopback with no API keys, while also covering the bundle mechanism itself
- **E2E** (manual, pre-release): two tailnet machines, checklist mirroring the acceptance criteria
- CI: GitHub Actions matrix ubuntu-latest / macos-latest / windows-latest running unit + loopback integration

## Dependency policy

Exact-pinned, minimal: `typebox` (already a pi peer), vitest (dev). No `ws` (Node's `net` is enough for JSONL/TCP; HTTP via `node:http`). No tar (manifest file sync).

## Risks

| Risk | Mitigation |
|---|---|
| pi RPC/extension API drift (fast-moving) | pin pi version range; frame protocol independent of pi internals; CI against latest pi |
| `packages/orchestrator` overlap | we deliberately embed our own supervisor; revisit if upstream stabilizes a remote-capable orchestrator |
| Bundle extensions misbehaving in the shared `ExtensionAPI` host | namespace their commands/tools on registration; document constraints in the bundle authoring guide |
| Windows workers + Unix-assuming skills | `platforms` manifest field enforced at spawn |
