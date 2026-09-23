import {defineConfig} from '@playwright/test'

export default defineConfig({
  testDir:'./tests/sdk-frameworks',
  testMatch:['astro-consumer.spec.ts','start-consumer.spec.ts','sveltekit-consumer.spec.ts','vite-consumer.spec.ts'],
  workers:1,
  timeout:180000,
  projects:['chromium','firefox','webkit'].map(browserName=>({
    name:browserName,
    use:{browserName:browserName as 'chromium'|'firefox'|'webkit'},
  })),
})
