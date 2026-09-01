import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { runAppleScript } from "@raycast/utils";

const execFileAsync = promisify(execFile);

const SIPS = "/usr/bin/sips";

/** Longest side sent to the API. DeepSeek scales images to roughly 800x800 for
 * billing anyway, so anything beyond this is wasted upload. */
const MAX_SIDE = 2048;

/** Refuse absurd source files before reading them into memory. */
const MAX_RAW_BYTES = 60 * 1024 * 1024;

/** DeepSeek caps the request body at 48 MiB; leave room for the prompt and JSON. */
export const MAX_B64_BYTES = 42 * 1024 * 1024;

export type ImageFormat = "jpeg" | "png" | "gif" | "webp" | "tiff" | "heic" | "bmp" | "unknown";

/** Formats DeepSeek accepts directly. Everything else has to go through sips. */
const API_FORMATS: ImageFormat[] = ["jpeg", "png", "gif", "webp"];

const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp|tiff?|heic|bmp)$/i;

export type NormalizedImage = {
  path: string;
  width: number;
  height: number;
  format: ImageFormat;
};

/**
 * Identifies an image by its magic bytes. DeepSeek sniffs the actual content
 * rather than trusting the filename, so we do the same — this also rejects
 * files with a misleading extension.
 */
export function sniffFormat(buffer: Buffer): ImageFormat {
  const ascii = (offset: number, length: number) => buffer.toString("ascii", offset, offset + length);

  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "jpeg";
  }

  if (
    buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return "png";
  }

  if (buffer.length >= 4 && ascii(0, 4) === "GIF8") {
    return "gif";
  }

  if (buffer.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") {
    return "webp";
  }

  if (
    buffer.length >= 4 &&
    ((buffer[0] === 0x49 && buffer[1] === 0x49 && buffer[2] === 0x2a && buffer[3] === 0x00) ||
      (buffer[0] === 0x4d && buffer[1] === 0x4d && buffer[2] === 0x00 && buffer[3] === 0x2a))
  ) {
    return "tiff";
  }

  if (buffer.length >= 12 && ascii(4, 4) === "ftyp" && ["heic", "heix", "hevc", "mif1", "msf1"].includes(ascii(8, 4))) {
    return "heic";
  }

  if (buffer.length >= 2 && buffer[0] === 0x42 && buffer[1] === 0x4d) {
    return "bmp";
  }

  return "unknown";
}

export function mimeForFormat(format: ImageFormat): string {
  switch (format) {
    case "png":
      return "image/png";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    default:
      // normalizeImage converts everything else to JPEG.
      return "image/jpeg";
  }
}

async function readHead(filePath: string): Promise<Buffer> {
  const handle = await fs.open(filePath, "r");

  try {
    const head = Buffer.alloc(16);
    const { bytesRead } = await handle.read(head, 0, 16, 0);
    return head.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** Cheap check for the detection chain: extension first, then magic bytes. */
export async function looksLikeImage(filePath: string): Promise<boolean> {
  if (!IMAGE_EXTENSIONS.test(filePath)) {
    return false;
  }

  try {
    return sniffFormat(await readHead(filePath)) !== "unknown";
  } catch {
    return false;
  }
}

/** Clipboard file paths arrive as either `file:///a/My%20Poster.png` or a bare path. */
export function normalizeFilePath(raw: string): string {
  let filePath = raw;

  if (filePath.startsWith("file://")) {
    filePath = filePath.slice("file://".length);
  }

  if (filePath.startsWith("localhost/")) {
    filePath = filePath.slice("localhost".length);
  }

  try {
    return decodeURIComponent(filePath);
  } catch {
    return filePath;
  }
}

export async function imageDimensions(filePath: string): Promise<{ width: number; height: number }> {
  const { stdout } = await execFileAsync(SIPS, ["-g", "pixelWidth", "-g", "pixelHeight", filePath]);

  return {
    width: Number(/pixelWidth:\s*(\d+)/.exec(stdout)?.[1] ?? NaN),
    height: Number(/pixelHeight:\s*(\d+)/.exec(stdout)?.[1] ?? NaN),
  };
}

/**
 * Converts formats DeepSeek cannot read and shrinks oversized images. Returns
 * the source untouched when it is already fine, to avoid a pointless re-encode.
 */
export async function normalizeImage(source: string, destinationDir: string): Promise<NormalizedImage> {
  const format = sniffFormat(await readHead(source));

  if (format === "unknown") {
    throw new Error("Unsupported image format.");
  }

  const stats = await fs.stat(source);

  if (stats.size > MAX_RAW_BYTES) {
    throw new Error("Image file is too large.");
  }

  const { width, height } = await imageDimensions(source);
  const needsConversion = !API_FORMATS.includes(format);
  const needsResize = Math.max(width, height) > MAX_SIDE;

  if (!needsConversion && !needsResize) {
    return { path: source, width, height, format };
  }

  await fs.mkdir(destinationDir, { recursive: true });
  const destination = path.join(destinationDir, `poster-${process.pid}-${Date.now()}.jpg`);

  const args = ["-s", "format", "jpeg", "-s", "formatOptions", "90"];
  if (needsResize) {
    args.push("-Z", String(MAX_SIDE)); // -Z preserves aspect ratio and only shrinks
  }
  args.push(source, "--out", destination);

  try {
    await execFileAsync(SIPS, args);
  } catch (error) {
    const stderr = error instanceof Error && "stderr" in error ? String(error.stderr).trim() : "";
    throw new Error(`Could not process image.${stderr ? ` ${stderr.slice(0, 160)}` : ""}`);
  }

  return { path: destination, ...(await imageDimensions(destination)), format: "jpeg" };
}

/**
 * Raycast's Clipboard API exposes only text, a file path, and HTML — never raw
 * image data — so a screenshot taken with Cmd+Ctrl+Shift+4 is invisible to it.
 * Probing the pasteboard types first avoids attempting a write that we know
 * would fail.
 */
export async function hasClipboardImage(): Promise<boolean> {
  try {
    const info = await runAppleScript("return (clipboard info) as text", { timeout: 5_000 });
    return /PNGf|TIFF/i.test(info);
  } catch {
    return false;
  }
}

const DUMP_CLIPBOARD_IMAGE = `
on run argv
  set destinationPath to item 1 of argv
  set imageData to the clipboard as «class PNGf»
  set outputFile to open for access (POSIX file destinationPath) with write permission
  try
    set eof of outputFile to 0
    write imageData to outputFile
    close access outputFile
  on error errorMessage
    close access outputFile
    error errorMessage
  end try
end run
`;

/** Writes the pasteboard image to `destinationPath`. Returns false when the
 * clipboard holds no image. */
export async function dumpClipboardImage(destinationPath: string): Promise<boolean> {
  if (!(await hasClipboardImage())) {
    return false;
  }

  try {
    await fs.mkdir(path.dirname(destinationPath), { recursive: true });
    await runAppleScript(DUMP_CLIPBOARD_IMAGE, [destinationPath], { timeout: 15_000 });

    const stats = await fs.stat(destinationPath);
    if (stats.size === 0) {
      return false;
    }

    // Guard against a truncated or mis-coerced write.
    return sniffFormat(await readHead(destinationPath)) !== "unknown";
  } catch (error) {
    console.debug("Could not read image from clipboard:", error);
    return false;
  }
}
