import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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

function jpeg(width: number, height: number): Uint8Array {
  return execFileSync(ffmpeg, [
    "-v", "error",
    "-f", "lavfi",
    "-i", `color=c=blue:s=${width}x${height}`,
    "-frames:v", "1",
    "-c:v", "mjpeg",
    "-f", "image2pipe",
    "pipe:1",
  ], { maxBuffer: 8 * 1024 * 1024 });
}

function matroska(): Uint8Array {
  const directory = mkdtempSync(join(tmpdir(), "marketing-real-matroska-fixture-"));
  const path = join(directory, "fixture.mkv");
  try {
    execFileSync(ffmpeg, [
      "-v", "error", "-y",
      "-f", "lavfi",
      "-i", "color=c=red:s=1080x1920:r=1",
      "-f", "lavfi",
      "-i", "sine=frequency=1000:sample_rate=44100",
      "-t", "2",
      "-c:v", "libx264",
      "-preset", "ultrafast",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-f", "matroska",
      path,
    ], { maxBuffer: 24 * 1024 * 1024, timeout: 30_000 });
    return readFileSync(path);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function mov(): Uint8Array {
  const directory = mkdtempSync(join(tmpdir(), "marketing-real-mov-fixture-"));
  const path = join(directory, "fixture.mov");
  try {
    execFileSync(ffmpeg, [
      "-v", "error", "-y",
      "-f", "lavfi",
      "-i", "color=c=red:s=1080x1920:r=1",
      "-f", "lavfi",
      "-i", "sine=frequency=1000:sample_rate=44100",
      "-t", "2",
      "-c:v", "libx264",
      "-preset", "ultrafast",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-f", "mov",
      path,
    ], { maxBuffer: 24 * 1024 * 1024, timeout: 30_000 });
    return readFileSync(path);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
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

function majorBrand(bytes: Uint8Array): string {
  const directory = mkdtempSync(join(tmpdir(), "marketing-major-brand-probe-"));
  const path = join(directory, "fixture-media");
  try {
    writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
    const output = execFileSync(ffprobe, [
      "-v", "error",
      "-show_entries", "format_tags=major_brand",
      "-of", "json",
      path,
    ], { encoding: "utf8" });
    const parsed = JSON.parse(output) as { format: { tags: { major_brand: string } } };
    return parsed.format.tags.major_brand;
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

  it("rejects a real 1080x1440 JPEG despite matching decoded dimensions", async () => {
    await expectGap(new MediaValidator().validateXhsPng(jpeg(1080, 1440)), "professional_media", "media_format_mismatch");
  }, 20_000);

  it("reports missing Chromium and actual image decode failures explicitly", async () => {
    await expectGap(
      new MediaValidator({ chromiumExecutablePath: "/definitely/missing/chromium" }).validateXhsPng(png(1080, 1440)),
      "professional_media",
      "chromium_unavailable",
    );
    await expectGap(
      new MediaValidator().validateXhsPng(Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2, 3])),
      "professional_media",
      "image_decode_failed",
    );
  }, 20_000);

  it("accepts a real 2000ms 1080x1920 H264/AAC MP4 with a standard major brand and bounded provenance", async () => {
    const content = mp4({ duration: "2" });
    expect(majorBrand(content)).toBe("isom");
    const result = await new MediaValidator({ ffprobeCommand: ffprobe }).validateChannelsMp4(content);
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

  it("rejects real Matroska despite H264/AAC streams and matching dimensions", async () => {
    await expectGap(
      new MediaValidator({ ffprobeCommand: ffprobe }).validateChannelsMp4(matroska()),
      "video_probe",
      "media_format_mismatch",
    );
  }, 30_000);

  it("rejects real QuickTime MOV with major_brand qt despite the shared MP4 demuxer", async () => {
    const content = mov();
    expect(majorBrand(content)).toBe("qt  ");
    await expectGap(
      new MediaValidator({ ffprobeCommand: ffprobe }).validateChannelsMp4(content),
      "video_probe",
      "media_format_mismatch",
    );
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

  it("rejects a fractional duration above 60 seconds before millisecond rounding", async () => {
    const tempDir = await createTempDir();
    const probe = join(tempDir, "ffprobe-fractional-duration");
    try {
      writeFileSync(probe, `#!/bin/sh\nif [ "$1" = "-version" ]; then echo ffprobe-test-version; else echo '{"streams":[{"codec_type":"video","codec_name":"h264","width":1080,"height":1920},{"codec_type":"audio","codec_name":"aac"}],"format":{"duration":"60.0004","format_name":"mov,mp4,m4a,3gp,3g2,mj2","tags":{"major_brand":"isom"}}}'; fi\n`, { mode: 0o700 });
      await expectGap(
        new MediaValidator({ ffprobeCommand: probe }).validateChannelsMp4(mp4()),
        "video_probe",
        "media_duration_mismatch",
      );
    } finally {
      await removeTempDir(tempDir);
    }
  }, 30_000);

  it("kills a timed-out fake ffprobe and removes its temporary media file", async () => {
    const tempDir = await createTempDir();
    const probe = join(tempDir, "ffprobe-timeout");
    const pidFile = join(tempDir, "probe-pid");
    const mediaCapture = join(tempDir, "media-path");
    try {
      writeFileSync(probe, `#!/bin/sh\nif [ "$1" = "-version" ]; then echo ffprobe-test-version; exit 0; fi\nfor last in "$@"; do :; done\necho "$$" > "${pidFile}"\necho "$last" > "${mediaCapture}"\nwhile :; do :; done\n`, { mode: 0o700 });
      await expectGap(
        new MediaValidator({ ffprobeCommand: probe, ffprobeTimeoutMs: 1_000 }).validateChannelsMp4(mp4()),
        "video_probe",
        "ffprobe_timeout",
      );
      const pid = Number(readFileSync(pidFile, "utf8").trim());
      expect(() => process.kill(pid, 0)).toThrowError(expect.objectContaining({ code: "ESRCH" }));
      const mediaPath = readFileSync(mediaCapture, "utf8").trim();
      expect(existsSync(mediaPath)).toBe(false);
      expect(existsSync(dirname(mediaPath))).toBe(false);
    } finally {
      await removeTempDir(tempDir);
    }
  }, 5_000);

  it("bounds fake ffprobe output at 64 KiB and removes temporary files", async () => {
    const tempDir = await createTempDir();
    const probe = join(tempDir, "ffprobe-output-overflow");
    const mediaCapture = join(tempDir, "media-path");
    try {
      writeFileSync(probe, `#!/bin/sh\nif [ "$1" = "-version" ]; then echo ffprobe-test-version; exit 0; fi\nfor last in "$@"; do :; done\necho "$last" > "${mediaCapture}"\n/usr/bin/head -c 70000 /dev/zero\n`, { mode: 0o700 });
      await expectGap(
        new MediaValidator({ ffprobeCommand: probe }).validateChannelsMp4(mp4()),
        "video_probe",
        "ffprobe_output_too_large",
      );
      const mediaPath = readFileSync(mediaCapture, "utf8").trim();
      expect(existsSync(mediaPath)).toBe(false);
      expect(existsSync(dirname(mediaPath))).toBe(false);
    } finally {
      await removeTempDir(tempDir);
    }
  }, 5_000);
});
