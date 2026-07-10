# Development Rules — pi-fleet

Cross-device orchestration extension for pi. Server-owned bundles, tailnet transport, pi as fleet orchestrator. Read `README.md` first, then `docs/plan.md`.

## Current status

Pre-implementation. Design is complete and frozen at the level of `docs/`. Next work is **Phase 0** of `docs/roadmap.md` (frames, path safety, bundle sync, CI matrix) — do not start networking, server, agent, or worker code before Phase 0 is green on all three OSes.

## Documentation map

| Doc | Authority over |
|---|---|
| `docs/plan.md` | protocol v1 frames, manifest v1, subsystem designs, security model |
| `docs/roadmap.md` | phase ordering and exit criteria |
| `docs/acceptance-criteria.md` | definition of done per phase (AC-x.y ids) |
| `docs/state-flow.md` | lifecycle state machines and sequences |
| `docs/user-stories.md` | scope rationale |

Docs are the spec. If implementation reveals a design flaw, update the doc **in the same commit** as the code change and say so in the commit message. Never let code and `plan.md` disagree silently.

## Design invariants (do not violate; ask before changing)

- **No secrets in bundles or frames.** Keys live on the machine that uses them (env / pi auth). Ever.
- **Frames are versioned** (`v: 1`) and validated at the wire boundary against typebox schemas — the same schemas that generate the TypeScript types. One source of truth.
- **Config precedence:** spawn override > bundle manifest > machine config. No fourth layer.
- **The file service is read-only.** There is no `fs_write`. Mutations happen only inside worker sessions.
- **Baselines are pinned and never written.** Tasks clone; `attach` mode is refused for pinned sessions.
- **Agents are the source of truth for sessions and instances**; the server holds projections, reconciled on connect.
- **Agents are deny-by-default.** Server identity is pinned at install; re-pointing is a local re-install, never remote.
- **Listeners bind the tailscale interface IP only.** Never `0.0.0.0`, never a public interface.
- **Delivery of accepted work is explicit** (`branch | pr | patch | none`); nothing lands anywhere implicitly.
- **`task_done_ack` ≠ acceptance.** Ack stops outbox retries; acceptance is a separate verdict after verification.

## Code rules

- TypeScript strict; no `any` unless unavoidable. Erasable syntax only (no `enum`, no parameter properties).
- **Zero native dependencies.** Pure TS + Node built-ins. No `node-pty`, no compiled modules, no `ws` (use `node:net` / `node:http`), no tar (manifest file sync).
- Direct dependencies pinned to exact versions. Install with `--ignore-scripts`.
- Top-level imports only; no inline `await import()`.
- Cross-platform is not optional:
  - `os.homedir()` + `path.join()`; manifest paths are POSIX, converted at write time
  - tailscale via CLI wrappers only (`tailscale.ts`), never the LocalAPI socket
  - spawn with argument arrays, never shell-interpolated strings; resolve `pi.cmd` via `where` on win32
  - shutdown via RPC `abort` + stdin close; `child.kill()` only as fallback; no POSIX signal assumptions
  - JSONL split on `\n` only, strip trailing `\r`; never Node `readline`
- All paths received over the wire go through `src/core/pathsafety.ts`. No exceptions, including "trusted" frames.
- Tool/LLM-facing output respects pi's truncation contract (50 KB / 2000 lines) using pi's exported utilities.

## Testing

- vitest. Every code change runs the affected tests; new behavior gets a test keyed to its AC id where one exists (name tests `AC-0.3 rejects traversal`, etc.).
- CI must stay green on ubuntu-latest, macos-latest, windows-latest. A change that passes only on Linux is not done.
- **No real LLM calls, API keys, or paid tokens in tests.** E2E uses the faux-provider test bundle (scripted `streamSimple`). Loopback networking only; no tailnet in CI.
- Reliability paths (outbox retry, reconnect, orphan re-adoption, cursor catch-up) get failure-injection tests, not just happy paths.

## Git

- Message format: `{feat,fix,docs,test,chore}: <concise description>`. Reference AC ids and doc sections when relevant.
- Stage explicit paths; never `git add -A`.
- Never commit unless asked. Never force push.

## Security posture for contributors

Treat every frame handler as hostile-input parsing: validate size, schema, then path safety, before any logic. The threat model lives in `docs/plan.md` (Security model) until `SECURITY.md` ships in Phase 2 — read it before touching listener, trust, fs, or deliver code.

## Interactive E2E via tmux (required)

Real users run pi interactively — never validate user-facing flows with `pi -p` alone. Drive the actual TUI in tmux:

```bash
tmux new-session -d -s fleet-e2e -x 120 -y 32
tmux send-keys -t fleet-e2e "cd ~/projects/pi-fleet && pi --no-session -e ./src/index.ts" Enter
sleep 12 && tmux capture-pane -t fleet-e2e -p | tail -20   # verify startup
tmux send-keys -t fleet-e2e "<user prompt exercising fleet tools>" Enter
sleep 45 && tmux capture-pane -t fleet-e2e -p               # verify tool calls, results, footer status
tmux kill-session -t fleet-e2e
```

Check the footer for `fleet: N/M running` (setStatus) and the transcript for tool rows. Remote pieces (agent on a VM) must be running first; see the wiki page pi-fleet-extension-design for the current test topology.
