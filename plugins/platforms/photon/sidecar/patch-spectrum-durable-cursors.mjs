#!/usr/bin/env node
// Patch Spectrum's in-memory resumable streams with Hermes' durable Photon
// cursor bridge. The bridge loads a per-stream cursor on construction, tags the
// final message of each item for sidecar acknowledgement, and clears a rejected
// cursor so a stale checkpoint cannot poison every future restart.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const MARKER = "Hermes patch: durable Photon stream cursors";
const REQUIRED_FRAGMENTS = [
  `Symbol.for("hermes.photon.streamCursor")`,
  "cursorBridge?.load(options.label)",
  "cursorBridge?.tag(options.label, item.cursor, alreadyDelivered ? [] : item.values)",
  "cursorBridge?.clear(options.label)",
];

function scriptDir() {
  return path.dirname(fileURLToPath(import.meta.url));
}

function replaceOnce(source, from, to, label) {
  const count = source.split(from).length - 1;
  if (count !== 1) {
    throw new Error(`expected exactly one ${label} match, found ${count}`);
  }
  return source.replace(from, to);
}

export function patchDurableCursors(root = scriptDir()) {
  const file = path.join(
    root,
    "node_modules",
    "@spectrum-ts",
    "core",
    "dist",
    "authoring.js"
  );
  if (!fs.existsSync(file)) {
    throw new Error(`@spectrum-ts/core authoring bundle not found: ${file}`);
  }
  const raw = fs.readFileSync(file, "utf8");
  if (raw.includes(MARKER)) {
    const missing = REQUIRED_FRAGMENTS.filter((fragment) => !raw.includes(fragment));
    if (missing.length) {
      throw new Error(`durable cursor patch marker is present but fragments are missing: ${missing.join(", ")}`);
    }
    return { patched: false, file, reason: "already patched" };
  }
  const CR = String.fromCharCode(13);
  const CRLF = CR + "\n";
  const usedCRLF = raw.includes(CRLF);
  let source = usedCRLF ? raw.split(CRLF).join("\n") : raw;

  source = replaceOnce(
    source,
    `const resumableOrderedStream = (options) => stream((emit, end) => {\n\tconst catchUpPageSize = options.catchUpPageSize ?? 100;`,
    `const resumableOrderedStream = (options) => stream((emit, end) => {\n\t// ${MARKER}\n\tconst cursorBridge = globalThis[Symbol.for("hermes.photon.streamCursor")];\n\tconst catchUpPageSize = options.catchUpPageSize ?? 100;`,
    "stream bridge initialization"
  );
  source = replaceOnce(
    source,
    `\tlet lastCursor;`,
    `\tlet lastCursor = cursorBridge?.load(options.label);`,
    "initial cursor"
  );
  source = replaceOnce(
    source,
    `\tconst deliverItem = async (item, resetRetry, clearOnCursorAdvance) => {\n\t\tif (!deliveredSinceCursor.has(item.id)) for (const value of item.values) await emit(value);`,
    `\tconst deliverItem = async (item, resetRetry, clearOnCursorAdvance) => {\n\t\tconst alreadyDelivered = deliveredSinceCursor.has(item.id);\n\t\tcursorBridge?.tag(options.label, item.cursor, alreadyDelivered ? [] : item.values);\n\t\tif (!alreadyDelivered) for (const value of item.values) await emit(value);`,
    "delivery acknowledgement tag"
  );
  source = replaceOnce(
    source,
    `\t\tif (error instanceof CursorRejectedError) {\n\t\t\tlastCursor = void 0;`,
    `\t\tif (error instanceof CursorRejectedError) {\n\t\t\tcursorBridge?.clear(options.label);\n\t\t\tlastCursor = void 0;`,
    "cursor rejection clear"
  );
  source = `// ${MARKER}\n${source}`;
  if (usedCRLF) source = source.split("\n").join(CRLF);
  const mode = fs.statSync(file).mode & 0o777;
  const temporary = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`
  );
  let fd;
  try {
    fd = fs.openSync(temporary, "wx", mode);
    fs.writeFileSync(fd, source, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, file);
    fs.chmodSync(file, mode);
    try {
      const directoryFd = fs.openSync(path.dirname(file), "r");
      try {
        fs.fsyncSync(directoryFd);
      } finally {
        fs.closeSync(directoryFd);
      }
    } catch {
      // Some platforms/filesystems do not support directory fsync.
    }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try {
      fs.unlinkSync(temporary);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return { patched: true, file };
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  try {
    const root = process.argv[2] ? path.resolve(process.argv[2]) : scriptDir();
    const result = patchDurableCursors(root);
    console.error(
      `photon-sidecar: Spectrum durable cursor patch ${result.patched ? "patched" : "ok"}: ${result.file}`
    );
  } catch (error) {
    console.error(
      `photon-sidecar: Spectrum durable cursor patch failed: ${error?.stack || error}`
    );
    process.exit(1);
  }
}
