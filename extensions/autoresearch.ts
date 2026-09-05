import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_RELATIVE_PATH, CONFIG_TEMPLATE, STATE_DIR, loadConfig } from "./config.ts";
import { createProposalCompleter, type ActiveModel } from "./completion.ts";
import { bestEntry, readLedger } from "./ledger.ts";
import { ensureExcluded, runDirectory, runResearchLoop, validateTag, type LoopStatus } from "./loop.ts";
import { PROPOSER_SYSTEM_PROMPT, renderProposalPrompt } from "./proposal.ts";

const WIDGET_ID = "autoresearch";
const SUBCOMMANDS = ["init", "start", "stop", "status"];

const PROGRAM_TEMPLATE = `# Research program

## Goal

Describe the objective in one or two sentences.

## Constraints

- Describe what the proposer must not change.
- Describe soft constraints such as memory or code simplicity.

## Ideas worth exploring

- List starting directions for the first experiments.
`;

function defaultTag(): string {
	return new Date().toISOString().slice(0, 16).replace(/[T:]/g, "-");
}

function formatMetric(value: number | null): string {
	return value === null ? "-" : String(value);
}

async function latestRunTag(root: string): Promise<string | undefined> {
	const runsDir = join(root, STATE_DIR, "runs");
	let names: string[];
	try {
		names = await readdir(runsDir);
	} catch {
		return undefined;
	}
	let latest: { tag: string; mtimeMs: number } | undefined;
	for (const name of names) {
		const info = await stat(join(runsDir, name)).catch(() => undefined);
		if (!info?.isDirectory()) continue;
		if (latest === undefined || info.mtimeMs > latest.mtimeMs) latest = { tag: name, mtimeMs: info.mtimeMs };
	}
	return latest?.tag;
}

