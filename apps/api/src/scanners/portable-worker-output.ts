import fs from "node:fs";
import path from "node:path";
import type { Writable } from "node:stream";

/** A detached scan must not die when a development API reload closes its pipes. */
export function tolerateClosedWorkerPipe(stream: Writable): void {
  stream.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code !== "EPIPE" && error.code !== "ERR_STREAM_DESTROYED") throw error;
  });
}

export function appendPortableWorkerEvent(outputDir: string, redactedLine: string): void {
  const fd = fs.openSync(path.join(outputDir, "portable-worker-events.log"),
    fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(fd, `[stdout] ${redactedLine}\n`); }
  finally { fs.closeSync(fd); }
}
