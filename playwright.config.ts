import { defineConfig } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const testData =
  process.env.AACL_E2E_DATA_DIR ?? fs.mkdtempSync(path.join(os.tmpdir(), 'aacl-e2e-'));
export default defineConfig({
  testDir: './tests/ui',
  fullyParallel: false,
  workers: 1,
  timeout: 45000,
  use: {
    baseURL: 'http://127.0.0.1:4781',
    browserName: 'chromium',
    viewport: { width: 1440, height: 1100 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm start',
    url: 'http://127.0.0.1:4781/api/health',
    reuseExistingServer: false,
    env: { PORT: '4781', AACL_DATA_DIR: testData },
    timeout: 30000,
  },
});
