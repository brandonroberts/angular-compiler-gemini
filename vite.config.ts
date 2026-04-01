/// <reference types="vitest" />

import { defineConfig, DepOptimizationConfig } from 'vite';
import { angular } from './angular-compiler/src/lib/angular';
import { JavaScriptTransformer } from '@angular/build/private';

type EsbuildOptions = NonNullable<DepOptimizationConfig['esbuildOptions']>;
type EsbuildPlugin = NonNullable<EsbuildOptions['plugins']>[number];

function createCompilerPlugin(): EsbuildPlugin {
    const javascriptTransformer = new JavaScriptTransformer({ sourcemap: true, jit: true }, 1);
    return {
        name: 'analogjs-angular-esbuild-deps-optimizer-plugin',
        async setup(build) {
          build.onLoad({ filter: /\.[cm]?js$/ }, async (args) => {
              const contents = await javascriptTransformer.transformFile(args.path);
              return {
                  contents,
                  loader: 'js',
              };
          });
        },
    };
}

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
  build: {
    target: ['es2020'],
  },
  optimizeDeps: {
    esbuildOptions: {
      plugins: [
        createCompilerPlugin()
      ]
    }
  },
  resolve: {
    mainFields: ['module'],
  },
  plugins: [
    angular(),
  ],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['src/test-setup.ts'],
    include: ['**/*.spec.ts'],
    reporters: ['default'],
  },
}));
