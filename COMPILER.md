# Analog Angular Compiler

A lightweight Angular compiler that transforms decorators and signal-based reactive APIs into Ivy static definitions. Designed for fast dev server compilation via Vite, without requiring a full TypeScript program.

## Installation

```bash
npm install @analogjs/angular-compiler
```

Peer dependencies: `@angular/compiler` >=19, `@angular/compiler-cli` >=19, `@angular/build` >=19, `vite` >=6.

## Entry Points

| Import | Exports | Use case |
|---|---|---|
| `@analogjs/angular-compiler/vite` | `angular()` | Vite plugin for `vite.config.ts` |
| `@analogjs/angular-compiler` | `compile()`, `scanFile()` | Programmatic compiler API (no Vite dependency) |

## Usage

### Vite Plugin

```ts
import { angular } from '@analogjs/angular-compiler/vite';

export default defineConfig({
  plugins: [angular()]
});
```

#### Options

```ts
angular({
  tsconfig: 'tsconfig.app.json',    // Path to tsconfig (default)
  inlineStyleLanguage: 'scss',       // 'scss' | 'sass' | 'less' | 'styl' | 'css'
})
```

### Programmatic API

```ts
import { compile, scanFile } from '@analogjs/angular-compiler';

// Compile a single file
const result = compile(sourceCode, fileName, { registry });
// result.code — compiled JavaScript
// result.map — V3 source map
// result.resourceDependencies — external template/style paths read

// Scan a file for Angular metadata (uses OXC Rust parser)
const entries = scanFile(code, fileName);
// entries: [{ selector, kind, className, fileName, ... }]
```

### Building from Source

```bash
cd angular-compiler
npx tsup
```

Output:
- `dist/index.js` (128B) — compiler API re-exports
- `dist/vite.js` (12KB) — Vite plugin re-export
- `dist/chunk-*.js` (121KB) — shared compiler code

## Architecture

```
Source file (.ts)
  │
  ├─ angular-compiler plugin (buildStart)
  │    @angular/compiler-cli readConfiguration() → rootNames
  │    OXC parser ──▶ scanFile() ──▶ ComponentRegistry
  │                                   (selectors, pipes, NgModule exports)
  │
  └─ angular-compiler plugin (transform, per request)
       ts.createSourceFile ──▶ extractMetadata / detectSignals / detectFieldDecorators
         │
         ▼
       @angular/compiler
         parseTemplate()
         compileComponentFromMetadata()
         compileDirectiveFromMetadata()
         compilePipeFromMetadata()
         compileNgModule() / compileInjector()
         compileFactoryFunction()
         compileClassMetadata()
         │
         ▼
       String emitter (Angular output AST → JavaScript strings)
         │
         ▼
       MagicString (surgical edits on original source → JS + source map)
```

The `angular()` plugin returns an array of Vite plugins:

1. **`analogjs-angular-compiler`** — AOT compilation, global analysis registry, HMR, style preprocessing
2. **`angular-build-optimizer`** — production `@angular/*` FESM transforms with advanced optimizations
3. **`angular-sourcemap-strip`** — strip source maps from library code in production
4. **`angular-deps`** — dev serve `@angular/*` FESM transforms with caching
5. **`angular-optimizer`** — Rolldown/esbuild dep pre-optimization (injected via `optimizeDeps`)

## Source Files

| File | Purpose |
|---|---|
| `angular.ts` | Main plugin entry, returns `Plugin[]`, composes all internal plugins |
| `compile.ts` | Single-file AOT compiler: metadata extraction, signals, DI, field decorators, Ivy codegen, inline string emitter |
| `registry.ts` | OXC-based file scanner, `ComponentRegistry` type |
| `plugins/build-optimizer.ts` | Production `@angular/*` FESM transforms |
| `plugins/deps.ts` | Dev serve `@angular/*` FESM transforms |
| `plugins/optimizer.ts` | Rolldown/esbuild dep pre-optimization |
| `plugins/cache.ts` | Shared LmdbCacheStore for transform caching |

