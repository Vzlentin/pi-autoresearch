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
/autoresearch init          # writes config.json and program.md in the state directory
# edit config.json and program.md there (init prints the path)
/autoresearch start [tag]   # creates or reuses branch autoresearch/<tag> and runs
/autoresearch status [tag]  # ledger summary for a run (default: active or most recent run)
/autoresearch stop          # abort after the current step; in-flight changes revert
```

The loop runs in the background of the Pi session. A widget shows the current iteration, best metric, and spend.

All harness state lives outside the repository, in `$XDG_STATE_HOME/pi-autoresearch/<absolute repository path>/` (default `~/.local/state/pi-autoresearch/...`), so nothing needs to be ignored or committed in shared projects. `config.json` and `program.md` are shared; each run keeps its own ledger and per-iteration logs under `runs/<tag>/`, so runs with different tags never mix and a run can be resumed by starting the same tag again. Starting without a tag creates a new timestamped run with a fresh baseline. Custom evaluator scripts can live in the state directory too; reference them by absolute path in `runCommand`. The experiment commits themselves land on the local `autoresearch/<tag>` branch, which is the keep/revert mechanism; do not push it.

## Configuration: `config.json`

```json
{
  "runCommand": "uv run train.py",
  "metric": { "pattern": "^val_bpb:\\s+([0-9.eE+-]+)", "direction": "min" },
  "editablePaths": ["train.py"],
  "readOnlyPaths": ["prepare.py"],
  "programPath": "program.md",
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
- `programPath` — optional markdown research program (goal, constraints, starting ideas); relative paths resolve against the state directory.
- `timeoutSeconds` — hard per-run timeout; overruns are killed and logged as crashes (default 600).
- `maxIterations` — stop point; `0` means run until `/autoresearch stop` (default 0).
- `model`, `thinkingLevel` — optional proposer override; defaults to the active session model and level.

## Loop semantics

1. If the ledger is empty, run the unmodified code once and record the baseline.
2. Each iteration: render a fresh proposer prompt (program, ledger tail, crash log tail if the previous run crashed, editable and read-only files), get one proposal, apply it, commit on `autoresearch/<tag>`.
3. Run `runCommand` with the timeout, extract the metric from the output.
4. Keep the commit if the metric improves on the best kept entry; otherwise `git reset --hard` back.
5. Append a `keep` / `discard` / `crash` / `invalid` entry to `runs/<tag>/ledger.jsonl` in the state directory.

Runs are resumable: starting again with the same repository continues from the existing ledger and skips the baseline. Stopping (`/autoresearch stop`, session shutdown) aborts the in-flight step and reverts uncommitted changes.

## Tests

```bash
npm test    # typecheck + model-free unit tests (config, ledger, proposal parsing, full loop against a toy git repo)
```
