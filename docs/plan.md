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
4. **Verification.** The worker parks in `awaiting_review` (process alive, context intact). The server LLM verifies using existing tools: `remote_output` for the transcript, `remote_prompt` to demand evidence (run tests, show `git diff --stat`). It then calls `remote_accept` or `remote_reject(feedback)` tools, which emit the verdict frames.
5. **Revision loop.** `task_reject` feedback is delivered to the same worker session as a new prompt — no context loss. The loop is capped (`maxRejects`, default 3); exceeding it moves the task to `escalated`, which notifies the human instead of consuming more tokens.

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
  "model": { "provider": "anthropic", "id": "claude-sonnet-4-5", "thinking": "medium" }
}
```

Sync algorithm: fetch manifest → compare `bundleHash` to cache dirs → fetch only missing/changed files into a temp dir → validate every path (POSIX, no `..`, no absolute, no reserved names, no case collisions) → atomic rename to `~/.pi/agent/fleet-cache/<bundleHash>/` → record provenance.

## Security model

- Listener binds the tailscale interface IP only, never `0.0.0.0`
- Every inbound TCP connection: `tailscale whois --json <ip>` → identity; unknown machine → `ctx.ui.confirm` on the server (or auto-deny for the headless agent); decisions persisted in `~/.pi/agent/pi-fleet.json` as `{ machine, user, policy: "allow" | "steer" | "deny" }`
- Bundles execute with full permissions on workers: spawns can pin `bundleHash`; workers record loaded bundle name+hash via `appendEntry`; server logs which identity spawned what
- No secrets in bundles or frames

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
