# State Flow

Authoritative state machines and sequence flows for pi-fleet. Frame names refer to [plan.md](plan.md) protocol v1.

## 1. Worker instance lifecycle (as tracked by the server)

```mermaid
stateDiagram-v2
    [*] --> requested      : remote_spawn tool / spawn frame
    requested --> spawning : agent accepts (spawned)
    requested --> failed   : spawn_error (platform mismatch, bad cwd, pin mismatch)
    spawning --> provisioning : pi process started, worker factory running
    provisioning --> idle  : bundle synced, session_start done, ready
    provisioning --> degraded_cache : registry unreachable, cache used
    provisioning --> failed : sync failed, no cache / path-safety violation
    degraded_cache --> idle
    idle --> running       : prompt / steer delivered
    running --> awaiting_review : agent_settled on a tracked task (task_done sent)
    awaiting_review --> verifying : server LLM begins review
    verifying --> accepted  : task_accept
    verifying --> revising  : task_reject {feedback}
    revising --> running    : feedback delivered as new prompt (same session)
    verifying --> escalated : maxRejects exceeded → notify human
    escalated --> verifying : human weighs in
    accepted --> idle       : disposition keep_idle
    accepted --> stopping   : disposition stop
    running --> idle        : agent_settled (untracked / ad-hoc prompt)
    running --> aborting   : remote_abort
    aborting --> idle      : abort confirmed
    idle --> stopping      : remote_stop / stop frame
    running --> stopping   : remote_stop (abort first)
    stopping --> stopped   : RPC abort + stdin close (graceful)
    stopping --> stopped   : kill after timeout (forced, flagged)
    stopped --> [*]
    failed --> [*]

    idle --> unreachable   : agent heartbeat timeout
    running --> unreachable: agent heartbeat timeout
    unreachable --> idle   : reconnect + snapshot (worker survived)
    unreachable --> running: reconnect + snapshot (worker still busy)
    unreachable --> stopped: reconnect, agent reports instance gone
```

Notes:
- `awaiting_review` keeps the worker process alive with its context intact, so `task_reject` revisions are cheap (no respawn, no re-provisioning).
- `unreachable` is a **server-side view state**: the worker itself keeps running under its agent. Reconciliation on reconnect trusts the agent's `instances` report.
- `degraded_cache` is surfaced in `fleet_status` and the widget; it clears on the next successful sync.

## 2. Server ⇄ agent connection lifecycle

```mermaid
stateDiagram-v2
    [*] --> connecting     : /serve discovers agent or agent dials in
    connecting --> authenticating : TCP established
    authenticating --> rejected   : whois unknown + denied / policy deny
    authenticating --> established: whois allowed (stored or confirmed)
    established --> established   : heartbeat every 15s
    established --> lost          : 45s without heartbeat / socket close
    lost --> connecting           : backoff retry (1s,2s,4s..30s cap)
    rejected --> [*]
```

## 3. Bundle sync (worker side)

```mermaid
stateDiagram-v2
    [*] --> fetch_manifest
    fetch_manifest --> cache_check      : manifest ok
    fetch_manifest --> use_stale_cache  : registry unreachable, cache exists
    fetch_manifest --> fail_fast        : registry unreachable, no cache
    cache_check --> ready               : bundleHash matches cache
    cache_check --> diffing             : hash differs / no cache
    diffing --> fetching                : changed+added file list
    fetching --> validating             : all files in temp dir
    validating --> reject               : path-safety violation (nothing written to cache)
    validating --> swapping             : all paths safe, hashes verified
    swapping --> ready                  : atomic rename to fleet-cache/<hash>/
    use_stale_cache --> ready_degraded
    ready --> [*]
    ready_degraded --> [*]
    reject --> fail_fast
    fail_fast --> [*]
```

## 4. Sequence: single-prompt delegation (Epic B1)

```mermaid
sequenceDiagram
    participant U as Ana (TUI)
    participant S as server pi (LLM + pi-fleet server)
    participant A as fleet agent (buildbox)
    participant W as worker pi (rpc)

    U->>S: "spawn a worker on buildbox in ~/projects/api, fix tests"
    S->>S: LLM calls remote_spawn(host=buildbox, cwd=~/projects/api, bundle=default)
    S->>A: spawn {cwd, bundle}
    A->>W: exec pi --mode rpc (env: PI_FLEET_SERVER, PI_FLEET_BUNDLE)
    W->>S: GET /v1/bundles/default/manifest
    S-->>W: manifest.json
    W->>S: GET file?path=...&hash=... (changed files only)
    W->>W: validate → atomic cache swap → resources_discover → setActiveTools
    A-->>S: spawned {instanceId}
    S->>S: LLM calls remote_prompt(instanceId, "make failing tests pass", blocking)
    S->>A: rpc {instanceId, {type:"prompt", message:...}}
    A->>W: JSONL on stdin
    loop agent events
        W-->>A: message_update / tool_execution_* / turn_end
        A-->>S: event {instanceId, ...}
        S-->>U: onUpdate() progress + fleet widget refresh
    end
    W-->>A: agent_settled
    A-->>S: event {instanceId, agent_settled}
    S->>S: remote_prompt returns final assistant message
    S-->>U: LLM summarizes worker result
```

