import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Usage } from "@earendil-works/pi-ai";
import { stateDir, type AutoresearchConfig } from "./config.ts";
import { appendLedger, bestEntry, isBetter, readLedger, type LedgerEntry } from "./ledger.ts";
import { parseProposal, type ProposalInput } from "./proposal.ts";

const CRASH_LOG_TAIL_LINES = 60;
const PROPOSE_ATTEMPTS = 3;
const PROPOSE_RETRY_DELAY_MS = 10_000;

export interface ExecResult {
	stdout: string;
	stderr: string;
	code: number;
	killed: boolean;
}

export interface LoopStatus {
	iteration: number;
	best: LedgerEntry | undefined;
	last: LedgerEntry | undefined;
	totalCost: number;
	totalTokens: number;
}

export interface LoopSummary {
	reason: "aborted" | "max-iterations";
	iterations: number;
	best: LedgerEntry | undefined;
	totalCost: number;
	totalTokens: number;
	branch: string;
	ledgerPath: string;
}

export interface LoopDeps {
	propose(input: ProposalInput, signal: AbortSignal): Promise<{ text: string; usage?: Usage }>;
	onStatus?(status: LoopStatus): void;
}

export function run(
	command: string,
	args: string[],
	cwd: string,
	timeoutMs: number | undefined,
	signal: AbortSignal | undefined,
): Promise<ExecResult> {
	return new Promise((resolvePromise) => {
		const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"], detached: true });
		let stdout = "";
		let stderr = "";
		let killed = false;
		let settled = false;
		const finish = (code: number | null) => {
			if (settled) return;
			settled = true;
			if (timer !== undefined) clearTimeout(timer);
			signal?.removeEventListener("abort", kill);
			resolvePromise({ stdout, stderr, code: code ?? -1, killed });
		};
		const kill = () => {
			killed = true;
			if (child.pid !== undefined) {
				try {
					process.kill(-child.pid, "SIGKILL");
				} catch {
					child.kill("SIGKILL");
				}
			}
		};
		const timer = timeoutMs !== undefined ? setTimeout(kill, timeoutMs) : undefined;
		signal?.addEventListener("abort", kill, { once: true });
		child.stdout.on("data", (data: Buffer) => {
			stdout += data.toString();
		});
		child.stderr.on("data", (data: Buffer) => {
			stderr += data.toString();
		});
		child.on("error", (error) => {
			stderr += `\n${String(error)}`;
			finish(-1);
		});
		child.on("close", (code) => finish(code));
	});
}

