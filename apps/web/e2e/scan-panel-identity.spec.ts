import { expect, test } from "@playwright/test";
import { mockApi } from "./fixtures";

test("Files and metrics keep separate identities across detail updates", async ({ page }) => {
  await mockApi(page);
  const keyErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && /same key/.test(message.text())) keyErrors.push(message.text());
  });
  await page.goto("/scans/scan-one?view=files");
  const progress = page.getByRole("heading", { name: "Analysis progress", exact: true });
  await expect(progress).toHaveCount(1);
  // Toggling siblings forces reconciliation: shared scan-ID keys used to leave
  // abandoned metric panels behind on each detail/context update.
  for (let index = 0; index < 4; index += 1) {
    await page.getByRole("button", { name: /^04 \/ Profile$/i }).click();
    await expect(progress).toHaveCount(1);
    await page.getByRole("button", { name: /^03 \/ Files$/i }).click();
    await expect(progress).toHaveCount(1);
  }
  expect(keyErrors).toEqual([]);
});
