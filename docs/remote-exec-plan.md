# Remote execution implementation plan

## Goal

Allow the pinned fleet server to execute deterministic commands directly on an agent machine, without spawning a pi worker or spending LLM tokens. Support Bash/sh on Linux/macOS, PowerShell on Windows, direct argv execution, streamed stdout/stderr, timeout, abort, status, and audit records.

## Security and privilege contract

- Execution is disabled by default. The agent must be started with `--exec-policy full`.
- Existing Tailscale whois and pinned-server authentication applies unchanged.
- `full` does not filter commands, absolute paths, `sudo`, PowerShell administration, service management, shutdown, or other system tools.
- The server receives exactly the OS privileges of the locally installed agent process. Remote requests cannot elevate the service account by themselves.
- `--exec-root` is only an optional working-directory policy, not a filesystem sandbox. With no roots configured, any existing cwd is allowed.
- No caller-supplied environment in v1. Commands inherit the agent service environment.
- Commands owned by a disconnected server connection are aborted to avoid orphaned administration processes.
- Commands, cwd, identity, timestamps, and exit metadata are appended to a mode-0600 JSONL audit file. Output is not audited.
- Do not put secrets directly in command strings or argv because commands cross the wire and are audited.

## Protocol

Agent hello advertises `capabilities: ["exec-v1"]` when enabled.

Frames:

- `exec_start`: mode (`shell|argv`), cwd, command or executable+args, timeoutSeconds.
- `exec_started`: correlated response containing execId.
- `exec_output`: ordered base64 stdout/stderr chunks.
- `exec_exit`: exitCode/signal/timedOut/aborted/durationMs.
- `exec_abort` / `exec_aborted`.
- `exec_list` / `exec_instances`.

Chunks are at most 48 KiB raw so encoded frames remain safely below the 1 MiB frame limit.

## Agent implementation

Add `ExecSupervisor` in `src/agent/exec.ts`:

- Direct argv uses `spawn(executable, args, { shell:false })`.
- Shell mode uses `/bin/bash -lc` (fallback `/bin/sh -lc`) or `powershell.exe -NoProfile -NonInteractive -Command`.
- POSIX commands run in a process group; abort/timeout terminates the group. Windows uses `taskkill /T /F`.
- Enforce maximum concurrent executions, default timeout, hard maximum timeout, and cwd policy.
- Stream output, retain only metadata, and keep bounded recent completed records for listing.
- Append start/exit audit records.

The daemon owns one supervisor and associates every execution with the authenticated connection that started it.

## Server implementation

- `AgentClient`: start/list/abort calls plus output/exit handlers.
- `FleetManager`: tracked execution projections, waiters, output retention (512 KiB per stream), wait/abort/list APIs.
- Extension tools:
  - `remote_exec` — start; wait by default and return stdout/stderr/exit metadata.
  - `remote_exec_output` — current/recent output and state.
  - `remote_exec_abort` — terminate the process tree.
  - `remote_exec_list` — list active/recent commands on a host.

## Configuration

CLI/service options:

- `--exec-policy off|full` (default `off`)
- repeatable `--exec-root <path>`
- `--max-execs <n>` (default 4)
- `--exec-timeout <seconds>` (default 300)
- `--exec-audit-file <path>`

`/fleet-agent` and `/fleet-service` accept `--exec-full`; service generation persists the execution flags. Windows service generation supports `/rl highest` when locally requested with `--privileged`; Unix privileged service installation remains an explicit local administrator action.

## Verification

1. Frame round-trip tests for every execution frame.
2. ExecSupervisor tests: argv fidelity, shell, separated output, nonzero exit, timeout, abort, concurrency, cwd roots, audit, output chunk bounds.
3. Daemon/AgentClient loopback tests: disabled policy, start/output/exit, abort/list, disconnect cleanup, whois gate.
4. FleetManager integration tests for wait and async output.
5. Three-OS CI, including real PowerShell execution on Windows runner.
6. Interactive tmux self-fleet E2E: remote shell creates a proof file; direct argv reads it; abort a long command.
7. Cross-device E2E against `ab-internal-10`, after updating its service with exec explicitly enabled.

## Definition of done

A TUI server can execute a Bash/PowerShell command on a selected agent, see stdout/stderr and exact exit metadata, inspect/abort asynchronous commands, and exercise all privileges of the agent account. No worker process or LLM call is involved. Unit/integration tests and both interactive E2Es pass.
