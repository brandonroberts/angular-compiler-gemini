/// <reference types="vitest" />

import { defineConfig, DepOptimizationConfig, ESBuildOptions } from 'vite';
import analog from '@analogjs/platform';
import { compile } from './angular-compiler/src/lib/compile';
import { JavaScriptTransformer } from '@angular/build/private';
import { readFileSync } from 'node:fs';

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
    {
      name: 'vite-angular-compiler',
      // enforce: 'pre',
      transform: {
        filter: {
          id: /.ts$/
        },
        handler(code, id) {
          if ( id.includes('app.ts')) {
          const file = readFileSync(id).toString('utf-8')
          const result = compile(file, id);
            console.log(id, result);
          return {
            code: result
          }
          }
          return;
        }
      }
    }
    // analog(),
  ],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['src/test-setup.ts'],
    include: ['**/*.spec.ts'],
    reporters: ['default'],
  },
}));
