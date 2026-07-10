# pi-fleet

Cross-device orchestration for [pi](https://github.com/earendil-works/pi-mono), terminal only. One pi extension that lets a pi instance on your main machine spawn, provision, watch, and steer pi sessions on any machine in your tailnet — no desktop app, no SSH, no cloud relay.

```
Server (your machine)                          Worker machines (tailnet)
---------------------                          -------------------------
pi (TUI) + pi-fleet [server mode]              pi-fleet agent [daemon]
  /serve                                         spawns pi --mode rpc
  bundle registry (skills/ext/tools)   --TCP-->  pi-fleet [worker mode]
  LLM fleet tools:                     tailnet     async factory pulls bundle
    remote_spawn / remote_prompt                   resources_discover -> skills
    remote_output / remote_abort                   registerTool / setActiveTools
    fleet_status                                   full RPC control channel
```

## Why

- **pi as orchestrator**: your local pi's LLM drives a fleet of remote pi workers through registered tools. "Spawn a worker on buildbox, fix the failing tests, report back" is a single prompt.
- **Everything lives on the server**: skills, extensions, tools, prompts, and model defaults are defined once in server-side bundles. Workers self-provision on spawn (content-hash cached), so there is no config drift.
- **Tailnet-native**: transport is plain TCP on the Tailscale interface. Identity comes free from `tailscale whois` — WireGuard-backed, no tokens, no pairing codes.
- **Terminal only, cross-platform**: pure TypeScript, no native deps. Linux, macOS, and Windows.

## Design principles

Borrowed from studying [Mosaic](https://github.com/emergent-inc/mosaic)'s cross-device architecture, adapted to pi's strengths:

1. **Single-writer log, no CRDTs.** A pi session is an append-only event log with one writer. Catch-up is snapshot-on-join (`sessionManager.getEntries()`), then live tail. No conflict resolution needed — steering input serializes through pi's own queue (`steer` / `followUp`).
2. **Content-blind control plane.** Frames are forwarded, never interpreted, by the transport layer.
3. **Identity from the network, not the app.** Tailnet membership + `tailscale whois` replaces session codes and token auth.
4. **State lives at the edges.** The server owns bundles; workers own their sessions; the wire carries only frames.

## Modes

| Mode | Runs on | Role |
|---|---|---|
| **server** | your main machine, inside interactive pi | bundle registry, fleet tools for the LLM, control plane listener |
| **agent** | each worker machine, as OS service | spawns/supervises `pi --mode rpc` processes on request |
| **worker** | inside each spawned pi | bootstrap: pull bundle, provision skills/extensions/tools, expose RPC |

All three roles ship in one pi package. A machine can hold multiple roles at once.

## Documentation

- [Roadmap](docs/roadmap.md) — phased delivery plan
- [Implementation plan](docs/plan.md) — components, protocol, milestones
- [User stories](docs/user-stories.md)
- [Acceptance criteria](docs/acceptance-criteria.md)
- [State flow](docs/state-flow.md) — lifecycle state machines and sequence flows

## Install

Everything ships in this one package (runtime deps: `typebox`, `jiti` only; the pi package is a type-only devDependency, so production installs stay lean). Two roles, two install paths:

Same official command on **every** machine (pi clones to `~/.pi/agent/git/github.com/picassio/pi-fleet` and runs a production `npm install`):

```bash
pi install git:github.com/picassio/pi-fleet
```

**Server / orchestrator machine**: that's it — the extension auto-loads in every pi session (fleet tools, `/fleet-*` commands).

**Worker / agent machines** (Linux/macOS) — one command:

```bash
curl -fsSL https://raw.githubusercontent.com/picassio/pi-fleet/main/scripts/bootstrap-agent.sh | sh -s -- --server <your-machine-tailnet-name> [--max-workers 4]
```

This runs the official `pi install git:...`, then starts the agent as a systemd user service (falls back to nohup; idempotent, safe to re-run for updates). Windows: `pi install git:github.com/picassio/pi-fleet`, then `node %USERPROFILE%\.pi\agent\git\github.com\picassio\pi-fleet\scripts\pi-fleet-agent.mjs install-service --server <name>`.

Workers spawned by the agent need **no** install at all — the agent injects its extension copy via `-e`.

Workers spawned by the agent need **no** pi-fleet install of their own — the agent injects its extension copy via `-e`.

Prerequisites everywhere: Node ≥ 20, pi, Tailscale up; Windows additionally needs Git Bash (pi requirement).

## Status

Pre-implementation. Design docs first, code second. See the [roadmap](docs/roadmap.md).

## License

MIT
