import { Plugin } from 'vite';
import { JavaScriptTransformer } from '@angular/build/private';

/**
 * Transforms @angular/* FESM modules during dev serve.
 */
export function depsPlugin(maxWorkers: number): Plugin {
  const transformer = new JavaScriptTransformer({ jit: true, sourcemap: true }, maxWorkers);
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
