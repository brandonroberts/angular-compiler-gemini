import { Plugin, ResolvedConfig, preprocessCSS } from 'vite';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { availableParallelism } from 'node:os';
import { readConfiguration } from '@angular/compiler-cli';
import { ComponentRegistry } from './registry';
import { scanFile } from './registry';
import { compile } from './compile';
import { buildOptimizerPlugin } from './plugins/build-optimizer';
import { depsPlugin } from './plugins/deps';
import { optimizerPlugin } from './plugins/optimizer';

import type { RegistryEntry } from './registry';

const DECORATOR_RE = /@(Component|Directive|Pipe|Injectable|NgModule)/;

/**
 * Generate HMR code using Angular's ɵɵreplaceMetadata.
 *
 * The applyMetadata callback re-defines ɵcmp and ɵfac on the old class
 * by copying from the newly compiled class in the hot-updated module.
 * ɵɵreplaceMetadata then merges the old/new definitions and recreates
 * matching LViews in the component tree.
 *
 * Falls back to page reload if ɵɵreplaceMetadata throws.
 */
function generateHmrCode(components: RegistryEntry[]): string {
  // Export applyMetadata functions so the accept callback can access them
  const applyFns = components.map(c => `
export function ɵhmr_${c.className}(type, namespaces) {
  type.ɵcmp = ${c.className}.ɵcmp;
  type.ɵfac = ${c.className}.ɵfac;
}`).join('\n');

  const replaceBlocks = components.map(c => `
      try {
        i0.ɵɵreplaceMetadata(
          ${c.className},
          newModule.ɵhmr_${c.className},
          { i0 },
          [],
          import.meta,
          "${c.className}"
        );
        replaced = true;
      } catch(e) {
        // ɵɵreplaceMetadata failed — will fall back to page reload
      }`
  ).join('\n');

  return `\n${applyFns}
if (import.meta.hot) {
  import.meta.hot.accept((newModule) => {
    if (!newModule) return;
    let replaced = false;${replaceBlocks}
    if (!replaced) {
      // Fallback: if no component was successfully replaced (e.g. root component),
      // trigger a full page reload
      import.meta.hot.invalidate('Component HMR failed, reloading');
    }
  });
}`;
}

/**
 * Vite plugin that performs global analysis across all Angular source files,
 * building a registry of selectors before single-file compilation runs.
 *
 * Phase 1 (buildStart): Scan all .ts files to build the ComponentRegistry.
 * Phase 2 (transform):  Pass the registry to compile() for each file.
 * HMR:                  Rescan changed files and invalidate dependents.
 */
export interface AngularPluginOptions {
  /** Path to tsconfig file. Default: 'tsconfig.app.json'. */
  tsconfig?: string;
  /** File extension for inline style preprocessing. Default: 'scss'. Set to 'less', 'sass', 'styl', or 'css' (no preprocessing). */
  inlineStyleLanguage?: 'scss' | 'sass' | 'less' | 'styl' | 'css';
}

