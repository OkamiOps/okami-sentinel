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

test("localizes every connection inspector operation without falling back to Portuguese", () => {
  const operationKeys = [
    "connections.operations.title",
    "connections.operations.inspect",
    "connections.operations.authenticate",
    "connections.operations.disconnect",
    "connections.operations.cancelAuth",
    "connections.operations.inspectionReady",
    "connections.operations.inspectionUnavailable",
    "connections.operations.authPending",
    "connections.operations.authCancelled",
    "connections.operations.disconnected",
    "connections.operations.disconnectRevoked",
    "connections.operations.disconnectLocalRemoved",
    "connections.operations.disconnectRevokePending",
    "connections.operations.disconnectNotSupported",
    "connections.operations.modelsUpdated",
    "connections.operations.modelsUnavailable",
    "connections.operations.probePassed",
    "connections.operations.probeFailed",
    "connections.operations.noModels",
    "connections.operations.error",
    "connections.operations.authCompleted",
    "connections.operations.authExpired",
    "connections.operations.authDenied",
    "connections.operations.authFailed",
    "connections.operations.authFlow",
    "connections.operations.openAuth",
    "connections.operations.userCode",
    "connections.operations.expiresAt",
    "connections.operations.modelCatalog",
    "connections.operations.modelCatalogHelp",
    "connections.operations.refreshModels",
    "connections.operations.selectModel",
    "connections.operations.probe",
  ] as const;
  for (const locale of ["pt-BR", "en", "es", "de", "fr"] as const) {
    for (const key of operationKeys) assert.notEqual(translate(locale, key), "");
  }
  assert.equal(translate("en", "connections.operations.inspect"), "Inspect / test");
  assert.equal(translate("es", "connections.operations.modelCatalog"), "Catálogo de modelos");
  assert.equal(translate("de", "connections.operations.authFailed"), "Authentifizierung fehlgeschlagen.");
  assert.equal(translate("fr", "connections.operations.openAuth"), "Ouvrir la page d’authentification sécurisée");
});
