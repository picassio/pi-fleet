/**
 * pi-fleet extension entry.
 *
 * Role detection (docs/plan.md "Roles and activation"):
 * - PI_FLEET_BUNDLE / PI_FLEET_SERVER set → worker mode: the async factory
 *   provisions the bundle BEFORE pi continues startup, so resources_discover
 *   and session_start already see the synced bundle (AC-1.1).
 * - otherwise → server-mode commands register lazily (Phase 2+); the factory
 *   has no side effects (AC-X.1).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { hostname } from "node:os";
import { FleetManager } from "./server/fleet.ts";
import { startAgentDaemon, AGENT_DEFAULT_PORT, type RunningAgent } from "./agent/daemon.ts";
import { Tailscale } from "./core/tailscale.ts";
import { loadBundleExtensions, type BundleExtensionLoadResult } from "./worker/host.ts";
import {
	parseWorkerEnv,
	provisionBundle,
	resolveResources,
	type ProvisionResult,
	type ResolvedResources,
} from "./worker/bootstrap.ts";

export default async function piFleet(pi: ExtensionAPI): Promise<void> {
	const workerEnv = parseWorkerEnv(process.env);
	if (workerEnv === null) {
		registerServerMode(pi);
		return;
	}

	// --- Worker mode -------------------------------------------------------
	// Provision inside the async factory: pi awaits this before session_start
	// and resources_discover, so the bundle is fully materialized first.
	const provision: ProvisionResult = await provisionBundle(workerEnv);
	const resources: ResolvedResources = resolveResources(provision.manifest, provision.dir);

	// Host bundle extensions against our own ExtensionAPI handle.
	const extensionResults: BundleExtensionLoadResult[] = await loadBundleExtensions(
		resources.extensionPaths,
		pi,
	);

	pi.on("resources_discover", () => ({
		skillPaths: resources.skillPaths,
		promptPaths: resources.promptPaths,
	}));

	// Phase 4: hot rebundle. Re-point the env and reload; the async factory
	// re-provisions from the registry while session history survives (AC-4.1).
	pi.registerCommand("fleet-use", {
		description: "Switch this worker to another bundle (re-sync + reload, session preserved)",
		handler: async (args, ctx) => {
			const bundle = args?.trim();
			if (!bundle) {
				if (ctx.hasUI) ctx.ui.notify("usage: /fleet-use <bundle>", "error");
				return;
			}
			process.env.PI_FLEET_BUNDLE = bundle;
			delete process.env.PI_FLEET_BUNDLE_HASH; // pin belongs to the old bundle
			await ctx.reload();
			return;
		},
	});

	// Phase 4: live tool narrowing without a reload (AC-4.2).
	pi.registerCommand("fleet-tools", {
		description: "Set this worker's active tools, e.g. /fleet-tools read,grep",
		handler: async (args, ctx) => {
			const names = (args ?? "").split(",").map((name) => name.trim()).filter(Boolean);
			if (names.length === 0) {
				if (ctx.hasUI) ctx.ui.notify(`active: ${pi.getActiveTools().join(", ")}`, "info");
				return;
			}
			const registered = new Set(pi.getAllTools().map((tool) => tool.name));
			pi.setActiveTools(names.filter((name) => registered.has(name)));
			if (ctx.hasUI) ctx.ui.notify(`active tools: ${pi.getActiveTools().join(", ")}`, "info");
		},
	});

	pi.on("session_start", async (event, ctx) => {
		if (event.reason !== "startup" && event.reason !== "reload") return;

		// Tool allowlist from the manifest (AC-1.3).
		const active = provision.manifest.tools?.active;
		if (active && active.length > 0) {
			const registered = new Set(pi.getAllTools().map((tool) => tool.name));
			pi.setActiveTools(active.filter((name) => registered.has(name)));
		}

		// Model policy: walk primary then fallbacks; setModel returns false
		// when this machine has no usable key for the model.
		const policy = provision.manifest.model;
		let selectedModel: string | null = null;
		if (policy) {
			const candidates = [policy.primary, ...(policy.fallbacks ?? [])];
			for (const candidate of candidates) {
				const model = ctx.modelRegistry.find(candidate.provider, candidate.id);
				if (model && (await pi.setModel(model))) {
					selectedModel = `${candidate.provider}/${candidate.id}`;
					const thinking = "thinking" in candidate ? candidate.thinking : undefined;
					if (thinking) {
						pi.setThinkingLevel(thinking as Parameters<typeof pi.setThinkingLevel>[0]);
					}
					break;
				}
			}
			if (selectedModel === null) {
				const tried = candidates.map((c) => `${c.provider}/${c.id}`).join(", ");
				throw new Error(`pi-fleet: no_usable_model — tried: ${tried}`);
			}
		}

		// Provisioning audit record (AC-1.5).
		pi.appendEntry("pi-fleet-provision", {
			bundle: provision.manifest.name,
			bundleHash: provision.manifest.bundleHash,
			status: provision.status,
			origin: provision.origin,
			fetched: provision.fetched.length,
			reused: provision.reused.length,
			selectedModel,
			extensions: extensionResults,
			instanceId: workerEnv.instanceId ?? null,
			taskId: workerEnv.taskId ?? null,
			traceId: workerEnv.traceId ?? null,
		});

		if (provision.status === "degraded" && ctx.hasUI) {
			ctx.ui.notify(
				`pi-fleet: registry unreachable — running from cached bundle ${provision.manifest.name}@${provision.manifest.bundleHash.slice(0, 12)}`,
				"warning",
			);
		}
		for (const result of extensionResults) {
			if (!result.ok && ctx.hasUI) {
				ctx.ui.notify(`pi-fleet: bundle extension failed: ${result.path}: ${result.error}`, "error");
			}
		}
	});
}

function registerServerMode(pi: ExtensionAPI): void {
	let fleet: FleetManager | undefined;
	let followId: string | undefined;
	const followLines: string[] = [];
	let lastUi: { setWidget(key: string, lines?: string[]): void; setStatus(key: string, text?: string): void } | undefined;
	const renderFleet = () => {
		if (!lastUi || !fleet) return;
		const instances = fleet.status();
		if (instances.length === 0) {
			lastUi.setWidget("fleet", undefined);
			lastUi.setStatus("fleet", undefined);
			return;
		}
		const running = instances.filter((entry) => entry.state === "running").length;
		lastUi.setStatus("fleet", `fleet: ${running}/${instances.length} running`);
		lastUi.setWidget(
			"fleet",
			instances.map((entry) => {
				const flag =
					entry.review === "awaiting" ? "REVIEW" : entry.settled ? "settled" : entry.state === "running" ? "busy" : entry.state;
				return `⏵ ${entry.instanceId} ${entry.host} ${entry.bundle} [${flag}]`;
			}),
		);
	};
	const getFleet = (): FleetManager => {
		// Wake the orchestrator when an untracked (async-prompted) worker settles:
		// the injected message triggers a review turn if pi is idle (docs/plan.md
		// "Task completion & verification" step 3).
		fleet ??= new FleetManager({
			onChange: renderFleet,
			onInstanceEvent: (instanceId, event) => {
				if (instanceId !== followId || !lastUi) return;
				const typed = event as { type?: string; message?: { role?: string; content?: Array<{ type?: string; text?: string }> }; toolName?: string };
				let line: string | undefined;
				if (typed.type === "message_end" && typed.message?.role === "assistant") {
					const textPart = (typed.message.content ?? []).find((part) => part.type === "text")?.text ?? "";
					line = `assistant: ${textPart.split("\n")[0]?.slice(0, 100)}`;
				} else if (typed.type === "tool_execution_start") {
					line = `tool: ${typed.toolName ?? "?"}`;
				} else if (typed.type === "agent_settled") {
					line = "-- settled --";
				}
				if (!line) return;
				followLines.push(line);
				if (followLines.length > 8) followLines.shift();
				lastUi.setWidget("fleet-follow", [`following ${followId}:`, ...followLines]);
			},
			onTaskDone: (frame) => {
				renderFleet();
				pi.sendMessage(
					{
						customType: "fleet-task-done",
						content:
							`Fleet task ${frame.taskId} (worker ${frame.instanceId}) completed durably.\n` +
							`Summary: ${frame.summary}\n` +
							"Verify with remote_diff/remote_output, then remote_accept or remote_reject.",
						display: true,
					},
					{ triggerTurn: true, deliverAs: "followUp" },
				);
			},
			onSettled: (instance) => {
				pi.sendMessage(
					{
						customType: "fleet-task-done",
						content:
							`Fleet worker ${instance.instanceId} on ${instance.host} settled. ` +
							`Last assistant message:\n${instance.lastAssistant ?? "(none)"}\n` +
							"Review the result (remote_output / fleet_status) and decide next steps.",
						display: true,
					},
					{ triggerTurn: true, deliverAs: "followUp" },
				);
			},
		});
		return fleet;
	};
	const text = (value: string) => ({
		content: [{ type: "text" as const, text: value }],
		details: {} as Record<string, unknown>,
	});
	const updateStatus = (ctx: {
		hasUI: boolean;
		ui: { setStatus(k: string, v?: string): void; setWidget(k: string, lines?: string[]): void };
	}) => {
		if (ctx.hasUI) lastUi = ctx.ui;
		renderFleet();
	};

	pi.on("session_shutdown", async () => {
		await fleet?.close();
		fleet = undefined;
	});

	let agentRunning: RunningAgent | undefined;
	pi.registerCommand("fleet-agent", {
		description: "Turn this pi session into a fleet agent: /fleet-agent <pinned-server-machine> (again to stop)",
		handler: async (args, ctx) => {
			if (agentRunning) {
				await agentRunning.close();
				agentRunning = undefined;
				if (ctx.hasUI) {
					ctx.ui.setStatus("fleet-agent", undefined);
					ctx.ui.notify("fleet-agent: stopped (workers stopped)", "info");
				}
				return;
			}
			const pinnedServer = args?.trim();
			if (!pinnedServer) {
				if (ctx.hasUI) ctx.ui.notify("usage: /fleet-agent <pinned-server-machine-name>", "error");
				return;
			}
			const tailscale = new Tailscale();
			const host = await tailscale.ip4();
			agentRunning = await startAgentDaemon({
				host,
				port: AGENT_DEFAULT_PORT,
				machine: hostname(),
				pinnedServer,
				whois: (ip) => tailscale.whois(ip),
			});
			if (ctx.hasUI) {
				ctx.ui.setStatus("fleet-agent", `agent: ${host}:${agentRunning.port} pinned ${pinnedServer}`);
				ctx.ui.notify(
					`fleet-agent serving on ${host}:${agentRunning.port} (pinned to ${pinnedServer}). Workers live while this pi session runs; use the bootstrap script for a durable service.`,
					"info",
				);
			}
		},
	});

	pi.on("session_shutdown", async () => {
		await agentRunning?.close();
		agentRunning = undefined;
	});

	pi.registerCommand("fleet-follow", {
		description: "Follow a fleet worker's activity live in a widget (run again to stop)",
		handler: async (args, ctx) => {
			if (followId) {
				followId = undefined;
				followLines.length = 0;
				if (ctx.hasUI) {
					ctx.ui.setWidget("fleet-follow", undefined);
					ctx.ui.notify("fleet-follow: stopped", "info");
				}
				return;
			}
			const instances = getFleet().status().filter((entry) => entry.state === "running");
			if (instances.length === 0) {
				if (ctx.hasUI) ctx.ui.notify("no running workers to follow", "warning");
				return;
			}
			const choice =
				args?.trim() ||
				(ctx.hasUI
					? await ctx.ui.select("Follow which worker?", instances.map((entry) => `${entry.instanceId} (${entry.host})`))
					: undefined);
			if (!choice) return;
			followId = choice.split(" ")[0];
			if (ctx.hasUI) {
				lastUi = ctx.ui;
				ctx.ui.setWidget("fleet-follow", [`following ${followId}:`, "(waiting for events)"]);
			}
		},
	});

	pi.registerCommand("fleet-doctor", {
		description: "Diagnose pi-fleet: tailscale, registry, baselines, agents, workers",
		handler: async (_args, ctx) => {
			const lines = await getFleet().doctor();
			if (ctx.hasUI) ctx.ui.notify(`fleet doctor:\n${lines.join("\n")}`, "info");
		},
	});

	pi.registerCommand("fleet", {
		description: "Show pi-fleet status",
		handler: async (_args, ctx) => {
			const instances = fleet?.status() ?? [];
			const summary =
				instances.length === 0
					? "no workers"
					: instances
							.map((entry) => `${entry.instanceId} ${entry.host} ${entry.bundle} ${entry.state}${entry.settled ? " settled" : ""}`)
							.join("\n");
			if (ctx.hasUI) ctx.ui.notify(`pi-fleet:\n${summary}`, "info");
		},
	});

	pi.registerTool({
		name: "remote_spawn",
		label: "Remote Spawn",
		description:
			"Spawn a pi worker on a fleet agent machine (tailnet). Returns the instanceId. " +
			"The worker provisions itself from this server's bundle registry.",
		promptSnippet: "Spawn a pi worker on a remote machine",
		promptGuidelines: [
			"Use remote_spawn to delegate work to another machine, then remote_prompt to task it.",
		],
		parameters: Type.Object({
			host: Type.String({ description: "Agent tailnet IP or hostname" }),
			cwd: Type.String({ description: "Working directory on the remote machine" }),
			bundle: Type.Optional(Type.String({ description: "Bundle name (default: default)" })),
			fromBaseline: Type.Optional(Type.String({ description: "Baseline label: start warm by cloning it" })),
			maxCost: Type.Optional(Type.Number({ description: "Abort the worker if its LLM cost exceeds this (USD)" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const manager = getFleet();
			let baseline;
			if (params.fromBaseline) {
				baseline = (await manager.loadBaselines()).get(params.fromBaseline);
				if (!baseline) throw new Error(`unknown baseline: ${params.fromBaseline}`);
			}
			const tracked = await manager.spawn({
				host: baseline?.host ?? params.host,
				cwd: baseline?.cwd ?? params.cwd,
				bundle: params.bundle ?? baseline?.bundle ?? "default",
				...(params.maxCost !== undefined ? { maxCost: params.maxCost } : {}),
			});
			let staleNote = "";
			if (baseline) {
				// Clone-on-spawn: attach to the pinned baseline, duplicate the branch
				// into a NEW session file, work in the clone (baseline never written).
				await manager.rpcRequest(tracked.instanceId, { type: "switch_session", sessionPath: baseline.sessionPath });
				await manager.rpcRequest(tracked.instanceId, { type: "clone" });
				if (baseline.gitHead) {
					try {
						const head = await manager.fs(tracked.instanceId, { type: "fs_diff", revParse: true });
						const current = head.text?.trim();
						if (current && current !== baseline.gitHead) {
							staleNote = ` WARNING: baseline_stale — repo HEAD ${current.slice(0, 12)} != baseline HEAD ${baseline.gitHead.slice(0, 12)}; consider re-priming`;
						}
					} catch {
						// staleness check best-effort
					}
				}
			}
			updateStatus(ctx);
			return {
				...text(
					`spawned ${tracked.instanceId} on ${tracked.host} (bundle ${tracked.bundle}` +
						`${baseline ? `, warm from baseline ${baseline.label}` : ""})${staleNote}`,
				),
				details: { instanceId: tracked.instanceId },
			};
		},
	});

	pi.registerTool({
		name: "remote_prompt",
		label: "Remote Prompt",
		description:
			"Send a prompt to a fleet worker. wait=true (default) blocks until the worker settles " +
			"and returns its final assistant message; wait=false returns immediately (poll with remote_output).",
		promptSnippet: "Task a remote pi worker and get its result",
		parameters: Type.Object({
			instanceId: Type.String(),
			message: Type.String(),
			wait: Type.Optional(Type.Boolean()),
			timeoutSeconds: Type.Optional(Type.Number({ description: "Max wait (default 600)" })),
		}),
		async execute(_id, params, signal, onUpdate) {
			const manager = getFleet();
			if (params.wait === false) {
				const taskId = `t-${Date.now().toString(36)}`;
				await manager.prompt(params.instanceId, params.message, taskId);
				return text(`task ${taskId} sent to ${params.instanceId}; you will be notified on durable task_done`);
			}
			await manager.prompt(params.instanceId, params.message);
			onUpdate?.(text("worker running..."));
			await manager.waitSettled(params.instanceId, (params.timeoutSeconds ?? 600) * 1000, signal);
			const result = manager.get(params.instanceId)?.lastAssistant ?? "(no assistant output captured)";
			return text(result.length > 20_000 ? `${result.slice(0, 20_000)}\n[truncated]` : result);
		},
	});

	pi.registerTool({
		name: "remote_output",
		label: "Remote Output",
		description: "Inspect a fleet worker: state, settled flag, last assistant message, recent event types.",
		parameters: Type.Object({ instanceId: Type.String() }),
		async execute(_id, params) {
			const { instance, recentEventTypes } = getFleet().output(params.instanceId);
			return text(
				[
					`instance ${instance.instanceId} on ${instance.host} (${instance.bundle})`,
					`state: ${instance.state}${instance.settled ? ", settled" : ", busy"}`,
					`recent events: ${recentEventTypes.join(", ") || "none"}`,
					`last assistant message:`,
					instance.lastAssistant ?? "(none)",
				].join("\n"),
			);
		},
	});

	pi.registerTool({
		name: "remote_abort",
		label: "Remote Abort",
		description: "Abort a fleet worker's current run (keeps the worker alive).",
		parameters: Type.Object({ instanceId: Type.String() }),
		async execute(_id, params) {
			await getFleet().abort(params.instanceId);
			return text(`abort sent to ${params.instanceId}`);
		},
	});

	pi.registerTool({
		name: "remote_stop",
		label: "Remote Stop",
		description: "Gracefully stop a fleet worker (abort, close stdin, kill after grace).",
		parameters: Type.Object({ instanceId: Type.String() }),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const result = await getFleet().stop(params.instanceId);
			updateStatus(ctx);
			return text(`stopped ${params.instanceId}${result.forced ? " (forced)" : ""}`);
		},
	});

	const fsResultToTool = (result: {
		text?: string;
		base64?: string;
		mime?: string;
		entries?: Array<{ name: string; kind: string; bytes?: number }>;
		truncated?: boolean;
		error?: { code: string; message: string };
	}) => {
		if (result.error) throw new Error(`${result.error.code}: ${result.error.message}`);
		if (result.base64 && result.mime) {
			return {
				content: [{ type: "image" as const, data: result.base64, mimeType: result.mime }],
				details: {} as Record<string, unknown>,
			};
		}
		if (result.entries) {
			return text(
				result.entries
					.map((entry) => `${entry.kind === "dir" ? "d" : "-"} ${entry.name}${entry.bytes !== undefined ? ` (${entry.bytes}B)` : ""}`)
					.join("\n") || "(empty)",
			);
		}
		return text(`${result.text ?? ""}${result.truncated ? "\n[truncated]" : ""}`);
	};

	pi.registerTool({
		name: "remote_read",
		label: "Remote Read",
		description:
			"Read a file from a fleet worker's cwd (agent-answered, zero worker tokens). " +
			"Text pages via offset/limit; images (png/jpg/gif/webp) return as viewable images.",
		parameters: Type.Object({
			instanceId: Type.String(),
			path: Type.String({ description: "Path relative to the worker's cwd" }),
			offset: Type.Optional(Type.Number()),
			limit: Type.Optional(Type.Number()),
		}),
		async execute(_id, params) {
			return fsResultToTool(
				await getFleet().fs(params.instanceId, {
					type: "fs_read",
					path: params.path,
					...(params.offset !== undefined ? { offset: params.offset } : {}),
					...(params.limit !== undefined ? { limit: params.limit } : {}),
				}),
			);
		},
	});

	pi.registerTool({
		name: "remote_ls",
		label: "Remote Ls",
		description: "List a directory in a fleet worker's cwd (agent-answered).",
		parameters: Type.Object({ instanceId: Type.String(), path: Type.String() }),
		async execute(_id, params) {
			return fsResultToTool(await getFleet().fs(params.instanceId, { type: "fs_list", path: params.path }));
		},
	});

	pi.registerTool({
		name: "remote_grep",
		label: "Remote Grep",
		description: "Regex search in a fleet worker's cwd (agent-answered; skips .git/node_modules).",
		parameters: Type.Object({
			instanceId: Type.String(),
			pattern: Type.String(),
			glob: Type.Optional(Type.String({ description: "e.g. **/*.ts" })),
		}),
		async execute(_id, params) {
			return fsResultToTool(
				await getFleet().fs(params.instanceId, {
					type: "fs_grep",
					pattern: params.pattern,
					...(params.glob ? { glob: params.glob } : {}),
				}),
			);
		},
	});

	pi.registerTool({
		name: "remote_diff",
		label: "Remote Diff",
		description:
			"git diff in a fleet worker's cwd (agent-answered) — the primary review primitive. " +
			"Use stat=true for an overview before reading full diffs.",
		promptGuidelines: [
			"Use remote_diff (not remote_prompt) to review a fleet worker's changes; it costs no worker tokens.",
		],
		parameters: Type.Object({
			instanceId: Type.String(),
			ref: Type.Optional(Type.String()),
			staged: Type.Optional(Type.Boolean()),
			stat: Type.Optional(Type.Boolean()),
		}),
		async execute(_id, params) {
			return fsResultToTool(
				await getFleet().fs(params.instanceId, {
					type: "fs_diff",
					...(params.ref ? { ref: params.ref } : {}),
					...(params.staged !== undefined ? { staged: params.staged } : {}),
					...(params.stat !== undefined ? { stat: params.stat } : {}),
				}),
			);
		},
	});

	const sessionFileFrom = (event: unknown): string | undefined => {
		const data = (event as { data?: Record<string, unknown> }).data ?? {};
		for (const key of ["sessionFile", "sessionPath", "file"]) {
			if (typeof data[key] === "string") return data[key] as string;
		}
		return undefined;
	};

	pi.registerTool({
		name: "remote_baseline",
		label: "Remote Baseline",
		description:
			"Create a pinned warm-context baseline on a fleet machine: spawn, prime (explore the repo), " +
			"compact, name it, record it. Later remote_spawn fromBaseline starts tasks with the repo already understood.",
		parameters: Type.Object({
			host: Type.String(),
			cwd: Type.String(),
			label: Type.String({ description: "Baseline label, e.g. api-repo" }),
			primingPrompt: Type.Optional(Type.String()),
			bundle: Type.Optional(Type.String()),
		}),
		async execute(_id, params, signal, onUpdate, ctx) {
			const manager = getFleet();
			const tracked = await manager.spawn({ host: params.host, cwd: params.cwd, bundle: params.bundle ?? "default" });
			updateStatus(ctx);
			onUpdate?.(text(`priming ${tracked.instanceId}...`));
			await manager.prompt(
				tracked.instanceId,
				params.primingPrompt ??
					"Explore this repository: read the README and any AGENTS/context files, inspect the layout, and summarize the architecture, conventions, and build/test commands. Do not modify anything.",
			);
			await manager.waitSettled(tracked.instanceId, 900_000, signal);
			onUpdate?.(text("compacting..."));
			await manager.rpcRequest(tracked.instanceId, { type: "compact" }, 300_000);
			await manager.rpcRequest(tracked.instanceId, { type: "set_session_name", name: `baseline:${params.label}` });
			const state = await manager.rpcRequest(tracked.instanceId, { type: "get_state" });
			const sessionPath = sessionFileFrom(state);
			let gitHead: string | undefined;
			try {
				const head = await manager.fs(tracked.instanceId, { type: "fs_diff", revParse: true });
				gitHead = head.text?.trim() || undefined;
			} catch {
				// not a git repo: staleness tracking unavailable
			}
			await manager.stop(tracked.instanceId);
			updateStatus(ctx);
			if (!sessionPath) throw new Error("could not determine the baseline session file from get_state");
			await manager.saveBaseline({
				label: params.label,
				host: params.host,
				cwd: params.cwd,
				sessionPath,
				bundle: params.bundle ?? "default",
				createdAt: Date.now(),
				...(gitHead ? { gitHead } : {}),
			});
			return text(`baseline "${params.label}" recorded (${sessionPath} on ${params.host}${gitHead ? `, HEAD ${gitHead.slice(0, 12)}` : ""})`);
		},
	});

	pi.registerTool({
		name: "fleet_baselines",
		label: "Fleet Baselines",
		description: "List recorded warm-context baselines.",
		parameters: Type.Object({}),
		async execute() {
			const baselines = [...(await getFleet().loadBaselines()).values()];
			if (baselines.length === 0) return text("no baselines");
			return text(
				baselines
					.map((entry) => `${entry.label}: ${entry.host} ${entry.cwd} (bundle ${entry.bundle}, ${entry.sessionPath})`)
					.join("\n"),
			);
		},
	});

	pi.registerTool({
		name: "remote_model",
		label: "Remote Model",
		description:
			"Switch a fleet worker's model and/or thinking level at runtime " +
			"(e.g. downgrade a worker to a cheaper model mid-task).",
		parameters: Type.Object({
			instanceId: Type.String(),
			provider: Type.Optional(Type.String()),
			modelId: Type.Optional(Type.String()),
			thinking: Type.Optional(Type.String({ description: "off|minimal|low|medium|high|xhigh|max" })),
		}),
		async execute(_id, params) {
			const manager = getFleet();
			const lines: string[] = [];
			if (params.provider && params.modelId) {
				const response = (await manager.rpcRequest(params.instanceId, {
					type: "set_model",
					provider: params.provider,
					modelId: params.modelId,
				})) as { success?: boolean; error?: string };
				if (response.success === false) {
					throw new Error(`set_model failed: ${response.error ?? "no usable key on that machine?"}`);
				}
				lines.push(`model → ${params.provider}/${params.modelId}`);
			}
			if (params.thinking) {
				await manager.rpcRequest(params.instanceId, { type: "set_thinking_level", level: params.thinking });
				lines.push(`thinking → ${params.thinking}`);
			}
			if (lines.length === 0) return text("nothing to change (pass provider+modelId and/or thinking)");
			return text(`${params.instanceId}: ${lines.join(", ")}`);
		},
	});

	pi.registerTool({
		name: "remote_accept",
		label: "Remote Accept",
		description: "Accept a fleet worker's completed task: disposition stop (default) or keep_idle.",
		parameters: Type.Object({
			instanceId: Type.String(),
			disposition: Type.Optional(Type.String({ description: "stop | keep_idle" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const manager = getFleet();
			const tracked = manager.get(params.instanceId);
			if (tracked) tracked.review = "none";
			if ((params.disposition ?? "stop") === "stop") {
				const result = await manager.stop(params.instanceId);
				updateStatus(ctx);
				return text(`accepted; worker stopped${result.forced ? " (forced)" : ""}`);
			}
			return text("accepted; worker kept idle for further tasks");
		},
	});

	pi.registerTool({
		name: "remote_reject",
		label: "Remote Reject",
		description:
			"Reject a fleet worker's completed task with revision feedback; the feedback is delivered " +
			"to the same worker session (context intact) as a new tracked task.",
		parameters: Type.Object({ instanceId: Type.String(), feedback: Type.String() }),
		async execute(_id, params) {
			const taskId = `t-${Date.now().toString(36)}`;
			await getFleet().prompt(params.instanceId, `Revision requested: ${params.feedback}`, taskId);
			return text(`rejected; revision task ${taskId} sent to the same session`);
		},
	});

	pi.registerTool({
		name: "fleet_sessions",
		label: "Fleet Sessions",
		description: "List pi sessions on a fleet machine (agent-scanned; baselines and tasks flagged).",
		parameters: Type.Object({ host: Type.String(), limit: Type.Optional(Type.Number()) }),
		async execute(_id, params) {
			const client = await getFleet().agent(params.host);
			const report = client.lastSessionsReport;
			if (!report) return text("no sessions report received yet from that agent");
			const rows = report.sessions.slice(0, params.limit ?? 25);
			if (rows.length === 0) return text("no sessions on that machine");
			return text(
				rows
					.map((s) => `${s.kind}${s.pinned ? "(pinned)" : ""} ${s.name ?? s.sessionId} cwd=${s.cwd} ${new Date(s.updatedAt).toISOString()}`)
					.join("\n"),
			);
		},
	});

	pi.registerTool({
		name: "session_search",
		label: "Session Search",
		description: "Search pi session content on a fleet machine (grep runs on the agent; only hits return).",
		parameters: Type.Object({ host: Type.String(), query: Type.String() }),
		async execute(_id, params) {
			const client = await getFleet().agent(params.host);
			const hits = await client.sessionSearch(params.query);
			if (hits.length === 0) return text("no matches");
			return text(hits.map((hit) => `${hit.sessionId} (${hit.path}): …${hit.snippet}…`).join("\n"));
		},
	});

	pi.registerTool({
		name: "fleet_status",
		label: "Fleet Status",
		description: "List all fleet workers: instanceId, host, bundle, state, settled.",
		parameters: Type.Object({}),
		async execute() {
			const instances = getFleet().status();
			if (instances.length === 0) return text("no workers");
			return text(
				instances
					.map(
						(entry) =>
							`${entry.instanceId} host=${entry.host} bundle=${entry.bundle} state=${entry.state} ${entry.settled ? "settled" : "busy"}`,
					)
					.join("\n"),
			);
		},
	});
}