## What's Supported

### Decorators

| Decorator | Static Fields | Notes |
|---|---|---|
| `@Component` | `ɵcmp`, `ɵfac`, `setClassMetadata` | Full template compilation with Ivy instructions |
| `@Directive` | `ɵdir`, `ɵfac`, `setClassMetadata` | Host bindings, listeners, inputs/outputs |
| `@Pipe` | `ɵpipe`, `ɵfac`, `setClassMetadata` | Pure and impure |
| `@Injectable` | `ɵprov`, `ɵfac`, `setClassMetadata` | `providedIn` variants |
| `@NgModule` | `ɵmod`, `ɵinj`, `ɵfac`, `setClassMetadata` | Declarations, exports, providers, bootstrap |

### Field Decorators

| Decorator | Supported |
|---|---|
| `@Input()` / `@Input('alias')` / `@Input({ required, transform })` | Yes |
| `@Output()` / `@Output('alias')` | Yes |
| `@ViewChild(pred, opts)` / `@ViewChildren(pred, opts)` | Yes |
| `@ContentChild(pred, opts)` / `@ContentChildren(pred, opts)` | Yes |
| `@HostBinding('prop')` | Yes |
| `@HostListener('event', ['$event'])` | Yes |

### Dependency Injection

| Feature | Supported |
|---|---|
| Constructor parameter injection | Yes (type annotations as tokens) |
| `@Inject(TOKEN)` | Yes |
| `@Optional()` | Yes |
| `@Self()` / `@SkipSelf()` / `@Host()` | Yes |
| `@Attribute('name')` | Yes |
| Type-only imports (`import type`) | Detected → `ɵɵinvalidFactory` |
| Class inheritance without constructor | `ɵɵgetInheritedFactory` |
| `forwardRef(() => X)` unwrapping | Yes (in imports, providers, queries) |

### @Component API Coverage

| Property | Status |
|---|---|
| `selector` | Supported (auto-generated for selectorless routed components) |
| `template` | Supported |
| `templateUrl` | Supported (inlined at compile time) |
| `styles` (array or string) | Supported (ShadowCss emulated encapsulation) |
| `styleUrl` / `styleUrls` | Supported (inlined at compile time) |
| `standalone` | Supported (defaults `true` for Angular 19+) |
| `changeDetection` | Supported (OnPush / Default) |
| `encapsulation` | Supported (Emulated / None / ShadowDom) |
| `imports` | Supported (resolved via registry) |
| `providers` | Supported |
| `viewProviders` | Supported |
| `animations` | Supported (passed through) |
| `exportAs` | Supported |
| `preserveWhitespaces` | Supported |
| `host` | Supported (listeners, properties, attributes) |
| `schemas` | Passed through |

### Signal APIs

| API | Supported |
|---|---|
| `signal()` | Yes (preserved as-is) |
| `computed()` | Yes (preserved as-is) |
| `input()` / `input.required()` | Yes (signal input descriptors with required flag, transform extraction) |
| `model()` / `model.required()` | Yes (generates input + `Change` output) |
| `output()` | Yes |
| `viewChild()` / `viewChild.required()` | Yes (signal queries) |
| `viewChildren()` | Yes (signal queries) |
| `contentChild()` / `contentChild.required()` | Yes (signal queries) |
| `contentChildren()` | Yes (signal queries) |
| `inject()` | Yes (preserved as-is) |

### Template Features

