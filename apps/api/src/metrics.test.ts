import assert from "node:assert/strict";
import test from "node:test";

import { measuredTokenCounts } from "./metrics.js";

test("counts measured tokens even when pricing is unavailable", () => {
  assert.deepEqual(measuredTokenCounts({
    cost: null,
    usage: {
      inputTokens: 1_250,
      cachedInputTokens: 250,
      cacheWriteInputTokens: null,
      outputTokens: 75,
    },
  }), { inputTokens: 1_250, outputTokens: 75 });
});
