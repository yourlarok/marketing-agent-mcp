import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { chromium, type Browser } from "playwright";
import { z } from "zod";
import {
  CHANNEL_PROFILES,
  type Mp4AssetValidation,
  type PngAssetValidation,
} from "../domain/content-production-model.js";
import { DomainError } from "../domain/errors.js";

const FFPROBE_TIMEOUT_MS = 10_000;
const FFPROBE_MAX_OUTPUT_BYTES = 64 * 1024;
const MEDIA_CONFIGURATION_ACTION =
  "Configure MARKETING_MEDIA_MCP_COMMAND and MARKETING_MEDIA_MCP_ARGS in the trusted deployment environment";
const PROBE_CONFIGURATION_ACTION =
  "Configure MARKETING_FFPROBE_COMMAND as an absolute deployment-controlled executable path";

export interface MediaValidatorOptions {
  ffprobeCommand?: string;
  chromiumExecutablePath?: string;
  ffprobeTimeoutMs?: number;
}

const probeSchema = z.object({
  streams: z.array(z.object({
    codec_type: z.string(),
    codec_name: z.string(),
    width: z.number().int().optional(),
    height: z.number().int().optional(),
  })),
  format: z.object({ duration: z.string() }),
});

function gap(capability: "professional_media" | "video_probe", reason: string, message: string, retryable = false): DomainError {
  return new DomainError("CAPABILITY_UNAVAILABLE", message, retryable, {
    capability,
    reason,
    configurationAction: capability === "professional_media" ? MEDIA_CONFIGURATION_ACTION : PROBE_CONFIGURATION_ACTION,
  });
}

function probeGap(reason: string, message: string, retryable = false): DomainError {
  return gap("video_probe", reason, message, retryable);
}

interface ProbeOutput {
  stdout: string;
}

function runFfprobe(command: string, args: string[], timeoutMs: number): Promise<ProbeOutput> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], env: {} });
    const stdout: Buffer[] = [];
    let outputBytes = 0;
    let timedOut = false;
    let outputExceeded = false;
    let spawnError: unknown;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    const collect = (chunk: Buffer): void => {
      if (outputExceeded) return;
      outputBytes += chunk.length;
      if (outputBytes > FFPROBE_MAX_OUTPUT_BYTES) {
        outputExceeded = true;
        child.kill("SIGKILL");
        return;
      }
      stdout.push(chunk);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > FFPROBE_MAX_OUTPUT_BYTES && !outputExceeded) {
        outputExceeded = true;
        child.kill("SIGKILL");
      }
    });
    child.on("error", (error) => {
      spawnError = error;
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (spawnError !== undefined) {
        reject(probeGap("ffprobe_unavailable", "ffprobe could not be started", true));
      } else if (timedOut) {
        reject(probeGap("ffprobe_timeout", "ffprobe exceeded the 10 second deadline", true));
      } else if (outputExceeded) {
        reject(probeGap("ffprobe_output_too_large", "ffprobe output exceeds 64 KiB"));
      } else if (code !== 0) {
        reject(probeGap("ffprobe_failed", "ffprobe could not inspect the MP4 bytes"));
      } else {
        resolve({ stdout: Buffer.concat(stdout).toString("utf8") });
      }
    });
  });
}

function probeVersion(output: string): string {
  const version = output.split("\n", 1)[0]?.trim() ?? "";
  if (version.length === 0 || version.length > 256) {
    throw probeGap("ffprobe_invalid_response", "ffprobe version provenance is missing or unbounded");
  }
  return version;
}

export class MediaValidator {
  constructor(private readonly options: MediaValidatorOptions = {}) {
    if (options.ffprobeCommand !== undefined && !isAbsolute(options.ffprobeCommand)) {
      throw new DomainError("INVALID_INPUT", "ffprobe command must be an absolute executable path");
    }
    if (options.ffprobeTimeoutMs !== undefined &&
        (!Number.isSafeInteger(options.ffprobeTimeoutMs) || options.ffprobeTimeoutMs < 1 ||
          options.ffprobeTimeoutMs > FFPROBE_TIMEOUT_MS)) {
      throw new DomainError("INVALID_INPUT", "ffprobe timeout override must be between 1 and 10000 ms");
    }
  }