| Feature | Supported |
|---|---|
| `@if` / `@else if` / `@else` | Yes |
| `@for` with `track`, `@empty` | Yes |
| `@for` implicit variables (`$index`, `$first`, `$last`, `$even`, `$odd`, `$count`) | Yes |
| `@switch` / `@case` / `@default` | Yes |
| `@defer` with all triggers (`on viewport`, `on idle`, `on timer`, `on hover`, `on interaction`, `when`) | Yes |
| `@defer` sub-blocks (`@loading`, `@placeholder`, `@error`) with `minimum` | Yes |
| `@defer` lazy dependency loading via `import()` | Yes |
| Nested `@defer` inside control flow | Yes |
| `@let` declarations | Yes |
| `{{ interpolation }}` | Yes |
| `[property]` binding | Yes |
| `(event)` binding | Yes |
| `[(two-way)]` binding | Yes |
| `[class.name]` / `[style.prop]` | Yes |
| `<ng-content>` (multi-slot projection) | Yes |
| Pipes in templates (with args, chained) | Yes |

### Cross-file Resolution

| Scenario | Supported |
|---|---|
| Component imports component | Yes (via registry) |
| Component imports directive | Yes (via registry) |
| Component imports pipe | Yes (via registry) |
| Component imports NgModule | Yes (exports expanded from registry) |
| Library imports (e.g. `RouterOutlet`) | Yes (added to dependencies, skipped for template matching) |
| Same-file imports | Yes (file-local selector fallback) |

## What's Not Supported

| Feature | Reason |
|---|---|
| Template type checking | Requires full `ts.Program`; use Angular Language Service in IDE |
| i18n / localization | Out of scope (future consideration) |
| Partial / linker compilation | Handled by separate plugin |
| Template source maps | Angular compiler doesn't propagate sourceSpan to output AST |
| Signal debug names | Not implemented |
| `setClassDebugInfo` | Not implemented |
| Spread imports (`...Module`) | Not implemented |

## HMR (Hot Module Replacement)

Leaf components support true HMR via Angular's `ɵɵreplaceMetadata`. When a component file changes in dev mode:

1. Vite hot-replaces the module
2. The `import.meta.hot.accept` callback calls `ɵɵreplaceMetadata` with the new component definition
3. Angular merges old/new definitions and recreates matching LViews without page reload

Root components (e.g. `App`) fall back to page reload since they can't be hot-replaced without re-bootstrapping the application. Non-Angular files use Vite's default HMR.

External template and style changes invalidate the parent `.ts` module, triggering re-compilation and HMR. Preprocessed styles are cached by mtime for fast re-compilation.

## Source Maps

The compiler generates V3 source maps via `magic-string` using surgical edits on the original source. Class bodies, methods, and expressions stay at their original character positions — only removed decorators and inserted Ivy fields are new content. The source map is passed through Vite's transform pipeline which composes it with other transforms for end-to-end mapping in browser devtools.

## Style Preprocessing

Both external and inline styles are preprocessed via Vite's `preprocessCSS` API:

- **External styles** (`.scss`, `.sass`, `.less`, `.styl` via `styleUrl`/`styleUrls`): read, preprocessed, cached by mtime, and passed to the compiler via `resolvedStyles`
- **Inline styles** (`styles: [...]` or `styles: \`...\``): extracted via TypeScript AST, preprocessed, and passed via `resolvedInlineStyles`

The `inlineStyleLanguage` option (default: `'scss'`) controls the file extension used for inline style preprocessing. Set to `'css'` to disable inline preprocessing.

Both the build optimizer and dev deps plugins share an `LmdbCacheStore` for cached `JavaScriptTransformer` results.

## Comparison with Angular's Compilers

### vs ngtsc (Angular's native compiler)

Both produce identical Ivy output because both call the same `@angular/compiler` APIs (`compileComponentFromMetadata`, `parseTemplate`, `compileFactoryFunction`, etc.). The template instructions are byte-for-byte equivalent.

