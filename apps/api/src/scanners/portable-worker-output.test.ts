import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import test from "node:test";
import { appendPortableWorkerEvent, tolerateClosedWorkerPipe } from "./portable-worker-output.js";

test("closed API pipes do not terminate worker output and events remain on disk", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "worker-events-"));
  t.after(() => fs.rmSync(dir, { recursive: true }));
  const stream = new Writable({ write(_chunk, _encoding, callback) { callback(Object.assign(new Error("closed"), { code: "EPIPE" })); } });
  tolerateClosedWorkerPipe(stream);
  appendPortableWorkerEvent(dir, '{"type":"usage"}');
  stream.write("event");
  await new Promise<void>((resolve) => setImmediate(resolve));
  appendPortableWorkerEvent(dir, '{"type":"artifact"}');
  assert.equal(fs.readFileSync(path.join(dir, "portable-worker-events.log"), "utf8"), '[stdout] {"type":"usage"}\n[stdout] {"type":"artifact"}\n');
});
