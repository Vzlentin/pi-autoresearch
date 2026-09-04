import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

export type LedgerStatus = "keep" | "discard" | "crash" | "invalid";

export interface LedgerEntry {
	iteration: number;
	timestamp: string;
	commit: string | null;
	status: LedgerStatus;
	metric: number | null;
	description: string;
	durationSeconds: number | null;
}

export async function readLedger(path: string): Promise<LedgerEntry[]> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch {
		return [];
	}
	const entries: LedgerEntry[] = [];
	for (const line of text.split("\n")) {
		if (line.trim() === "") continue;
		entries.push(JSON.parse(line) as LedgerEntry);
	}
	return entries;
}

export async function appendLedger(path: string, entry: LedgerEntry): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await appendFile(path, `${JSON.stringify(entry)}\n`, "utf8");
}

export function isBetter(candidate: number, current: number, direction: "min" | "max"): boolean {
	return direction === "min" ? candidate < current : candidate > current;
}

/** Best kept entry with a metric, or undefined when none exists. */
export function bestEntry(entries: LedgerEntry[], direction: "min" | "max"): LedgerEntry | undefined {
	let best: LedgerEntry | undefined;
	for (const entry of entries) {
		if (entry.status !== "keep" || entry.metric === null) continue;
		if (best === undefined || best.metric === null || isBetter(entry.metric, best.metric, direction)) {
			best = entry;
		}
	}
	return best;
}
