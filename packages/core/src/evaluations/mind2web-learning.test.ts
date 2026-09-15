import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "@rstest/core";
import { AgentLoader } from "../core/agent-loader.js";
import { fileURLToPath } from "node:url";
import { copyLibrary, initializeLibrary, inspectLibrary } from "./mind2web-library.js";
import {
  runLearningLoop,
  splitTasks,
  type JudgeReport,
  type LearningOptions,
} from "./mind2web-learning.js";
import { BrowserRecorder, RomeClient, writeJson, type AttemptOptions } from "./online-mind2web.js";

const directories: string[] = [];
async function temporary() {
  const path = await mkdtemp(join(tmpdir(), "rome-learning-"));
  directories.push(path);
  return path;
}
afterEach(async () => {
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});
const tasks = Array.from({ length: 8 }, (_, i) => ({
  task_id: `task_${i}`,
  confirmed_task: `Task ${i}`,
  website: "https://example.com",
  reference_length: 1,
}));

async function fakeJudge(directory: string): Promise<JudgeReport> {
  const { config } = JSON.parse(await readFile(join(directory, "run.json"), "utf8"));
  const output = join(directory, "judges");
  await mkdir(output);
  let errors = 0;
  for (const id of config.taskIds) {
    const state = JSON.parse(await readFile(join(directory, "tasks", id, "attempt.json"), "utf8"));
    if (state.status === "error") {
      errors++;
      continue;
    }
    await writeJson(join(output, `${id}.json`), {
      predicted_label: 1,
      response: config.phase === "holdout" ? "SECRET_HOLDOUT_FEEDBACK" : "LEARNING_FEEDBACK",
    });
  }
  return {
    directory: output,
    config: { backend: "rome", model: "judge" },
    summary: {
      selected: config.taskIds.length,
      judged: config.taskIds.length - errors,
      successes: config.taskIds.length - errors,
      execution_errors: errors,
      judge_errors: 0,
      pending: 0,
      success_rate: (config.taskIds.length - errors) / config.taskIds.length,
      success_rate_lower_bound: 0,
    },
  };
}

function loopOptions(directory: string): LearningOptions {
  return {
    directory,
    tasks,
    learningCount: 2,
    holdoutCount: 2,
    iterations: 2,
    seed: "seed",
    client: new RomeClient("http://127.0.0.1:1"),
    execute: async () => {
      throw new Error("No real browser in this test");
    },
    maxSteps: 10,
    timeoutMs: 1000,
    judge: fakeJudge,
    provenance: {},
  };
}

