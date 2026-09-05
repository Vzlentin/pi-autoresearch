import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const STATE_DIR = ".autoresearch";
export const CONFIG_RELATIVE_PATH = `${STATE_DIR}/config.json`;

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type ConfigThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface MetricConfig {
	/** Regular expression applied to the run output. Capture group 1 is the metric value. */
	pattern: string;
	direction: "min" | "max";
}

export interface AutoresearchConfig {
	/** Shell command that runs one experiment, executed with bash -c in the repository root. */
	runCommand: string;
	metric: MetricConfig;
	/** Relative paths the proposer may rewrite. */
	editablePaths: string[];
	/** Relative paths shown to the proposer as read-only context. */
	readOnlyPaths: string[];
	/** Optional markdown file with the research goal and constraints. */
	programPath?: string;
	/** Hard timeout for one run. A run that exceeds it is killed and counted as a crash. */
	timeoutSeconds: number;
	/** Stop when the absolute iteration index reaches this value. 0 means unlimited. */
	maxIterations: number;
	/** Optional proposer model as "provider/modelId". Defaults to the active session model. */
	model?: string;
	/** Optional proposer thinking level. Defaults to the active session level. */
	thinkingLevel?: ConfigThinkingLevel;
}

export const CONFIG_TEMPLATE: unknown = {
	runCommand: "uv run train.py",
	metric: { pattern: "^val_bpb:\\s+([0-9.eE+-]+)", direction: "min" },
	editablePaths: ["train.py"],
	readOnlyPaths: ["prepare.py"],
	programPath: `${STATE_DIR}/program.md`,
	timeoutSeconds: 600,
	maxIterations: 100,
};

function fail(message: string): never {
	throw new Error(`${CONFIG_RELATIVE_PATH}: ${message}`);
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0);
}

export function parseConfig(raw: unknown): AutoresearchConfig {
	if (typeof raw !== "object" || raw === null) fail("must be a JSON object");
	const data = raw as Record<string, unknown>;

	if (typeof data.runCommand !== "string" || data.runCommand.trim() === "") {
		fail("runCommand must be a non-empty string");
	}

	const metric = data.metric as Record<string, unknown> | undefined;
	if (typeof metric !== "object" || metric === null) fail("metric must be an object");
	if (typeof metric.pattern !== "string" || metric.pattern === "") {
		fail("metric.pattern must be a non-empty regular expression string");
	}
	try {
		new RegExp(metric.pattern, "m");
	} catch (error) {
		fail(`metric.pattern does not compile: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (metric.direction !== "min" && metric.direction !== "max") {
		fail('metric.direction must be "min" or "max"');
	}

	if (!isStringArray(data.editablePaths) || data.editablePaths.length === 0) {
		fail("editablePaths must be a non-empty array of relative paths");
	}
	for (const path of data.editablePaths) {
		if (path.startsWith("/") || path.split("/").includes("..")) {
			fail(`editablePaths entries must be relative paths inside the repository: ${path}`);
		}
	}
	if (data.readOnlyPaths !== undefined && !isStringArray(data.readOnlyPaths)) {
		fail("readOnlyPaths must be an array of relative paths");
	}
	if (data.programPath !== undefined && typeof data.programPath !== "string") {
		fail("programPath must be a string");
	}
	if (
		data.timeoutSeconds !== undefined &&
		(typeof data.timeoutSeconds !== "number" || data.timeoutSeconds <= 0)
	) {
		fail("timeoutSeconds must be a positive number");
	}
	if (
		data.maxIterations !== undefined &&
		(typeof data.maxIterations !== "number" || data.maxIterations < 0 || !Number.isInteger(data.maxIterations))
	) {
		fail("maxIterations must be a non-negative integer");
	}
	if (data.model !== undefined) {
		if (typeof data.model !== "string" || !data.model.includes("/")) {
			fail('model must be "provider/modelId"');
		}
	}
	if (
		data.thinkingLevel !== undefined &&
		!THINKING_LEVELS.includes(data.thinkingLevel as (typeof THINKING_LEVELS)[number])
	) {
		fail(`thinkingLevel must be one of: ${THINKING_LEVELS.join(", ")}`);
	}

	return {
		runCommand: data.runCommand,
		metric: { pattern: metric.pattern, direction: metric.direction },
		editablePaths: data.editablePaths,
		readOnlyPaths: (data.readOnlyPaths as string[] | undefined) ?? [],
		programPath: data.programPath as string | undefined,
		timeoutSeconds: (data.timeoutSeconds as number | undefined) ?? 600,
		maxIterations: (data.maxIterations as number | undefined) ?? 0,
		model: data.model as string | undefined,
		thinkingLevel: data.thinkingLevel as ConfigThinkingLevel | undefined,
	};
}

export async function loadConfig(root: string): Promise<AutoresearchConfig> {
	let text: string;
	try {
		text = await readFile(join(root, STATE_DIR, "config.json"), "utf8");
	} catch {
		fail(`not found in ${root}. Run "/autoresearch init" to create a template.`);
	}
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (error) {
		fail(`invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	return parseConfig(raw);
}
