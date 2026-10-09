import { basename } from "node:path";
import { z } from "zod";
import type { ToolDefinition } from "@argent/registry";
import { requireArtifacts, type ArtifactHandle } from "../../artifacts";
import { assertSupported } from "../../utils/capability";
import { resolveDevice } from "../../utils/device-info";
import { stopRecording } from "../../utils/ios-audio";

const zodSchema = z.object({
  udid: z.string().describe("Target iOS Simulator UDID from `list-devices`."),
  bundleId: z.string().describe("App passed to `audio-record-start`."),
});

type Params = z.infer<typeof zodSchema>;

/** Same hint as screen recordings: save durably instead of in the disposable cache. */
const RECORDINGS_DIR = ".argent/recordings";

interface AudioRecordStopResult {
  /** The finished recording (16-bit PCM WAV). */
  audio: ArtifactHandle;
  durationMs: number;
  sampleRate: number;
  channels: number;
  /** Only when the app produced sound faster than it could be written; the gaps are in the file. */
  droppedFrames?: number;
  warning?: string;
}

const capability = { apple: { simulator: true } } as const;

export const audioRecordStopTool: ToolDefinition<Params, AudioRecordStopResult> = {
  id: "audio-record-stop",
  interaction: {
    startedMsg: ({ params }) => `Stopping audio recording of ${params.bundleId}`,
    completedMsg: ({ result }) => `Saved audio recording ${result.audio.filename}`,
    failedMsg: ({ failureSignal }) => `Failed to stop audio recording: ${failureSignal.error_code}`,
  },
  capability,
  description: `Stop the recording started by \`audio-record-start\` and retrieve the WAV file of what the app played.
Use when the sound you wanted to capture has finished playing.
Returns { audio, durationMs, sampleRate, channels, droppedFrames?, warning? }; audio is a downloadable artifact materialized to a local path. The WAV is 16-bit PCM at the device sample rate (usually 48 kHz, stereo). A warning says when the recording is empty.
Fails if the app is not being recorded, or did not finish the file in time.`,
  searchHint: "audio record stop finish save wav output speaker sound",
  zodSchema,
  services: () => ({}),
  async execute(_services, params, ctx) {
    assertSupported("audio-record-stop", capability, resolveDevice(params.udid));
    const artifacts = requireArtifacts(ctx);
    const recording = await stopRecording(params.udid, params.bundleId);
    const audio = await artifacts.register({
      hostPath: recording.path,
      kind: "audio-recording",
      mimeType: "audio/wav",
      // Drop the internal `argent-` temp-file prefix from the saved name.
      filename: basename(recording.path).replace(/^argent-/, ""),
      saveDir: RECORDINGS_DIR,
    });
    const result: AudioRecordStopResult = {
      audio,
      durationMs: recording.durationMs,
      sampleRate: recording.sampleRate,
      channels: recording.channels,
    };
    if (recording.droppedFrames > 0) result.droppedFrames = recording.droppedFrames;
    if (recording.durationMs === 0) {
      result.warning =
        `${params.bundleId} played nothing while it was recorded. Start the recording before the sound plays; ` +
        `sound played by web content or another process is not covered.`;
    }
    return result;
  },
};