describe("Mind2Web tool learning", () => {
  it("uses reproducible disjoint splits and rejects oversubscribed sizes", () => {
    const split = splitTasks(tasks, 3, 2, "seed");
    expect(splitTasks([...tasks].reverse(), 3, 2, "seed")).toEqual(split);
    expect(split.learning.some((task) => split.holdout.includes(task))).toBe(false);
    expect(() => splitTasks(tasks, 8, 1, "seed")).toThrow();
    expect(() => splitTasks(tasks, 0, 1, "seed")).toThrow();
  });

  it("retains tools across tasks and rounds while excluding holdout feedback", async () => {
    const root = await temporary();
    const directory = join(root, "experiment");
    const visits: Array<{ taskId: string; frozen: boolean; tool: string | null }> = [];
    const attempt = async (options: AttemptOptions) => {
      await mkdir(options.directory);
      const path = join(options.learning!.library, "site-tool.mjs");
      let tool: string | null = null;
      try {
        tool = await readFile(path, "utf8");
      } catch {}
      visits.push({ taskId: options.task.task_id, frozen: options.learning!.frozen, tool });
      if (!options.learning!.frozen) await writeFile(path, `${tool ?? ""}improved\n`);
      await writeJson(join(options.directory, "attempt.json"), { status: "completed" });
    };
    await runLearningLoop(loopOptions(directory), attempt);
    expect(visits).toHaveLength(12);
    expect(visits.slice(0, 4).every((visit) => visit.frozen && visit.tool === null)).toBe(true);
    expect(visits[5].tool).toBe("improved\n");
    expect(visits[8].tool).toBe("improved\nimproved\n");
    const feedback = await readFile(join(directory, "library", "learning-feedback.json"), "utf8");
    expect(feedback).toContain("LEARNING_FEEDBACK");
    expect(feedback).not.toContain("SECRET_HOLDOUT_FEEDBACK");
    const curve = JSON.parse(await readFile(join(directory, "learning-curve.json"), "utf8"));
    expect(curve.map((point: { round: number }) => point.round)).toEqual([0, 1, 2]);
    expect(curve[0].libraryBefore).toBe(curve[0].libraryAfter);
    expect(curve[1].libraryBefore).not.toBe(curve[1].libraryAfter);
    expect(
      await readFile(join(directory, "rounds", "001", "tools-after", "site-tool.mjs"), "utf8"),
    ).toBe("improved\nimproved\n");
  });

  it("invalidates a frozen-library mutation and resets the next evaluation task's copy", async () => {
    const root = await temporary();
    const directory = join(root, "experiment");
    const libraries: string[] = [];
    await runLearningLoop(
      { ...loopOptions(directory), learningCount: 1, holdoutCount: 2, iterations: 1 },
      async (options) => {
        await mkdir(options.directory);
        if (options.learning!.frozen) {
          libraries.push(options.learning!.library);
          await expect(
            readFile(join(options.learning!.library, "forbidden.txt")),
          ).rejects.toThrow();
          await writeFile(join(options.learning!.library, "forbidden.txt"), "mutation");
        }
        await writeJson(join(options.directory, "attempt.json"), { status: "completed" });
      },
    );
    expect(new Set(libraries).size).toBe(libraries.length);
    const curve = JSON.parse(await readFile(join(directory, "learning-curve.json"), "utf8"));
    expect(curve[0].holdout.execution_errors).toBe(2);
    expect(curve[1].holdout.execution_errors).toBe(2);
    await expect(readFile(join(directory, "library", "forbidden.txt"))).rejects.toThrow();
  });

  it("stops after uncertain cancellation without judging or starting another task", async () => {
    const root = await temporary();
    let count = 0;
    await expect(
      runLearningLoop(
        {
          ...loopOptions(join(root, "experiment")),
          judge: async () => {
            throw new Error("Must not judge");
          },
        },
        async (options) => {
          count++;
          await mkdir(options.directory);
          await writeJson(join(options.directory, "attempt.json"), {
            status: "cancellation_unconfirmed",
          });
          throw new Error("Unconfirmed cancellation");
        },
      ),
    ).rejects.toThrow("Unconfirmed cancellation");
    expect(count).toBe(1);
  });

  it("copies libraries byte-for-byte and rejects symlinks", async () => {
    const root = await temporary();
    const library = join(root, "library");
    await initializeLibrary(library);
    await writeFile(join(library, "binary"), Buffer.from([0xff, 0x00]));
    const first = await inspectLibrary(library);
    expect((await copyLibrary(library, join(root, "copy"))).sha256).toBe(first.sha256);
    await writeFile(join(library, "binary"), Buffer.from([0xfe, 0x00]));
    expect((await inspectLibrary(library)).sha256).not.toBe(first.sha256);
    await symlink(join(root, "copy"), join(library, "link"));
    await expect(inspectLibrary(library)).rejects.toThrow("symlinks");
  });

  it("loads a Codex judge with empty declared tool lists and no browser discovery", async () => {
    const loader = new AgentLoader();
    const directory = await temporary();
    await writeFile(
      join(directory, "online-mind2web-judge.yaml"),
      await readFile(
        fileURLToPath(new URL("../../agents/online-mind2web-judge.yaml", import.meta.url)),
      ),
    );
    await loader.loadAll(directory);
    const judge = loader.get("online-mind2web-judge");
    expect(judge.providerId).toBe("openai");
    expect(judge.tools).toEqual([]);
    expect(judge.actions).toEqual([]);
    expect(judge.allowedSubagents).toEqual([]);
    expect(judge.networkDiscovery).toBe(false);
  });

  it("records page scripts and native OpenCLI calls using an experimental schema", async () => {
    const root = await temporary();
    await mkdir(join(root, "trajectory"));
    const calls: string[][] = [];
    const recorder = new BrowserRecorder(
      root,
      "session",
      async (args) => {
        calls.push(args);
        if (args[2] === "screenshot")
          await writeFile(args[3], Buffer.from("89504e470d0a1a0a", "hex"));
        return {
          success: true,
          stdout: args[2] === "get" ? "https://example.com" : "ok",
          stderr: "",
        };
      },
      10,
      true,
    );
    await recorder.act({ command: "eval", args: ["document.title"] });
    await recorder.act({
      command: "opencli",
      args: ["site", "search", "query"],
      screenshotTab: "target",
    });
    const result = await recorder.finish(tasks[0], "answer");
    expect(result.schema_version).toBe("rome-mind2web-tools-v1");
    expect(calls).toContainEqual(["site", "search", "query"]);
    expect(calls.filter((call) => call[2] === "screenshot").at(-1)).toContain("target");
    expect(result.action_history[0].action).toContain("EXECUTE_SCRIPT");
    expect(result.action_history[1].action).toContain("RUN_OPENCLI");
  });
});
