import { defineConfig, devices } from '@playwright/test';

// One mobile end-to-end test lands in M1 (§13); config is scaffolded in M0.
export default defineConfig({
  testDir: './tests/e2e',
  use: { baseURL: 'http://localhost:5173' },
  projects: [{ name: 'mobile', use: { ...devices['iPhone 14'] } }],
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5173',
    reuseExistingServer: true,
  },
});
