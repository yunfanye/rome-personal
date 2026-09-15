import { execFile } from "node:child_process";
import { mkdir, readFile, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  copyLibrary,
  initializeLibrary,
  inspectLibrary,
  recordLibraryDelta,
} from "./mind2web-library.js";
import {
  digest,
  runAttempt,
  writeJson,
  type AttemptOptions,
  type Task,
  type RomeClient,
  type CommandRunner,
} from "./online-mind2web.js";

export function splitTasks(
  tasks: Task[],
  learningCount: number,
  holdoutCount: number,
  seed: string,
): { learning: Task[]; holdout: Task[] } {
  if (
    !Number.isInteger(learningCount) ||
    learningCount < 1 ||
    !Number.isInteger(holdoutCount) ||
    holdoutCount < 0 ||
    learningCount + holdoutCount > tasks.length
  ) {
    throw new Error(
      "Choose a positive learning count and a nonnegative holdout count within the dataset size",
    );
  }
  const ordered = [...tasks].sort((a, b) =>
    digest(`${seed}:${a.task_id}`).localeCompare(digest(`${seed}:${b.task_id}`)),
  );
  return {
    learning: ordered.slice(0, learningCount),
    holdout: ordered.slice(learningCount, learningCount + holdoutCount),
  };
}

const judgeReportSchema = z.object({
  directory: z.string(),
  config: z.record(z.string(), z.unknown()),
  summary: z.object({
    selected: z.number().int(),
    judged: z.number().int(),
    successes: z.number().int(),
    execution_errors: z.number().int(),
    judge_errors: z.number().int(),
    pending: z.number().int(),
    success_rate: z.number().nullable(),
    success_rate_lower_bound: z.number(),
  }),
});
export type JudgeReport = z.infer<typeof judgeReportSchema>;

export interface JudgeOptions {
  python: string;
  upstream: string;
  model: string;
  romeUrl: string;
  timeoutSeconds: number;
  concurrency: number;
}

export async function judgeRun(directory: string, options: JudgeOptions): Promise<JudgeReport> {
  const script = fileURLToPath(new URL("online-mind2web-judge.py", import.meta.url));
  await rm(join(directory, "judge-latest.json"), { force: true });
  const outcome = await new Promise<{
    code: number | string | undefined;
    stdout: string;
    stderr: string;
  }>((resolveResult, reject) => {
    execFile(
      options.python,
      [
        script,
        "--run",
        directory,
        "--upstream",
        options.upstream,
        "--backend",
        "rome",
        "--rome-url",
        options.romeUrl,
        "--model",
        options.model,
        "--timeout-seconds",
        String(options.timeoutSeconds),
        "--concurrency",
        String(options.concurrency),
      ],
      { maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error && typeof error.code !== "number") reject(error);
        else resolveResult({ code: error?.code ?? undefined, stdout, stderr });
      },
    );
  });
  await writeJson(join(directory, "judge-process.json"), outcome);
  if (outcome.code !== undefined && outcome.code !== 1)
    throw new Error(`Judge failed: ${outcome.stderr}`);
  const report = judgeReportSchema.parse(
    JSON.parse(await readFile(join(directory, "judge-latest.json"), "utf8")),
  );
  if (
    report.config.model !== options.model ||
    report.config.backend !== "rome" ||
    report.config.romeUrl !== options.romeUrl
  )
    throw new Error("Judge report configuration mismatch");
  if (report.summary.judge_errors || report.summary.pending)
    throw new Error(
      `Judge is incomplete. Inspect ${directory}/judge-process.json before continuing.`,
    );
  return report;
}

export interface LearningOptions {
  directory: string;
  tasks: Task[];
  learningCount: number;
  holdoutCount: number;
  iterations: number;
  seed: string;
  client: RomeClient;
  execute: CommandRunner;
  model?: string;
  reasoningEffort?: string;
  maxSteps: number;
  timeoutMs: number;
  seedLibrary?: string;
  signal?: AbortSignal;
  judge: (directory: string) => Promise<JudgeReport>;
  provenance: Record<string, unknown>;
  onProgress?: (message: string, data: Record<string, unknown>) => void;
}

