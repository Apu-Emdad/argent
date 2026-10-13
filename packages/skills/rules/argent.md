---
description: Argent iOS Simulator and Android Emulator Agent — always-on guidance for methodology and tools for working with, interacting, testing and profiling mobile app work
alwaysApply: true
---

<description>
If argent is installed and configured in this environment, its MCP tools are the preferred form of interaction with the application for iOS simulator, physical iPhone, Android emulator, Chromium (CDP) app, and Vega (Amazon Fire TV) device control; otherwise see `<availability_check>` below before attempting any argent workflow. A "Chromium (CDP) app" is any Chromium runtime exposing a Chrome DevTools Protocol endpoint — an Electron app, or any Chromium-family browser (Chrome/Brave/Edge) launched with `--remote-debugging-port`; all are driven through the same tool surface and tagged `platform: "chromium"`. A "Vega device" is a virtual device (VVD) or physical unit — driven by tv-remote (D-pad) and tagged `platform: "vega"`. Physical iPhones (iPads are not supported) appear in `list-devices` as iOS entries with kind `"device"`; they are driven over USB cable only, and the on-device runner's signing is auto-detected from the Mac's keychain (`ARGENT_IOS_TEAM_ID` overrides). Automation there is app-scoped: `launch-app` registers the target app before anything else can act. Read `argent-ios-device-setup` to get one connected and `argent-ios-device-interact` before interacting.
Running MCP server and managing the Argent toolkit utilises `argent` command - if asked use `argent --help` for reference.
To check current version of MCP server run `argent --version` command.

Use cases:

- User mentions iOS simulator, Android emulator, device, or app interaction
- The app user is working with is a mobile application which can be run in a simulator/emulator
- Any tapping, swiping, typing, screenshotting, or inspecting a running app
- Any code change that affects visible mobile UI, layout, styling, copy, navigation, or screen composition
- Any request to execute manual QA, UI QA, or visual behavior validation for a mobile app
- Running, debugging, or testing a React Native app (iOS, Android or Vega)
- Profiling performance or diagnosing re-renders in a React Native app (iOS or Android)
- Running, debugging, or testing a Chromium (CDP) app — an Electron app (boot with `boot-device` + `electronAppPath`) or a Chromium browser exposing CDP (auto-discovered on port `9222` / `ARGENT_CHROMIUM_PORTS`); on Chromium scroll with `gesture-scroll` and drag with `gesture-drag` — `gesture-swipe` is touch-only
  </description>

<availability_check>
<important>Run this check once per session, before the first argent tool call or `argent` command. Do not re-probe before later calls.</important>

Confirm argent is available:

1. Are `mcp__argent__*` tools in your tool list? If none are present, argent is not available.
2. If still unsure, run `command -v argent`. A non-zero exit means the CLI is not on PATH.

If argent IS available, ignore the rest of this block and follow this rule normally.

If argent is ABSENT, treat it as an expected state, not an error to retry. Do not call `mcp__argent__*` tools, do not run `argent` commands, and do not attempt any argent workflow. Tell the user once, and ask if you should continue without argent:

> Argent isn't installed in this environment. To enable the mobile/Chromium tooling this repo is configured for, run `npx @swmansion/argent@latest init -y` (or `npm i -g @swmansion/argent@latest && argent init -y`).
> </availability_check>

<tapping_rule>
<important>**Never** derive tap coordinates from screenshot pixels</important>
Interaction tools (`gesture-tap`, `gesture-swipe`, `keyboard`, `button`, `launch-app`, `open-url`, `run-sequence`, …) return the screen **after** the action: a screenshot AND the accessibility element tree (`--- Elements after action (describe) ---`, the same format `describe` prints, with normalized 0–1 frames). Take tap coordinates from that tree — the centre of the element's frame (`x + width/2`, `y + height/2`). You do not need a separate discovery call before a tap when the last result already lists the target.

Call a discovery tool yourself only when you have no fresh tree for the current screen — before the first action on a screen you have not touched yet, after waiting for something to load, or when the last tree did not list your target. Preferred tools are, in order:

- `describe` - native app-level components and safely targetable foreground apps (iOS and Android).
- `native-describe-screen` - accessibility screen description via injected native devtools (iOS only)
- `debugger-component-tree` - react-native specific components

`native-user-interactable-view-at-point` / `native-view-at-point` are follow-up diagnostics once you already have a candidate point (iOS only).

