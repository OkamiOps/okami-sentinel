import assert from "node:assert/strict";
import test from "node:test";
import { resolveLocale, translate } from "../i18n";

test("resolves supported browser locale variants", () => {
  assert.equal(resolveLocale("pt-PT"), "pt-BR");
  assert.equal(resolveLocale("en-GB"), "en");
  assert.equal(resolveLocale("es-MX"), "es");
  assert.equal(resolveLocale("de-AT"), "de");
  assert.equal(resolveLocale("fr-CA"), "fr");
});

test("falls back to pt-BR and interpolates variables", () => {
  assert.equal(resolveLocale("ja-JP"), "pt-BR");
  assert.equal(translate("de", "compare.run", { count: 6 }), "6 SCANS VERGLEICHEN");
});

test("translates the connection workbench in every supported locale", () => {
  assert.equal(translate("pt-BR", "connections.title"), "Rotas de conexão");
  assert.equal(translate("en", "connections.title"), "Connection routes");
  assert.equal(translate("es", "connections.title"), "Rutas de conexión");
  assert.equal(translate("de", "connections.title"), "Verbindungsrouten");
  assert.equal(translate("fr", "connections.title"), "Routes de connexion");
  assert.equal(translate("pt-BR", "connections.transport.local-cli"), "CLI local");
  assert.equal(translate("de", "connections.status.ready"), "Bereit");
  assert.equal(translate("fr", "connections.auth.existing-session"), "Session locale existante");
});