/** Each phase finishes and is judged before the next phase can change the shared library. */
export async function runLearningLoop(
  options: LearningOptions,
  attempt: (options: AttemptOptions) => Promise<void> = runAttempt,
): Promise<void> {
  if (!Number.isInteger(options.iterations) || options.iterations < 1)
    throw new Error("Choose at least one learning iteration");
  const split = splitTasks(
    options.tasks,
    options.learningCount,
    options.holdoutCount,
    options.seed,
  );
  const directory = resolve(options.directory);
  await mkdir(directory, { recursive: false });
  await mkdir(join(directory, "rounds"));
  const library = join(directory, "library");
  if (options.seedLibrary) await copyLibrary(options.seedLibrary, library);
  await initializeLibrary(library);
  const initial = await inspectLibrary(library);
  const manifest = {
    protocol: "rome-mind2web-tool-learning-v1",
    status: "running",
    createdAt: new Date().toISOString(),
    iterations: options.iterations,
    seed: options.seed,
    initialLibrarySha256: initial.sha256,
    learningTaskIds: split.learning.map((task) => task.task_id),
    holdoutTaskIds: split.holdout.map((task) => task.task_id),
    model: options.model ?? null,
    reasoningEffort: options.reasoningEffort ?? null,
    maxSteps: options.maxSteps,
    timeoutMs: options.timeoutMs,
    ...options.provenance,
    holdoutIsolation:
      "Per-task copied tool library; fresh Rome chats; shared runtime and browser profile. Prompt-level memory isolation requires trace review.",
  };
  await writeJson(join(directory, "experiment.json"), manifest);
  await writeJson(join(directory, "split.json"), split);
  const curve: Array<Record<string, unknown>> = [];
  const feedback: unknown[] = [];
  const ensureRunning = () => {
    if (options.signal?.aborted) throw new Error("Learning loop interrupted");
  };

  const runPhase = async (
    round: number,
    phase: "learning" | "holdout",
    tasks: Task[],
    checkpoint: string,
  ): Promise<JudgeReport | null> => {
    if (!tasks.length) return null;
    const phaseDirectory = join(directory, "rounds", String(round).padStart(3, "0"), phase);
    await mkdir(phaseDirectory);
    await mkdir(join(phaseDirectory, "tasks"));
    await mkdir(join(phaseDirectory, "libraries"));
    const frozen = round === 0 || phase === "holdout";
    const config = {
      taskIds: tasks.map((task) => task.task_id),
      round,
      phase,
      frozen,
      model: options.model ?? null,
      librarySha256: (await inspectLibrary(checkpoint)).sha256,
    };
    await writeJson(join(phaseDirectory, "run.json"), { config });
    await writeJson(join(phaseDirectory, "tasks.json"), tasks);
    for (const task of tasks) {
      ensureRunning();
      const taskDirectory = join(phaseDirectory, "tasks", task.task_id);
      const taskLibrary = frozen ? join(phaseDirectory, "libraries", task.task_id) : library;
      if (frozen) await copyLibrary(checkpoint, taskLibrary);
      const before = await inspectLibrary(taskLibrary);
      options.onProgress?.("task started", { round, phase, taskId: task.task_id, frozen });
      try {
        await attempt({
          client: options.client,
          execute: options.execute,
          task,
          directory: taskDirectory,
          model: options.model,
          reasoningEffort: options.reasoningEffort,
          maxSteps: options.maxSteps,
          timeoutMs: options.timeoutMs,
          signal: options.signal,
          learning: { library: taskLibrary, frozen },
        });
      } catch (error) {
        const state = JSON.parse(await readFile(join(taskDirectory, "attempt.json"), "utf8"));
        if (state.status !== "error") throw error;
        options.onProgress?.("task failed", {
          round,
          phase,
          taskId: task.task_id,
          error: state.error,
        });
      }
      const after = await inspectLibrary(taskLibrary);
      await recordLibraryDelta(taskDirectory, before, after);
      if (frozen && before.sha256 !== after.sha256) {
        const path = join(taskDirectory, "attempt.json");
        const state = JSON.parse(await readFile(path, "utf8"));
        await writeJson(path, {
          ...state,
          status: "error",
          error: "Frozen tool library was modified during evaluation",
        });
        try {
          await rename(
            join(taskDirectory, "result.json"),
            join(taskDirectory, "invalid-result.json"),
          );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
    }
    ensureRunning();
    options.onProgress?.("phase judging", { round, phase });
    const report = await options.judge(phaseDirectory);
    if (
      report.summary.pending ||
      report.summary.judge_errors ||
      report.summary.selected !== tasks.length
    )
      throw new Error("Judge report is incomplete or has the wrong task count");
    return report;
  };

  try {
    for (let round = 0; round <= options.iterations; round++) {
      ensureRunning();
      const roundDirectory = join(directory, "rounds", String(round).padStart(3, "0"));
      await mkdir(roundDirectory);
      const before = await copyLibrary(library, join(roundDirectory, "tools-before"));
      const learned = await runPhase(
        round,
        "learning",
        split.learning,
        join(roundDirectory, "tools-before"),
      );
      const after = await copyLibrary(library, join(roundDirectory, "tools-after"));
      const heldout = await runPhase(
        round,
        "holdout",
        split.holdout,
        join(roundDirectory, "tools-after"),
      );
      curve.push({
        round,
        kind: round === 0 ? "baseline" : "learning",
        libraryBefore: before.sha256,
        libraryAfter: after.sha256,
        toolFileCount: Object.keys(after.files).length,
        learning: learned?.summary ?? null,
        holdout: heldout?.summary ?? null,
      });
      await writeJson(join(directory, "learning-curve.json"), curve);
      // Only learning-task feedback enters the persistent artifact. Holdout scores stay in the report tree.
      if (learned) {
        for (const task of split.learning) {
          try {
            const judgement = JSON.parse(
              await readFile(join(learned.directory, `${task.task_id}.json`), "utf8"),
            );
            feedback.push({
              round,
              task: task.confirmed_task,
              website: task.website,
              score: judgement.predicted_label,
              feedback: judgement.response,
            });
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        }
        await writeJson(join(library, "learning-feedback.json"), feedback);
      }
      await writeJson(join(roundDirectory, "round.json"), {
        status: "completed",
        librarySha256: (await inspectLibrary(library)).sha256,
      });
    }
    manifest.status = "completed";
  } catch (error) {
    manifest.status = "stopped";
    await writeJson(join(directory, "error.json"), {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    await writeJson(join(directory, "experiment.json"), manifest);
  }
}
