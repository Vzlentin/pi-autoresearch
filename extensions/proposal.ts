import type { LedgerEntry } from "./ledger.ts";

export interface ProposalFile {
	path: string;
	content: string;
}

export interface ProposalInput {
	iteration: number;
	runCommand: string;
	metricPattern: string;
	direction: "min" | "max";
	program?: string;
	files: ProposalFile[];
	readOnlyFiles: ProposalFile[];
	entries: LedgerEntry[];
	/** Tail of the previous run log when the previous iteration crashed. */
	lastCrashLog?: string;
}

export interface ParsedProposal {
	description: string;
	files: ProposalFile[];
}

const LEDGER_TAIL = 40;
const DESCRIPTION_MAX = 160;

export const PROPOSER_SYSTEM_PROMPT = [
	"You are an autonomous research engineer inside a harness-driven experiment loop.",
	"Each call is one iteration. Propose exactly one experimental change to the editable files, then stop.",
	"The harness applies your files, commits, runs the experiment, extracts the metric, and keeps or reverts the change mechanically.",
	"",
	"Rules:",
	"- Rewrite only editable files. Return the complete new content of each file you change.",
	"- Propose one focused idea per iteration. Use the ledger to avoid repeats and to build on kept changes.",
	"- Prefer simple changes. A tiny gain that adds much complexity is not worth it. Deletions that hold the metric are wins.",
	"- If the previous run crashed, fix the cause or move to a different idea.",
	"- Never change how the metric is computed or reported.",
	"",
	"Output format, exactly, with no other text before or after:",
	"<<<DESCRIPTION>>>",
	"<one short line naming the experiment>",
	"<<<FILE: relative/path>>>",
	"<complete new file content>",
	"<<<END FILE>>>",
	"",
	"Repeat the FILE block for each editable file you change. Only listed editable paths are allowed.",
].join("\n");

function renderLedger(entries: LedgerEntry[], direction: "min" | "max"): string {
	if (entries.length === 0) return "(empty; the harness will run a baseline first)";
	const lines = ["iteration\tstatus\tmetric\tdescription"];
	const tail = entries.slice(-LEDGER_TAIL);
	if (tail.length < entries.length) {
		lines.push(`(${entries.length - tail.length} earlier entries omitted)`);
	}
	for (const entry of tail) {
		lines.push(`${entry.iteration}\t${entry.status}\t${entry.metric ?? "-"}\t${entry.description}`);
	}
	return lines.join("\n");
}

export function renderProposalPrompt(input: ProposalInput): string {
	const sections: string[] = [];
	const goal = input.direction === "min" ? "Minimize" : "Maximize";
	sections.push(
		[
			`## Objective`,
			`${goal} the metric captured by the regular expression ${input.metricPattern} in the output of: ${input.runCommand}`,
			`This is iteration ${input.iteration}. Each run has a fixed budget enforced by the harness.`,
		].join("\n"),
	);
	if (input.program) {
		sections.push(`## Program\n${input.program.trim()}`);
	}
	sections.push(`## Ledger\n${renderLedger(input.entries, input.direction)}`);
	if (input.lastCrashLog) {
		sections.push(`## Previous run crashed. Log tail\n${input.lastCrashLog}`);
	}
	for (const file of input.readOnlyFiles) {
		sections.push(`## Read-only file: ${file.path}\n${file.content}`);
	}
	for (const file of input.files) {
		sections.push(`## Editable file: ${file.path}\n${file.content}`);
	}
	sections.push("Propose the next experiment now, in the required output format.");
	return sections.join("\n\n");
}

function sanitizeDescription(raw: string): string {
	const flat = raw.replace(/\s+/g, " ").trim();
	return flat.length > DESCRIPTION_MAX ? `${flat.slice(0, DESCRIPTION_MAX - 1)}…` : flat;
}

export function parseProposal(
	text: string,
	editablePaths: string[],
): ParsedProposal | { error: string } {
	const lines = text.split("\n");
	let index = 0;
	while (index < lines.length && lines[index].trim() !== "<<<DESCRIPTION>>>") index += 1;
	if (index >= lines.length) return { error: "missing <<<DESCRIPTION>>> block" };
	index += 1;

	const descriptionLines: string[] = [];
	while (index < lines.length && !lines[index].trim().startsWith("<<<FILE:")) {
		descriptionLines.push(lines[index]);
		index += 1;
	}
	const description = sanitizeDescription(descriptionLines.join(" "));
	if (description === "") return { error: "empty description" };

	const allowed = new Set(editablePaths);
	const files: ProposalFile[] = [];
	const seen = new Set<string>();
	while (index < lines.length) {
		const header = lines[index].trim();
		if (!header.startsWith("<<<FILE:")) {
			index += 1;
			continue;
		}
		const match = /^<<<FILE:\s*(.+?)\s*>>>$/.exec(header);
		if (!match) return { error: `malformed file header: ${header}` };
		const path = match[1];
		if (!allowed.has(path)) return { error: `path is not editable: ${path}` };
		if (seen.has(path)) return { error: `duplicate file block: ${path}` };
		seen.add(path);
		index += 1;
		const content: string[] = [];
		while (index < lines.length && lines[index].trim() !== "<<<END FILE>>>") {
			content.push(lines[index]);
			index += 1;
		}
		if (index >= lines.length) return { error: `missing <<<END FILE>>> for ${path}` };
		index += 1;
		let body = content.join("\n");
		if (!body.endsWith("\n")) body += "\n";
		files.push({ path, content: body });
	}
	if (files.length === 0) return { error: "no file blocks in proposal" };
	return { description, files };
}
