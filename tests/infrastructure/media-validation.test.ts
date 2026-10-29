import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { DomainError } from "../../src/domain/errors.js";
import { MediaValidator } from "../../src/infrastructure/media-validation.js";
import { createTempDir, removeTempDir } from "../helpers.js";

const ffmpeg = process.env.MARKETING_TEST_FFMPEG ?? "/opt/homebrew/bin/ffmpeg";
const ffprobe = process.env.MARKETING_TEST_FFPROBE ?? "/opt/homebrew/bin/ffprobe";

function png(width: number, height: number): Uint8Array {
  return execFileSync(ffmpeg, [
    "-v", "error",
    "-f", "lavfi",
    "-i", `color=c=blue:s=${width}x${height}`,
    "-frames:v", "1",
    "-c:v", "png",
    "-f", "image2pipe",
    "pipe:1",
  ], { maxBuffer: 8 * 1024 * 1024 });
}

function mp4(options: { duration?: string; width?: number; audio?: boolean; videoCodec?: string } = {}): Uint8Array {
  const width = options.width ?? 1080;
  const audio = options.audio ?? true;
  const directory = mkdtempSync(join(tmpdir(), "marketing-real-video-fixture-"));
  const path = join(directory, "fixture.mp4");
  try {
    execFileSync(ffmpeg, [
      "-v", "error", "-y",
      "-f", "lavfi",
      "-i", `color=c=red:s=${width}x1920:r=1`,
      ...(audio ? ["-f", "lavfi", "-i", "sine=frequency=1000:sample_rate=44100"] : []),
      "-t", options.duration ?? "2",
      "-c:v", options.videoCodec ?? "libx264",
      "-preset", "ultrafast",
      "-pix_fmt", "yuv420p",
      ...(audio ? ["-c:a", "aac"] : []),
      "-video_track_timescale", "1000",
      path,
    ], { maxBuffer: 24 * 1024 * 1024, timeout: 30_000 });
    return readFileSync(path);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

async function expectGap(promise: Promise<unknown>, capability: string, reason: string): Promise<void> {
  await expect(promise).rejects.toMatchObject<DomainError>({
    code: "CAPABILITY_UNAVAILABLE",
    details: { capability, reason },
  });
}

describe("real Playwright and ffprobe media validators", () => {
  it("requires the real test-only media executables rather than skipping video checks", () => {
    expect(existsSync(ffmpeg), `MARKETING_TEST_FFMPEG executable missing: ${ffmpeg}`).toBe(true);
    expect(existsSync(ffprobe), `MARKETING_TEST_FFPROBE executable missing: ${ffprobe}`).toBe(true);
  });

  it("decodes a real 1080x1440 PNG through Chromium img.decode", async () => {
    const result = await new MediaValidator().validateXhsPng(png(1080, 1440));
    expect(result).toEqual({
      status: "passed",
      profileId: "xhs_png_1080x1440_v1",
      guarantee: "internal_acceptance_only",
      decoder: "playwright_chromium",
      width: 1080,
      height: 1440,
      durationMs: null,
      videoCodec: null,
      audioCodec: null,
    });
  }, 20_000);

  it("rejects a real 1440x1080 PNG using decoded natural dimensions", async () => {
    await expectGap(new MediaValidator().validateXhsPng(png(1440, 1080)), "professional_media", "media_dimensions_mismatch");
  }, 20_000);

  it("reports missing Chromium and actual image decode failures explicitly", async () => {
    await expectGap(
      new MediaValidator({ chromiumExecutablePath: "/definitely/missing/chromium" }).validateXhsPng(png(1080, 1440)),
      "professional_media",
      "chromium_unavailable",
    );
    await expectGap(new MediaValidator().validateXhsPng(Uint8Array.from([0, 1, 2, 3])), "professional_media", "image_decode_failed");
  }, 20_000);

  it("accepts a real 2000ms 1080x1920 H264/AAC MP4 and records bounded ffprobe provenance", async () => {
    const result = await new MediaValidator({ ffprobeCommand: ffprobe }).validateChannelsMp4(mp4({ duration: "2" }));
    expect(result).toMatchObject({
      status: "passed",
      profileId: "channels_mp4_1080x1920_h264_aac_v1",
      guarantee: "internal_acceptance_only",
      probe: "ffprobe",
      width: 1080,
      height: 1920,
      durationMs: 2_000,
      videoCodec: "h264",
      audioCodec: "aac",
    });
    expect(result.probeVersion.length).toBeGreaterThan(0);
    expect(result.probeVersion.length).toBeLessThanOrEqual(256);
  }, 30_000);

  it("rejects real wrong-width video", async () => {
    await expectGap(
      new MediaValidator({ ffprobeCommand: ffprobe }).validateChannelsMp4(mp4({ width: 1082 })),
      "video_probe",
      "media_dimensions_mismatch",
    );
  }, 30_000);

  it("rejects real H264 video without AAC audio", async () => {
    await expectGap(
      new MediaValidator({ ffprobeCommand: ffprobe }).validateChannelsMp4(mp4({ audio: false })),
      "video_probe",
      "media_codec_mismatch",
    );
  }, 30_000);

  it("rejects a real 60001ms video", async () => {
    await expectGap(
      new MediaValidator({ ffprobeCommand: ffprobe }).validateChannelsMp4(mp4({ duration: "60.001" })),
      "video_probe",
      "media_duration_mismatch",
    );
  }, 40_000);

  it("rejects a real non-H264 video codec", async () => {
    await expectGap(
      new MediaValidator({ ffprobeCommand: ffprobe }).validateChannelsMp4(mp4({ videoCodec: "mpeg4" })),
      "video_probe",
      "media_codec_mismatch",
    );
  }, 30_000);

  it("reports unconfigured and unavailable ffprobe explicitly", async () => {
    await expectGap(new MediaValidator().validateChannelsMp4(mp4()), "video_probe", "ffprobe_not_configured");
    await expectGap(
      new MediaValidator({ ffprobeCommand: "/definitely/missing/ffprobe" }).validateChannelsMp4(mp4()),
      "video_probe",
      "ffprobe_unavailable",
    );
  }, 30_000);

  it("rejects malformed probe JSON and bounds version provenance", async () => {
    const tempDir = await createTempDir();
    const malformed = join(tempDir, "ffprobe-malformed");
    const hugeVersion = join(tempDir, "ffprobe-huge-version");
    try {
      writeFileSync(malformed, `#!/bin/sh\nif [ "$1" = "-version" ]; then echo ffprobe-test-version; else echo '{not-json'; fi\n`, { mode: 0o700 });
      writeFileSync(hugeVersion, `#!/bin/sh\nif [ "$1" = "-version" ]; then head -c 300 /dev/zero | tr '\\0' x; else echo '{"streams":[],"format":{"duration":"1"}}'; fi\n`, { mode: 0o700 });
      chmodSync(malformed, 0o700);
      chmodSync(hugeVersion, 0o700);
      await expectGap(new MediaValidator({ ffprobeCommand: malformed }).validateChannelsMp4(mp4()), "video_probe", "ffprobe_invalid_response");
      await expectGap(new MediaValidator({ ffprobeCommand: hugeVersion }).validateChannelsMp4(mp4()), "video_probe", "ffprobe_invalid_response");
    } finally {
      await removeTempDir(tempDir);
    }
  }, 30_000);
});
