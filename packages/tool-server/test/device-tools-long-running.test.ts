import { describe, expect, it } from "vitest";
import { Registry } from "@argent/registry";
import { createBootDeviceTool } from "../src/tools/devices/boot-device";
import { reinstallAppTool } from "../src/tools/reinstall-app/index";
import { createRestartAppTool } from "../src/tools/restart-app/index";
import { createDescribeTool } from "../src/tools/describe/index";
import { createLaunchAppTool } from "../src/tools/launch-app/index";
import { nativeProfilerStartTool } from "../src/tools/profiler/native-profiler/native-profiler-start";

const registry = new Registry();
const slowDeviceTools: { id: string; longRunning?: boolean }[] = [
  createBootDeviceTool(registry),
  reinstallAppTool,
  createRestartAppTool(registry),
  createDescribeTool(registry),
  createLaunchAppTool(registry),
  nativeProfilerStartTool,
];

describe("device tools that can outlive the MCP fetch timeout", () => {
  it.each(slowDeviceTools)("$id is declared longRunning", (tool) => {
    expect(tool.longRunning).toBe(true);
  });
});
