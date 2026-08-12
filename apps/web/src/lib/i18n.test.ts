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

test("localizes ledger identity and truthful scan removal in every supported locale", () => {
  const keys = [
    "scans.engine",
    "scans.model",
    "scans.total",
    "delete.description",
    "delete.folder",
    "delete.forever",
  ] as const;
  for (const locale of ["pt-BR", "en", "es", "de", "fr"] as const) {
    for (const key of keys) assert.notEqual(translate(locale, key), "");
    assert.match(translate(locale, "delete.description"), /reposit|repos|dépôt/i);
  }
  assert.equal(translate("pt-BR", "scans.engine"), "Motor");
  assert.equal(translate("en", "scans.total"), "Total");
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

test("localizes terminal connection errors and their retry action", () => {
  const retryByLocale = {
    "pt-BR": "Tentar novamente",
    en: "Try again",
    es: "Intentar de nuevo",
    de: "Erneut versuchen",
    fr: "Réessayer",
  } as const;
  for (const locale of ["pt-BR", "en", "es", "de", "fr"] as const) {
    assert.notEqual(translate(locale, "connections.error"), "");
    assert.equal(translate(locale, "common.retry"), retryByLocale[locale]);
  }
});

test("localizes the system readiness bench in every supported locale", () => {
  const keys = [
    "settings.title",
    "settings.refresh",
    "settings.engineRegistry",
    "settings.routePostureDescription",
    "settings.compatibilityDescription",
    "settings.ingestionDescription",
    "settings.reindexError",
  ] as const;
  for (const locale of ["pt-BR", "en", "es", "de", "fr"] as const) {
    for (const key of keys) assert.notEqual(translate(locale, key), "");
    assert.match(translate(locale, "settings.moduleCode"), /^07\.01 \/ /);
  }
  for (const locale of ["en", "es", "de", "fr"] as const) {
    assert.notEqual(translate(locale, "settings.refresh"), translate("pt-BR", "settings.refresh"));
    assert.notEqual(translate(locale, "settings.ingestionDescription"), translate("pt-BR", "settings.ingestionDescription"));
    assert.notEqual(translate(locale, "settings.reindexError"), translate("pt-BR", "settings.reindexError"));
  }
});

test("localizes remote guardrail enrollment, preflight, and policy authority", () => {
  const keys = [
    "guardrails.enrollTitle",
    "guardrails.enrollDescription",
    "guardrails.preflightTitle",
    "guardrails.preflightDescription",
    "guardrails.remoteTargetHelp",
    "guardrails.localTargetHelp",
    "guardrails.executorTitle",
    "guardrails.previewDescription",
    "guardrails.previewRequired",
    "guardrails.policyRemoteTitle",
    "guardrails.policyRemoteDescription",
    "guardrails.copyProposal",
    "guardrails.downloadProposal",
    "guardrails.pipelineSubtitle",
  ] as const;
  for (const locale of ["pt-BR", "en", "es", "de", "fr"] as const) {
    for (const key of keys) {
      assert.notEqual(translate(locale, key), "");
      if (locale !== "pt-BR") assert.notEqual(translate(locale, key), translate("pt-BR", key));
    }
  }
  assert.match(translate("en", "guardrails.remoteTargetHelp"), /implicit HEAD/i);
  assert.match(translate("de", "guardrails.policyRemoteDescription"), /GitHub-App/i);
  assert.match(translate("fr", "guardrails.previewDescription"), /dix minutes/i);
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
    "connections.operations.protocolUnsupported",
    "connections.operations.sessionExpired",
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

test("localizes safe connection save failures in every supported locale", () => {
  const saveErrorKeys = [
    "connections.saveError.sessionExpired",
    "connections.saveError.secureStorageUnavailable",
    "connections.saveError.credentialWriteFailed",
    "connections.saveError.stateInconsistent",
    "connections.saveError.invalidConnection",
  ] as const;
  for (const locale of ["pt-BR", "en", "es", "de", "fr"] as const) {
    for (const key of saveErrorKeys) {
      assert.notEqual(translate(locale, key), "");
      if (locale !== "pt-BR") assert.notEqual(translate(locale, key), translate("pt-BR", key));
    }
  }
});

test("localizes connection-aware scan routing in every supported locale", () => {
  const routingKeys = [
    "newScan.connectionRoute",
    "newScan.connectionHelp",
    "newScan.selectConnection",
    "newScan.connectionLoading",
    "newScan.connectionError",
    "newScan.connectionEmpty",
    "newScan.connectionRequired",
    "newScan.manageConnections",
    "newScan.connectionModelRequired",
    "newScan.runtimeDefault",
    "newScan.runtimeDefaultHelp",
    "newScan.modelLoading",
    "newScan.modelError",
    "newScan.modelEmpty",
    "newScan.selectModel",
    "newScan.compatibilityError",
    "newScan.compatibilityBlocked",
    "newScan.compatibilityLoading",
    "newScan.providerValidationHelp",
    "newScan.providerValidating",
    "newScan.providerValidationReady",
    "newScan.providerValidationFailed",
    "newScan.providerValidationError",
    "newScan.connectionReady",
    "newScan.connectionBlocked",
    "newScan.connectionCheck",
  ] as const;
  for (const locale of ["pt-BR", "en", "es", "de", "fr"] as const) {
    for (const key of routingKeys) {
      assert.notEqual(translate(locale, key), "");
      if (locale !== "pt-BR") assert.notEqual(translate(locale, key), translate("pt-BR", key));
    }
  }
  assert.equal(translate("en", "newScan.connectionRoute"), "EXECUTION CONNECTION");
  assert.equal(translate("de", "newScan.runtimeDefault"), "RUNTIME-STANDARD");
  assert.equal(translate("fr", "newScan.manageConnections"), "Gérer les connexions");
});

test("localizes Codex Security execution provenance and fail-closed Portable states", () => {
  const profileKeys = [
    "newScan.executionProfile",
    "newScan.profile.auto",
    "newScan.profile.native",
    "newScan.profile.portable",
    "newScan.profile.nativeReason",
    "newScan.profile.portableReason",
    "newScan.compatibilityPortableRequired",
    "newScan.compatibilityPortableStale",
    "newScan.compatibilityPortableFailed",
    "newScan.compatibilityPortableRunnerUnavailable",
    "scanDetail.executionProfile",
    "scanDetail.profileVersion",
    "scanDetail.methodologyRef",
    "scanDetail.protocol",
    "scanDetail.connectionAuth",
    "scanDetail.portableDisclosure",
    "report.executionProfile",
    "report.profileVersion",
    "report.methodologyRef",
    "report.protocol",
    "report.connectionAuth",
    "report.portableDisclosure",
    "compare.profileMismatch",
  ] as const;
  for (const locale of ["pt-BR", "en", "es", "de", "fr"] as const) {
    for (const key of profileKeys) {
      assert.notEqual(translate(locale, key), "");
    }
    if (locale !== "pt-BR") {
      assert.notEqual(translate(locale, "newScan.profile.auto"), translate("pt-BR", "newScan.profile.auto"));
      assert.notEqual(translate(locale, "newScan.profile.portableReason"), translate("pt-BR", "newScan.profile.portableReason"));
      assert.notEqual(translate(locale, "newScan.compatibilityPortableRunnerUnavailable"), translate("pt-BR", "newScan.compatibilityPortableRunnerUnavailable"));
    }
  }
  assert.equal(translate("en", "newScan.profile.native"), "Native");
  assert.equal(translate("en", "newScan.profile.portable"), "Portable");
  assert.equal(translate("pt-BR", "scanDetail.repeat"), "Repetir Portable");
  assert.equal(translate("en", "scanDetail.repeat"), "Retry Portable");
  assert.equal(translate("es", "scanDetail.repeat"), "Repetir Portable");
  assert.equal(translate("de", "scanDetail.repeat"), "Portable wiederholen");
  assert.equal(translate("fr", "scanDetail.repeat"), "Relancer Portable");
  assert.match(translate("en", "newScan.profile.portableReason"), /Sentinel/);
  assert.match(translate("en", "newScan.compatibilityPortableRunnerUnavailable"), /not available/i);
});
