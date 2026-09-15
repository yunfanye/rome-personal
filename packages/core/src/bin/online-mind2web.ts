import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { createLogger } from "../logger.js";
import { judgeRun, runLearningLoop, type JudgeOptions } from "../evaluations/mind2web-learning.js";
import {
  DATASET,
  UPSTREAM_REVISION,
  RomeClient,
  digest,
  downloadTasks,
  openCliRunner,
  parseTasks,
  runAttempt,
  validateResult,
  writeJson,
} from "../evaluations/online-mind2web.js";

const log = createLogger("online-mind2web");
const invocationDirectory = process.env.INIT_CWD ?? process.cwd();
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    help: { type: "boolean", short: "h" },
    tasks: { type: "string" },
    out: { type: "string" },
    revision: { type: "string", default: "main" },
    "rome-url": { type: "string", default: "http://127.0.0.1:4141/api" },
    profile: { type: "string" },
    model: { type: "string" },
    "reasoning-effort": { type: "string" },
    limit: { type: "string", default: "1" },
    "task-id": { type: "string", multiple: true },
    "max-steps": { type: "string", default: "80" },
    "timeout-seconds": { type: "string", default: "600" },
    resume: { type: "boolean", default: false },
    iterations: { type: "string" },
    "learning-count": { type: "string" },
    "holdout-count": { type: "string" },
    seed: { type: "string", default: "rome-tool-learning-v1" },
    "seed-library": { type: "string" },
    upstream: { type: "string" },
    python: { type: "string", default: "python3" },
    "judge-model": { type: "string", default: "gpt-6-astra" },
    "judge-timeout-seconds": { type: "string", default: "300" },
    "judge-concurrency": { type: "string", default: "1" },
  },
});

