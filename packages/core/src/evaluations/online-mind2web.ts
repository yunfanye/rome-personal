import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { z } from "zod";

export const UPSTREAM_REVISION = "f0d805ee0e9e0b3ea70911e45e5264b72968f3dc";
export const DATASET = "osunlp/Online-Mind2Web";
const httpUrl = z.url().refine((value) => /^https?:/.test(value), "Expected an HTTP(S) URL");
export const taskSchema = z.object({
  task_id: z.string().regex(/^[A-Za-z0-9_-]+$/),
  confirmed_task: z.string().min(1),
  website: httpUrl,
  reference_length: z.number().int().positive(),
});
export type Task = z.infer<typeof taskSchema>;

export function parseTasks(value: unknown): Task[] {
  const tasks = z.array(taskSchema).min(1).parse(value);
  if (new Set(tasks.map((task) => task.task_id)).size !== tasks.length) {
    throw new Error("Duplicate task IDs in the dataset");
  }
  return tasks;
}

export const stepSchema = z
  .object({
    step: z.number().int().nonnegative(),
    screenshot: z.string().regex(/^\d{4}\.png$/),
    url: httpUrl,
    action: z.string().min(1),
    thought: z.string().nullable(),
    action_status: z.enum(["SUCCESS", "FAILED"]).optional(),
  })
  .strict();
export const resultSchema = z
  .object({
    schema_version: z.enum(["online-mind2web-v2", "rome-mind2web-tools-v1"]),
    task: z.string().min(1),
    task_id: taskSchema.shape.task_id,
    reference_length: taskSchema.shape.reference_length,
    agent_final_answer: z.string().nullable(),
    action_history: z.array(stepSchema).min(1),
  })
  .strict();
export type Step = z.infer<typeof stepSchema>;
export type Result = z.infer<typeof resultSchema>;

export async function writeJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporary, path);
}

