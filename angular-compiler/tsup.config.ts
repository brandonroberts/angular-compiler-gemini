import { defineConfig } from 'tsup';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  entry: {
    index: resolve(__dirname, 'src/lib/index.ts'),
    vite: resolve(__dirname, 'src/lib/vite.ts'),
  },
  outDir: resolve(__dirname, 'dist'),
  format: ['esm'],
  dts: false,
  sourcemap: true,
  clean: true,
  external: [
    '@angular/compiler',
    '@angular/compiler-cli',
    '@angular/build',
    '@angular/build/private',
    'vite',
    'typescript',
    'node:fs',
    'node:path',
    'node:os',
    'node:module',
  ],
});
