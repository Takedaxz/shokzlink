// Isolated HTTP fixtures; this script must never mutate a real device.
import { chromium } from "@playwright/test";
import assert from "node:assert/strict";

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const errors = [];
const writes = [];
let online = false;
const fixture = {
  device: {
    connected: true,
    name: "SWIM PRO",
    mount: "/isolated-test",
    total: 1000000,
    free: 900000,
    tracks: [],
    folders: ["Training"],
  },
  library: [
    {
      path: "Example.mp3",
      name: "Example.mp3",
      title: "Example",
      size: 2048,
      modified: 1,
    },
  ],
  folders: [],
  jobs: [],
  dependencies: { ffmpeg: true, yt_dlp: true },
  auth: { configured: false, authenticated: false },
  libraryPath: "/isolated-test/library",
};
page.on("pageerror", (error) => errors.push(error.message));
await page.route("**/api/**", async (route) => {
  const request = route.request();
  if (request.method() !== "GET") {
    writes.push(request.url());
    await route.abort();
    return;
  }
  if (online && request.url().endsWith("/status")) {
    await route.fulfill({ json: fixture });
  } else {
    await route.fulfill({
      status: 503,
      json: { detail: "Isolated test server unavailable" },
    });
  }
});

async function navigate(name) {
  const menu = page.getByRole("button", {
    name: "Open navigation",
    exact: true,
  });
  if (await menu.isVisible()) await menu.click();
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("button", { name, exact: true })
    .click();
  const toggle = page.getByRole("button", {
    name: "Open navigation",
    exact: true,
  });
  if (await toggle.isVisible()) {
    assert.equal(await toggle.getAttribute("aria-expanded"), "false");
    assert.equal(
      await page.locator("#workspace-navigation").isVisible(),
      false,
    );
    assert.equal(
      await page
        .locator("#main")
        .evaluate((node) => node === document.activeElement),
      true,
    );
  }
}

try {
  await page.goto(process.env.SHOKZLINK_URL || "http://127.0.0.1:8765");
  await page.getByRole("alert").waitFor();
  assert.match(
    await page.getByRole("alert").innerText(),
    /Cannot reach the local server/,
  );
  online = true;
  await page.getByRole("button", { name: "Retry" }).click();
  await page.getByText("Local server online").waitFor();

  let checks = 0;
  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const name of [
      "Library",
      "YouTube",
      "YouTube Music",
      "Downloads",
      "Settings",
    ]) {
      await navigate(name);
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        ),
        false,
        `${name} overflows at ${width}px`,
      );
      assert.equal(
        await page.getByRole("heading", { level: 1 }).count(),
        1,
        `${name} requires one page heading`,
      );
      const short = await page
        .locator(
          'button:visible,input:not([type="checkbox"]):visible,select:visible',
        )
        .evaluateAll((nodes) =>
          nodes
            .filter((node) => node.getBoundingClientRect().height < 44)
            .map((node) => node.textContent || node.getAttribute("aria-label")),
        );
      assert.deepEqual(short, [], `${name} has short targets at ${width}px`);
      assert.equal(
        await page.evaluate(
          () => getComputedStyle(document.documentElement).backgroundColor,
        ),
        "rgb(255, 255, 255)",
      );
      checks++;
    }
  }
  await page.setViewportSize({ width: 375, height: 1000 });
  await page.getByRole("button", { name: "Open navigation" }).click();
  await page.keyboard.press("Escape");
  assert.equal(
    await page
      .getByRole("button", { name: "Open navigation" })
      .getAttribute("aria-expanded"),
    "false",
  );
  assert.equal(
    await page
      .getByRole("button", { name: "Open navigation" })
      .evaluate((node) => node === document.activeElement),
    true,
  );

  await page.setViewportSize({ width: 1440, height: 1000 });
  await navigate("Library");
  await page.getByLabel("Select Example.mp3").check();
  await page
    .getByRole("button", { name: "Delete", exact: true })
    .first()
    .click();
  assert.match(await page.getByRole("dialog").innerText(), /Example.mp3/);
  await page.keyboard.press("Escape");
  assert.equal(await page.getByRole("dialog").count(), 0);
  await page.getByRole("button", { name: "Safely eject", exact: true }).click();
  await page.getByRole("dialog").waitFor();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal(await page.getByRole("dialog").count(), 0);
  assert.deepEqual(errors, []);
  assert.deepEqual(writes, []);
  console.log(
    `PASS: ${checks} page/viewport checks; white theme; one h1/page; >=44px controls; mobile navigation/Escape/focus; delete/eject cancellation; offline state; no runtime errors; zero mutation requests.`,
  );
} finally {
  await browser.close();
}
