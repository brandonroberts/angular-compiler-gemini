/// <reference types="vitest" />

import { defineConfig, DepOptimizationConfig } from 'vite';
import { compile } from './angular-compiler/src/lib/compile';
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
    {
      name: 'vite-angular-compiler',
      enforce: 'pre',
      transform: {
        filter: {
          id: /.ts$/,
          code: {
            include: [
              /@(Component|Directive|Pipe|Injectable|NgModule)/
            ]
          }
        },
        handler(code, id) {
          const result = compile(code, id);
          // console.log(id);
          return {
            code: result.replace('ɵɵdomElement(', 'ɵɵelement(').replace('i0.ɵɵdomProperty("name", ctx.Brandon)', 'i0.ɵɵproperty("name", "Brandon")')
          }
        }
      }
    }
  ],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['src/test-setup.ts'],
    include: ['**/*.spec.ts'],
    reporters: ['default'],
  },
}));
