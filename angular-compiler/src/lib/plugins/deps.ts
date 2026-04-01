import { Plugin } from 'vite';
import { JavaScriptTransformer } from '@angular/build/private';
import { createCache } from './cache';

/**
 * Transforms @angular/* FESM modules during dev serve.
 * Uses LmdbCacheStore to avoid re-transforming unchanged modules.
 */
export function depsPlugin(maxWorkers: number): Plugin {
  const cacheEntry = createCache('dev-deps');
  const transformer = new JavaScriptTransformer({ jit: true, sourcemap: true }, maxWorkers, cacheEntry?.cache);
  return {
    name: 'angular-deps',
    enforce: 'pre',
    apply: 'serve',
    transform: {
      filter: { id: /fesm(.*?)\.mjs/ },
      async handler(_code, id) {
        const filePath = id.split('?')[0];
        const contents = await transformer.transformFile(filePath);
        return { code: Buffer.from(contents).toString('utf-8') };
      },
    },
  };
}
