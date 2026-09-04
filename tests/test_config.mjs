import assert from "node:assert/strict";
import test from "node:test";
import { parseConfig } from "../extensions/config.ts";

const valid = {
	runCommand: "uv run train.py",
	metric: { pattern: "^val_bpb:\\s+([0-9.]+)", direction: "min" },
	editablePaths: ["train.py"],
};

test("parseConfig accepts a minimal config and applies defaults", () => {
	const config = parseConfig(valid);
	assert.equal(config.runCommand, "uv run train.py");
	assert.equal(config.timeoutSeconds, 600);
	assert.equal(config.maxIterations, 0);
	assert.deepEqual(config.readOnlyPaths, []);
	assert.equal(config.programPath, undefined);
	assert.equal(config.model, undefined);
});

test("parseConfig keeps explicit optional fields", () => {
	const config = parseConfig({
		...valid,
		readOnlyPaths: ["prepare.py"],
		programPath: "program.md",
		timeoutSeconds: 60,
		maxIterations: 5,
		model: "anthropic/claude-fable-5",
		thinkingLevel: "low",
	});
	assert.deepEqual(config.readOnlyPaths, ["prepare.py"]);
	assert.equal(config.maxIterations, 5);
	assert.equal(config.model, "anthropic/claude-fable-5");
	assert.equal(config.thinkingLevel, "low");
});

test("parseConfig rejects bad inputs", () => {
	assert.throws(() => parseConfig(null), /must be a JSON object/);
	assert.throws(() => parseConfig({ ...valid, runCommand: "" }), /runCommand/);
	assert.throws(() => parseConfig({ ...valid, metric: { pattern: "(", direction: "min" } }), /does not compile/);
	assert.throws(() => parseConfig({ ...valid, metric: { pattern: "x", direction: "up" } }), /direction/);
	assert.throws(() => parseConfig({ ...valid, editablePaths: [] }), /editablePaths/);
	assert.throws(() => parseConfig({ ...valid, editablePaths: ["/etc/passwd"] }), /relative paths/);
	assert.throws(() => parseConfig({ ...valid, editablePaths: ["a/../../b"] }), /relative paths/);
	assert.throws(() => parseConfig({ ...valid, timeoutSeconds: 0 }), /timeoutSeconds/);
	assert.throws(() => parseConfig({ ...valid, maxIterations: 1.5 }), /maxIterations/);
	assert.throws(() => parseConfig({ ...valid, model: "no-slash" }), /model/);
	assert.throws(() => parseConfig({ ...valid, thinkingLevel: "extreme" }), /thinkingLevel/);
});
