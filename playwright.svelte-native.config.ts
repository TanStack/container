import {defineConfig} from '@playwright/test'
export default defineConfig({testDir:'tests/svelte-native',workers:1,timeout:60000,use:{browserName:'chromium',trace:'on'}})
