import { test as setup, expect } from "@playwright/test";
import { signIn } from "./helpers/auth.ts";
import { ADMIN_STORAGE_STATE, seededAdmin } from "./helpers/env.ts";

/**
 * Signs the seeded admin in once per run and saves the session cookie, so the
 * `chromium` project can start every test already authenticated. Runs before
 * any spec because `chromium` depends on the `setup` project.
 */
setup("sign in as the seeded admin", async ({ page }) => {
  await signIn(page, seededAdmin.email, seededAdmin.password);
  await expect(
    page.getByRole("banner").getByText(seededAdmin.name, { exact: true }),
  ).toBeVisible();
  await page.context().storageState({ path: ADMIN_STORAGE_STATE });
});