export function angular(options: AngularPluginOptions = {}): Plugin[] {
  const opts = options;
  const inlineStyleLanguage = opts.inlineStyleLanguage || 'scss';
  const registry: ComponentRegistry = new Map();
  // Track which files import which classes, for HMR invalidation
  const dependents = new Map<string, Set<string>>(); // className → set of files that import it
  // Track external resource → parent .ts file for reload on resource change
  const resourceToSource = new Map<string, string>(); // resource path → .ts file path
  let resolvedConfig: ResolvedConfig;
  let isServe = false;

  /**
   * Extract styleUrl/styleUrls from source, read and preprocess them via Vite.
   * Returns a Map of absolute path → compiled CSS for the compiler to use.
   */
  async function resolveStyleFiles(code: string, id: string): Promise<Map<string, string> | undefined> {
    // Quick check: does the source reference external styles?
    if (!code.includes('styleUrl')) return undefined;

    // Extract styleUrl and styleUrls paths with a simple regex
    const styleUrls: string[] = [];
    const singleMatch = code.match(/styleUrl\s*:\s*['"`]([^'"`]+)['"`]/);
    if (singleMatch) styleUrls.push(singleMatch[1]);
    const arrayMatch = code.matchAll(/styleUrls\s*:\s*\[([^\]]+)\]/g);
    for (const m of arrayMatch) {
      const urls = m[1].matchAll(/['"`]([^'"`]+)['"`]/g);
      for (const u of urls) styleUrls.push(u[1]);
    }

    if (styleUrls.length === 0) return undefined;

    const result = new Map<string, string>();
    const dir = path.dirname(id);

    for (const url of styleUrls) {
      if (!/\.(scss|sass|less|styl)$/.test(url)) continue;
      const filePath = path.resolve(dir, url);
      try {
        const source = fs.readFileSync(filePath, 'utf-8');
        const processed = await preprocessCSS(source, filePath, resolvedConfig);
        result.set(filePath, processed.code);
      } catch (e: any) {
        console.warn(`[angular-compiler] Style preprocessing failed for ${filePath}: ${e.message}`);
      }
    }

    return result.size > 0 ? result : undefined;
  }

  /**
   * Preprocess inline styles that contain SCSS/Sass syntax.
   * Detects styles with $ variables, & parent selectors, or nested rules
   * and runs them through Vite's preprocessCSS.
   */
  async function preprocessInlineStyles(code: string, id: string): Promise<Map<number, string> | undefined> {
    if (inlineStyleLanguage === 'css') return undefined;
    if (!code.includes('styles')) return undefined;

    // Use TypeScript AST to reliably extract inline style strings
    const ts = await import('typescript');
    const sf = ts.createSourceFile(id, code, ts.ScriptTarget.Latest, true);
    const styleStrings: string[] = [];

    // Walk AST to find styles property in decorator arguments
    function visit(node: any) {
      if (ts.isPropertyAssignment(node) && node.name.getText(sf) === 'styles') {
        const val = node.initializer;
        if (ts.isArrayLiteralExpression(val)) {
          for (const el of val.elements) {
            if (ts.isStringLiteral(el) || ts.isNoSubstitutionTemplateLiteral(el)) {
              styleStrings.push(el.text);
            }
          }
        } else if (ts.isStringLiteral(val) || ts.isNoSubstitutionTemplateLiteral(val)) {
          // styles: `...` (singular string)
          styleStrings.push(val.text);
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(sf);

    if (styleStrings.length === 0) return undefined;

    const result = new Map<number, string>();
    for (let i = 0; i < styleStrings.length; i++) {
      try {
        const fakePath = id.replace(/\.ts$/, `.inline-${i}.${inlineStyleLanguage}`);
        const processed = await preprocessCSS(styleStrings[i], fakePath, resolvedConfig);
        result.set(i, processed.code);
      } catch (e: any) {
        console.warn(`[angular-compiler] Inline style preprocessing failed in ${id}: ${e.message}`);
      }
    }

    return result.size > 0 ? result : undefined;
  }

  /**
   * Resolve source files from tsconfig using Angular's readConfiguration.
   * Uses rootNames from the parsed config to get the full file list.
   */
  function resolveSourceFiles(): string[] {
    const root = process.cwd();
    const tsconfigPath = path.resolve(root, opts.tsconfig || 'tsconfig.app.json');

    try {
      const config = readConfiguration(tsconfigPath);
      return config.rootNames;
    } catch (e: any) {
      console.warn(`[angular-compiler] Could not read tsconfig at ${tsconfigPath}: ${e.message}`);
      return [];
    }
  }

  function scanSingleFile(filePath: string) {
    try {
      const code = fs.readFileSync(filePath, 'utf-8');
      const entries = scanFile(code, filePath);
      for (const entry of entries) {
        registry.set(entry.className, entry);
      }
    } catch {
      // Skip files that can't be read/parsed
    }
  }

  const maxWorkers = Math.max(1, availableParallelism() - 1);

  const angularCompilationPlugin: Plugin = {
    name: 'analogjs-angular-compiler',
    enforce: 'pre',

    config(_config, { command }) {
      isServe = command === 'serve';
      return {
        optimizeDeps: {
          rolldownOptions: {
            plugins: [optimizerPlugin()],
          },
        },
      } as any;
    },

    configResolved(config) {
      resolvedConfig = config;
    },

    buildStart() {
      registry.clear();
      const files = resolveSourceFiles();
      for (const file of files) {
        scanSingleFile(file);
      }
    },

    configureServer(server) {
      // Initial scan happens via buildStart.
      // Watch for new files being added.
      server.watcher.on('add', (filePath) => {
        if (filePath.endsWith('.ts') && !filePath.endsWith('.spec.ts') && !filePath.endsWith('.d.ts')) {
          scanSingleFile(filePath);
        }
      });
    },

    transform: {
      filter: {
        id: /.ts$/,
        code: {
          include: [DECORATOR_RE]
        }
      },
      async handler(code, id) {
        // Pre-resolve external style files: SCSS/Sass/Less via Vite
        const resolvedStyles = await resolveStyleFiles(code, id);

        // Pre-resolve inline styles that contain SCSS syntax
        const resolvedInlineStyles = await preprocessInlineStyles(code, id);

        const result = compile(code, id, { registry, resolvedStyles, resolvedInlineStyles });
        // Track resource dependencies for file watching
        for (const dep of result.resourceDependencies) {
          resourceToSource.set(dep, id);
        }

        let outputCode = result.code;

        // Append HMR code in dev mode for component files.
        // Use the registry (already populated by buildStart/scanSingleFile) instead of
        // re-parsing the file with scanFile — avoids a redundant OXC parse per transform.
        if (isServe) {
          const components: RegistryEntry[] = [];
          for (const entry of registry.values()) {
            if (entry.fileName === id && entry.kind === 'component') {
              components.push(entry);
            }
          }
          if (components.length > 0) {
            outputCode += generateHmrCode(components);
          }
        }

        return { code: outputCode, map: result.map };
      }
    },

    handleHotUpdate({ file, server, modules }) {
      // When an external template/style file changes, invalidate the parent .ts module
      const parentSource = resourceToSource.get(file);
      if (parentSource) {
        const parentModule = server.moduleGraph.getModuleById(parentSource);
        if (parentModule) {
          return [parentModule];
        }
      }

      if (!file.endsWith('.ts')) return;

      const code = fs.readFileSync(file, 'utf-8');

      // Rescan this file for metadata changes
      const oldEntries = [...registry.entries()]
        .filter(([_, v]) => v.fileName === file)
        .map(([k]) => k);

      // Remove old entries from this file
      for (const key of oldEntries) {
        registry.delete(key);
      }

      // Scan for new entries
      const newEntries = scanFile(code, file);
      const changed = new Set<string>();

      for (const entry of newEntries) {
        const old = oldEntries.includes(entry.className)
          ? undefined // was removed above
          : registry.get(entry.className);

        registry.set(entry.className, entry);

        // Track if selector changed (would affect dependents)
        if (!oldEntries.includes(entry.className) || old?.selector !== entry.selector) {
          changed.add(entry.className);
        }
      }

      // If selectors changed, invalidate files that import the changed classes
      if (changed.size > 0) {
        const affectedModules = [];
        for (const className of changed) {
          const deps = dependents.get(className);
          if (deps) {
            for (const depFile of deps) {
              const mod = server.moduleGraph.getModuleById(depFile);
              if (mod) affectedModules.push(mod);
            }
          }
        }
        if (affectedModules.length > 0) {
          return [...modules, ...affectedModules];
        }
      }
    }
  };

  return [
    angularCompilationPlugin,
    ...buildOptimizerPlugin(maxWorkers),
    depsPlugin(maxWorkers),
  ];
}