export default function autoresearchExtension(pi: ExtensionAPI) {
	let controller: AbortController | undefined;
	let runningTag: string | undefined;

	const clearWidget = (ctx: ExtensionCommandContext) => {
		if (ctx.mode === "tui") ctx.ui.setWidget(WIDGET_ID, undefined);
	};

	const init = async (ctx: ExtensionCommandContext) => {
		const stateDir = join(ctx.cwd, STATE_DIR);
		await mkdir(stateDir, { recursive: true });
		try {
			await ensureExcluded(ctx.cwd);
		} catch {
			ctx.ui.notify(`Not a git repository; ${STATE_DIR}/ was not added to .git/info/exclude.`, "warning");
		}
		try {
			await writeFile(join(stateDir, "config.json"), `${JSON.stringify(CONFIG_TEMPLATE, null, 2)}\n`, { flag: "wx" });
			ctx.ui.notify(`Created ${CONFIG_RELATIVE_PATH}. Edit it before starting a run.`, "info");
		} catch {
			ctx.ui.notify(`${CONFIG_RELATIVE_PATH} already exists.`, "warning");
		}
		try {
			await writeFile(join(stateDir, "program.md"), PROGRAM_TEMPLATE, { flag: "wx" });
			ctx.ui.notify(`Created ${STATE_DIR}/program.md stub.`, "info");
		} catch {
			// Keep the existing program file.
		}
	};

	const status = async (ctx: ExtensionCommandContext, tagArgument: string | undefined) => {
		const tag = tagArgument ?? runningTag ?? (await latestRunTag(ctx.cwd));
		if (tag === undefined) {
			ctx.ui.notify(`No runs under ${STATE_DIR}/runs/. Use "/autoresearch start".`, "info");
			return;
		}
		let entries;
		try {
			entries = await readLedger(join(runDirectory(ctx.cwd, tag), "ledger.jsonl"));
		} catch (error) {
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			return;
		}
		if (entries.length === 0) {
			ctx.ui.notify(`No ledger for run ${tag}.`, "info");
			return;
		}
		let direction: "min" | "max" = "min";
		try {
			direction = (await loadConfig(ctx.cwd)).metric.direction;
		} catch {
			// Config was removed after the run; report with the default direction.
		}
		const counts = new Map<string, number>();
		for (const entry of entries) counts.set(entry.status, (counts.get(entry.status) ?? 0) + 1);
		const best = bestEntry(entries, direction);
		const last = entries[entries.length - 1];
		const lines = [
			`Run ${tag}: ${controller && runningTag === tag ? "running" : "not running"}.`,
			`Entries: ${entries.length} (${[...counts.entries()].map(([key, count]) => `${key} ${count}`).join(", ")})`,
			best ? `Best: ${best.metric} at iteration ${best.iteration} (${best.description})` : "Best: none kept yet",
			`Last: iteration ${last.iteration} ${last.status} ${formatMetric(last.metric)} (${last.description})`,
		];
		ctx.ui.notify(lines.join("\n"), "info");
	};

	const start = async (ctx: ExtensionCommandContext, tagArgument: string | undefined) => {
		if (controller) {
			ctx.ui.notify(`A run is already active on tag ${runningTag}. Use "/autoresearch stop" first.`, "warning");
			return;
		}
		const tag = tagArgument ?? defaultTag();
		try {
			validateTag(tag);
		} catch (error) {
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			return;
		}
		let config;
		try {
			config = await loadConfig(ctx.cwd);
		} catch (error) {
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			return;
		}
		let model: ActiveModel | undefined;
		if (config.model !== undefined) {
			const slash = config.model.indexOf("/");
			model = ctx.modelRegistry.find(config.model.slice(0, slash), config.model.slice(slash + 1));
			if (!model) {
				ctx.ui.notify(`Model not found: ${config.model}`, "error");
				return;
			}
		} else {
			model = ctx.model ?? undefined;
			if (!model) {
				ctx.ui.notify("No active model and no model configured.", "error");
				return;
			}
		}
		const thinkingLevel = config.thinkingLevel ?? ctx.thinkingLevel ?? "off";
		const complete = createProposalCompleter(ctx.modelRegistry);
		const abort = new AbortController();
		controller = abort;
		runningTag = tag;

		const onStatus = (loopStatus: LoopStatus) => {
			if (ctx.mode !== "tui") return;
			const best = loopStatus.best
				? `best ${loopStatus.best.metric} @ ${loopStatus.best.iteration}`
				: "no best yet";
			const last = loopStatus.last
				? `last ${loopStatus.last.status} ${formatMetric(loopStatus.last.metric)}`
				: "baseline pending";
			ctx.ui.setWidget(WIDGET_ID, [
				`autoresearch ${tag}: iteration ${loopStatus.iteration} | ${best} | ${last} | $${loopStatus.totalCost.toFixed(2)}`,
			]);
		};

		const propose = async (
			input: Parameters<typeof renderProposalPrompt>[0],
			signal: AbortSignal,
		) => {
			const context: Context = {
				systemPrompt: PROPOSER_SYSTEM_PROMPT,
				messages: [{ role: "user", content: renderProposalPrompt(input), timestamp: Date.now() }],
			};
			const message = await complete({ model, context, thinkingLevel, signal });
			if (message.stopReason === "error" || message.stopReason === "aborted") {
				throw new Error(message.errorMessage ?? `proposal ${message.stopReason}`);
			}
			const text = message.content
				.filter((item) => item.type === "text")
				.map((item) => item.text)
				.join("\n");
			return { text, usage: message.usage };
		};

		ctx.ui.notify(`autoresearch started: branch autoresearch/${tag}, model ${model.provider}/${model.id}`, "info");
		void runResearchLoop(ctx.cwd, config, tag, { propose, onStatus }, abort.signal)
			.then((summary) => {
				const best = summary.best
					? `best ${summary.best.metric} at iteration ${summary.best.iteration} (${summary.best.description})`
					: "no kept result";
				ctx.ui.notify(
					`autoresearch ${summary.reason} after iteration ${summary.iterations} on ${summary.branch}: ${best}. ` +
						`Cost $${summary.totalCost.toFixed(2)}, ${summary.totalTokens} tokens. Ledger: ${summary.ledgerPath}`,
					"info",
				);
			})
			.catch((error) => {
				ctx.ui.notify(`autoresearch stopped: ${error instanceof Error ? error.message : String(error)}`, "error");
			})
			.finally(() => {
				controller = undefined;
				runningTag = undefined;
				clearWidget(ctx);
			});
	};

	pi.registerCommand("autoresearch", {
		description: "Autonomous experiment loop: init | start [tag] | stop | status [tag]",
		getArgumentCompletions: (prefix) => {
			const items = SUBCOMMANDS.filter((name) => name.startsWith(prefix)).map((name) => ({
				value: name,
				label: name,
			}));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
			const subcommand = parts[0] ?? "status";
			if (subcommand === "init") return init(ctx);
			if (subcommand === "start") return start(ctx, parts[1]);
			if (subcommand === "status") return status(ctx, parts[1]);
			if (subcommand === "stop") {
				if (!controller) {
					ctx.ui.notify("No autoresearch run is active.", "info");
				} else {
					controller.abort();
					ctx.ui.notify("Stopping after the current step; in-flight changes are reverted.", "info");
				}
				return;
			}
			ctx.ui.notify(`Unknown subcommand: ${subcommand}. Use init | start [tag] | stop | status [tag].`, "error");
		},
	});

	pi.on("session_shutdown", async () => {
		controller?.abort();
	});
}
