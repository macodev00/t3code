import { openBootstrapThread, openSurface } from "./_helpers.mjs";
// Scene for #12887: Diff panel (branch vs main) on a repo where `office` (file) became `office/config.ts`.
export const initLocalStorage = { "t3code.diffFileTreeOpen": "false" };
// Close-up of the right (Diff) panel: from the panel's left edge to the viewport edge, top 400px.
async function panelShot(page, shot, name) {
  const btn = await page.getByRole("button", { name: "Close Diff" }).boundingBox();
  const vp = page.viewportSize();
  const x = Math.max(0, Math.floor(btn.x - 12));
  return shot(name, { clip: { x, y: 0, width: vp.width - x, height: 400 } });
}
export async function run({ page, shot, markStart }) {
  await openBootstrapThread(page, "office-fixture");
  await openSurface(page, "Diff");
  await page.getByRole("button", { name: "Show file tree" }).waitFor({ timeout: 60000 });
  await page.getByText("office/config.ts").first().waitFor({ timeout: 60000 });
  await page.waitForTimeout(1500);
  markStart();
  await page.waitForTimeout(1000);
  await shot("diff-panel-tree-hidden");
  await page.getByRole("button", { name: "Show file tree" }).click();
  await page.waitForTimeout(3500);
  await shot("file-tree-opened");
  if (await page.getByText("Something went wrong.").count()) { await page.waitForTimeout(1500); return; } // "before": crash screen captured
  await panelShot(page, shot, "panel-file-tree-opened");
  // "after": select both colliding entries in the tree (Pierre tree lives in an open shadow root;
  // getByRole pierces it). Each click must expand the matching diff, proving the paths map back.
  await page.getByRole("treeitem", { name: "config.ts" }).first().click();
  await page.waitForTimeout(1500);
  await panelShot(page, shot, "panel-select-office-config");
  await page.getByRole("treeitem", { name: /^office/ }).first().click(); // the deleted `office` file row
  await page.waitForTimeout(1500);
  await panelShot(page, shot, "panel-select-office-file");
  await page.waitForTimeout(1500);
}