export function digest(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function validateResult(directory: string): Promise<Result> {
  const result = resultSchema.parse(
    JSON.parse(await readFile(join(directory, "result.json"), "utf8")),
  );
  for (const [index, step] of result.action_history.entries()) {
    if (step.step !== index || step.screenshot !== `${String(index).padStart(4, "0")}.png`) {
      throw new Error(`Step ${index} is not aligned with its screenshot`);
    }
    const image = await readFile(join(directory, "trajectory", step.screenshot));
    if (!image.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) {
      throw new Error(`Step ${index} has no valid PNG screenshot`);
    }
    if (step.action_status && !step.action.endsWith(`| ${step.action_status}`)) {
      throw new Error(`Step ${index} has conflicting action status`);
    }
  }
  const final = result.action_history.at(-1)!;
  if (final.action !== `TASK_COMPLETE -> ANSWER: ${result.agent_final_answer ?? ""}`) {
    throw new Error("Final action does not match agent_final_answer");
  }
  return result;
}

export async function downloadTasks(
  destination: string,
  revision: string,
  token?: string,
): Promise<void> {
  const metadataResponse = await fetch(
    `https://huggingface.co/api/datasets/${DATASET}/revision/${encodeURIComponent(revision)}`,
  );
  if (!metadataResponse.ok) throw new Error(`Dataset metadata: HTTP ${metadataResponse.status}`);
  const metadata = z
    .object({ sha: z.string().regex(/^[a-f0-9]{40}$/) })
    .parse(await metadataResponse.json());
  const response = await fetch(
    `https://huggingface.co/datasets/${DATASET}/resolve/${metadata.sha}/Online_Mind2Web.json`,
    {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(60_000),
    },
  );
  if (!response.ok) {
    throw new Error(
      `Dataset download: HTTP ${response.status}. Accept access at https://huggingface.co/datasets/${DATASET} and set HF_TOKEN locally, or supply --tasks with an authorized local export.`,
    );
  }
  const raw = await response.text();
  const tasks = parseTasks(JSON.parse(raw));
  await writeFile(destination, raw, { flag: "wx" });
  await writeJson(`${destination}.metadata.json`, {
    dataset: DATASET,
    revision: metadata.sha,
    sha256: digest(raw),
    count: tasks.length,
    downloadedAt: new Date().toISOString(),
  });
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  success: boolean;
}
export type CommandRunner = (args: string[]) => Promise<CommandResult>;

export function openCliRunner(profile: string): CommandRunner {
  return (args) =>
    new Promise((resolve, reject) => {
      execFile(
        "opencli",
        ["--profile", profile, ...args],
        {
          timeout: 45_000,
          maxBuffer: 8 * 1024 * 1024,
          env: { ...process.env, NO_COLOR: "1", OPENCLI_CDP_ENDPOINT: "" },
        },
        (error, stdout, stderr) => {
          if (error && (error.killed || ("code" in error && error.code === "ENOENT"))) {
            reject(
              new Error("OpenCLI could not finish. Check its installation and browser connection."),
            );
          } else {
            // Some OpenCLI versions print failures while returning exit code zero.
            let reportedError = false;
            try {
              reportedError = Boolean(JSON.parse(stdout).error);
            } catch {}
            resolve({
              stdout,
              stderr,
              success: !error && !reportedError && !/[✖❌]/u.test(stderr),
            });
          }
        },
      );
    });
}

const verbs = {
  open: "NAVIGATE",
  back: "GO_BACK",
  click: "CLICK",
  fill: "TYPE",
  type: "TYPE",
  scroll: "SCROLL",
  hover: "HOVER",
  select: "SELECT",
  keys: "PRESS_KEY",
  wait: "WAIT",
  state: "WAIT",
  find: "WAIT",
  get: "WAIT",
  extract: "WAIT",
  frames: "WAIT",
  eval: "EXECUTE_SCRIPT",
  opencli: "RUN_OPENCLI",
} as const;
export const browserRequestSchema = z
  .object({
    command: z.enum(Object.keys(verbs) as [keyof typeof verbs, ...(keyof typeof verbs)[]]),
    args: z.array(z.string().max(8000)).max(20).default([]),
    screenshotTab: z.string().min(1).optional(),
  })
  .strict();
type BrowserRequest = z.infer<typeof browserRequestSchema>;
const observations = new Set(["state", "find", "get", "extract", "frames", "wait"]);

export function actionDescription(
  request: BrowserRequest,
  success: boolean,
  allowScripts = false,
): string {
  const verb = verbs[request.command];
  const targeted = ["click", "fill", "type", "hover", "select"].includes(request.command);
  const target = targeted ? request.args[0] : "page";
  if (
    !allowScripts &&
    (request.command === "eval" || request.command === "opencli" || request.screenshotTab)
  ) {
    throw new Error("Scripts and alternate tabs require the tool-learning protocol");
  }
  if (targeted && (!target || target.startsWith("-") || (!allowScripts && /^\d+$/.test(target)))) {
    throw new Error(
      "Use an explicit CSS selector as the first argument for pointer and input commands, not a numeric OpenCLI ref.",
    );
  }
  const description =
    request.command === "open"
      ? "Open the specified URL"
      : `OpenCLI ${request.command} ${JSON.stringify(request.args)}`;
  return `${target} -> ${verb} -> ${description}${observations.has(request.command) ? "" : ` | ${success ? "SUCCESS" : "FAILED"}`}`;
}

export class BrowserRecorder {
  readonly steps: Step[] = [];
  readonly commands: unknown[] = [];
  fatalError: string | undefined;
  stopped = false;
  private busy = false;
  private lastScreenshotTab: string | undefined;

  constructor(
    readonly directory: string,
    readonly session: string,
    private readonly execute: CommandRunner,
    readonly maxSteps: number,
    readonly allowScripts = false,
  ) {}

  private async cli(args: string[]): Promise<CommandResult> {
    return this.execute([
      "browser",
      this.session,
      ...args,
      ...(args[0] === "open" ? ["--window", "background"] : []),
    ]);
  }

  async prepare(): Promise<void> {
    // OpenCLI can fail to attach when a new session navigates before its blank tab is ready.
    const setup = await this.cli(["state"]);
    await writeJson(join(this.directory, "setup.json"), setup);
    if (!setup.success)
      throw new Error(`Could not prepare the browser session: ${setup.stderr || setup.stdout}`);
  }

  private async snapshot(
    action: string,
    status?: "SUCCESS" | "FAILED",
    tab?: string,
  ): Promise<Step> {
    const screenshot = `${String(this.steps.length).padStart(4, "0")}.png`;
    const imagePath = join(this.directory, "trajectory", screenshot);
    const target = tab ? ["--tab", tab] : [];
    const image = await this.cli(["screenshot", imagePath, ...target]);
    if (!image.success || !(await stat(imagePath)).size)
      throw new Error("Screenshot capture failed");
    const location = await this.cli(["get", "url", ...target]);
    if (!location.success) throw new Error("Could not record the page URL");
    const url = location.stdout.match(/https?:\/\/[^\s"<>]+/)?.[0];
    const step = stepSchema.parse({
      step: this.steps.length,
      screenshot,
      url,
      action,
      thought: null,
      ...(status ? { action_status: status } : {}),
    });
    this.steps.push(step);
    await writeJson(join(this.directory, "steps.json"), this.steps);
    return step;
  }

  async act(value: unknown): Promise<unknown> {
    if (this.stopped || this.fatalError)
      throw new Error(this.fatalError ?? "The attempt has ended");
    if (this.busy)
      throw new Error("A browser command is already running. Send commands sequentially.");
    if (this.steps.length >= this.maxSteps) {
      this.fatalError = "Browser step limit reached";
      throw new Error(this.fatalError);
    }
    const request = browserRequestSchema.parse(value);
    actionDescription(request, true, this.allowScripts);
    if (request.args.some((arg) => /^--?(tab|profile|cdp|help|window)/.test(arg))) {
      throw new Error("Commands must operate on the attempt's assigned tab and profile");
    }
    if (request.command === "open") httpUrl.parse(request.args[0]);
    // The lock covers both the command and its evidence. A second caller cannot change the page between them.
    this.busy = true;
    try {
      const startedAt = new Date().toISOString();
      const output =
        request.command === "opencli"
          ? await this.execute(request.args)
          : await this.cli([request.command, ...request.args]);
      this.commands.push({ ...request, ...output, startedAt, endedAt: new Date().toISOString() });
      await writeJson(join(this.directory, "commands.json"), this.commands);
      const status = observations.has(request.command)
        ? undefined
        : output.success
          ? "SUCCESS"
          : "FAILED";
      const step = await this.snapshot(
        actionDescription(request, output.success, this.allowScripts),
        status,
        request.screenshotTab,
      );
      this.lastScreenshotTab = request.screenshotTab;
      return {
        ...output,
        screenshot: join(this.directory, "trajectory", step.screenshot),
        url: step.url,
      };
    } catch (error) {
      this.fatalError = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      this.busy = false;
    }
  }

  async finish(task: Task, answer: string | null): Promise<Result> {
    await this.drain();
    if (this.fatalError) throw new Error(this.fatalError);
    await this.snapshot(
      `TASK_COMPLETE -> ANSWER: ${answer ?? ""}`,
      undefined,
      this.lastScreenshotTab,
    );
    const result: Result = {
      schema_version: this.allowScripts ? "rome-mind2web-tools-v1" : "online-mind2web-v2",
      task: task.confirmed_task,
      task_id: task.task_id,
      reference_length: task.reference_length,
      agent_final_answer: answer,
      action_history: this.steps,
    };
    await writeJson(join(this.directory, "result.json"), result);
    return validateResult(this.directory);
  }

  async drain(): Promise<void> {
    this.stopped = true;
    while (this.busy) await new Promise((resolve) => setTimeout(resolve, 50));
  }

  async close(): Promise<void> {
    await this.drain();
    await this.cli(["close"]);
  }
}

export async function serveRecorder(
  recorder: BrowserRecorder,
): Promise<{ url: string; close(): Promise<void> }> {
  const path = `/browser/${randomUUID()}`;
  const server = createServer(async (request, response) => {
    response.setHeader("Content-Type", "application/json");
    try {
      if (
        request.method !== "POST" ||
        request.url !== path ||
        request.headers.origin ||
        !request.headers["content-type"]?.startsWith("application/json")
      ) {
        response
          .writeHead(403)
          .end(JSON.stringify({ error: "Use the assigned browser endpoint with JSON" }));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 32_768) throw new Error("Browser request exceeds 32 KiB");
        chunks.push(chunk);
      }
      response.end(
        JSON.stringify(await recorder.act(JSON.parse(Buffer.concat(chunks).toString()))),
      );
    } catch (error) {
      response
        .writeHead(400)
        .end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No recorder address");
  return {
    url: `http://127.0.0.1:${address.port}${path}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

export interface ToolLearningContext {
  library: string;
  frozen: boolean;
}

export function taskPrompt(
  task: Task,
  recorderUrl: string,
  maxSteps: number,
  learning?: ToolLearningContext,
): string {
  if (learning)
    return `${task.confirmed_task}

Complete this live web task with Rome. The assigned browser starts at ${task.website}.
This experiment measures reusable tool building and reuse. Tool library: ${learning.library}
${learning.frozen ? "This is an evaluation task. The supplied library is frozen: use it without creating, editing, or deleting tools or notes." : "Build and improve reusable OpenCLI scripts while solving this task. Reuse existing tools first. Save reusable code, usage examples, and debugging lessons in the library. Do not save task-specific answers or hard-code benchmark outcomes. Read learning-feedback.json there when present."}
Use your coding tools to work in that library. For every web operation use the recorded endpoint ${recorderUrl}.
The library's rome-opencli.mjs exports browser(command, args, screenshotTab?) and opencli(args, screenshotTab?). It uses the ROME_BROWSER_ENDPOINT environment variable.
Run scripts with ROME_BROWSER_ENDPOINT='${recorderUrl}' node <script-path>. Python and shell scripts can POST the same JSON endpoint.
Supported browser commands: open, back, click, fill, type, scroll, hover, select, keys, wait, state, find, get, extract, frames, eval.
Page JavaScript: {"command":"eval","args":["document.querySelector('h1').textContent"]}.
Native OpenCLI adapters: {"command":"opencli","args":["<site>","<command>","..."]}.
For an adapter or script that opens another tab, pass its real target ID as screenshotTab so the paired screenshot shows that tab. Use OpenCLI tab list to find it.
Each endpoint call saves the actual command output and an after-command screenshot. Scripts may make multiple sequential calls. A compound eval/adapter call has one end-state screenshot, not a screenshot for each internal operation.
At most ${maxSteps} recorded calls. Read returned screenshot paths when useful. Do not call OpenCLI or other web tools outside the recorder.
Do not inspect evaluator code, result directories, judge sessions, benchmark answers, or other task sessions. Use only the current task and the supplied library for prior experience. Do not read or write global Rome memory for this experiment.
Start from the assigned website. Report login, CAPTCHA, and missing-information blockers accurately. End with the answer supported by browser evidence. Do not schedule future work or ask the user questions.`;
  return `${task.confirmed_task}

This is an Online-Mind2Web evaluation of Rome. The assigned tab already starts at ${task.website}.
Complete the task using only this recorded browser endpoint for all web interactions:
${recorderUrl}
Call it from Bash with curl --fail-with-body -sS -H 'Content-Type: application/json' --data '{"command":"state","args":[]}' '${recorderUrl}'.
It executes OpenCLI in your assigned session and returns its output, URL, and an absolute screenshot path. You may read that screenshot.
Commands: open, back, click, fill, type, scroll, hover, select, keys, wait, state, find, get, extract, frames.
Arguments follow OpenCLI browser syntax. Use explicit CSS selectors (not numeric refs) as the first argument to click/fill/type/hover/select. Use get html or find to inspect selectors.
Example input: {"command":"fill","args":["input[name=q]","search terms"]}.
Send one command at a time. At most ${maxSteps} browser calls, including observations. Remain in the assigned tab.
Do not use unrecorded browser tools, site adapters, direct HTTP requests, WebSearch, WebFetch, or other agents. Do not consult benchmark answers, prior sessions, or memory, or write memories about this task.
Start from the assigned website. If blocked by login, CAPTCHA, or missing information, report the blocker. Do not invent missing information.
When finished, answer the user's task with facts observed in the browser. Do not ask the user questions or schedule follow-up work.`;
}

export class RomeClient {
  constructor(readonly baseUrl: string) {}
  async request(path: string, body?: unknown): Promise<unknown> {
    const response = await fetch(`${this.baseUrl.replace(/\/$/, "")}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
      redirect: "error",
    });
    if (!response.ok) throw new Error(`Rome ${path}: HTTP ${response.status}`);
    return response.json();
  }
  async active(sessionId: string, turnId: string): Promise<boolean> {
    const turns = z
      .array(z.object({ turnId: z.string() }))
      .parse(await this.request(`/chat/sessions/${sessionId}/turns`));
    return turns.some((turn) => turn.turnId === turnId);
  }
  async interrupt(sessionId: string, turnId: string): Promise<void> {
    await this.request(`/chat/turns/${turnId}/interrupt`, {});
    const deadline = Date.now() + 30_000;
    while (await this.active(sessionId, turnId)) {
      if (Date.now() > deadline)
        throw new Error(
          "Rome did not stop the turn. Stop this run before starting another attempt.",
        );
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}

const traceSchema = z.array(
  z
    .object({
      type: z.string(),
      agent: z.string().optional(),
      content: z.string().optional(),
      status: z.string().optional(),
      turnId: z.string().optional(),
      error: z.string().optional(),
    })
    .passthrough(),
);

export function terminalResult(
  trace: unknown,
  turnId: string,
): { answer: string; accounting: unknown } {
  const blocks = traceSchema
    .parse(trace)
    .filter((block) => !block.agent || block.agent === "main" || block.agent === "core:main");
  const error = blocks.find((block) => block.type === "error");
  if (error) throw new Error(`Rome turn failed: ${error.error ?? "Unknown provider error"}`);
  if (
    !blocks.some(
      (block) =>
        block.type === "turn_end" && block.turnId === turnId && block.status === "completed",
    )
  ) {
    throw new Error("Rome turn did not complete successfully");
  }
  const result = [...blocks].reverse().find((block) => block.type === "result");
  if (!result || typeof result.content !== "string")
    throw new Error("Rome returned no terminal answer");
  return { answer: result.content, accounting: result.accounting ?? null };
}

export interface AttemptOptions {
  client: RomeClient;
  task: Task;
  directory: string;
  execute: CommandRunner;
  model?: string;
  reasoningEffort?: string;
  maxSteps: number;
  timeoutMs: number;
  signal?: AbortSignal;
  learning?: ToolLearningContext;
}

export async function runAttempt(options: AttemptOptions): Promise<void> {
  const { client, task, directory } = options;
  await mkdir(directory, { recursive: false });
  await mkdir(join(directory, "trajectory"));
  const recorder = new BrowserRecorder(
    directory,
    `om2w-${randomUUID()}`,
    options.execute,
    options.maxSteps,
    Boolean(options.learning),
  );
  const metadata: Record<string, unknown> = {
    taskId: task.task_id,
    status: "running",
    startedAt: new Date().toISOString(),
    browserSession: recorder.session,
  };
  await writeJson(join(directory, "attempt.json"), metadata);
  let bridge: Awaited<ReturnType<typeof serveRecorder>> | undefined;
  let sessionId: string | undefined;
  let turnId: string | undefined;
  let complete = false;
  let submitting = false;
  try {
    await recorder.prepare();
    const initial = (await recorder.act({
      command: "open",
      args: [task.website],
    })) as CommandResult;
    if (!initial.success) throw new Error("The benchmark start website could not be opened");
    bridge = await serveRecorder(recorder);
    const session = z
      .object({ id: z.string() })
      .passthrough()
      .parse(
        await client.request("/chat/sessions", {
          name: `Online-Mind2Web ${task.task_id}`,
          largeModelSelection: options.model,
          reasoningEffort: options.reasoningEffort,
        }),
      );
    sessionId = session.id;
    metadata.session = session;
    if (options.model && session.largeModelSelection !== options.model) {
      throw new Error(`Rome did not accept the requested model selector: ${options.model}`);
    }
    const prompt = taskPrompt(task, bridge.url, options.maxSteps, options.learning);
    await writeFile(join(directory, "prompt.txt"), prompt);
    metadata.status = "submitting";
    await writeJson(join(directory, "attempt.json"), metadata);
    submitting = true;
    const receipt = z.object({ turnId: z.string() }).parse(
      await client.request(`/chat/sessions/${sessionId}/turns`, {
        text: prompt,
        inputId: randomUUID(),
        reasoningEffort: options.reasoningEffort,
      }),
    );
    turnId = receipt.turnId;
    metadata.turnId = turnId;
    metadata.status = "running";
    await writeJson(join(directory, "attempt.json"), metadata);
    const deadline = Date.now() + options.timeoutMs;
    while (await client.active(sessionId, turnId)) {
      if (options.signal?.aborted || Date.now() > deadline || recorder.fatalError) {
        throw new Error(
          recorder.fatalError ?? (options.signal?.aborted ? "Run interrupted" : "Task timeout"),
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    complete = true;
    const trace = await client.request(`/chat/sessions/${sessionId}/turns/${turnId}/trace.json`);
    await writeJson(join(directory, "rome-trace.json"), trace);
    const terminal = terminalResult(trace, turnId);
    await recorder.finish(task, terminal.answer);
    metadata.accounting = terminal.accounting;
    metadata.status = "completed";
  } catch (error) {
    metadata.status = "error";
    metadata.error = error instanceof Error ? error.message : String(error);
    // A lost submission response can hide a running turn. Stop the suite until its session is inspected.
    if (submitting && !turnId) metadata.status = "cancellation_unconfirmed";
    if (sessionId && turnId && !complete) {
      try {
        await client.interrupt(sessionId, turnId);
      } catch (cancellationError) {
        metadata.status = "cancellation_unconfirmed";
        throw cancellationError;
      }
    }
    throw error;
  } finally {
    metadata.endedAt = new Date().toISOString();
    await recorder.drain();
    await bridge?.close();
    await recorder.close().catch(() => {});
    if (sessionId && turnId && metadata.status !== "completed") {
      try {
        const trace = await client.request(
          `/chat/sessions/${sessionId}/turns/${turnId}/trace.json`,
        );
        await writeJson(join(directory, "rome-trace.json"), trace);
      } catch {
        /* Preserve the execution error when Rome cannot provide the partial trace. */
      }
    }
    await writeJson(join(directory, "attempt.json"), metadata);
  }
}
