import assert from "node:assert/strict";
import test from "node:test";
import { resolveLocale, translate } from "../i18n";
import { CONNECTION_PRESETS } from "./connection-presets";

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

test("localizes every provider preset label and its critical setup guidance", () => {
  const customBundleKeys = [
    "connections.preset.customBundleRequiredHelp",
    "connections.preset.customBundleReplacementWarning",
    "connections.draftError.customEndpoint",
    "connections.draftError.customReplacement",
  ] as const;
  for (const locale of ["pt-BR", "en", "es", "de", "fr"] as const) {
    for (const preset of CONNECTION_PRESETS) {
      assert.notEqual(translate(locale, preset.labelKey), "");
    }
    for (const key of customBundleKeys) {
      assert.notEqual(translate(locale, key), "");
    }
  }

  assert.equal(translate("en", "connections.preset.openai-chatgpt-browser-oauth"), "ChatGPT subscription · browser");
  assert.equal(translate("es", "connections.preset.chooseMimoRegion"), "Elegir una región");
  assert.equal(translate("de", "connections.draftError.mimoRegion"), "Wähle vor dem Ersetzen des Zugangs eine MiMo-Token-Plan-Region.");
  assert.equal(translate("fr", "connections.preset.mimoRegionUpdateHelp"), "Choisissez explicitement une région avant de remplacer un identifiant Token Plan existant.");
  assert.equal(translate("en", "connections.preset.customBundleReplacementWarning"), "While editing, any sensitive field replaces the entire bundle. Enter the base URL and an API key or header again.");
});
