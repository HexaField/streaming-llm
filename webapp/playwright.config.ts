import { defineConfig, devices } from '@playwright/test'
import path from 'path'
import { fileURLToPath } from 'url'

const currentDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(currentDir, '..')
const isCI = !!process.env.CI

export default defineConfig({
  testDir: './tests',
  timeout: 120_000,
  expect: {
    timeout: 30_000
  },
  use: {
    baseURL: 'http://127.0.0.1:5173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure'
  },
  webServer: [
    {
      command: 'python3 -m backend.server',
      cwd: repoRoot,
      url: 'http://127.0.0.1:8000/healthz',
      timeout: 120_000,
      reuseExistingServer: !isCI,
      env: {
        ...process.env,
        STREAMING_LLM_MODEL: 'sshleifer/tiny-gpt2',
        STREAMING_LLM_ENABLE: '0',
        PYTHONUNBUFFERED: '1'
      }
    },
    {
      command: 'npm run dev -- --host 127.0.0.1 --port 5173',
      cwd: currentDir,
      url: 'http://127.0.0.1:5173',
      timeout: 120_000,
      reuseExistingServer: !isCI
    }
  ],
  reporter: [['list'], ['html', { open: 'never' }]],
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] }
    }
  ]
})