async function git(root: string, ...args: string[]): Promise<string> {
	const result = await run("git", args, root, 60_000, undefined);
	if (result.code !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`);
	}
	return result.stdout.trim();
}

export function extractMetric(output: string, pattern: string): number | null {
	const match = new RegExp(pattern, "m").exec(output);
	if (!match) return null;
	const value = Number.parseFloat(match[1] ?? match[0]);
	return Number.isFinite(value) ? value : null;
}

const TAG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function validateTag(tag: string): void {
	if (!TAG_PATTERN.test(tag) || tag.endsWith(".") || tag.includes("..")) {
		throw new Error(
			`invalid tag "${tag}": use 1-64 letters, digits, ".", "_" or "-", starting with a letter or digit`,
		);
	}
}

export function runDirectory(root: string, tag: string): string {
	validateTag(tag);
	return join(stateDir(root), "runs", tag);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolvePromise) => {
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolvePromise();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			resolvePromise();
		};
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

interface RunOutcome {
	metric: number | null;
	crashed: boolean;
	durationSeconds: number;
	logPath: string;
	logText: string;
}

async function runExperiment(
	root: string,
	config: AutoresearchConfig,
	logsDir: string,
	iteration: number,
	signal: AbortSignal,
): Promise<RunOutcome> {
	const started = Date.now();
	const result = await run("bash", ["-c", config.runCommand], root, config.timeoutSeconds * 1000, signal);
	const logText = [
		result.stdout,
		result.stderr ? `\n--- stderr ---\n${result.stderr}` : "",
		result.killed ? `\n--- killed after ${config.timeoutSeconds}s timeout or abort ---` : "",
	].join("");
	const logPath = join(logsDir, `iter-${iteration}.log`);
	await writeFile(logPath, logText, "utf8");
	const metric = extractMetric(logText, config.metric.pattern);
	return {
		metric,
		crashed: result.code !== 0 || result.killed || metric === null,
		durationSeconds: (Date.now() - started) / 1000,
		logPath,
		logText,
	};
}

function logTail(text: string): string {
	return text.split("\n").slice(-CRASH_LOG_TAIL_LINES).join("\n");
}

async function proposeWithRetry(
	deps: LoopDeps,
	input: ProposalInput,
	signal: AbortSignal,
): Promise<{ text: string; usage?: Usage }> {
	let lastError: unknown;
	for (let attempt = 1; attempt <= PROPOSE_ATTEMPTS; attempt += 1) {
		if (signal.aborted) break;
		try {
			return await deps.propose(input, signal);
		} catch (error) {
			lastError = error;
			if (attempt < PROPOSE_ATTEMPTS && !signal.aborted) {
				await sleep(PROPOSE_RETRY_DELAY_MS, signal);
			}
		}
	}
	throw lastError instanceof Error ? lastError : new Error(String(lastError ?? "proposal aborted"));
}

export async function runResearchLoop(
	root: string,
	config: AutoresearchConfig,
	tag: string,
	deps: LoopDeps,
	signal: AbortSignal,
): Promise<LoopSummary> {
	const runDir = runDirectory(root, tag);
	const logsDir = join(runDir, "logs");
	const ledgerPath = join(runDir, "ledger.jsonl");
	await mkdir(logsDir, { recursive: true });

	for (const path of [...config.editablePaths, ...config.readOnlyPaths]) {
		await readFile(join(root, path), "utf8").catch(() => {
			throw new Error(`configured path does not exist: ${path}`);
		});
	}

	const porcelain = await git(root, "status", "--porcelain");
	const dirty = porcelain.split("\n").filter((line) => line.trim() !== "");
	if (dirty.length > 0) {
		throw new Error(`worktree is not clean:\n${dirty.join("\n")}`);
	}

	const branch = `autoresearch/${tag}`;
	const branchExists =
		(await run("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], root, 60_000, undefined))
			.code === 0;
	await git(root, "checkout", ...(branchExists ? [branch] : ["-b", branch]));

	const entries = await readLedger(ledgerPath);
	let iteration = entries.length > 0 ? Math.max(...entries.map((entry) => entry.iteration)) : -1;
	let totalCost = 0;
	let totalTokens = 0;
	const direction = config.metric.direction;

	const emit = () => {
		deps.onStatus?.({
			iteration,
			best: bestEntry(entries, direction),
			last: entries[entries.length - 1],
			totalCost,
			totalTokens,
		});
	};

	const record = async (entry: LedgerEntry) => {
		await appendLedger(ledgerPath, entry);
		entries.push(entry);
		emit();
	};

	if (entries.length === 0) {
		iteration = 0;
		const outcome = await runExperiment(root, config, logsDir, 0, signal);
		if (signal.aborted) {
			return { reason: "aborted", iterations: 0, best: undefined, totalCost, totalTokens, branch, ledgerPath };
		}
		if (outcome.crashed) {
			throw new Error(
				`baseline run failed (metric ${outcome.metric === null ? "not found" : outcome.metric}); see ${outcome.logPath}`,
			);
		}
		await record({
			iteration: 0,
			timestamp: new Date().toISOString(),
			commit: await git(root, "rev-parse", "--short", "HEAD"),
			status: "keep",
			metric: outcome.metric,
			description: "baseline",
			durationSeconds: outcome.durationSeconds,
		});
	}

	let lastOutcome: RunOutcome | undefined;
	while (!signal.aborted && (config.maxIterations === 0 || iteration < config.maxIterations)) {
		iteration += 1;

		const files = [];
		for (const path of config.editablePaths) {
			files.push({ path, content: await readFile(join(root, path), "utf8") });
		}
		const readOnlyFiles = [];
		for (const path of config.readOnlyPaths) {
			readOnlyFiles.push({ path, content: await readFile(join(root, path), "utf8") });
		}
		const previous = entries[entries.length - 1];
		const input: ProposalInput = {
			iteration,
			runCommand: config.runCommand,
			metricPattern: config.metric.pattern,
			direction,
			program: config.programPath
				? await readFile(resolve(stateDir(root), config.programPath), "utf8")
				: undefined,
			files,
			readOnlyFiles,
			entries: [...entries],
			lastCrashLog:
				previous?.status === "crash" && lastOutcome !== undefined ? logTail(lastOutcome.logText) : undefined,
		};

		const response = await proposeWithRetry(deps, input, signal);
		totalCost += response.usage?.cost.total ?? 0;
		totalTokens += response.usage?.totalTokens ?? 0;
		if (signal.aborted) break;

		const parsed = parseProposal(response.text, config.editablePaths);
		if ("error" in parsed) {
			lastOutcome = undefined;
			await record({
				iteration,
				timestamp: new Date().toISOString(),
				commit: null,
				status: "invalid",
				metric: null,
				description: `invalid proposal: ${parsed.error}`,
				durationSeconds: null,
			});
			continue;
		}

		const preHead = await git(root, "rev-parse", "HEAD");
		for (const file of parsed.files) {
			await writeFile(join(root, file.path), file.content, "utf8");
		}
		const changed = await git(root, "status", "--porcelain", "--", ...parsed.files.map((file) => file.path));
		if (changed.trim() === "") {
			lastOutcome = undefined;
			await record({
				iteration,
				timestamp: new Date().toISOString(),
				commit: null,
				status: "invalid",
				metric: null,
				description: `no-op proposal: ${parsed.description}`,
				durationSeconds: null,
			});
			continue;
		}
		await git(root, "add", "--", ...parsed.files.map((file) => file.path));
		await git(root, "commit", "-m", `autoresearch ${iteration}: ${parsed.description}`);
		const commit = await git(root, "rev-parse", "--short", "HEAD");

		const outcome = await runExperiment(root, config, logsDir, iteration, signal);
		if (signal.aborted) {
			await git(root, "reset", "--hard", preHead);
			break;
		}
		lastOutcome = outcome;

		const best = bestEntry(entries, direction);
		let status: LedgerEntry["status"];
		if (outcome.crashed || outcome.metric === null) {
			status = "crash";
		} else if (best?.metric == null || isBetter(outcome.metric, best.metric, direction)) {
			status = "keep";
		} else {
			status = "discard";
		}
		if (status !== "keep") {
			await git(root, "reset", "--hard", preHead);
		}
		await record({
			iteration,
			timestamp: new Date().toISOString(),
			commit,
			status,
			metric: outcome.metric,
			description: parsed.description,
			durationSeconds: outcome.durationSeconds,
		});
	}

	return {
		reason: signal.aborted ? "aborted" : "max-iterations",
		iterations: iteration,
		best: bestEntry(entries, direction),
		totalCost,
		totalTokens,
		branch,
		ledgerPath,
	};
}