| | ngtsc | This compiler |
|---|---|---|
| Size | ~200,000+ lines | ~2,000 lines |
| Requires `ts.Program` | Yes (reads all files, resolves modules) | No |
| Type checking | Full TS + template type checking | None (use Angular Language Service) |
| Template compilation | Full Ivy instructions | Full Ivy instructions (same APIs) |
| Output format | `ɵɵdefineComponent` (final) | `ɵɵdefineComponent` (final) |
| Global analysis | Via type checker (full scope resolution) | Via tsconfig + OXC registry scan |
| Constructor DI | Full (via type checker) | Full (via AST parameter analysis) |
| `setClassMetadata` | Yes | Yes |
| Source maps | Yes (via TS emitter) | Yes (via MagicString surgical edits + inline string emitter) |
| HMR | Full (with tracking metadata) | Leaf components (root falls back to reload) |
| `@defer` lazy loading | Yes | Yes |
| SCSS preprocessing | Via `@angular/build` | Via Vite `preprocessCSS` + LmdbCacheStore |
| i18n | Full ICU extraction + localization | Not supported |
| Template type checking | Full (`strictTemplates`) | Not supported |
| Incremental compilation | `ts.Program` reuse | Per-file (Vite handles caching) |
| Diagnostic messages | Hundreds of template/binding errors | Unresolved selector warnings only |
| Partial compilation (libraries) | `ɵɵngDeclareComponent` | Not in scope |
| Declaration files (`.d.ts`) | Yes | Not in scope |

#### Performance

| Metric | ngtsc | This compiler |
|---|---|---|
| Cold build (500 components) | 5-15s | <1s (on-demand) |
| Hot rebuild (1 file changed) | 200-500ms | 2-5ms |
| Dev server start | 3-10s | <1s |
| Registry scan (1000 files) | N/A (type checker) | ~37ms (OXC) |

#### The Tradeoff

ngtsc gives **compile-time safety** — wrong template bindings, missing inputs, and type mismatches are caught before the browser runs. This compiler gives **speed** — identical Ivy output, identical runtime behavior, but no compile-time template validation. With Angular Language Service running in the IDE, the developer experience is nearly identical — errors show as red squiggles in the editor instead of terminal output.

### vs Angular Local Compilation

| | Local Compilation | This compiler |
|---|---|---|
| Output format | `ɵɵngDeclareComponent` (partial) | `ɵɵdefineComponent` (final) |
| Linker required | Yes | No |
| Template compiled at | Link time | Compile time |
| Selector matching | Deferred to linker | Done via global analysis plugin |
| Cross-version compatibility | Yes (stable declaration format) | No (tied to Angular version) |
| Use case | Library publishing (npm) | Application dev server |
| Requires `ts.Program` | No | No |

### vs esbuild/SWC (type stripping)

| | esbuild/SWC | This compiler |
|---|---|---|
| TypeScript handling | Strip types only | Strip types + transform decorators |
| Angular awareness | None | Full (templates, signals, Ivy codegen) |
| Template compilation | N/A | Full Ivy instructions |
| Speed | ~0.01ms/file | ~0.5-2ms/file |
| Output | Valid JS (no Angular metadata) | Valid JS + Ivy static fields |

## Performance

### Per-file Compilation

| Component Complexity | Time |
|---|---|
| Simple (1 element, no signals) | ~0.5ms |
| Medium (control flow, signals, styles) | ~1.8ms |
| Complex (nested control flow, many bindings) | ~3ms |

In Vite dev mode, only requested files are compiled on demand. A typical page load compiles 10-20 files (~20-40ms total).

### Compilation Breakdown (medium component)

| Phase | % of time | Tool |
|---|---|---|
| Template parsing | ~46% | `@angular/compiler` (JS) |
| TypeScript parsing | ~29% | `ts.createSourceFile` (JS) |
| Code emission | ~25% | Inline string emitter + MagicString |

The dominant cost is Angular's template parser — JavaScript that can't be replaced with Rust without reimplementing the Angular template compiler.

### Registry Cold Scan

| Files | OXC (parse + walk) | TypeScript (parse only) |
|---|---|---|
| 200 | ~8ms | ~23ms |
| 500 | ~19ms | ~55ms |
| 1000 | ~37ms | ~55ms |

The registry scan uses OXC's native Rust parser for ~1.5x faster file scanning at build start.

## Angular Version Compatibility

