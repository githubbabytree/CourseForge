import { chromium } from "playwright-core";

const executablePath = process.env.CHROMIUM_PATH?.trim() || chromium.executablePath();
const browser = await chromium.launch({ executablePath, headless: true, chromiumSandbox: process.env.VIDEO_WORKER_CHROMIUM_SANDBOX !== "false", args: ["--disable-dev-shm-usage", "--disable-background-networking"] });
try {
  const page = await browser.newPage({ javaScriptEnabled: false });
  await page.setContent("<!doctype html><title>CourseForge sandbox probe</title><p>ok</p>");
  if (await page.textContent("p") !== "ok") throw new Error("browser sandbox probe content mismatch");
  process.stdout.write(`chromium_sandbox_probe=ok executable=${executablePath}\n`);
} finally {
  await browser.close();
}