If a **tap fails twice** at the same coordinates, **stop retrying** and re-run a discovery tool.

If `describe` fails, **read the exact error before reacting**, follow the recovery guidance in `argent-device-interact` to choose the correct next action.

Before starting to interact with the app, read the `argent-device-interact` skill first.
</tapping_rule>

<device_selection_rule>
Before booting, running, or interacting with any app, call `list-devices` first - prefer running devices.

Decision order:

1. **Explicit user intent** - choose the user named platform or device. Look for words "simulator" and "emulator".
2. **Prefer a running device.** iOS simulators - state `Booted` and Android devices - `state: "device"` come first in `list-devices`; Chromium (CDP) apps appear as `platform: "chromium"`, `state: "Running"`. A cabled physical iPhone (`platform: "ios"`, `kind: "device"`, `state: "connected"`) is listed first too, but it is not a running simulator: never pick it because it is there. Use it only when the user names the phone, a physical or real device, or hardware testing. With nothing else booted, boot a simulator or ask which target the user means.
3. **Single-platform project:** (per `argent-environment-inspector` flags `is_native_ios`/`is_native_android`, or RN with only one platform configured) → boot that platform.
   </device_selection_rule>

<skill_reading_rule>
<important>Always read relevant skills for guidance before executing argent-mcp tool - read skill_routing reference</important>
</skill_reading_rule>

<general_rules>

- All simulator/emulator interactions go through argent MCP tools — never use `xcrun simctl`,
  raw `curl` to simulator ports, or the simulator-server binary directly.
- Before calling any gesture tool for the first time, use ToolSearch to load its schema.
- Interaction tools (`gesture-tap`, `gesture-swipe`, `gesture-pinch`, `gesture-rotate`, `gesture-custom`, `launch-app`, etc.) return a screenshot and the element tree automatically.
  Call `screenshot` or `describe` separately only for a baseline before any action or after a delay.
- Always open apps with `launch-app` or `open-url` — never tap home screen icons.
- If a task can require a saved flow, choose `argent-create-flow` or `argent-qa-flows` before the first launch or in-app action. Start the recorder before walking the path; recording is not retroactive.
- Always use `run-sequence` when performing multiple sequential device actions where you don't need to observe the screen between steps. More in `argent-device-interact` skill.
- When the session ends or the user says they are done: call `stop-all-simulator-servers` with `devices: [...]`
  naming the devices this session actually used. One tool-server is shared by every other agent using this
  argent install, so an unscoped call tears down their devices too; reserve that form for a deliberate
  machine-wide cleanup.
  If the user started Metro separately, ask whether to call `stop-metro` (specify the port if not 8081).
- If tools provided by mcp-server are not sufficient and action can be done using `xcrun`, `adb`, or other commands, use the command. Examples: changing device options, performing a device action such as lock, shake, etc. Not on a physical iPhone.
- When waiting for an action, do not call `screenshot` repeatedly without a proper wait mechanism. Use the `await-ui-element` tool to block until the UI settles (e.g. wait for an element to become `visible`/`hidden`, or to contain expected `text`) instead of polling.
  </general_rules>

<react_native_detection>
Project type is determined by the `argent-environment-inspector` subagent (see `subagents` section).
When the subagent result is available, use its `is_react_native` field as the authoritative
source — do not re-inspect files manually.

If the subagent has not run yet and project type is unknown, run it first before proceeding. Always use subagents if available to run `gather-workspace-data` data tool, if possible do not run yourself.

When `is_react_native` is true: load `argent-react-native-app-workflow` skill. Use `debugger-component-tree` for element discovery - if the responses are large or unhelpful, try `describe`.
</react_native_detection>

<skill_routing>
Load the matching skill before running argent tools for that workflow; skills hold the step-by-step procedure and edge cases.
No platform named → `list-devices` first and pick the booted target (do not default to iOS); a `platform:"vega"` entry → `argent-tv-interact`.

