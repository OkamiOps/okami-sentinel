import assert from "node:assert/strict";
import test from "node:test";

import { parseApiResponse } from "./http.js";

test("describes an empty HTTP 500 response", async () => {
  await assert.rejects(
    () => parseApiResponse(new Response("", { status: 500 })),
    /API indisponível \(HTTP 500\)/,
  );
});

test("uses a structured API error", async () => {
  await assert.rejects(
    () => parseApiResponse(new Response(
      JSON.stringify({ error: "Referência main não encontrada" }),
      { status: 400 },
    )),
    /Referência main não encontrada/,
  );
});

test("rejects invalid and empty successful responses", async () => {
  await assert.rejects(
    () => parseApiResponse(new Response("not-json", { status: 200 })),
    /resposta inválida/,
  );
  await assert.rejects(
    () => parseApiResponse(new Response(null, { status: 204 })),
    /resposta vazia/,
  );
});