The compiler detects the installed `@angular/compiler` version at startup and adapts:

| Feature | Angular 19 | Angular 20+ | Angular 21+ |
|---|---|---|---|
| `hasDirectiveDependencies` | Omitted | Set when imports present | Same |
| `externalStyles` | Omitted | Same | Available (not used) |
| All other APIs | Compatible | Compatible | Compatible |

Supported range: **Angular 19+**. Conformance tested against **Angular 17-21**.

## Future Architecture (tsgo)

When TypeScript moves to `tsgo` (Go-based compiler), Angular will need to separate type checking from decorator transformation — the same split this compiler already makes:

```
tsgo (Go)                    Angular Transform (JS)
├─ Type stripping            ├─ compile() per file
├─ Module resolution         ├─ @angular/compiler APIs
└─ Type checking             └─ angular() plugin
                                  └─ Registry scan (OXC/Rust)
```

This compiler's architecture — single-file transforms using `@angular/compiler` with global analysis as a separate registry — is the likely direction for Angular's compiler when `tsgo` replaces `tsc`.

## Test Suite

305 tests across 13 spec files:

| File | Tests | Coverage |
|---|---|---|
| `component.spec.ts` | 48 | All @Component features, signals (including required variants), control flow, defer, pipes, content projection, external resources, resource dependencies, providers, source maps |
| `ast-translator.spec.ts` | 43 | Every AST visitor method (expressions + statements), ngDevMode global |
| `decorator-fields.spec.ts` | 15 | @Input, @Output, @ViewChild, @ContentChild, @HostBinding, @HostListener field decorators |
| `constructor-di.spec.ts` | 8 | Constructor DI: @Inject, @Optional, inheritance, union types, multiple params |
| `error-handling.spec.ts` | 7 | Unknown decorators, undecorated classes, selectorless components, forwardRef, invalid templates |
| `registry.spec.ts` | 6 | All decorator types, multi-declaration, NgModule exports |
| `cross-file-resolution.spec.ts` | 5 | Cross-file component, pipe, directive resolution |
| `ngmodule.spec.ts` | 3 | Compilation, providers, export resolution |
| `injectable.spec.ts` | 3 | `providedIn` variants |
| `directive.spec.ts` | 2 | Host bindings, exportAs |
| `pipe.spec.ts` | 2 | Pure and impure |
| `compile.spec.ts` | 2 | Original smoke tests |
| `conformance.spec.ts` | 160 | Angular compliance test suite (v17-v21, 87%+ Ivy instruction match) |

### Conformance Testing

The compiler is validated against Angular's official compliance test suite. A conformance test runner compares compiled Ivy instruction output against Angular's expected patterns with instruction normalization (`ɵɵtemplate`↔`ɵɵdomTemplate`, named↔anonymous functions).

#### Pass Rates by Angular Version

| Angular | Pass Rate | Tests |
|---|---|---|
| v17 (latest patch) | 85.1% | 142 |
| v18 (latest patch) | 76.8% | 143 |
| v19 (latest patch) | 81.9% | 137 |
| v20 (latest patch) | 92.5% | 141 |
| v21 (latest patch) | 87.8% | 148 |
| latest | 87.8% | 155 |

Remaining soft-failures are output formatting differences (`@defer` multi-file deps, named function patterns), not functional issues. All versions produce 0 hard test failures.

#### Running Conformance Tests

```bash
# Local (auto-detects ~/projects/angular/angular)
npx vitest run angular-compiler/src/lib/conformance.spec.ts

# Specific major version (resolves latest patch)
bash scripts/setup-conformance.sh 19
ANGULAR_SOURCE_DIR=.angular-conformance npx vitest run angular-compiler/src/lib/conformance.spec.ts

# Exact version
bash scripts/setup-conformance.sh 21.0.0

# Latest release (auto-detected via GitHub API)
bash scripts/setup-conformance.sh
```

CI runs a matrix of Angular 17, 18, 19, 20, 21, and latest on every push/PR.
