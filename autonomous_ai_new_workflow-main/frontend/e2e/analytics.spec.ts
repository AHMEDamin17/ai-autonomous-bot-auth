import { test, expect } from "@playwright/test";

test("happy path: connect → catalog → KPI → query", async ({ page }) => {
  await page.goto("/");
  await page.click("text=Layer");
  await page.fill("input[name=name]", "Test MySQL");
  await page.selectOption("select[name=type]", "MySQL");
  await page.fill("input[name=host]", "localhost:3306");
  await page.fill("input[name=user]", "root");
  await page.fill("input[name=password]", "root");
  await page.fill("input[name=schema]", "icon_component_db");
  await page.click("button:has-text('+ Add')");
  await page.click("text=Analytics AI");
  await page.fill("textarea[placeholder*='Ask']", "Show me revenue by region");
  await page.press("textarea", "Enter");
  await expect(page.locator("text=Insight")).toBeVisible({ timeout: 30_000 });
});
