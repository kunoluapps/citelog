// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Kunolu
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'action/test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20_000,
  },
});