## 5. Sequence: first-contact trust (Epic E1)

```mermaid
sequenceDiagram
    participant A as fleet agent (new machine)
    participant S as server pi
    participant TS as tailscaled (server machine)
    participant U as Ana

    A->>S: TCP connect (tailnet IP)
    S->>TS: tailscale whois --json <peer-ip>
    TS-->>S: {machine: "buildbox", user: "ana@github"}
    S->>S: lookup pi-fleet.json → unknown
    S->>U: confirm "buildbox (ana@github) wants to join the fleet. Allow?"
    alt allow
        U-->>S: yes (policy: allow | steer)
        S->>S: persist decision
        S-->>A: hello {accepted}
    else deny
        U-->>S: no
        S->>S: persist deny
        S-->>A: close
    end
```

## 6. Sequence: orchestrator restart + reattach (AC-3.5)

```mermaid
sequenceDiagram
    participant S as server pi
    participant A as fleet agent
    participant W as worker pi (still running)

    Note over S: pi exits (session_shutdown closes sockets)
    Note over A,W: agent + worker unaffected, events buffered (bounded ring)
    S->>A: reconnect after restart (/serve or persisted flag)
    A-->>S: hello + instances [{instanceId, state: running}]
    S->>A: rpc {instanceId, {type:"get_state"}}
    A-->>S: event {instanceId, state snapshot}
    S->>S: rebuild fleet registry + widget from snapshot
    Note over S: remote_output serves buffered tail + snapshot
```

## 7. Sequence: task completion, ack, and verification

```mermaid
sequenceDiagram
    participant W as worker pi
    participant A as fleet agent
    participant O as agent outbox (disk)
    participant S as server pi (orchestrator LLM)
    participant U as Ana

    W-->>A: agent_settled (tracked taskId)
    A->>O: persist task_done {taskId, seq, summary, stats}
    A->>S: task_done
    alt server reachable
        S-->>A: task_done_ack
        A->>O: delete outbox entry
    else server offline / asleep
        Note over A,O: retry with backoff; replay on reconnect
        A->>S: task_done (replayed)
        S-->>A: task_done_ack (deduped by taskId+seq)
    end
    S->>S: sendMessage(fleet-task-done, triggerTurn: true)
    Note over S: worker state → awaiting_review
    S->>S: LLM wakes, reviews
    S->>A: rpc {instanceId, prompt: "run tests, show git diff --stat"}
    A->>W: JSONL stdin
    W-->>S: evidence (via event frames)
    alt work verified
        S->>A: task_accept {disposition}
        S-->>U: notify + widget: accepted
    else needs revision
        S->>A: task_reject {feedback}
        A->>W: feedback as new prompt (same session, context intact)
        Note over W: running again → next agent_settled starts a new review cycle
    else maxRejects exceeded
        S-->>U: notify: escalated, human review needed
    end
```

## 8. Sequence: baseline creation and clone-on-spawn

```mermaid
sequenceDiagram
    participant S as server pi (LLM)
    participant A as fleet agent
    participant B as baseline worker pi
    participant T as task worker pi

    S->>A: spawn {cwd: ~/projects/api, bundle: default}
    A->>B: exec pi --mode rpc
    S->>B: prompt (bundle priming prompt: explore repo, conventions)
    B-->>S: agent_settled
    S->>B: compact
    S->>B: set_session_name "baseline:api"
    S->>S: registry: {kind: baseline, pinned, gitHead: abc123}
    S->>A: stop {instanceId}  # baseline session file remains on disk

    Note over S: later: task arrives
    S->>A: spawn {cwd, bundle, fromSession: "baseline:api"}
    A->>T: exec pi --mode rpc --session <baseline.jsonl>
    S->>T: clone            # duplicate branch -> NEW session file
    T-->>S: cloned {newSessionPath}
    S->>S: registry: {kind: task, name: "task:t42:fix-tests", parentSession: baseline}
    S->>T: prompt (task)    # baseline file never written
```

## 9. Session registry reconciliation

```mermaid
stateDiagram-v2
    [*] --> stale_projection : server (re)connects to agent
    stale_projection --> reconciling : sessions_report received
    reconciling --> synced : projection == agent SessionManager.listAll()
    synced --> synced : incremental sessions_report on change
    synced --> catch_up : reattach to live session
    catch_up --> synced : get_entries {since: last seen id} applied
    synced --> stale_projection : connection lost
```

## 10. Runtime rebundle (`/fleet-use`, AC-4.1)

```mermaid
stateDiagram-v2
    [*] --> running_old   : worker on bundle A
    running_old --> syncing : prompt "/fleet-use B" (via rpc)
    syncing --> reloading : bundle B cached (same sync machine as §3)
    syncing --> unchanged : sync fails → keep bundle A, report error
    reloading --> running_new : ctx.reload() → session_start(reason reload) → provision from B
    unchanged --> running_old
    running_new --> [*]
```

Session history is preserved across `reloading` because reload replays the same session file; only resources and tools change.
