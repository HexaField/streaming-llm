import { test, expect, Page } from "@playwright/test";

const uniqueSuffix = Date.now();
const agentName = `E2E Agent ${uniqueSuffix}`;
const systemPrompt = "You are an integration-test assistant.";
const markdownContext = "# Test Context\n- bullet 1\n- bullet 2";
const chatMessage = `Hello from playwright ${uniqueSuffix}`;
const safeAgentName = agentName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

async function waitForAgentList(page: Page) {
  await expect(page.getByText(agentName)).toBeVisible({ timeout: 30_000 });
}

test.describe("StreamingLLM multi-agent chat", () => {
  test("user can manage agents and stream chat", async ({ page }) => {
    await page.goto("/");

    await expect(page.getByRole("button", { name: /Planner/i })).toBeVisible();

    await page.getByRole("button", { name: "New" }).click();
    await page.getByLabel("Agent Name").fill(agentName);
    await page.getByLabel("System Prompt").fill(systemPrompt);
    await page.getByLabel("Markdown Context").fill(markdownContext);
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Agent saved")).toBeVisible();

    await page.reload();
    await waitForAgentList(page);
    await page.getByRole("button", { name: new RegExp(`^${safeAgentName}`) }).click();

    const temperatureSlider = page.locator('input[type="range"]');
    await temperatureSlider.fill("0");

    const input = page.getByPlaceholder("Send a message…");
    await input.fill(chatMessage);
    await page.getByRole("button", { name: "Send" }).click();

    const assistantBubble = page.locator('[data-testid="message-assistant"]').last();
    await expect(assistantBubble).toContainText(/.+/, { timeout: 60_000 });

    await expect(page.getByText("stopped")).not.toBeVisible({ timeout: 5_000 });
  });
});
