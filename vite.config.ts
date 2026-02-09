import path from 'node:path'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@pm-cm/core': path.resolve(__dirname, 'packages/core/src/index.ts'),
      '@pm-cm/yjs': path.resolve(__dirname, 'packages/yjs/src/index.ts'),
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: './src/vitest.setup.ts',
  },
})
