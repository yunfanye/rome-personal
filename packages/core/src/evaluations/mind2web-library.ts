import { copyFile, lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { digest, writeJson } from "./online-mind2web.js";

const clientSource = `async function call(command, args, screenshotTab) {
  const endpoint = process.env.ROME_BROWSER_ENDPOINT;
  if (!endpoint) throw new Error("Set ROME_BROWSER_ENDPOINT for the current task");
  const response = await fetch(endpoint, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ command, args, ...(screenshotTab ? { screenshotTab } : {}) }),
  });
  const result = await response.json();
  if (!response.ok || result.success === false) throw new Error(JSON.stringify(result));
  return result;
}
export const browser = (command, args = [], screenshotTab) => call(command, args, screenshotTab);
export const opencli = (args, screenshotTab) => call("opencli", args, screenshotTab);
`;

export async function initializeLibrary(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  for (const [name, content] of Object.entries({
    "rome-opencli.mjs": clientSource,
    "README.md":
      "# Reusable web tools\n\nSave reusable scripts here with usage examples and debugging notes. Use rome-opencli.mjs for recorded browser and OpenCLI calls. Read ROME_BROWSER_ENDPOINT from the environment on each run. Do not persist endpoint URLs, credentials, task answers, or benchmark-specific shortcuts.\n",
  })) {
    try {
      await writeFile(join(directory, name), content, { flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}

export interface LibrarySnapshot {
  sha256: string;
  files: Record<string, string>;
}

/** Rejects symlinks and excludes generated dependency directories from the portable artifact. */
export async function inspectLibrary(directory: string): Promise<LibrarySnapshot> {
  const files: Record<string, string> = {};
  let bytes = 0;
  const walk = async (relative: string): Promise<void> => {
    const entries = await readdir(join(directory, relative), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if ([".git", "node_modules", "__pycache__", ".venv"].includes(entry.name)) continue;
      const path = join(relative, entry.name);
      if (entry.isSymbolicLink())
        throw new Error(`Tool libraries cannot contain symlinks: ${path}`);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) {
        bytes += (await lstat(join(directory, path))).size;
        if (bytes > 50 * 1024 * 1024 || Object.keys(files).length >= 1000)
          throw new Error(
            "Tool library exceeds 1,000 files or 50 MiB. Keep generated data outside the library.",
          );
        files[path] = digest(await readFile(join(directory, path)));
      } else throw new Error(`Unsupported tool-library entry: ${path}`);
    }
  };
  await walk("");
  return { files, sha256: digest(JSON.stringify(files)) };
}

export async function copyLibrary(source: string, destination: string): Promise<LibrarySnapshot> {
  const before = await inspectLibrary(source);
  await mkdir(destination, { recursive: false });
  for (const path of Object.keys(before.files)) {
    await mkdir(dirname(join(destination, path)), { recursive: true });
    await copyFile(join(source, path), join(destination, path));
  }
  const copied = await inspectLibrary(destination);
  const after = await inspectLibrary(source);
  if (before.sha256 !== after.sha256 || copied.sha256 !== before.sha256)
    throw new Error("Tool library changed while its snapshot was copied");
  return copied;
}

export async function recordLibraryDelta(
  directory: string,
  before: LibrarySnapshot,
  after: LibrarySnapshot,
): Promise<void> {
  await writeJson(join(directory, "tool-changes.json"), {
    before: before.sha256,
    after: after.sha256,
    added: Object.keys(after.files).filter((path) => !(path in before.files)),
    modified: Object.keys(after.files).filter(
      (path) => path in before.files && before.files[path] !== after.files[path],
    ),
    removed: Object.keys(before.files).filter((path) => !(path in after.files)),
  });
}
