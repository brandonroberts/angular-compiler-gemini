import { Plugin } from 'vite';
import { JavaScriptTransformer } from '@angular/build/private';

/**
 * Transforms .js deps during Rolldown/esbuild optimization.
 */
export function optimizerPlugin(): Plugin {
  const transformer = new JavaScriptTransformer({ sourcemap: true, jit: true }, 1);
  return {
    name: 'angular-optimizer',
    load: {
      filter: { id: /\.[cm]?js$/ },
      async handler(id) {
        const contents = await transformer.transformFile(id);
        return { code: Buffer.from(contents).toString('utf-8') } as any;
      },
    },
    buildEnd() { transformer.close(); },
  } as any;
}
