import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config';

/** Live-RPC / network tests — run: `npm run test:integration` */
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: 'node',
      include: ['src/**/*.integration.test.ts'],
      exclude: ['node_modules'],
      testTimeout: 120_000,
    },
  }),
);
