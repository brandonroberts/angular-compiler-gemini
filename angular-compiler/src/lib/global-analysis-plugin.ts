import { Plugin } from 'vite';
import * as fs from 'fs';
import * as path from 'path';
import { ComponentRegistry } from './registry';
import { scanFile } from './registry';
import { compile } from './compile';

const DECORATOR_RE = /@(Component|Directive|Pipe|Injectable|NgModule)/;

/**
 * Vite plugin that performs global analysis across all Angular source files,
 * building a registry of selectors before single-file compilation runs.
 *
 * Phase 1 (buildStart): Scan all .ts files to build the ComponentRegistry.
 * Phase 2 (transform):  Pass the registry to compile() for each file.
 * HMR:                  Rescan changed files and invalidate dependents.
 */
export function globalAnalysisPlugin(srcDirs: string[] = ['src']): Plugin {
  const registry: ComponentRegistry = new Map();
  // Track which files import which classes, for HMR invalidation
  const dependents = new Map<string, Set<string>>(); // className → set of files that import it
  // Track external resource → parent .ts file for reload on resource change
  const resourceToSource = new Map<string, string>(); // resource path → .ts file path

  function scanDirectory(dir: string) {
    if (!fs.existsSync(dir)) return;

    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.resolve(dir, entry.name);
      if (entry.isDirectory() && entry.name !== 'node_modules') {
        scanDirectory(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts') && !entry.name.endsWith('.d.ts')) {
        scanSingleFile(fullPath);
      }
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

  return {
    name: 'vite-angular-global-analysis',
    enforce: 'pre',

    buildStart() {
      registry.clear();
      for (const dir of srcDirs) {
        scanDirectory(path.resolve(process.cwd(), dir));
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
      handler(code, id) {
        const result = compile(code, id, registry);
        // Track resource dependencies for file watching
        for (const dep of result.resourceDependencies) {
          resourceToSource.set(dep, id);
        }
        return { code: result.code };
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
}
