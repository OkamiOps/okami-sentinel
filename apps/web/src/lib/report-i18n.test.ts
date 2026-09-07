import assert from "node:assert/strict";
import test from "node:test";
import { translate, type Locale } from "../i18n";
import { translateScoped } from "../i18n/scoped";
import { scanReportMessages } from "../i18n/scan-report";
import { compareReportMessages } from "../i18n/compare-report";
import { reportCommonMessages } from "../i18n/report-common";

const placeholders = (message: string) => [...new Set(message.match(/\{\w+\}/g) ?? [])].sort();
for (const [name, messages] of Object.entries({ scan: scanReportMessages, compare: compareReportMessages, common: reportCommonMessages })) {
  test(`${name} report translations cover all five languages and preserve dynamic fields`, () => {
    const source = messages["pt-BR"];
    assert.deepEqual(Object.keys(messages).sort(), ["de", "en", "es", "fr", "pt-BR"]);
    for (const [locale, dictionary] of Object.entries(messages)) {
      assert.deepEqual(Object.keys(dictionary).sort(), Object.keys(source).sort());
      for (const [key, text] of Object.entries(dictionary as Record<string, string>)) {
        assert.ok(text.trim(), `${locale}: ${key} must not be empty`);
        assert.deepEqual(placeholders(text), placeholders(source[key as keyof typeof source]), `${locale}: ${key}`);
      }
    }
  });
}

test("scoped report translations interpolate original names and retain shared translations", () => {
  for (const locale of Object.keys(scanReportMessages) as Locale[]) {
    const title = translateScoped(scanReportMessages, locale, "scanReport.documentTitle", { name: "Original repository" });
    assert.ok(title.includes("Original repository"));
    assert.equal(title.includes("{name}"), false);
    assert.equal(translateScoped(scanReportMessages, locale, "common.retry"), translate(locale, "common.retry"));
  }
});
