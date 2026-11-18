// Playwright configuration for the browser checks. `npm run e2e` starts the
// static server on a spare port, then drives the four views.
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test/e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:5188',
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    launchOptions: {
      // SwiftShader supplies WebGL2 in headless Linux containers.
      args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
    },
  },
  webServer: {
    command: 'node tools/serve.mjs',
    url: 'http://127.0.0.1:5188/',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
    env: { PORT: '5188' },
  },
});
