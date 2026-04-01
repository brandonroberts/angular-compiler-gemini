import { Plugin } from 'vite';
import * as vite from 'vite';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { JavaScriptTransformer } from '@angular/build/private';

let LmdbCacheStore: any;
try {
  const req = createRequire(import.meta.url);
  const buildRequire = createRequire(req.resolve('@angular/build/private'));
  ({ LmdbCacheStore } = buildRequire('../src/tools/esbuild/lmdb-cache-store'));
} catch { /* not available */ }

/**
 * Transforms @angular/* FESM modules for production builds.
 * Applies advanced optimizations and tree-shaking annotations.
 */
export function buildOptimizerPlugin(maxWorkers: number): Plugin[] {
  let cacheStore: any;
  let cache: unknown;

  if (LmdbCacheStore && !process.versions['webcontainer']) {
    cacheStore = new LmdbCacheStore(
      path.join(process.cwd(), 'node_modules', '.cache', 'analog', 'build-optimizer.db')
    );
    cache = cacheStore.createCache('jstransformer');
  }

  const transformer = new JavaScriptTransformer(
    { sourcemap: false, thirdPartySourcemaps: false, advancedOptimizations: true, jit: true },
    maxWorkers, cache
  );
  let isProd = false;

  return [
    {
      name: 'angular-build-optimizer',
      apply: 'build',
      async buildEnd() {
        transformer.close();
        await cacheStore?.close();
      },
      config(userConfig) {
        isProd = userConfig.mode === 'production' || process.env['NODE_ENV'] === 'production';
        const defines = isProd ? { ngJitMode: 'false', ngI18nClosureMode: 'false', ngDevMode: 'false', ngServerMode: `${!!userConfig.build?.ssr}` } : {};
        return {
          define: defines,
          [(vite as any).rolldownVersion ? 'oxc' : 'esbuild']: { define: isProd ? defines : undefined },
        };
      },
      transform: {
        filter: { id: /fesm20.*\.[cm]?js$/ },
        async handler(_code, id) {
          const filePath = id.split('?')[0];
          const sideEffects = id.includes('@angular/compiler') ? true : false;
          const result = await transformer.transformFile(filePath, false, sideEffects);
          return { code: Buffer.from(result).toString() };
        },
      },
    },
    {
      name: 'angular-sourcemap-strip',
      apply: 'build',
      enforce: 'pre',
      transform: {
        filter: { id: /\.[cm]?js$/ },
        handler(code, id) {
          if (/fesm20/.test(id)) return;
          return {
            code: isProd ? code.replace(/^\/\/# sourceMappingURL=[^\r\n]*/gm, '') : code,
            map: { mappings: '' },
          };
        },
      },
    },
  ];
}
