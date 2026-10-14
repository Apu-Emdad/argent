import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  prepareFileInputs,
  applyClientFileDirectives,
  CLIENT_FILE_MARKER,
  type FileInputSpec,
  type FileInputWire,
} from "../src/file-inputs.js";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "client-e2e-dirs-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const e2e = (name: string) => path.join(root, ".argent", "e2e", name);
const legacy = (name: string) => path.join(root, ".argent", "flows", name);

async function write(file: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, "steps: []\n");
}

/** flow-execute's flow_file spec, as a tool-server with both directories advertises it. */
const flowFileSpec: FileInputSpec = {
  target: "flow_file",
  path: "${project_root}/.argent/flows/${name}.yaml",
  paths: ["${project_root}/.argent/e2e/${name}.yaml", "${project_root}/.argent/flows/${name}.yaml"],
  kind: "file",
  skipWhenSet: "flow_path",
};

async function derived(name: string, spec = flowFileSpec): Promise<string> {
  const out = (await prepareFileInputs(
    [spec],
    { name, project_root: root },
    {
      includeContent: false,
    }
  )) as Record<string, FileInputWire>;
  return out.flow_file!.path;
}

describe("a flow_file derived from paths", () => {
  it("is the .argent/e2e test when there is one, also beside a same-named legacy test", async () => {
    await write(e2e("both.yaml"));
    await write(legacy("both.yaml"));
    await write(e2e("new.yaml"));

    expect(await derived("both")).toBe(e2e("both.yaml"));
    expect(await derived("new")).toBe(e2e("new.yaml"));
  });

  it("is the .argent/flows test when only it exists", async () => {
    await write(legacy("old.yaml"));

    expect(await derived("old")).toBe(legacy("old.yaml"));
  });

  it("is the .argent/e2e path when neither exists", async () => {
    expect(await derived("nowhere")).toBe(e2e("nowhere.yaml"));
  });

  it("is `path` for a tool-server that advertises no paths", async () => {
    await write(e2e("new.yaml"));
    const { paths: _paths, ...older } = flowFileSpec;

    expect(await derived("new", older)).toBe(legacy("new.yaml"));
  });
});

describe("a recorded test written by the client", () => {
  it.each(["e2e", "flows"])("is written into .argent/%s", async (dir) => {
    const file = path.join(root, ".argent", dir, "rec.yaml");
    const { result, written } = await applyClientFileDirectives({
      savedTo: { [CLIENT_FILE_MARKER]: true, path: file, content: "steps: []\n" },
    });

    expect(result).toEqual({ savedTo: file });
    expect(written).toEqual([file]);
    await expect(fs.readFile(file, "utf8")).resolves.toBe("steps: []\n");
  });

  it("is refused in any other directory under .argent", async () => {
    const file = path.join(root, ".argent", "tests", "rec.yaml");
    const { result, written } = await applyClientFileDirectives({
      savedTo: { [CLIENT_FILE_MARKER]: true, path: file, content: "steps: []\n" },
    });

    expect(result).toEqual({ savedTo: null });
    expect(written).toEqual([]);
  });
});
