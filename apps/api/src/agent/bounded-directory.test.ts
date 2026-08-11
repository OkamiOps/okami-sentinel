import assert from "node:assert/strict";
import test from "node:test";

import { collectBounded } from "./bounded-directory.js";

test("bounded directory collection stops after the truncation sentinel", async () => {
  let pulled = 0;
  async function* entries(): AsyncGenerator<number> {
    for (let index = 0; index < 10_000; index += 1) {
      pulled += 1;
      yield index;
    }
  }

  const result = await collectBounded(entries(), 3);

  assert.deepEqual(result, { entries: [0, 1, 2], truncated: true });
  assert.equal(pulled, 4);
});
