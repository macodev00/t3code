// Shared scene helpers.
/** From "/", open the empty thread that `start --auto-bootstrap-project-from-cwd` created for <projectTitle>. */
export async function openBootstrapThread(page, projectTitle) {
  await page.getByText(projectTitle).first().waitFor({ timeout: 180000 });
  await page.waitForTimeout(1500);
  if (!page.url().includes("/thread")) {
    await page.locator("li[data-thread-item]").first().click(); // first sidebar thread row
    await page.waitForURL(/\/thread/, { timeout: 30000 });
  }
  await page.waitForTimeout(1500);
  const dismiss = page.getByRole("button", { name: /Dismiss .* provider error/ }); // no provider configured: expected banner
  if (await dismiss.count()) await dismiss.first().click();
}
/** Open a right-panel surface ("Diff", "Files", "Terminal", ...) on the current thread. */
export async function openSurface(page, name) {
  if (await page.getByRole("button", { name: `Close ${name}` }).count()) return;
  await page.getByRole("button", { name: "Toggle right panel" }).click();
  await page.waitForTimeout(800);
  await page.getByText(name, { exact: true }).first().click();
}
