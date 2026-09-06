import assert from "node:assert/strict";
import test from "node:test";

import { ApiError, formatApiError, parseApiResponse } from "./http.js";
import { translate, type Locale } from "../i18n.js";

test("describes an empty HTTP 500 response", async () => {
  await assert.rejects(
    () => parseApiResponse(new Response("", { status: 500 })),
    (error: unknown) => error instanceof ApiError && error.status === 500
      && error.message === "API indisponível (HTTP 500)"
      && formatApiError(error, (key, values) => translate("pt-BR", key, values)) === "API indisponível (HTTP 500)",
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
    (error: unknown) => error instanceof ApiError && error.kind === "invalid",
  );
  await assert.rejects(
    () => parseApiResponse(new Response(null, { status: 204 })),
    (error: unknown) => error instanceof ApiError && error.kind === "empty",
  );
});

test("localizes transport failures in every supported locale and preserves business errors", () => {
  for (const locale of ["pt-BR", "en", "es", "de", "fr"] as Locale[]) {
    const t = (key: Parameters<typeof translate>[1], values?: Record<string, string | number>) => translate(locale, key, values);
    assert.equal(formatApiError(new TypeError("Failed to fetch"), t), t("common.requestFailed"));
    assert.equal(formatApiError(new ApiError("invalid_api_response", "invalid", 200), t), t("common.apiInvalidResponse"));
    assert.equal(formatApiError(new ApiError("empty_api_response", "empty", 204), t), t("common.apiEmptyResponse"));
    assert.equal(formatApiError(new ApiError("Concurrent scan limit reached", "http", 409), t), "Concurrent scan limit reached");
  }
});
