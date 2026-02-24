import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Give integration tests enough time.
    // dream-and-peer-card tests require up to 4 min (workspace nuke + queue drain).
    testTimeout: 300_000, // 5 min ceiling
    // Always run against the isolated test workspace, never the production 'openclaw' workspace.
    // Note: The Honcho API does not support peer deletion, so test data accumulates in this
    // workspace over time. To fully reset, delete and recreate the 'openclaw-test' workspace
    // manually. The workspace isolation here is the critical safety net.
    env: {
      HONCHO_WORKSPACE_ID: 'openclaw-test',
    },
  },
});