  async validateXhsPng(bytes: Uint8Array): Promise<PngAssetValidation> {
    if (bytes.byteLength < 1 || bytes.byteLength > CHANNEL_PROFILES.xhs.maxBytes) {
      throw new DomainError("INVALID_INPUT", "PNG bytes exceed the internal profile byte limit");
    }
    let browser: Browser | undefined;
    try {
      try {
        browser = await chromium.launch({
          headless: true,
          ...(this.options.chromiumExecutablePath === undefined ? {} : { executablePath: this.options.chromiumExecutablePath }),
        });
      } catch (error) {
        throw gap("professional_media", "chromium_unavailable", "Playwright Chromium is unavailable", true);
      }
      const page = await browser.newPage();
      let dimensions: { width: number; height: number };
      try {
        try {
          const dataUrl = `data:image/png;base64,${Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64")}`;
          dimensions = await page.evaluate(async (source) => {
            const image = new Image();
            image.src = source;
            await image.decode();
            return { width: image.naturalWidth, height: image.naturalHeight };
          }, dataUrl);
        } catch (error) {
          throw gap("professional_media", "image_decode_failed", "Chromium could not decode the PNG bytes");
        }
      } finally {
        await page.close();
      }
      if (dimensions.width !== CHANNEL_PROFILES.xhs.width || dimensions.height !== CHANNEL_PROFILES.xhs.height) {
        throw gap("professional_media", "media_dimensions_mismatch", "PNG natural dimensions do not match the XHS profile");
      }
      return {
        status: "passed",
        profileId: CHANNEL_PROFILES.xhs.profileId,
        guarantee: "internal_acceptance_only",
        decoder: "playwright_chromium",
        width: dimensions.width,
        height: dimensions.height,
        durationMs: null,
        videoCodec: null,
        audioCodec: null,
      };
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw gap("professional_media", "chromium_unavailable", "Playwright Chromium execution failed", true);
    } finally {
      if (browser) {
        try {
          await browser.close();
        } catch (error) {
          throw gap("professional_media", "chromium_cleanup_failed", "Playwright Chromium cleanup failed");
        }
      }
    }
  }

  async validateChannelsMp4(bytes: Uint8Array): Promise<Mp4AssetValidation> {
    if (!this.options.ffprobeCommand) {
      throw probeGap("ffprobe_not_configured", "ffprobe is not configured");
    }
    if (bytes.byteLength < 1 || bytes.byteLength > CHANNEL_PROFILES.channels.maxBytes) {
      throw new DomainError("INVALID_INPUT", "MP4 bytes exceed the internal profile byte limit");
    }
    const directory = await mkdtemp(join(tmpdir(), "marketing-media-probe-"));
    try {
      const mediaPath = join(directory, "candidate.mp4");
      await writeFile(mediaPath, bytes, { flag: "wx", mode: 0o600 });
      const timeoutMs = this.options.ffprobeTimeoutMs ?? FFPROBE_TIMEOUT_MS;
      const versionOutput = await runFfprobe(this.options.ffprobeCommand, ["-version"], timeoutMs);
      const provenance = probeVersion(versionOutput.stdout);
      const inspection = await runFfprobe(this.options.ffprobeCommand, [
        "-v", "error",
        "-show_entries", "stream=codec_type,codec_name,width,height:format=duration",
        "-show_streams",
        "-show_format",
        "-of", "json",
        mediaPath,
      ], timeoutMs);
      let decoded: unknown;
      try {
        decoded = JSON.parse(inspection.stdout);
      } catch (error) {
        throw probeGap("ffprobe_invalid_response", "ffprobe returned malformed JSON");
      }
      const parsed = probeSchema.safeParse(decoded);
      if (!parsed.success) throw probeGap("ffprobe_invalid_response", "ffprobe returned an invalid inspection schema");
      const videos = parsed.data.streams.filter((stream) => stream.codec_type === "video");
      const audio = parsed.data.streams.filter((stream) => stream.codec_type === "audio");
      if (videos.length !== 1 || audio.length !== 1 || videos[0]!.codec_name !== "h264" || audio[0]!.codec_name !== "aac") {
        throw probeGap("media_codec_mismatch", "MP4 must contain exactly one H.264 video stream and one AAC audio stream");
      }
      if (videos[0]!.width !== CHANNEL_PROFILES.channels.width || videos[0]!.height !== CHANNEL_PROFILES.channels.height) {
        throw probeGap("media_dimensions_mismatch", "MP4 dimensions do not match the Channels profile");
      }
      if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(parsed.data.format.duration)) {
        throw probeGap("media_duration_mismatch", "MP4 duration is not finite and positive");
      }
      const durationSeconds = Number(parsed.data.format.duration);
      if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > 60) {
        throw probeGap("media_duration_mismatch", "MP4 duration must be greater than zero and at most 60 seconds");
      }
      const durationMs = Math.round(durationSeconds * 1_000);
      if (!Number.isSafeInteger(durationMs) || durationMs < 1 || durationMs > 60_000) {
        throw probeGap("media_duration_mismatch", "MP4 duration cannot be represented by the internal millisecond descriptor");
      }
      return {
        status: "passed",
        profileId: CHANNEL_PROFILES.channels.profileId,
        guarantee: "internal_acceptance_only",
        probe: "ffprobe",
        probeVersion: provenance,
        width: videos[0]!.width,
        height: videos[0]!.height,
        durationMs,
        videoCodec: "h264",
        audioCodec: "aac",
      };
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw probeGap("ffprobe_unavailable", "ffprobe inspection could not be completed", true);
    } finally {
      try {
        await rm(directory, { recursive: true, force: true });
      } catch (error) {
        throw probeGap("ffprobe_cleanup_failed", "Temporary ffprobe files could not be removed");
      }
    }
  }
}
