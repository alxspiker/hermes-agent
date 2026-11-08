// Durable per-stream cursor store for Photon/Spectrum catch-up across restarts.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const CURSOR_BRIDGE_SYMBOL = Symbol.for("hermes.photon.streamCursor");
export const CURSOR_TAG_KEY = "__hermesPhotonCursorCheckpoint";

function validCursor(value) {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return undefined;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? value : undefined;
}

function readState(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).flatMap(([label, cursor]) => {
        const valid = validCursor(cursor);
        return typeof label === "string" && label && valid !== undefined
          ? [[label, valid]]
          : [];
      })
    );
  } catch (error) {
    if (error?.code !== "ENOENT") {
      console.error(
        `photon-sidecar: ignoring unreadable cursor state ${filePath}: ${error?.message || error}`
      );
    }
    return {};
  }
}

function writeState(filePath, state) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`
  );
  let fd;
  try {
    fd = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(fd, JSON.stringify(state) + "\n", "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, filePath);
    fs.chmodSync(filePath, 0o600);
    try {
      const dirFd = fs.openSync(directory, "r");
      try {
        fs.fsyncSync(dirFd);
      } finally {
        fs.closeSync(dirFd);
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
}

export function createDurableCursorBridge(filePath) {
  const state = readState(filePath);
  const persist = () => writeState(filePath, state);
  return {
    load(label) {
      return validCursor(state[label]);
    },
    tag(label, cursor, values) {
      const valid = validCursor(cursor);
      if (!label || valid === undefined) return;
      if (!Array.isArray(values) || values.length === 0) {
        this.commit(label, valid);
        return;
      }
      const value = values[values.length - 1];
      const message = Array.isArray(value) ? value[1] : value;
      if (!message || typeof message !== "object") return;
      Object.defineProperty(message, CURSOR_TAG_KEY, {
        configurable: true,
        enumerable: true,
        value: { label, cursor: valid },
      });
    },
    commitTagged(message) {
      if (!message || typeof message !== "object") return;
      const checkpoint = message[CURSOR_TAG_KEY];
      if (!checkpoint) return;
      delete message[CURSOR_TAG_KEY];
      this.commit(checkpoint.label, checkpoint.cursor);
    },
    isTagged(message) {
      return Boolean(message && typeof message === "object" && message[CURSOR_TAG_KEY]);
    },
    commit(label, cursor) {
      const valid = validCursor(cursor);
      if (!label || valid === undefined) return;
      const previous = validCursor(state[label]);
      if (previous !== undefined && Number(valid) < Number(previous)) return;
      if (previous === valid) return;
      state[label] = valid;
      persist();
    },
    clear(label) {
      if (!label || !(label in state)) return;
      delete state[label];
      persist();
      console.error(
        `photon-sidecar: Spectrum rejected durable cursor for ${label}; accepting an event gap and resuming live`
      );
    },
  };
}
