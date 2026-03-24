# Analog Angular Compiler

A lightweight Angular compiler that transforms decorators and signal-based reactive APIs into Ivy static definitions. Designed for fast dev server compilation via Vite, without requiring a full TypeScript program.

## Architecture

```
Source file (.ts)
  │
  ├─ Global Analysis Plugin (buildStart)
  │    OXC parser ──▶ scanFile() ──▶ ComponentRegistry
  │                                   (selectors, pipes, NgModule exports)
  │
  └─ Single-file Transform (per request)
       ts.createSourceFile ──▶ extractMetadata / detectSignals
         │
         ▼
       @angular/compiler
         parseTemplate()
         compileComponentFromMetadata()
         compileDirectiveFromMetadata()
         compilePipeFromMetadata()
         compileNgModule() / compileInjector()
         │
         ▼
       AstTranslator (Angular output AST → TypeScript AST)
         │
         ▼
       ts.Printer ──▶ JavaScript output
```

The compiler is split into two phases:

1. **Global analysis** (`global-analysis-plugin.ts`): A Vite plugin that scans all source files at build start using OXC's native Rust parser. Builds a `ComponentRegistry` mapping class names to selectors, pipe names, and NgModule exports.

2. **Single-file transform** (`compile.ts`): Per-file decorator-to-Ivy transformation. Receives the registry for cross-file dependency resolution. Emits final Ivy instructions directly — no linker step required.

## Source Files

| File | Lines | Purpose |
|---|---|---|
| `compile.ts` | 518 | Single-file compiler: decorator extraction, signal detection, Ivy codegen |
| `ast-translator.ts` | 290 | Angular output AST → TypeScript AST visitor (all expression/statement types) |
| `registry.ts` | 110 | OXC-based file scanner, `ComponentRegistry` type |
| `global-analysis-plugin.ts` | 133 | Vite plugin: registry build, transform orchestration, HMR invalidation |
| **Total** | **1,051** | |

## What's Supported

### Decorators

| Decorator | Static Fields | Notes |
|---|---|---|
| `@Component` | `ɵcmp`, `ɵfac` | Full template compilation with Ivy instructions |
| `@Directive` | `ɵdir`, `ɵfac` | Host bindings, listeners, inputs/outputs |
| `@Pipe` | `ɵpipe`, `ɵfac` | Pure and impure |
| `@Injectable` | `ɵprov`, `ɵfac` | `providedIn` variants |
| `@NgModule` | `ɵmod`, `ɵinj`, `ɵfac` | Declarations, exports, providers, bootstrap |

### @Component API Coverage

| Property | Status |
|---|---|
| `selector` | Supported |
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
| `input()` / `input.required()` | Yes (signal input descriptors) |
| `model()` | Yes (generates input + `Change` output) |
| `output()` | Yes |
| `viewChild()` / `viewChildren()` | Yes (signal queries) |
| `contentChild()` / `contentChildren()` | Yes (signal queries) |
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
| Source maps | Out of scope |
| `@defer` lazy dependency loading | Requires global analysis of which imports are defer-only |
| Partial / linker compilation | Handled by separate plugin |
| HMR (hot module replacement) | Requires `ngtsc` HMR tracking metadata; falls back to page reload |
| CSS scoping for `styleUrl` files | Styles are inlined as strings; SCSS requires Vite preprocessing |

## Comparison with Angular's Compilers

### vs ngtsc (Angular's full compiler)

| | ngtsc | This compiler |
|---|---|---|
| Requires `ts.Program` | Yes (reads all files, resolves modules) | No |
| Type checking | Full TS + template type checking | None |
| Template compilation | Full Ivy instructions | Full Ivy instructions |
| Output format | `ɵɵdefineComponent` (final) | `ɵɵdefineComponent` (final) |
| Linker required | No | No |
| Global analysis | Via type checker (full scope resolution) | Via registry scan (selector matching) |
| Dev rebuild speed | Medium (incremental `ts.Program` reuse) | Fast (single-file transform) |
| Cold build speed | Slow (full program creation) | Fast (on-demand per file) |

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
| Code printing | ~25% | `ts.Printer` (JS) |

The dominant cost is Angular's template parser — JavaScript that can't be replaced with Rust without reimplementing the Angular template compiler.

### Registry Cold Scan

| Files | OXC (parse + walk) | TypeScript (parse only) |
|---|---|---|
| 200 | ~8ms | ~23ms |
| 500 | ~19ms | ~55ms |
| 1000 | ~37ms | ~55ms |

The registry scan uses OXC's native Rust parser for ~1.5x faster file scanning at build start.

### Production Build

Full production build of the demo app (314 modules): **~1.2 seconds**.

## Angular Version Compatibility

The compiler detects the installed `@angular/compiler` version at startup and adapts:

| Feature | Angular 19 | Angular 20+ | Angular 21+ |
|---|---|---|---|
| `hasDirectiveDependencies` | Omitted | Set when imports present | Same |
| `externalStyles` | Omitted | Same | Available (not used) |
| All other APIs | Compatible | Compatible | Compatible |

Supported range: **Angular 19+**.

## Future Architecture (tsgo)

When TypeScript moves to `tsgo` (Go-based compiler), Angular will need to separate type checking from decorator transformation — the same split this compiler already makes:

```
tsgo (Go)                    Angular Transform (JS)
├─ Type stripping            ├─ compile() per file
├─ Module resolution         ├─ @angular/compiler APIs
└─ Type checking             └─ Global analysis plugin
                                  └─ Registry scan (OXC/Rust)
```

This compiler's architecture — single-file transforms using `@angular/compiler` with global analysis as a separate registry — is the likely direction for Angular's compiler when `tsgo` replaces `tsc`.

## Test Suite

107 tests across 11 spec files:

| File | Tests | Coverage |
|---|---|---|
| `component.spec.ts` | 37 | All @Component features, signals, control flow, defer, pipes, content projection, external resources |
| `ast-translator.spec.ts` | 42 | Every AST visitor method (expressions + statements) |
| `directive.spec.ts` | 2 | Host bindings, exportAs |
| `pipe.spec.ts` | 2 | Pure and impure |
| `injectable.spec.ts` | 3 | `providedIn` variants |
| `ngmodule.spec.ts` | 3 | Compilation, providers, export resolution |
| `registry.spec.ts` | 6 | All decorator types, multi-declaration, NgModule exports |
| `global-analysis.spec.ts` | 5 | Cross-file component, pipe, directive resolution |
| `error-handling.spec.ts` | 4 | Unknown decorators, undecorated classes, invalid templates |
| `compile.spec.ts` | 2 | Original smoke tests |
| `app.spec.ts` | 1 | Application-level test |
