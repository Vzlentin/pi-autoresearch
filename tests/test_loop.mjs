import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

process.env.XDG_STATE_HOME = await mkdtemp(join(tmpdir(), "autoresearch-state-"));

const { extractMetric, runResearchLoop, validateTag } = await import("../extensions/loop.ts");
import { readLedger } from "../extensions/ledger.ts";

function git(root, ...args) {
	return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

async function makeRepo() {
	const root = await mkdtemp(join(tmpdir(), "autoresearch-loop-"));
	git(root, "init", "-q", "-b", "main");
	git(root, "config", "user.email", "test@example.com");
	git(root, "config", "user.name", "Test");
	await writeFile(join(root, "value.txt"), "10\n", "utf8");
	git(root, "add", "value.txt");
	git(root, "commit", "-q", "-m", "initial");
	return root;
}

const config = {
	runCommand: 'v="$(cat value.txt)"; if [ "$v" = "crash" ]; then echo boom >&2; exit 1; fi; echo "metric: $v"',
	metric: { pattern: "^metric:\\s+([0-9.]+)", direction: "min" },
	editablePaths: ["value.txt"],
	readOnlyPaths: [],
	programPath: undefined,
	timeoutSeconds: 30,
	maxIterations: 4,
};

function proposal(value) {
	return ["<<<DESCRIPTION>>>", `set value to ${value}`, "<<<FILE: value.txt>>>", value, "<<<END FILE>>>"].join("\n");
}

test("validateTag accepts branch-safe names and rejects the rest", () => {
	for (const tag of ["acv-graph-v1", "2026-09-05-07-51", "run_2", "a.b", "x"]) {
		assert.doesNotThrow(() => validateTag(tag), tag);
	}
	for (const tag of ["", "acv graph", "a/b", "-lead", ".hidden", "a..b", "trail.", "a".repeat(65), "tag\n"]) {
		assert.throws(() => validateTag(tag), /invalid tag/, JSON.stringify(tag));
	}
});

test("runResearchLoop rejects an invalid tag before touching git", async () => {
	const root = await makeRepo();
	await assert.rejects(
		runResearchLoop(root, config, "bad/tag", { propose: async () => ({ text: "" }) }, new AbortController().signal),
		/invalid tag/,
	);
	assert.equal(git(root, "rev-parse", "--abbrev-ref", "HEAD"), "main");
	await rm(root, { recursive: true, force: true });
});

test("extractMetric parses the first capture group", () => {
	assert.equal(extractMetric("noise\nmetric: 1.25\n", "^metric:\\s+([0-9.]+)"), 1.25);
	assert.equal(extractMetric("nothing here", "^metric:\\s+([0-9.]+)"), null);
});

test("runResearchLoop: baseline, keep, discard, crash, invalid", async () => {
	const root = await makeRepo();
	const proposals = [proposal("5"), proposal("7"), proposal("crash"), "garbage output"];
	const proposeInputs = [];
	const deps = {
		propose: async (input) => {
			proposeInputs.push(input);
			return { text: proposals[input.iteration - 1] };
		},
	};

	const summary = await runResearchLoop(root, config, "test", deps, new AbortController().signal);

	assert.equal(summary.reason, "max-iterations");
	assert.equal(summary.iterations, 4);
	assert.equal(summary.branch, "autoresearch/test");
	assert.equal(
		summary.ledgerPath,
		join(process.env.XDG_STATE_HOME, "pi-autoresearch", root, "runs", "test", "ledger.jsonl"),
	);
	assert.equal(summary.best?.metric, 5);
	assert.equal(git(root, "rev-parse", "--abbrev-ref", "HEAD"), "autoresearch/test");

	const entries = await readLedger(summary.ledgerPath);
	assert.deepEqual(
		entries.map((entry) => [entry.iteration, entry.status, entry.metric]),
		[
			[0, "keep", 10],
			[1, "keep", 5],
			[2, "discard", 7],
			[3, "crash", null],
			[4, "invalid", null],
		],
	);

	// Kept change persists; discarded and crashed changes are reverted.
	assert.equal(await readFile(join(root, "value.txt"), "utf8"), "5\n");
	// Branch history: initial commit plus the one kept experiment commit.
	assert.equal(git(root, "rev-list", "--count", "HEAD"), "2");
	// Each proposer response is saved next to the run log.
	assert.equal(await readFile(join(summary.ledgerPath, "..", "logs", "iter-1.proposal.md"), "utf8"), proposals[0]);
	// The crash log tail is offered to the proposer on the next iteration.
	assert.equal(proposeInputs[2].lastCrashLog, undefined);
	assert.match(proposeInputs[3].lastCrashLog, /boom/);
	// Harness state lives outside the repository.
	assert.equal(git(root, "status", "--porcelain"), "");

	await rm(root, { recursive: true, force: true });
});

test("runResearchLoop resumes from an existing ledger without a new baseline", async () => {
	const root = await makeRepo();
	const first = await runResearchLoop(
		root,
		{ ...config, maxIterations: 1 },
		"resume",
		{ propose: async () => ({ text: proposal("8") }) },
		new AbortController().signal,
	);
	assert.equal(first.iterations, 1);

	let proposeCalls = 0;
	const second = await runResearchLoop(
		root,
		{ ...config, maxIterations: 2 },
		"resume",
		{
			propose: async (input) => {
				proposeCalls += 1;
				assert.equal(input.iteration, 2);
				assert.equal(input.entries.length, 2);
				return { text: proposal("4") };
			},
		},
		new AbortController().signal,
	);

	assert.equal(proposeCalls, 1);
	assert.equal(second.best?.metric, 4);
	assert.equal(await readFile(join(root, "value.txt"), "utf8"), "4\n");
	await rm(root, { recursive: true, force: true });
});

test("runResearchLoop keeps runs with different tags independent", async () => {
	const root = await makeRepo();
	const first = await runResearchLoop(
		root,
		{ ...config, maxIterations: 1 },
		"alpha",
		{ propose: async () => ({ text: proposal("8") }) },
		new AbortController().signal,
	);
	assert.equal(first.best?.metric, 8);

	const inputs = [];
	const second = await runResearchLoop(
		root,
		{ ...config, maxIterations: 1 },
		"beta",
		{
			propose: async (input) => {
				inputs.push(input);
				return { text: proposal("9") };
			},
		},
		new AbortController().signal,
	);

	// The second run started from its own baseline, not from alpha's ledger.
	assert.equal(inputs.length, 1);
	assert.equal(inputs[0].iteration, 1);
	assert.equal(inputs[0].entries.length, 1);
	assert.equal(inputs[0].entries[0].description, "baseline");
	assert.notEqual(second.ledgerPath, first.ledgerPath);
	assert.equal((await readLedger(first.ledgerPath)).length, 2);
	assert.equal((await readLedger(second.ledgerPath)).length, 2);
	await rm(root, { recursive: true, force: true });
});

test("runResearchLoop bypasses repository commit hooks", async () => {
	const root = await makeRepo();
	await writeFile(join(root, ".git", "hooks", "pre-commit"), "#!/bin/sh\necho hook ran >&2\nexit 1\n", { mode: 0o755 });
	const summary = await runResearchLoop(
		root,
		{ ...config, maxIterations: 1 },
		"hooks",
		{ propose: async () => ({ text: proposal("3") }) },
		new AbortController().signal,
	);
	assert.equal(summary.best?.metric, 3);
	assert.equal(git(root, "rev-list", "--count", "HEAD"), "2");
	await rm(root, { recursive: true, force: true });
});

test("runResearchLoop refuses a dirty worktree", async () => {
	const root = await makeRepo();
	await writeFile(join(root, "value.txt"), "dirty\n", "utf8");
	await assert.rejects(
		runResearchLoop(root, config, "dirty", { propose: async () => ({ text: "" }) }, new AbortController().signal),
		/not clean/,
	);
	await rm(root, { recursive: true, force: true });
});

test("runResearchLoop aborts between iterations", async () => {
	const root = await makeRepo();
	const abort = new AbortController();
	const summary = await runResearchLoop(
		root,
		{ ...config, maxIterations: 0 },
		"abort",
		{
			propose: async () => {
				abort.abort();
				return { text: proposal("6") };
			},
		},
		abort.signal,
	);
	assert.equal(summary.reason, "aborted");
	// The kept baseline is the only ledger entry with a metric.
	assert.equal(summary.best?.metric, 10);
	await rm(root, { recursive: true, force: true });
});
