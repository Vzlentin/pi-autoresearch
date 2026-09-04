import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { appendLedger, bestEntry, isBetter, readLedger } from "../extensions/ledger.ts";

function entry(iteration, status, metric) {
	return {
		iteration,
		timestamp: new Date().toISOString(),
		commit: "abc1234",
		status,
		metric,
		description: `entry ${iteration}`,
		durationSeconds: 1,
	};
}

test("readLedger returns [] for a missing file", async () => {
	assert.deepEqual(await readLedger("/nonexistent/ledger.jsonl"), []);
});

test("appendLedger and readLedger round-trip", async () => {
	const dir = await mkdtemp(join(tmpdir(), "autoresearch-ledger-"));
	const path = join(dir, "nested", "ledger.jsonl");
	await appendLedger(path, entry(0, "keep", 1.5));
	await appendLedger(path, entry(1, "discard", 1.7));
	const entries = await readLedger(path);
	assert.equal(entries.length, 2);
	assert.equal(entries[0].metric, 1.5);
	assert.equal(entries[1].status, "discard");
	await rm(dir, { recursive: true, force: true });
});

test("isBetter respects direction", () => {
	assert.equal(isBetter(1, 2, "min"), true);
	assert.equal(isBetter(2, 1, "min"), false);
	assert.equal(isBetter(2, 1, "max"), true);
	assert.equal(isBetter(1, 1, "max"), false);
});

test("bestEntry picks the best kept metric only", () => {
	const entries = [
		entry(0, "keep", 2.0),
		entry(1, "discard", 0.5),
		entry(2, "keep", 1.0),
		entry(3, "crash", null),
	];
	assert.equal(bestEntry(entries, "min")?.iteration, 2);
	assert.equal(bestEntry(entries, "max")?.iteration, 0);
	assert.equal(bestEntry([], "min"), undefined);
	assert.equal(bestEntry([entry(0, "crash", null)], "min"), undefined);
});
