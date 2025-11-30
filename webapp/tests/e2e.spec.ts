import { expect, Page, test } from '@playwright/test'

const uniqueSuffix = Date.now()
const agentName = `E2E Agent ${uniqueSuffix}`
const systemPrompt = 'You are an integration-test assistant.'
const markdownContext = '# Test Context\n- bullet 1\n- bullet 2'
const chatMessage = `Hello from playwright ${uniqueSuffix}`
const safeAgentName = agentName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

async function waitForAgentList(page: Page) {
  await expect(page.getByRole('button', { name: new RegExp(`^${safeAgentName}`) }).first()).toBeVisible({ timeout: 30_000 })
}

test.describe('StreamingLLM multi-agent chat', () => {
  test('user can manage agents and stream chat', async ({ page }) => {
    await page.goto('/')

    await expect(page.getByRole('button', { name: /^Planner/i })).toBeVisible()

    await page.getByRole('button', { name: 'New Agent' }).click()
    await page.getByLabel('Agent Name').fill(agentName)
    await page.getByLabel('System Prompt').fill(systemPrompt)
    await page.getByLabel('Markdown Context').fill(markdownContext)
    await page.getByRole('button', { name: 'Save' }).click()
    await expect(page.getByText('Agent saved')).toBeVisible()

    await page.reload()
    await waitForAgentList(page)
    await page.getByLabel(`Add ${agentName} to conversation`).click()
    await page.getByRole('button', { name: new RegExp(`^${safeAgentName}`) }).first().click()

    const temperatureSlider = page.locator('input[type="range"]')
    await temperatureSlider.fill('0')

    const input = page.getByPlaceholder('Send a message…')
    await input.fill(chatMessage)
    await expect(page.getByRole('button', { name: 'Send' })).toBeEnabled({ timeout: 60_000 })
    await page.getByRole('button', { name: 'Send' }).click()

    const assistantBubble = page.locator('[data-testid="message-assistant"]').last()
    await expect(assistantBubble).toContainText(/.+/, { timeout: 60_000 })

    await expect(page.getByText('stopped')).not.toBeVisible({ timeout: 5_000 })
  })

  test('inspector surfaces ACE state', async ({ page }) => {
    await page.goto('/')

    const plannerButton = page.getByRole('button', { name: /^Planner/i }).first()
    await expect(plannerButton).toBeVisible()
    await plannerButton.click()

    await expect(page.getByRole('button', { name: 'Conversation' })).toBeVisible()

    await expect(page.getByText('Memory summary').first()).toBeVisible({ timeout: 30_000 })

    await page.getByRole('button', { name: 'Agent' }).click()
    await expect(page.getByText('Local summary').first()).toBeVisible({ timeout: 30_000 })
    await expect(page.getByRole('button', { name: 'Reset' })).toBeVisible()

    await page.getByRole('button', { name: 'Global' }).click()
    await expect(page.getByText('Global strategies').first()).toBeVisible({ timeout: 30_000 })
  })
})
