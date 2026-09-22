import assert from "node:assert/strict";
import test from "node:test";

import { localizeOperatorText } from "../i18n/operator-text.js";
import { formatApiError, ApiError } from "./http.js";
import { translate } from "../i18n.js";

test("translates known Portuguese API sentences without changing stable codes", () => {
  assert.equal(localizeOperatorText("Scan não encontrado", "en"), "Scan not found");
  assert.equal(localizeOperatorText("Scan não encontrado", "de"), "Scan nicht gefunden");
  assert.equal(localizeOperatorText("Scan não encontrado", "fr"), "Scan introuvable");
  assert.equal(localizeOperatorText("repository_already_registered", "en"), "repository_already_registered");
  assert.equal(
    localizeOperatorText("Remote GitHub acme/sentinel disponível.", "es"),
    "Remoto de GitHub acme/sentinel disponible.",
  );
  assert.equal(
    formatApiError(new ApiError("Gate não encontrado", "http", 404), (key) => translate("pt-BR", key)),
    "Gate não encontrado",
  );
});