- `argent-ios-simulator-setup` — iOS simulator task, none booted yet, need a UDID or simulator-server
- `argent-android-emulator-setup` — Android emulator task, none running, need an adb serial, or installing an APK
- `argent-ios-device-setup` (cable, trust, signing) → `argent-ios-device-interact` (app-scoped contract) — ONLY for an iPhone: the user names a physical iPhone, or a real device / "on my phone" / USB / hardware with an iOS target, or the target iOS entry has kind `"device"`. A physical Android phone uses the Android workflow. Never for a simulator, never because a cabled phone is listed first. On hardware every interaction starts with `launch-app`; `paste`, `settings-permissions`, two-finger gestures, `rotate`, `shake`, screen recording, `debugger-*`, `react-profiler-*`, `native-profiler-*` and `native-*` do not exist
- `argent-device-interact` — tapping, swiping, typing, gestures, hardware buttons, launching/restarting apps, opening URLs, rotate/fold, standalone screenshots, verifying a visible UI change. Phone/tablet simulators and emulators only: not TV, not a physical iPhone
- `argent-tv-interact` — any TV: `runtimeKind: "tv"` (Apple TV sim, Android TV emulator), `platform:"vega"` / `kind:"vvd"` (Fire TV), or Apple TV / tvOS / Android TV / leanback / Vega / Fire TV / D-pad mentioned. Focus-driven: `describe` (focus) + `tv-remote` + `keyboard`, never `gesture-*`. Covers boot, app lifecycle, focus navigation, typing, screenshots; on Vega also VVD lifecycle, Fast Refresh and JS debugging (evaluate, logs, network). Saved flows (`argent-create-flow`, `argent-qa-flows`, recorded as `tool: tv-remote` steps) exist on Vega only; on Apple TV / Android TV report that limitation
- `argent-settings-permissions` — grant/deny/revoke/reset a runtime permission the app itself can't flip (camera, microphone, photos, contacts, notifications, calendar, location, location-always, media-library, motion, reminders; TCC/privacy): pre-authorize or deny before the app asks, re-enable after a denial (iOS never re-prompts), or reset so the first-run dialog reappears. iOS simulator and Android emulator/device. Not when the app has an in-app toggle or shows its own permission dialog — tap that (`argent-device-interact`); not for permissions/settings outside that list
- `argent-screenshot-diff` — visual regression, screenshot diff/compare, before/after comparison, or a visible UI change where stable pixel comparison adds evidence
- `argent-screen-recording` — record a video / mp4 / clip of an interaction, animation or bug reproduction (use `argent-create-flow` for a replayable sequence)
- `argent-react-native-app-workflow` — RN project: starting Metro, running/building the iOS or Android app, build failures, pods, lost Metro connection, reading logs, reloading the JS bundle, reinstalling
- `argent-metro-debugger` — JS evaluation, inspecting the React component tree at source level, element placement via `debugger-component-tree`
- `argent-react-native-profiler` — measuring specific components or app-wide bottlenecks, re-renders, CPU hotspots, ranked perf reports
- `argent-native-profiler` — native CPU hotspots and UI hangs (iOS via xctrace; Android via Perfetto), memory leaks (iOS only); also the native half of dual profiling with `argent-react-native-profiler`
- `argent-react-native-optimization` — app feels slow, optimize, bundle size, startup time, re-renders, lists/images/navigation, any perf task. Entry point for all perf work; delegates measurement to `argent-react-native-profiler`
- `argent-test-ui-flow` — one-off interact → screenshot → verify check, nothing saved
- `argent-create-flow` — save or replay a repeatable path ("flow", repeat, test X times) for profiling, A/B comparison, retry or reuse
- `argent-qa-flows` — save a test case / ticket / acceptance criteria as a regression (e2e/QA) test; needs stable evidence and two unchanged full passes. iOS, Android, Chromium, Vega; not Apple TV / Android TV
- Saved-artifact routing: one-off check → `argent-test-ui-flow`; saved path → `argent-create-flow`; saved acceptance test → `argent-qa-flows`
- `argent-lens` — the user asks for design variants / options / A-B choices for a screen or component, or you have more than one candidate look and want a human to pick before committing (propose_variant loop + one blocking await_user_selection). Off by default: `argent enable argent-lens` first

</skill_routing>

<subagents>
ENVIRONMENT INSPECTION AT SESSION START
Use subagent: `argent-environment-inspector`
When:
- Environment context of the project is not yet known
- No "Project Environment" section exists in project memory / `MEMORY.md` or you lack information about basic setup workflows
- Need to determine build commands, startup scripts, metro port, platform support, or QA tooling
  If the subagent already ran this session (result in memory), use that context directly — do NOT re-run.
Rules:
  - Run the `argent-environment-inspector` subagent if possible. Never call `gather-workspace-data` yourself - do only if subagent is not available.
  - The main agent is responsible for persisting the subagent's JSON result to project memory
</subagents>
