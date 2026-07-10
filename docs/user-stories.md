# User Stories

Personas:
- **Ana** — developer with a laptop (macOS), a desktop (Linux), and a Windows build box, all on one tailnet. Runs pi interactively on the laptop.
- **Fleet agent** — the headless daemon on Ana's other machines.

## Epic A — Provisioning: everything lives on the server

**A1.** As Ana, I define skills, extensions, tools, and model defaults once in a `default` bundle on my laptop, so that every worker I spawn anywhere behaves identically without per-machine setup.

**A2.** As Ana, I create a custom `rust-reviewer` bundle next to `default`, so that specialized workers get a different toolset by passing one spawn argument.

**A3.** As Ana, when I re-spawn a worker whose bundle hasn't changed, provisioning completes from cache with no downloads, so that spawns feel instant.

**A4.** As Ana, when a bundle targets `["linux","darwin"]` and I try to spawn it on the Windows box, the spawn is refused with a clear reason, so that I never debug bash-isms on Windows.

**A5.** As Ana, I can see in any worker's session record exactly which bundle name and hash it was provisioned with, so that I can audit what code ran where.

## Epic B — Orchestration: pi drives the fleet

**B1.** As Ana, I type "spawn a worker on buildbox in ~/projects/api and make the failing tests pass, then summarize" into my local pi, and the model uses fleet tools to do it end-to-end, so that delegation is a single prompt.

**B2.** As Ana, I can run multiple workers in parallel on different machines and my local pi's model polls their outputs and consolidates results, so that fan-out work doesn't serialize.

**B3.** As Ana, I see a persistent fleet widget in my TUI showing each worker's machine, state, and current activity, so that I always know what the fleet is doing.

**B4.** As Ana, I can abort or stop any worker from my local pi (via prompt or command), so that a runaway worker never requires SSH-ing anywhere.

**B5.** As Ana, when my laptop pi restarts, workers keep running under their agents, and my pi reattaches and catches up via snapshot, so that orchestrator restarts are non-events.

## Epic C — Runtime control

**C1.** As Ana, I switch a running worker from `default` to `rust-reviewer` (`/fleet-use`) without losing its session history, so that retargeting doesn't cost context.

**C2.** As Ana, I narrow a worker to read-only tools mid-task (`/fleet-tools read,grep`), so that I can let it inspect production checkouts safely.

**C3.** As Ana, I steer a running worker with a mid-stream instruction from my laptop, delivered through pi's native steer queue, so that course corrections don't wait for the turn to finish.

## Epic D — Observability

**D1.** As Ana, I open `/fleet`, pick a worker, and follow its transcript live (read-only) in my TUI, so that I can watch a remote session like a local one.

**D2.** As Ana, from the follow view I can type input that is sent as steering to that worker, so that watching escalates naturally to intervening.

**D3.** As Ana, I run `fleet doctor` on any machine and get a pass/fail on tailscale state, agent reachability, and bundle cache integrity, so that setup problems are self-diagnosable.

## Epic E — Security & trust

**E1.** As Ana, the first time a new machine connects to my server, I get a confirm dialog with its tailnet identity (machine + user from whois), and my decision is remembered, so that fleet membership is explicit.

**E2.** As Ana, connections from outside my tailnet are impossible by construction (listener bound to the tailscale IP only), so that exposure never depends on application-level auth alone.

**E3.** As Ana, I can mark a machine `steer` (may send input) vs `allow` (view/spawn only) vs `deny`, so that trust is graded, not binary.

## Epic F — Cross-platform

**F1.** As Ana, I install the same package on Linux, macOS, and Windows machines with `pi install`, and `/fleet-install-agent` sets up the native service on each, so that platform differences are the extension's problem, not mine.

**F2.** As Ana, worker spawning, bundle sync, and shutdown behave identically on all three OSes (given Git Bash on Windows), so that a mixed fleet is unremarkable.
