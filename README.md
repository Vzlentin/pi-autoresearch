# pi-autoresearch

A local Pi package that runs a harness-owned autonomous experiment loop in the style of [karpathy/autoresearch](https://github.com/karpathy/autoresearch): propose one change, commit, run, measure, keep or revert, repeat.

The harness owns the loop, execution, measurement, git keep/revert, and the ledger. The model only does the creative part: each iteration is one fresh, focused completion that sees the program, the ledger tail, and the current editable files, then proposes exactly one change. Context never accumulates across iterations, and loop continuation is a property of the harness, not a prompt instruction.

## Local install

```bash
npm install
npm test
pi install "$PWD"
```

## Usage

In the target experiment repository (a clean git worktree):

```bash
/autoresearch init          # writes .autoresearch/config.json and .autoresearch/program.md
# edit .autoresearch/config.json and .autoresearch/program.md
/autoresearch start [tag]   # creates or reuses branch autoresearch/<tag> and runs
/autoresearch status        # ledger summary
/autoresearch stop          # abort after the current step; in-flight changes revert
```

The loop runs in the background of the Pi session. A widget shows the current iteration, best metric, and spend.

All harness state lives in `.autoresearch/` (config, program, ledger, per-iteration run logs), which is added to `.git/info/exclude` automatically. Nothing from the harness needs to be committed to the target repository; custom evaluator scripts can live in `.autoresearch/` too. The experiment commits themselves land on the local `autoresearch/<tag>` branch, which is the keep/revert mechanism; do not push it.

## Configuration: `.autoresearch/config.json`

```json
{
  "runCommand": "uv run train.py",
  "metric": { "pattern": "^val_bpb:\\s+([0-9.eE+-]+)", "direction": "min" },
  "editablePaths": ["train.py"],
  "readOnlyPaths": ["prepare.py"],
  "programPath": ".autoresearch/program.md",
  "timeoutSeconds": 600,
  "maxIterations": 100,
  "model": "openai-codex/gpt-5.6-sol",
  "thinkingLevel": "medium"
}
```

- `runCommand` — shell command for one experiment, run with `bash -c` in the repository root.
- `metric.pattern` — regular expression over the combined run output; capture group 1 is the metric.
- `metric.direction` — `min` or `max`.
- `editablePaths` — files the proposer may rewrite (complete-file rewrites).
- `readOnlyPaths` — files shown as read-only context.
- `programPath` — optional markdown research program (goal, constraints, starting ideas).
- `timeoutSeconds` — hard per-run timeout; overruns are killed and logged as crashes (default 600).
- `maxIterations` — stop point; `0` means run until `/autoresearch stop` (default 0).
- `model`, `thinkingLevel` — optional proposer override; defaults to the active session model and level.

## Loop semantics

1. If the ledger is empty, run the unmodified code once and record the baseline.
2. Each iteration: render a fresh proposer prompt (program, ledger tail, crash log tail if the previous run crashed, editable and read-only files), get one proposal, apply it, commit on `autoresearch/<tag>`.
3. Run `runCommand` with the timeout, extract the metric from the output.
4. Keep the commit if the metric improves on the best kept entry; otherwise `git reset --hard` back.
5. Append a `keep` / `discard` / `crash` / `invalid` entry to `.autoresearch/ledger.jsonl`.

Runs are resumable: starting again with the same repository continues from the existing ledger and skips the baseline. Stopping (`/autoresearch stop`, session shutdown) aborts the in-flight step and reverts uncommitted changes.

## Tests

```bash
npm test    # typecheck + model-free unit tests (config, ledger, proposal parsing, full loop against a toy git repo)
```
