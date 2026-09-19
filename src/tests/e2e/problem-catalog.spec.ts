import { expect, test } from "@playwright/test";
import { LEVELS } from "@/content/levels";
import { LEVEL_SOLUTIONS } from "@/content/levels/solutions";

test.describe.configure({ retries: 0 });

// Every published problem goes through the same editor/apply/submit/history path.
for (const level of LEVELS) {
  test(`published problem: ${level.slug}`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => {
      // Match Monaco's isCancellationError contract for obsolete model work.
      // Restrict the exclusion to the pinned vendor stack; every other page error
      // still fails the test, with its full stack available for diagnosis.
      if (
        error.name === "Canceled" &&
        error.message === "Canceled" &&
        error.stack?.includes("/monaco-editor@0.55.1/")
      )
        return;
      errors.push(error.stack ?? error.message);
    });
    await page.goto(`/problems/${level.slug}`);
    await expect(page.getByText("Scenario ready", { exact: true })).toBeVisible({
      timeout: 60_000,
    });
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    for (const [path, source] of Object.entries(LEVEL_SOLUTIONS[level.slug]!.files)) {
      await page.getByRole("tab", { name: path, exact: true }).click();
      await expect(page.locator(".monaco-editor").first()).toBeVisible();
      // Focus Monaco's input, not the surrounding container/minimap. Keep the edit
      // itself on the keyboard path so onChange and draft persistence are exercised.
      await page.evaluate(() => {
        (window as any).monaco.editor.getEditors()[0].focus();
      });
      await page.keyboard.press("ControlOrMeta+a");
      // A clipboard paste preserves multiline YAML indentation. insertText is
      // treated as typing by Monaco's edit context and applies auto-indent.
      await page.evaluate((text) => navigator.clipboard.writeText(text), source);
      await page.keyboard.press("ControlOrMeta+v");
      await expect
        .poll(() =>
          page.evaluate(() => (window as any).monaco.editor.getEditors()[0].getModel().getValue()),
        )
        .toBe(source);
    }
    const build = level.challengeMode === "build";
    await page
      .getByRole("button", { name: build ? "Run Static Review" : "Apply Changes", exact: true })
      .click();
    await expect(async () => {
      const close = page.getByRole("button", {
        name: build ? "Revise design" : "Keep investigating",
        exact: true,
      });
      if (await close.isVisible()) await close.click();
      await page
        .getByRole("button", {
          name: build ? "Submit Static Review" : "Run Validation",
          exact: true,
        })
        .click();
      await expect(
        page.getByRole("heading", {
          name: build ? "Static review passed" : "Incident resolved",
          exact: true,
        }),
      ).toBeVisible({ timeout: 1500 });
    }).toPass({ timeout: level.engine.kind === "webernetes" ? 90_000 : 10_000 });
    await page.getByRole("button", { name: "Done", exact: true }).click();
    await page.getByText(/Submission history \(/).click();
    await expect(page.getByText(/Passed ·/).first()).toBeVisible();
    expect(errors).toEqual([]);
  });
}

test("compact workspace keeps all three panes usable without page overflow", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/problems/all-replicas-one-failure-domain");
  await expect(page.getByText("Scenario ready", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Apply Changes", exact: true })).toBeInViewport();
  await expect
    .poll(() =>
      page.locator("#center").evaluate((element) => element.getBoundingClientRect().width),
    )
    .toBeGreaterThan(340);
  await page.getByRole("button", { name: "Problem", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "All Replicas, One Failure Domain" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Cluster", exact: true }).click();
  await expect(page.getByText("Cluster Explorer", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});
