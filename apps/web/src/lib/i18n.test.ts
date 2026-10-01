import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import ts from "typescript";
import { resolveLocale, translate } from "../i18n";
import { CONNECTION_PRESETS } from "./connection-presets";

test("resolves supported browser locale variants", () => {
  assert.equal(resolveLocale("pt-PT"), "pt-BR");
  assert.equal(resolveLocale("en-GB"), "en");
  assert.equal(resolveLocale("es-MX"), "es");
  assert.equal(resolveLocale("de-AT"), "de");
  assert.equal(resolveLocale("fr-CA"), "fr");
});

test("dashboard windows explicitly distinguish the preview from filtered totals in every language", () => {
  for (const locale of ["pt-BR", "en", "es", "de", "fr"] as const) {
    for (const key of ["dashboard.recentWindow", "dashboard.trendWindow"] as const) {
      const message = translate(locale, key, { shown: 100, total: 10000 });
      assert.ok(message.includes("100"));
      assert.ok(message.includes("10000"));
      assert.ok(!message.includes("{shown}") && !message.includes("{total}"));
      if (locale !== "pt-BR" && key === "dashboard.trendWindow") assert.notEqual(message, translate("pt-BR", key, { shown: 100, total: 10000 }));
    }
  }
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
    // Settings is nav module 08; its five sections are 08.01 to 08.05.
    assert.match(translate(locale, "settings.moduleCode"), /^08\.01 \/ /);
    assert.match(translate(locale, "connections.moduleCode"), /^08\.02 \/ /);
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
    "guardrails.authorityTitle",
    "guardrails.sourceTitle",
    "guardrails.githubChainTitle",
    "guardrails.executionQuestion",
    "guardrails.remoteTargetHelp",
    "guardrails.localTargetHelp",
    "guardrails.localIdentityPending",
    "guardrails.executorTitle",
    "guardrails.previewDescription",
    "guardrails.costInFlight",
    "guardrails.publicationIneligible",
    "guardrails.previewRequired",
    "guardrails.remoteAuthorityTitle",
    "guardrails.remoteAuthorityDescription",
    "guardrails.callerDescription",
    "guardrails.actionsStatus.caller_workflow_missing",
    "guardrails.localExecutionDescription",
    "guardrails.currentFolder",
    "guardrails.readingDirectories",
    "guardrails.manualPath",
    "guardrails.policyRemoteTitle",
    "guardrails.policyRemoteDescription",
    "guardrails.copyProposal",
    "guardrails.downloadProposal",
    "guardrails.scopeExecution",
    "guardrails.protectedBranches",
    "guardrails.maxCostHint",
    "guardrails.simulationTitle",
    "guardrails.confirmLocalWrite",
    "guardrails.configurationErrors",
    "guardrails.rulesTitle",
    "guardrails.ruleOrderHelp",
    "guardrails.requestReview",
    "guardrails.diffTitle",
    "guardrails.nextFile",
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

/**
 * The Guardrails tab's phase-2 copy. A key missing from a locale would fall back to
 * Portuguese in a German screenshot, which is the inconsistency the operator will
 * see first.
 */
test("localizes the repository list, the policy precedence and the baseline in five locales", () => {
  const keys = [
    "guardrails.baseline.absent",
    "guardrails.baseline.building",
    "guardrails.baseline.ready",
    "guardrails.baseline.stale",
    "guardrails.baseline.stale.scan_lineage",
    "guardrails.baseline.stale.protected_branch",
    "guardrails.baselineSectionTitle",
    "guardrails.baselineSectionDescription",
    "guardrails.baselineBuildNow",
    "guardrails.baselineBuildCost",
    "guardrails.baselineNoPushAction",
    "guardrails.baselineNotice.absent",
    "guardrails.baselineNotice.incompatible",
    "guardrails.baselineNotice.incompatible.scan_lineage",
    "guardrails.policySource.repository_file",
    "guardrails.policySource.sentinel",
    "guardrails.policySource.default",
    "guardrails.policySource.workspace",
    "guardrails.policySource.fileInvalid",
    "guardrails.policyFileBanner",
    "guardrails.policyFileInvalid",
    "guardrails.presetTitle",
    "guardrails.presetDescription",
    "guardrails.preset.block-critical-high",
    "guardrails.preset.block-critical-highDetail",
    "guardrails.preset.block-critical",
    "guardrails.preset.warn-only",
    "guardrails.preset.custom",
    "guardrails.preset.customDetail",
    "guardrails.repositoriesTitle",
    "guardrails.repositoriesDescription",
    "guardrails.repositoriesEmpty",
    "guardrails.repositoriesEmptyDescription",
    "guardrails.addRepositories",
    "guardrails.removeRepositoryConfirm",
    "guardrails.removeRepositoryBusy",
    "guardrails.enrollSelectTitle",
    "guardrails.enrollSelectDescription",
    "guardrails.enrollSkip.already_enrolled",
    "guardrails.enrollSkip.not_authorized",
    "guardrails.enrollSkip.archived",
    "guardrails.repositoryPageDescription",
    "guardrails.gateHistoryTitle",
    "guardrails.prCommentTitle",
    "guardrails.prCommentDescription",
    "guardrails.prCommentLanguage",
    "guardrails.prCommentLanguageHint",
    "guardrails.comment.absent",
    "guardrails.comment.published",
    "guardrails.comment.failed",
    "guardrails.openPullRequest",
    "guardrails.viewComment",
    "guardrails.republishComment",
    "guardrails.rulesSection",
    "guardrails.diffSection",
    "guardrails.effort",
    "guardrails.lifecycleValue.reopened",
    "guardrails.baselineBuildInFlight",
    "guardrails.baselineBuildExecutor",
    "guardrails.policyUnavailable",
    "guardrails.policyUnavailableDescription",
  ] as const;
  const placeholders = (value: string) => [...new Set(value.match(/\{\w+\}/g) ?? [])].sort();
  for (const locale of ["pt-BR", "en", "es", "de", "fr"] as const) {
    for (const key of keys) {
      assert.notEqual(translate(locale, key).trim(), "", `${locale}.${key}`);
      assert.deepEqual(placeholders(translate(locale, key)), placeholders(translate("pt-BR", key)), `${locale}.${key}`);
      // A sentence that merely inherited Portuguese is not a translation of it. Short
      // labels are exempt: Spanish and Portuguese really do share words like
      // "Ausente", and demanding a difference would force a worse translation.
      if (locale !== "pt-BR" && translate("pt-BR", key).length > 40) {
        assert.notEqual(translate(locale, key), translate("pt-BR", key), `${locale}.${key}`);
      }
    }
  }
  // The interpolated ones keep their variables.
  for (const locale of ["pt-BR", "en", "es", "de", "fr"] as const) {
    const removal = translate(locale, "guardrails.removeRepositoryTitle", { name: "OkamiOps/sentinel" });
    assert.ok(removal.includes("OkamiOps/sentinel"), locale);
    const selected = translate(locale, "guardrails.enrollSelected", { count: 3, total: 9 });
    assert.ok(selected.includes("3") && selected.includes("9"), locale);
    const result = translate(locale, "guardrails.enrollResult", { enrolled: 3, skipped: 1 });
    assert.ok(result.includes("3") && result.includes("1"), locale);
  }
  // Four distinct baseline words, so the list cannot say the same thing twice.
  for (const locale of ["pt-BR", "en", "es", "de", "fr"] as const) {
    const words = (["absent", "building", "ready", "stale"] as const)
      .map((state) => translate(locale, `guardrails.baseline.${state}` as typeof keys[number]));
    assert.equal(new Set(words).size, 4, locale);
  }
});

test("no catalogue promises an internal phase", () => {
  // Our release plan is not a product fact. A sentence that says "arrives in phase 2"
  // is a note to ourselves printed on the operator's screen, and it ages into a lie.
  // The check reads the catalogues as text, so it covers every locale and every key
  // name without needing a list that someone must remember to extend.
  const phases = /\b(fase|phase|phasen)\s*\d/i;
  const directory = new URL("../i18n/", import.meta.url);
  const files = [
    new URL("../i18n.tsx", import.meta.url),
    ...readdirSync(directory)
      .filter((name) => name.endsWith(".ts"))
      .map((name) => new URL(name, directory)),
  ];
  for (const file of files) {
    for (const literal of readFileSync(file, "utf8").match(/"[^"\n]*"/g) ?? []) {
      assert.equal(phases.test(literal), false, `${file.pathname}: ${literal}`);
    }
  }
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


test("core scan flows declare every translation explicitly and retain placeholders", () => {
  const source = ts.createSourceFile("i18n.tsx", readFileSync(new URL("../i18n.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const declared = new Map<string, Set<string>>();
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      let initializer = node.initializer;
      if (ts.isAsExpression(initializer) || ts.isSatisfiesExpression(initializer)) initializer = initializer.expression;
      if (ts.isObjectLiteralExpression(initializer)) {
        declared.set(node.name.text, new Set(initializer.properties.flatMap((property) =>
          ts.isPropertyAssignment(property) && ts.isStringLiteral(property.name) ? [property.name.text] : [])));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  const criticalErrors = new Set(["common.apiUnavailable", "common.apiInvalidResponse", "common.apiEmptyResponse", "common.requestFailed", "shell.engineChecking", "shell.apiOffline", "shell.lastUpdated"]);
  const keys = [...declared.get("ptBR")!].filter((key) => /^(scans|scanDetail|compare)\./.test(key) || criticalErrors.has(key)) as Array<Parameters<typeof translate>[1]>;
  assert.ok(keys.length > 100, "The audit must include the full critical-flow catalogue");
  const placeholders = (value: string) => [...new Set(value.match(/\{\w+\}/g) ?? [])].sort();
  for (const locale of ["en", "es", "de", "fr"] as const) {
    // Inheriting English or Portuguese is convenient for legacy pages but is
    // not a translation of these user-facing flows. Identical terms such as
    // PID remain valid when explicitly supplied by that locale.
    const explicit = new Set([...declared.get(locale)!, ...declared.get(`${locale}Ui`)!]);
    assert.deepEqual(keys.filter((key) => !explicit.has(key)), [], `${locale}: missing explicit critical-flow translations`);
    for (const key of keys) {
      assert.ok(translate(locale, key).trim(), `${locale}.${key} must be readable`);
      assert.deepEqual(placeholders(translate(locale, key)), placeholders(translate("pt-BR", key)), `${locale}.${key}: interpolation mismatch`);
    }
  }
});


test("gate details localize operational outcomes and publication without claiming an uncommitted snapshot", () => {
  const expected = { "pt-BR": "Sem mudanças", en: "No changes", es: "Sin cambios", de: "Keine Änderungen", fr: "Aucun changement" } as const;
  for (const locale of ["pt-BR", "en", "es", "de", "fr"] as const) {
    assert.equal(translate(locale, "guardrails.outcome.no_changes"), expected[locale]);
    assert.match(translate(locale, "guardrails.localTargetHelp"), /HEAD/);
    assert.ok(!translate(locale, "guardrails.localTargetHelp").includes("content:"));
    if (locale !== "pt-BR") {
      for (const key of ["guardrails.publishTitle", "guardrails.publishDetail", "guardrails.publishConfirmDetail", "guardrails.status.completed", "guardrails.noCausalEvidence"] as const) {
        assert.notEqual(translate(locale, key), translate("pt-BR", key));
      }
    }
  }
});

test("protected-branch bootstrap copy names the branch and does not send the operator elsewhere", () => {
  for (const locale of ["pt-BR", "en", "es", "de", "fr"] as const) {
    const established = translate(locale, "guardrails.bootstrapProtected", { branch: "main" });
    const missing = translate(locale, "guardrails.bootstrapMissing", { branch: "main" });
    assert.ok(established.includes("main"), `${locale} established copy must name main`);
    assert.ok(missing.includes("main"), `${locale} missing copy must name main`);
    assert.notEqual(established, missing);
    assert.ok(!established.includes("{branch}"));
    assert.ok(!missing.includes("{branch}"));
  }
  assert.match(translate("pt-BR", "guardrails.bootstrapProtected", { branch: "main" }), /referência/);
  assert.match(translate("en", "guardrails.bootstrapMissing", { branch: "main" }), /Run the gate on main/);
});

/**
 * The GitHub tab's catalogue is scoped, so the global audit above never sees it.
 * Every key has to exist in all five locales with the same placeholders: a missing
 * one would fall back to Portuguese in a German screenshot, which is exactly the
 * inconsistency the operator called grotesque.
 */
test("the GitHub tab is translated key-for-key in five locales", async () => {
  const { githubActionsMessages } = await import("../i18n/github-actions");
  const locales = ["pt-BR", "en", "es", "de", "fr"] as const;
  const reference = Object.keys(githubActionsMessages["pt-BR"]).sort();
  assert.ok(reference.length > 150, "the GitHub catalogue looks truncated");
  const placeholders = (value: string) => [...new Set(value.match(/\{\w+\}/g) ?? [])].sort();
  for (const locale of locales) {
    assert.deepEqual(Object.keys(githubActionsMessages[locale]).sort(), reference, `${locale}: key set differs`);
    for (const key of reference as Array<keyof typeof githubActionsMessages["pt-BR"]>) {
      const message = githubActionsMessages[locale][key];
      assert.ok(message.trim().length > 0, `${locale}.${key} is empty`);
      assert.deepEqual(
        placeholders(message),
        placeholders(githubActionsMessages["pt-BR"][key]),
        `${locale}.${key}: interpolation mismatch`,
      );
    }
  }
  // The copy the carries pin, in the language the operator reads.
  assert.match(githubActionsMessages["pt-BR"]["github.delivery.stale"], /sem evento recente/i);
  assert.match(githubActionsMessages["pt-BR"]["github.delivery.pingHint"], /ping/i);
  assert.match(githubActionsMessages.de["github.caller.check.secret_present"], /OPENAI_API_KEY/);
  // Every state has its own sentence; two of them must not read the same.
  const states = ["not_ready", "unknown", "none", "suspended"] as const;
  for (const locale of locales) {
    const details = states.map((state) => githubActionsMessages[locale][`github.installationsState.${state}Detail`]);
    assert.equal(new Set(details).size, states.length, `${locale}: two installation states share a sentence`);
  }
  // A locale that merely copied Portuguese is not a translation of these.
  for (const locale of ["en", "es", "de", "fr"] as const) {
    for (const key of ["github.description", "github.checklistTitle", "github.reason.fork_pull_request", "github.actions.dayBudgetHint"] as const) {
      assert.notEqual(githubActionsMessages[locale][key], githubActionsMessages["pt-BR"][key], `${locale}.${key}`);
    }
  }
});
