import * as path from 'node:path';
import { createRequire } from 'node:module';

let LmdbCacheStore: any;
try {
  const req = createRequire(import.meta.url);
  const buildRequire = createRequire(req.resolve('@angular/build/private'));
  ({ LmdbCacheStore } = buildRequire('../src/tools/esbuild/lmdb-cache-store'));
} catch { /* not available */ }

export function createCache(name: string): { cache: unknown; close: () => Promise<void> } | undefined {
  if (!LmdbCacheStore || process.versions['webcontainer']) return undefined;

  const cacheStore = new LmdbCacheStore(
    path.join(process.cwd(), 'node_modules', '.cache', 'analog', `${name}.db`)
  );
  const cache = cacheStore.createCache('jstransformer');
  return {
    cache,
    close: () => cacheStore.close(),
  };
}