async function main(): Promise<void> {
  const command = positionals[0];
  if (values.help || !command) {
    process.stdout.write(`Online-Mind2Web with Rome

download --out tasks.json [--revision main]     Download using local HF_TOKEN
run --tasks tasks.json --out run --profile ID  Run Rome in the same container
    [--limit 1] [--task-id ID ...] [--model SLUG] [--reasoning-effort high]
    [--max-steps 80] [--timeout-seconds 600] [--resume]
validate --out run                             Check v2 results and screenshots
judge --out run --upstream PATH                Score with Codex in Rome (no API key)
    [--judge-model SLUG] [--python PATH] [--judge-concurrency 1]
learn --tasks tasks.json --out experiment --profile ID --upstream PATH
    --iterations N --learning-count N --holdout-count N
    [--seed TEXT] [--seed-library PATH] [--model SLUG] [--judge-model SLUG]
    Runs a frozen baseline, then N tool-building rounds and fixed held-out evaluations.

Use a dedicated Rome instance/browser profile. See docs/online-mind2web.md.
`);
    return;
  }
  const output = resolve(invocationDirectory, z.string().min(1).parse(values.out));
  const judgeOptions = (): JudgeOptions => ({
    python: values.python,
    upstream: resolve(invocationDirectory, z.string().min(1).parse(values.upstream)),
    model: values["judge-model"],
    romeUrl: values["rome-url"],
    timeoutSeconds: z.coerce
      .number()
      .int()
      .positive()
      .max(7200)
      .parse(values["judge-timeout-seconds"]),
    concurrency: z.coerce.number().int().min(1).max(20).parse(values["judge-concurrency"]),
  });
  if (command === "judge") {
    const report = await judgeRun(output, judgeOptions());
    log.info("Codex judgement complete", report.summary);
    return;
  }
  if (command === "download") {
    await mkdir(dirname(output), { recursive: true });
    await downloadTasks(output, values.revision, process.env.HF_TOKEN);
    log.info("dataset downloaded", { output });
    return;
  }
  if (command === "validate") {
    const directories = await readdir(join(output, "tasks"), { withFileTypes: true });
    let count = 0;
    for (const directory of directories.filter((entry) => entry.isDirectory())) {
      await validateResult(join(output, "tasks", directory.name));
      count++;
    }
    if (!count) throw new Error("No results to validate");
    log.info("trajectories validated", { count });
    return;
  }
  if (command !== "run" && command !== "learn") throw new Error(`Unknown command: ${command}`);
  const options = z
    .object({
      tasks: z.string().min(1),
      profile: z.string().min(1),
      "rome-url": z
        .url()
        .refine(
          (url) => new URL(url).hostname === "127.0.0.1",
          "Run inside the Rome container using its loopback API",
        ),
      limit: z.coerce.number().int().positive().max(300),
      "max-steps": z.coerce.number().int().min(2).max(9998),
      "timeout-seconds": z.coerce.number().int().positive().max(7200),
      model: z.string().min(1).optional(),
      "reasoning-effort": z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
    })
    .parse(values);
  const raw = await readFile(resolve(invocationDirectory, options.tasks), "utf8");
  const allTasks = parseTasks(JSON.parse(raw));
  const ids = values["task-id"];
  if (ids?.some((id) => !allTasks.some((task) => task.task_id === id)))
    throw new Error("Unknown --task-id");
  const tasks = ids?.length
    ? allTasks.filter((task) => ids.includes(task.task_id))
    : allTasks.slice(0, options.limit);
  const execute = openCliRunner(options.profile);
  const version = await execute(["--version"]);
  if (!version.success) throw new Error("OpenCLI is not available");
  const client = new RomeClient(options["rome-url"]);
  await client.request("/health");
  const code = await readFile(
    new URL("../evaluations/online-mind2web.ts", import.meta.url),
    "utf8",
  );
  const config = {
    dataset: DATASET,
    datasetSha256: digest(raw),
    taskIds: tasks.map((task) => task.task_id),
    runnerSha256: digest(code + (await readFile(new URL(import.meta.url), "utf8"))),
    profile: options.profile,
    romeUrl: options["rome-url"],
    model: options.model ?? null,
    reasoningEffort: options["reasoning-effort"] ?? null,
    maxSteps: options["max-steps"],
    timeoutSeconds: options["timeout-seconds"],
    upstreamRevision: UPSTREAM_REVISION,
    opencliVersion: version.stdout.trim(),
  };
  if (command === "learn") {
    if (values.resume || ids?.length)
      throw new Error(
        "Learning experiments use a fixed split and a new output directory. Use --seed-library to start from a saved checkpoint.",
      );
    const sizes = z
      .object({
        iterations: z.coerce.number().int().min(1).max(100),
        learning: z.coerce.number().int().positive(),
        holdout: z.coerce.number().int().nonnegative(),
      })
      .parse({
        iterations: values.iterations,
        learning: values["learning-count"],
        holdout: values["holdout-count"],
      });
    const judging = judgeOptions();
    const controller = new AbortController();
    process.once("SIGINT", () => controller.abort());
    process.once("SIGTERM", () => controller.abort());
    const loopSource = await readFile(
      new URL("../evaluations/mind2web-learning.ts", import.meta.url),
    );
    const librarySource = await readFile(
      new URL("../evaluations/mind2web-library.ts", import.meta.url),
    );
    await runLearningLoop({
      directory: output,
      tasks: allTasks,
      learningCount: sizes.learning,
      holdoutCount: sizes.holdout,
      iterations: sizes.iterations,
      seed: values.seed,
      client,
      execute,
      model: options.model,
      reasoningEffort: options["reasoning-effort"],
      maxSteps: options["max-steps"],
      timeoutMs: options["timeout-seconds"] * 1000,
      seedLibrary: values["seed-library"]
        ? resolve(invocationDirectory, values["seed-library"])
        : undefined,
      signal: controller.signal,
      judge: (directory) => judgeRun(directory, judging),
      provenance: {
        config: { ...config, taskIds: undefined },
        judge: judging,
        loopSha256: digest(loopSource),
        libraryCodeSha256: digest(librarySource),
      },
      onProgress: (message, data) => log.info(message, data),
    });
    log.info("learning experiment complete", { output });
    return;
  }
  if (values.resume) {
    const manifest = JSON.parse(await readFile(join(output, "run.json"), "utf8"));
    if (JSON.stringify(manifest.config) !== JSON.stringify(config))
      throw new Error("Resume configuration differs from run.json. Use a new --out directory.");
  } else {
    await mkdir(output, { recursive: false });
    await mkdir(join(output, "tasks"));
    let revision: string | null = null;
    try {
      revision = execFileSync("git", ["rev-parse", "HEAD"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {}
    await writeJson(join(output, "run.json"), {
      config,
      romeGitRevision: revision,
      createdAt: new Date().toISOString(),
      nodeVersion: process.version,
      protocol:
        "Rome main agent with recorded OpenCLI commands and CSS selectors; fresh chat and tab per task; profile storage and Rome memory are not reset; prompt-level tool restrictions require trace review.",
    });
    await writeJson(join(output, "tasks.json"), tasks);
  }
  const abort = new AbortController();
  process.once("SIGINT", () => abort.abort());
  process.once("SIGTERM", () => abort.abort());
  const summary = { selected: tasks.length, completed: 0, errors: 0, pending: tasks.length };
  for (const task of tasks) {
    if (abort.signal.aborted) break;
    const directory = join(output, "tasks", task.task_id);
    let previous: { status?: string } | undefined;
    try {
      previous = JSON.parse(await readFile(join(directory, "attempt.json"), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (previous) {
      if (!values.resume || !["completed", "error"].includes(previous.status ?? "")) {
        throw new Error(
          `Attempt ${task.task_id} is incomplete. Inspect its Rome turn before using a new output directory.`,
        );
      }
      if (previous.status === "completed") {
        await validateResult(directory);
        summary.completed++;
      } else summary.errors++;
    } else {
      log.info("task started", { taskId: task.task_id });
      try {
        await runAttempt({
          client,
          task,
          directory,
          execute,
          model: options.model,
          reasoningEffort: options["reasoning-effort"],
          maxSteps: options["max-steps"],
          timeoutMs: options["timeout-seconds"] * 1000,
          signal: abort.signal,
        });
        summary.completed++;
      } catch (error) {
        summary.errors++;
        log.error("task failed", {
          taskId: task.task_id,
          error: error instanceof Error ? error.message : String(error),
        });
        const attempt = JSON.parse(await readFile(join(directory, "attempt.json"), "utf8"));
        if (attempt.status === "cancellation_unconfirmed") throw error;
      }
    }
    summary.pending--;
    await writeJson(join(output, "summary.json"), summary);
  }
  await writeJson(join(output, "summary.json"), summary);
  log.info("run finished; completed means execution ended, not benchmark success", summary);
  if (summary.errors || summary.pending) process.exitCode = 1;
}

main().catch((error: unknown) => {
  log.error("evaluation failed", { error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
});
