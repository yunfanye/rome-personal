# Online-Mind2Web

`pnpm eval:mind2web` evaluates Rome through its existing chat API. Each task creates a fresh [session](concepts/sessions.md) for the main [agent](concepts/agents.md).
The runner records OpenCLI browser commands, screenshots, page URLs, and the full Rome trace.
WebJudge uses fresh Codex sessions inside Rome to score that evidence. The `learn` command measures tool creation and reuse across rounds.

## Evaluation protocol

The `run` command measures **Rome with recorded OpenCLI browser commands and CSS selectors**.
The model receives the benchmark instruction and a browser recording endpoint.
The endpoint executes each command and captures its screenshot before returning control to the model.
It supports navigation, clicks, typing, selection, scrolling, keyboard input, and page inspection in one background tab.
For the broader tool surface, use `learn`. It permits page JavaScript, numeric references, native OpenCLI adapters, and reusable scripts.

The tool restrictions are instructions in the task prompt. Rome retains its normal tool catalog, so review `rome-trace.json` for unrecorded web access before publishing scores.
The runner does not reset browser cookies, local storage, Rome memory, or installed apps.
Use a dedicated evaluation instance and browser profile, with no unrelated tasks running.
Record that profile's login state and the installed apps alongside the run.

The runner opens the specified start website before sending the task to Rome.
It copies the human `reference_length` from the dataset and sets unavailable per-step thoughts to `null`.
It exports the [upstream v2 submission format](https://github.com/OSU-NLP-Group/Online-Mind2Web/blob/f0d805ee0e9e0b3ea70911e45e5264b72968f3dc/data/schema_v2/README.md).
`SUCCESS` and `FAILED` on an action describe OpenCLI execution, not task completion. Inspect the paired screenshot when reviewing the action's effect.

## Prepare the runtime

1. Enter the dev shell with `nix develop`.
2. Start the stack with `pnpm dev:all`, following [Development Setup](../DEVELOPMENT.md).
3. Connect the model account to use in Rome.
4. Run `./r opencli profile list` and choose the evaluation browser's connected profile ID.
5. Open a shell in the Rome container with `./r bash`.

Run the following commands from the repository root inside that container.
The runner and Rome need the same loopback network and filesystem for the recording endpoint and screenshot paths.
The default Rome API is `http://127.0.0.1:4141/api`. Use `--rome-url` if the instance uses another internal port.

## Download the tasks

The [official dataset](https://huggingface.co/datasets/osunlp/Online-Mind2Web) requires access approval.

1. Accept the dataset's access terms on Hugging Face.
2. Set `HF_TOKEN` in the command's environment through your local secret manager.
3. Download a snapshot:

```bash
pnpm eval:mind2web download --out /tmp/mind2web-tasks.json
```

The downloader resolves `main` to a commit and saves its revision and SHA-256 checksum beside the task file.
Use `--revision <commit>` to retrieve the same snapshot again.
An authorized local JSON export can be supplied directly with `--tasks`.
The expected fields are `task_id`, `confirmed_task`, `website`, and `reference_length`.
The runner never supplies other dataset fields to the agent.

## Run Rome

For a synthetic connectivity check without dataset access, use `packages/core/src/evaluations/fixtures/online-mind2web-smoke.json` with `--tasks`.
That fixture is not a benchmark task and must be excluded from reported benchmark scores.

Replace `PROFILE_ID` with the connected evaluation profile ID:

```bash
pnpm eval:mind2web run \
  --tasks /tmp/mind2web-tasks.json \
  --out /tmp/mind2web-smoke \
  --profile PROFILE_ID \
  --limit 1
```

The default uses Rome's configured model. `--model` takes a WebChat model selector slug, as described in [model selection](concepts/agents.md#model-selection).
Each attempt saves the selected session and the terminal model accounting.

| Option | Default | Purpose |
| --- | --- | --- |
| `--limit` | `1` | Select the first N tasks in dataset order |
| `--task-id` | none | Select exact IDs, repeatable, overrides `--limit` |
| `--model` | Rome configuration | Pin a WebChat model selector slug |
| `--reasoning-effort` | Rome configuration | Set the turn's reasoning effort |
| `--max-steps` | `80` | Limit browser calls, including the initial navigation and observations |
| `--timeout-seconds` | `600` | Limit each agent turn |
| `--resume` | false | Continue an existing run with identical configuration |

For all 300 tasks, use `--limit 300` with a new output directory.
Tasks execute sequentially. The final screenshot does not consume a browser-call allowance.
Timeouts and step-limit failures request cancellation and wait for the Rome turn to stop.
If cancellation cannot be confirmed, the entire run stops.

Resume skips completed and failed attempts without retrying them.
It refuses unfinished attempts and changes to the task selection, runner, model, browser profile, or limits.
Inspect an unfinished Rome turn before starting another run. Use a new output directory for retries.

## Inspect the evidence

```text
run/
  run.json
  tasks.json
  summary.json
  tasks/<task_id>/
    attempt.json
    prompt.txt
    commands.json
    setup.json
    steps.json
    rome-trace.json
    result.json
    trajectory/0000.png
```

`summary.json` distinguishes completed executions, execution errors, and pending tasks.
A completed execution does not establish benchmark success.
Failed attempts retain available evidence and their error in `attempt.json`.

Validate completed results and their screenshot files:

```bash
pnpm eval:mind2web validate --out /tmp/mind2web-smoke
```

This command accepts both result formats and fails if any task directory lacks a valid result.
Before sharing results, review screenshots and raw traces for account information.
Submit only the intended `result.json` and `trajectory/` files for each task.
Keep the other artifacts for reproducibility and trace review.

## Learn reusable tools

Choose the iteration count and task counts when starting the experiment:

```bash
pnpm eval:mind2web learn \
  --tasks /tmp/mind2web-tasks.json \
  --out /tmp/mind2web-learning \
  --profile PROFILE_ID \
  --upstream /tmp/online-mind2web-upstream \
  --python /tmp/mind2web-venv/bin/python \
  --iterations "$ITERATIONS" \
  --learning-count "$LEARNING_TASKS" \
  --holdout-count "$HOLDOUT_TASKS" \
  --judge-model gpt-6-astra
```

All three counts are required. Set `--holdout-count 0` to measure improvement on repeated learning tasks only.
`--seed` fixes the task split and order. The learning and held-out task IDs never overlap.
`--model` selects the solving model independently of `--judge-model`.

The experiment runs these phases:

1. Run a baseline on both task sets with a frozen tool library.
2. Solve the learning tasks while building and improving reusable tools.
3. Save the library as a checkpoint.
4. Evaluate the held-out tasks using a fresh copy of that checkpoint for each task.
5. Save both scores and give only learning-task judge feedback to the next learning round.

Steps 2–5 repeat for the requested number of iterations.
The total number of solving attempts is `(iterations + 1) × (learning tasks + held-out tasks)`.
WebJudge makes additional Codex calls for key points, screenshot selection, and the final verdict.

### Script interface

Rome can write JavaScript, Python, or shell scripts in the persistent `library/` directory while completing a learning task.
The supplied `rome-opencli.mjs` client routes each OpenCLI call through the recorder:

```javascript
import { browser, opencli } from "./rome-opencli.mjs";

const heading = await browser("eval", ["document.querySelector('h1')?.textContent"]);
console.log(heading.stdout);

// A native adapter can use its own target tab for the evidence screenshot.
const result = await opencli(["site", "command", "argument"], targetTabId);
```

Each script reads the current recording endpoint from `ROME_BROWSER_ENDPOINT`.
The task prompt supplies that value. Scripts must not save a task's endpoint for later reuse.
Page scripts and native adapters receive one screenshot after the command finishes.
Their internal operations do not each receive a screenshot, so these runs use `rome-mind2web-tools-v1`, not the official v2 submission schema.
For this protocol, the judge also receives recorded tool output as untrusted evidence.
Each output is limited to 8,000 characters, with a 100,000-character total budget. Truncation is marked in the judge input.
The final answer appears separately as an untrusted claim for answer-based tasks. The judge must check it against recorded evidence, not accept it as proof.

Tools, usage notes, and `learning-feedback.json` persist across learning tasks and rounds.
Task prompts require reusable implementations and prohibit stored task answers or benchmark-specific shortcuts.
The harness records file checksums and each task's additions, edits, and deletions.
Checkpoints exclude `.git`, `node_modules`, `.venv`, and `__pycache__`. Keep dependency manifests with the tool source.
Libraries reject symlinks and are limited to 1,000 files and 50 MiB.

### Compare rounds

```text
experiment/
  experiment.json
  split.json
  learning-curve.json
  library/
  rounds/000/             # Frozen baseline
  rounds/001/
    tools-before/
    tools-after/
    learning/
    holdout/
    round.json
```

`learning-curve.json` contains both task-set scores, error counts, and the library checksum for each round.
Learning-set improvement measures adaptation to repeated tasks. Held-out improvement measures transfer to other tasks under the recorded runtime conditions.
Scores can fall between rounds. The runner reports every round without selecting only the best result.

Held-out tasks cannot change the source library. Each gets its own copy, and a file change invalidates that attempt.
Held-out feedback never enters `learning-feedback.json`.
The Rome runtime and browser profile remain shared, and restrictions on global memory and other sessions rely on task instructions.
Review traces before treating this as a clean generalization result. A separate clean runtime provides stronger isolation.

The loop stops on incomplete judging or unconfirmed cancellation and keeps its artifacts.
It requires a new output directory on each invocation. To continue from saved tools, start another experiment with `--seed-library <checkpoint-directory>`.
That new experiment runs its own baseline and records the starting library checksum.

## Score with WebJudge

The default backend uses the [upstream evaluator's](https://github.com/OSU-NLP-Group/Online-Mind2Web#automatic-evaluator-via-llm-as-a-judge-webjudge) pinned prompts and screenshot-selection procedure, powered by Codex inside Rome.
Its screenshot-selection threshold is 3.
It removes `TASK_COMPLETE` and the agent's final answer from the judge's action history, while retaining the final screenshot.
The script protocol supplies the candidate answer separately. The reference protocol omits it.
This is a Codex-powered WebJudge result. It is not the upstream `o4-mini` reference configuration.

The `online-mind2web-judge` agent pins the OpenAI provider and declares empty tool, action, and subagent lists, with browser discovery disabled.
It receives screenshots as native image input. Each evaluation stage gets a fresh session and project, without main-agent memory.
The scorer rejects any judge trace containing a tool call or subagent call, or accounting from another provider.
Rome can still advertise provider-native tools and globally granted actions. This is a checked no-tool-use protocol, not a separate operating-system sandbox.

1. Start Rome with the current source so the judge agent and native image forwarding are loaded.
2. Sign into Codex through Rome.

3. Clone the evaluator on the machine that holds the results:

```bash
git clone --depth 1 --filter=blob:none --sparse https://github.com/OSU-NLP-Group/Online-Mind2Web.git /tmp/online-mind2web-upstream
git -C /tmp/online-mind2web-upstream sparse-checkout set src data/schema_v2
git -C /tmp/online-mind2web-upstream fetch --depth 1 origin f0d805ee0e9e0b3ea70911e45e5264b72968f3dc
git -C /tmp/online-mind2web-upstream checkout f0d805ee0e9e0b3ea70911e45e5264b72968f3dc
```

4. Create a Python environment and install the pinned upstream dependencies:

```bash
python3 -m venv /tmp/mind2web-venv
/tmp/mind2web-venv/bin/pip install -r /tmp/online-mind2web-upstream/requirements.txt
```

5. Validate the evidence without calling a model:

```bash
/tmp/mind2web-venv/bin/python packages/core/src/evaluations/online-mind2web-judge.py \
  --run /tmp/mind2web-smoke \
  --upstream /tmp/online-mind2web-upstream \
  --check-only
```

6. Score through Rome's Codex connection:

```bash
pnpm eval:mind2web judge \
  --out /tmp/mind2web-smoke \
  --upstream /tmp/online-mind2web-upstream \
  --python /tmp/mind2web-venv/bin/python \
  --judge-model gpt-6-astra \
  --judge-concurrency 1
```

No separate `OPENAI_API_KEY` is needed for this backend. Rome uses its connected Codex account.
The default judge model selector is `gpt-6-astra`. Change it with `--judge-model`.
Judge sessions, model accounting, and traces appear under the judge output's `rome-traces/` directory.
The upstream source checkout must match the pinned revision without modifications to `src`.

For the upstream reference model through an API key, invoke the Python script with `--backend openai --model o4-mini` and set `OPENAI_API_KEY` locally.
That optional backend uses [Chat Completions](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create) with a 16,384-token output allowance and no temperature override.

Judgements appear under `run/judges/<configuration-hash>/`.
Reruns reuse judgements only when the result and screenshot checksums match.
Execution errors remain in the selected-task denominator. Pending tasks or judge errors leave `success_rate` unset and produce a lower bound separately.
Record the dataset revision, model, browser state, protocol, and execution errors when comparing results.
The dataset uses [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/), and the evaluator code uses MIT.
Follow the [upstream citation instructions](https://github.com/OSU-NLP-Group/Online-Mind2Web#-citation) when publishing benchmark results.
