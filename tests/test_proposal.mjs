import assert from "node:assert/strict";
import test from "node:test";
import { parseProposal, renderProposalPrompt } from "../extensions/proposal.ts";

test("renderProposalPrompt includes objective, ledger, and files", () => {
	const prompt = renderProposalPrompt({
		iteration: 3,
		runCommand: "uv run train.py",
		metricPattern: "^val_bpb: ([0-9.]+)",
		direction: "min",
		program: "Goal: lower val_bpb.",
		files: [{ path: "train.py", content: "print('hi')\n" }],
		readOnlyFiles: [{ path: "prepare.py", content: "CONST = 1\n" }],
		entries: [
			{
				iteration: 0,
				timestamp: "t",
				commit: "abc",
				status: "keep",
				metric: 1.0,
				description: "baseline",
				durationSeconds: 10,
			},
		],
		lastCrashLog: "Traceback: boom",
	});
	assert.match(prompt, /Minimize the metric/);
	assert.match(prompt, /iteration 3/);
	assert.match(prompt, /Goal: lower val_bpb\./);
	assert.match(prompt, /0\tkeep\t1\tbaseline/);
	assert.match(prompt, /Previous run crashed/);
	assert.match(prompt, /Read-only file: prepare\.py/);
	assert.match(prompt, /Editable file: train\.py/);
});

test("renderProposalPrompt truncates a long ledger", () => {
	const entries = Array.from({ length: 60 }, (_, index) => ({
		iteration: index,
		timestamp: "t",
		commit: "abc",
		status: "discard",
		metric: 1,
		description: `try ${index}`,
		durationSeconds: 1,
	}));
	const prompt = renderProposalPrompt({
		iteration: 61,
		runCommand: "x",
		metricPattern: "y",
		direction: "max",
		files: [],
		readOnlyFiles: [],
		entries,
	});
	assert.match(prompt, /20 earlier entries omitted/);
	assert.doesNotMatch(prompt, /\ttry 19$/m);
	assert.match(prompt, /try 59/);
});

const validProposal = [
	"<<<DESCRIPTION>>>",
	"increase learning rate",
	"<<<FILE: train.py>>>",
	"LR = 0.04",
	"<<<END FILE>>>",
].join("\n");

test("parseProposal accepts a valid proposal", () => {
	const parsed = parseProposal(validProposal, ["train.py"]);
	assert.equal(parsed.description, "increase learning rate");
	assert.equal(parsed.files.length, 1);
	assert.equal(parsed.files[0].path, "train.py");
	assert.equal(parsed.files[0].content, "LR = 0.04\n");
});

test("parseProposal tolerates prose around the blocks", () => {
	const parsed = parseProposal(`Some preamble.\n${validProposal}\ntrailing note`, ["train.py"]);
	assert.equal(parsed.description, "increase learning rate");
});

test("parseProposal rejects malformed proposals", () => {
	assert.match(parseProposal("no blocks here", ["train.py"]).error, /DESCRIPTION/);
	assert.match(parseProposal("<<<DESCRIPTION>>>\n\n<<<FILE: train.py>>>\nx\n<<<END FILE>>>", ["train.py"]).error, /empty description/);
	assert.match(parseProposal(validProposal, ["other.py"]).error, /not editable/);
	assert.match(
		parseProposal(`${validProposal}\n<<<FILE: train.py>>>\ny\n<<<END FILE>>>`, ["train.py"]).error,
		/duplicate/,
	);
	assert.match(
		parseProposal("<<<DESCRIPTION>>>\nidea\n<<<FILE: train.py>>>\nx", ["train.py"]).error,
		/missing <<<END FILE>>>/,
	);
	assert.match(parseProposal("<<<DESCRIPTION>>>\nidea only", ["train.py"]).error, /no file blocks/);
});
