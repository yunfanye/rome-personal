import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "@rstest/core";
import {
  BrowserRecorder,
  RomeClient,
  actionDescription,
  parseTasks,
  runAttempt,
  serveRecorder,
  terminalResult,
  validateResult,
  writeJson,
  type CommandRunner,
} from "./online-mind2web.js";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
  "base64",
);
const task = {
  task_id: "fixture_1",
  confirmed_task: "Read the page title",
  website: "https://example.com",
  reference_length: 3,
};
const directories: string[] = [];
async function temporary() {
  const directory = await mkdtemp(join(tmpdir(), "rome-mind2web-"));
  directories.push(directory);
  return directory;
}
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function fakeBrowser(calls: string[][] = []): CommandRunner {
  return async (args) => {
    calls.push(args);
    if (args[2] === "screenshot") await writeFile(args[3], png);
    return {
      stdout: args[2] === "get" ? "https://example.com/\n" : "ok",
      stderr: "",
      success: true,
    };
  };
}

describe("Online-Mind2Web evidence", () => {
  it("rejects unsafe IDs, duplicate tasks, and absent human reference lengths", () => {
    expect(() => parseTasks([{ ...task, task_id: "../escape" }])).toThrow();
    expect(() => parseTasks([task, task])).toThrow("Duplicate");
    expect(() => parseTasks([{ ...task, reference_length: undefined }])).toThrow();
    expect(parseTasks([{ ...task, irrelevant_annotation: "not supplied to Rome" }])).toEqual([
      task,
    ]);
  });

  it("records screenshots before returning the action and keeps the answer separate", async () => {
    const directory = await temporary();
    await mkdir(join(directory, "trajectory"));
    const calls: string[][] = [];
    const recorder = new BrowserRecorder(directory, "test", fakeBrowser(calls), 10);
    await recorder.act({ command: "open", args: [task.website] });
    await recorder.act({ command: "fill", args: ["input[name=q]", "literal $() and `text`"] });
    expect(calls.slice(3, 6).map((call) => call[2])).toEqual(["fill", "screenshot", "get"]);
    const result = await recorder.finish(task, "Observed answer");
    expect(result.reference_length).toBe(3);
    expect(result.action_history).toHaveLength(3);
    expect(result.action_history.every((step) => step.thought === null)).toBe(true);
    expect(result.action_history[1].action).toContain("literal $() and `text`");
    expect(result.action_history[2].action).toBe("TASK_COMPLETE -> ANSWER: Observed answer");
    await rm(join(directory, "trajectory", "0001.png"));
    await expect(validateResult(directory)).rejects.toThrow();
  });

  it("rejects concurrent commands while an action's evidence is being captured", async () => {
    const directory = await temporary();
    await mkdir(join(directory, "trajectory"));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const execute = fakeBrowser();
    const recorder = new BrowserRecorder(
      directory,
      "test",
      async (args) => {
        if (args[2] === "open") await gate;
        return execute(args);
      },
      10,
    );
    const opening = recorder.act({ command: "open", args: [task.website] });
    await expect(recorder.act({ command: "state" })).rejects.toThrow("already running");
    release();
    await opening;
    expect(recorder.steps).toHaveLength(1);
  });

  it("stops after evidence failure or a step limit instead of exporting partial success", async () => {
    const directory = await temporary();
    await mkdir(join(directory, "trajectory"));
    const recorder = new BrowserRecorder(directory, "test", fakeBrowser(), 1);
    await recorder.act({ command: "state" });
    await expect(recorder.act({ command: "state" })).rejects.toThrow("step limit");
    await expect(recorder.finish(task, "done")).rejects.toThrow("step limit");
    const broken = new BrowserRecorder(
      directory,
      "broken",
      async () => {
        throw new Error("Browser disconnected");
      },
      10,
    );
    await expect(broken.act({ command: "state" })).rejects.toThrow("disconnected");
    await expect(broken.finish(task, "done")).rejects.toThrow("disconnected");
  });

  it("keeps failed browser actions and rejects numeric refs or tab overrides", async () => {
    expect(actionDescription({ command: "click", args: ["button.submit"] }, false)).toContain(
      "| FAILED",
    );
    expect(() => actionDescription({ command: "click", args: ["12"] }, true)).toThrow(
      "CSS selector",
    );
    const recorder = new BrowserRecorder(await temporary(), "test", fakeBrowser(), 10);
    await expect(recorder.act({ command: "get", args: ["url", "--tab=other"] })).rejects.toThrow(
      "assigned tab",
    );
  });

  it("requires the parent turn's completion and ignores child final answers", () => {
    const trace = [
      {
        type: "result",
        agent: "main",
        content: "Parent answer",
        accounting: { model: "pinned-model" },
      },
      { type: "result", agent: "assistant:explore", content: "Child answer" },
      { type: "turn_end", agent: "main", turnId: "turn", status: "completed" },
    ];
    expect(terminalResult(trace, "turn").answer).toBe("Parent answer");
    expect(() => terminalResult(trace, "other-turn")).toThrow();
    expect(() =>
      terminalResult([{ type: "result", content: "Looks successful" }], "turn"),
    ).toThrow();
  });

  it("accepts only JSON POSTs on the assigned recorder endpoint", async () => {
    const directory = await temporary();
    await mkdir(join(directory, "trajectory"));
    const recorder = new BrowserRecorder(directory, "test", fakeBrowser(), 10);
    const bridge = await serveRecorder(recorder);
    try {
      expect((await fetch(bridge.url)).status).toBe(403);
      expect(
        (
          await fetch(bridge.url, {
            method: "POST",
            headers: { Origin: "https://example.com", "Content-Type": "application/json" },
            body: '{"command":"state"}',
          })
        ).status,
      ).toBe(403);
      const response = await fetch(bridge.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: '{"command":"state"}',
      });
      expect(response.status).toBe(200);
      expect(recorder.steps).toHaveLength(1);
    } finally {
      await bridge.close();
    }
  });

  it("preserves cancellation failures so a suite cannot start the next task", async () => {
    const root = await temporary();
    class UnstoppableClient extends RomeClient {
      override async request(path: string): Promise<unknown> {
        if (path === "/chat/sessions") return { id: "session" };
        return { turnId: "turn" };
      }
      override async active(): Promise<boolean> {
        return true;
      }
      override async interrupt(): Promise<void> {
        throw new Error("Cancellation failed");
      }
    }
    const abort = new AbortController();
    abort.abort();
    const directory = join(root, "attempt");
    await expect(
      runAttempt({
        client: new UnstoppableClient("http://127.0.0.1"),
        task,
        directory,
        execute: fakeBrowser(),
        maxSteps: 10,
        timeoutMs: 100,
        signal: abort.signal,
      }),
    ).rejects.toThrow("Cancellation failed");
    const attempt = JSON.parse(await readFile(join(directory, "attempt.json"), "utf8"));
    expect(attempt.status).toBe("cancellation_unconfirmed");
    await expect(readFile(join(directory, "result.json"))).rejects.toThrow();
  });

  it("exports a completed Rome turn with its accounting and original task", async () => {
    const root = await temporary();
    const requests: Array<{ path: string; body: unknown }> = [];
    class CompletedClient extends RomeClient {
      override async request(path: string, body?: unknown): Promise<unknown> {
        requests.push({ path, body });
        if (path === "/chat/sessions")
          return { id: "new-session", largeModelSelection: "selected-model" };
        if (path.endsWith("trace.json"))
          return [
            { type: "result", content: "Example Domain", accounting: { model: "actual-model" } },
            { type: "turn_end", turnId: "turn", status: "completed" },
          ];
        return { turnId: "turn" };
      }
      override async active(): Promise<boolean> {
        return false;
      }
    }
    const directory = join(root, task.task_id);
    await runAttempt({
      client: new CompletedClient("http://127.0.0.1"),
      task,
      directory,
      execute: fakeBrowser(),
      model: "selected-model",
      maxSteps: 10,
      timeoutMs: 1000,
    });
    const result = await validateResult(directory);
    expect(result.task).toBe(task.confirmed_task);
    expect(result.agent_final_answer).toBe("Example Domain");
    const attempt = JSON.parse(await readFile(join(directory, "attempt.json"), "utf8"));
    expect(attempt.status).toBe("completed");
    expect(attempt.accounting.model).toBe("actual-model");
    expect(requests[1].path).toBe("/chat/sessions/new-session/turns");
    expect((requests[1].body as { text: string }).text).toContain(task.confirmed_task);
  });

  it("stops the suite when a submission response is lost", async () => {
    const root = await temporary();
    class LostResponseClient extends RomeClient {
      override async request(path: string): Promise<unknown> {
        if (path === "/chat/sessions") return { id: "known-session" };
        throw new Error("Submission response timed out");
      }
    }
    const directory = join(root, "attempt");
    await expect(
      runAttempt({
        client: new LostResponseClient("http://127.0.0.1"),
        task,
        directory,
        execute: fakeBrowser(),
        maxSteps: 10,
        timeoutMs: 1000,
      }),
    ).rejects.toThrow("timed out");
    const attempt = JSON.parse(await readFile(join(directory, "attempt.json"), "utf8"));
    expect(attempt.status).toBe("cancellation_unconfirmed");
    expect(attempt.session.id).toBe("known-session");
  });

  it("rejects a final answer that disagrees with the terminal step", async () => {
    const directory = await temporary();
    await mkdir(join(directory, "trajectory"));
    const recorder = new BrowserRecorder(directory, "test", fakeBrowser(), 10);
    await recorder.act({ command: "state" });
    const result = await recorder.finish(task, "original");
    await writeJson(join(directory, "result.json"), { ...result, agent_final_answer: "different" });
    await expect(validateResult(directory)).rejects.toThrow("does not match");
  });
});
