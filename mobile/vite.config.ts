import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

export default defineConfig({
  plugins: [react()],
  resolve: {
    // one protocol, zero drift: the desktop's shared types are imported directly
    alias: { '@shared': resolve(__dirname, '../src/shared') }
  },
  server: { fs: { allow: [resolve(__dirname, '..')] } },
  build: { outDir: 'dist', target: 'es2022' }
})
