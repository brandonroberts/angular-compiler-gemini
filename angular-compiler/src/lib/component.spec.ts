import { describe, it, expect } from 'vitest';
import { compile } from './compile';
import { expectCompiles } from './test-helpers';

describe('@Component', () => {
  it('compiles a component with template and styles', () => {
    const result = compile(`
      import { Component, signal } from '@angular/core';
      @Component({
        selector: 'app-hello',
        template: '<h1>Hello {{ title() }}</h1>',
        styles: [':host { display: block; }']
      })
      export class HelloComponent {
        title = signal('World');
      }
    `, 'hello.ts');

    expectCompiles(result);
    expect(result).toContain('ɵfac');
    expect(result).toContain('ɵcmp');
    expect(result).toContain('app-hello');
    // Decorator is stripped
    expect(result).not.toContain('@Component');
    // Angular core namespace injected
    expect(result).toContain('import * as i0 from "@angular/core"');
    // Factory function is correct
    expect(result).toContain('new (__ngFactoryType__ || HelloComponent)()');
    // Template function emitted
    expect(result).toMatch(/template:\s*\(rf, ctx\)/);
    // Text interpolation instruction
    expect(result).toContain('ɵɵtextInterpolate');
  });

  it('compiles component with empty template', () => {
    const result = compile(`
      import { Component } from '@angular/core';
      @Component({ selector: 'app-empty', template: '' })
      export class EmptyComponent {}
    `, 'empty.ts');

    expectCompiles(result);
    expect(result).toContain('ɵcmp');
    expect(result).toContain('decls: 0');
    expect(result).toContain('vars: 0');
  });

  it('preserves user imports', () => {
    const result = compile(`
      import { Component, signal } from '@angular/core';
      @Component({ selector: 'app-test', template: '' })
      export class TestComponent {
        x = signal(0);
      }
    `, 'test.ts');

    expect(result).toContain("import { Component, signal } from '@angular/core'");
  });

  describe('Signals', () => {
    it('detects input() and input.required()', () => {
      const result = compile(`
        import { Component, input } from '@angular/core';
        @Component({
          selector: 'app-input-test',
          template: '<span>{{ name() }} {{ id() }}</span>'
        })
        export class InputTestComponent {
          name = input<string>();
          id = input.required<number>();
        }
      `, 'input-test.ts');

      expectCompiles(result);
      // Signal inputs use array descriptor format [flags, publicName, className, transform]
      expect(result).toContain('name: [');
      expect(result).toContain('id: [');
    });

    it('generates input + output for model()', () => {
      const result = compile(`
        import { Component, model } from '@angular/core';
        @Component({ selector: 'app-model', template: '{{ value() }}' })
        export class ModelComponent {
          value = model(0);
        }
      `, 'model.ts');

      expectCompiles(result);
      expect(result).toContain('value: [');
      expect(result).toContain('valueChange: "valueChange"');
    });

    it('detects output()', () => {
      const result = compile(`
        import { Component, output } from '@angular/core';
        @Component({
          selector: 'app-output-test',
          template: '<button (click)="clicked.emit()">Click</button>'
        })
        export class OutputTestComponent {
          clicked = output<void>();
        }
      `, 'output-test.ts');

      expectCompiles(result);
      expect(result).toContain('clicked: "clicked"');
      // Event binding generates a listener (domListener in DomOnly mode for standalone without deps)
      expect(result).toContain('ɵɵdomListener');
    });

    it('compiles computed and signal', () => {
      const result = compile(`
        import { Component, signal, computed } from '@angular/core';
        @Component({
          selector: 'app-computed',
          template: '<span>{{ doubled() }}</span>'
        })
        export class ComputedComponent {
          count = signal(0);
          doubled = computed(() => this.count() * 2);
        }
      `, 'computed.ts');

      expectCompiles(result);
      expect(result).toContain('ɵcmp');
      expect(result).toContain('ɵɵtextInterpolate');
    });

    it('detects viewChild and viewChildren', () => {
      const result = compile(`
        import { Component, viewChild, viewChildren } from '@angular/core';
        @Component({
          selector: 'app-queries',
          template: '<input #myInput /><div #item></div>'
        })
        export class QueryComponent {
          myInput = viewChild('myInput');
          items = viewChildren('item');
        }
      `, 'queries.ts');

      expectCompiles(result);
      // View queries emit viewQuery instructions
      expect(result).toContain('ɵɵviewQuery');
    });

    it('detects contentChild and contentChildren', () => {
      const result = compile(`
        import { Component, contentChild, contentChildren } from '@angular/core';
        @Component({
          selector: 'app-content-queries',
          template: '<ng-content></ng-content>'
        })
        export class ContentQueryComponent {
          header = contentChild('header');
          panels = contentChildren('panel');
        }
      `, 'content-queries.ts');

      expectCompiles(result);
      // Content queries emit contentQuery instructions
      expect(result).toContain('ɵɵcontentQuery');
    });

    it('compiles all signal types together', () => {
      const result = compile(`
        import { Component, signal, computed, input, output, model, viewChild } from '@angular/core';
        @Component({
          selector: 'app-kitchen-sink',
          template: \`
            <span>{{ name() }} {{ count() }} {{ doubled() }}</span>
            <input #myRef />
          \`
        })
        export class KitchenSinkComponent {
          name = input('default');
          count = model(0);
          clicked = output<void>();
          internal = signal('state');
          doubled = computed(() => this.internal().length * 2);
          myRef = viewChild('myRef');
        }
      `, 'kitchen-sink.ts');

      expectCompiles(result);
      expect(result).toContain('name: [');
      expect(result).toContain('count: [');
      expect(result).toContain('clicked: "clicked"');
      expect(result).toContain('countChange: "countChange"');
      expect(result).toContain('ɵɵviewQuery');
    });
  });

  describe('Control Flow', () => {
    it('compiles @if / @else', () => {
      const result = compile(`
        import { Component, signal } from '@angular/core';
        @Component({
          selector: 'app-if',
          template: \`
            @if (show()) {
              <div>Visible</div>
            } @else {
              <div>Hidden</div>
            }
          \`
        })
        export class IfComponent {
          show = signal(true);
        }
      `, 'if.ts');

      expectCompiles(result);
      expect(result).toContain('ɵɵconditional');
      // Two template functions: one for if, one for else
      expect(result).toContain('IfComponent_Conditional');
    });

    it('compiles @for with track and @empty', () => {
      const result = compile(`
        import { Component, signal } from '@angular/core';
        @Component({
          selector: 'app-for',
          template: \`
            @for (item of items(); track item.id) {
              <span>{{ item.name }}</span>
            } @empty {
              <p>No items</p>
            }
          \`
        })
        export class ForComponent {
          items = signal<any[]>([]);
        }
      `, 'for.ts');

      expectCompiles(result);
      expect(result).toContain('ɵɵrepeaterCreate');
      expect(result).toContain('ɵɵrepeater');
    });

    it('compiles @for with implicit variables', () => {
      const result = compile(`
        import { Component, signal } from '@angular/core';
        @Component({
          selector: 'app-for-vars',
          template: \`
            @for (item of items(); track item; let i = $index, first = $first, last = $last) {
              <span>{{ i }} {{ first }} {{ last }} {{ item }}</span>
            }
          \`
        })
        export class ForVarsComponent {
          items = signal(['a', 'b', 'c']);
        }
      `, 'for-vars.ts');

      expectCompiles(result);
      expect(result).toContain('ɵɵrepeaterCreate');
    });

    it('compiles @switch / @case / @default', () => {
      const result = compile(`
        import { Component, signal } from '@angular/core';
        @Component({
          selector: 'app-switch',
          template: \`
            @switch (status()) {
              @case ('active') { <span>Active</span> }
              @case ('inactive') { <span>Inactive</span> }
              @default { <span>Unknown</span> }
            }
          \`
        })
        export class SwitchComponent {
          status = signal('active');
        }
      `, 'switch.ts');

      expectCompiles(result);
      expect(result).toContain('ɵɵconditional');
    });

    it('compiles nested control flow', () => {
      const result = compile(`
        import { Component, signal } from '@angular/core';
        @Component({
          selector: 'app-nested',
          template: \`
            @if (show()) {
              @for (item of items(); track item) {
                @if (item > 2) {
                  <span>{{ item }}</span>
                }
              }
            }
          \`
        })
        export class NestedComponent {
          show = signal(true);
          items = signal([1, 2, 3, 4]);
        }
      `, 'nested.ts');

      expectCompiles(result);
      expect(result).toContain('ɵɵconditional');
      expect(result).toContain('ɵɵrepeaterCreate');
    });
  });

  describe('@defer', () => {
    it('compiles @defer with loading/placeholder/error', () => {
      const result = compile(`
        import { Component } from '@angular/core';
        @Component({
          selector: 'app-defer',
          template: \`
            @defer (on viewport) {
              <div>Loaded</div>
            } @loading {
              <p>Loading...</p>
            } @placeholder {
              <p>Placeholder</p>
            } @error {
              <p>Error</p>
            }
          \`
        })
        export class DeferComponent {}
      `, 'defer.ts');

      expectCompiles(result);
      expect(result).toContain('ɵɵdefer');
      expect(result).toContain('ɵɵdeferOnViewport');
      // Sub-templates for each block
      expect(result).toContain('DeferComponent_Defer_');
      expect(result).toContain('DeferComponent_DeferLoading_');
      expect(result).toContain('DeferComponent_DeferPlaceholder_');
      expect(result).toContain('DeferComponent_DeferError_');
    });

    it('compiles @defer with idle trigger', () => {
      const result = compile(`
        import { Component } from '@angular/core';
        @Component({
          selector: 'app-defer-idle',
          template: \`
            @defer (on idle) {
              <p>Loaded</p>
            }
          \`
        })
        export class DeferIdleComponent {}
      `, 'defer-idle.ts');

      expectCompiles(result);
      expect(result).toContain('ɵɵdefer');
      expect(result).toContain('ɵɵdeferOnIdle');
    });

    it('compiles @defer with timer trigger', () => {
      const result = compile(`
        import { Component } from '@angular/core';
        @Component({
          selector: 'app-defer-timer',
          template: \`
            @defer (on timer(500ms)) {
              <p>Loaded</p>
            }
          \`
        })
        export class DeferTimerComponent {}
      `, 'defer-timer.ts');

      expectCompiles(result);
      expect(result).toContain('ɵɵdefer');
      expect(result).toContain('ɵɵdeferOnTimer');
    });
  });

  describe('Content Projection', () => {
    it('compiles multi-slot ng-content with correct selectors', () => {
      const result = compile(`
        import { Component } from '@angular/core';
        @Component({
          selector: 'app-card',
          template: \`
            <div class="header"><ng-content select="[card-header]"></ng-content></div>
            <div class="body"><ng-content></ng-content></div>
            <div class="footer"><ng-content select="[card-footer]"></ng-content></div>
          \`
        })
        export class CardComponent {}
      `, 'card.ts');

      expectCompiles(result);
      expect(result).toContain('ngContentSelectors');
      expect(result).toContain('ɵɵprojection');
      // Verify the selectors include the named slots
      expect(result).toContain('card-header');
      expect(result).toContain('card-footer');
    });
  });

  describe('Pipes in Templates', () => {
    it('compiles pipe usage in template', () => {
      const result = compile(`
        import { Component, Pipe, signal } from '@angular/core';

        @Pipe({ name: 'upper' })
        export class UpperPipe {
          transform(v: string) { return v.toUpperCase(); }
        }

        @Component({
          selector: 'app-piped',
          template: '{{ name() | upper }}',
          imports: [UpperPipe]
        })
        export class PipedComponent {
          name = signal('hello');
        }
      `, 'piped.ts');

      expectCompiles(result);
      expect(result).toContain('ɵɵpipe');
      expect(result).toContain('ɵɵpipeBind1');
    });

    it('compiles pipe with arguments', () => {
      const result = compile(`
        import { Component, Pipe, signal } from '@angular/core';

        @Pipe({ name: 'slice' })
        export class SlicePipe {
          transform(v: string, start: number, end: number) { return v.slice(start, end); }
        }

        @Component({
          selector: 'app-pipe-args',
          template: '{{ text() | slice:0:5 }}',
          imports: [SlicePipe]
        })
        export class PipeArgsComponent {
          text = signal('hello world');
        }
      `, 'pipe-args.ts');

      expectCompiles(result);
      expect(result).toContain('ɵɵpipe');
      expect(result).toContain('ɵɵpipeBind3');
    });

    it('compiles chained pipes', () => {
      const result = compile(`
        import { Component, Pipe, signal } from '@angular/core';

        @Pipe({ name: 'upper' })
        export class UpperPipe {
          transform(v: string) { return v.toUpperCase(); }
        }

        @Pipe({ name: 'exclaim' })
        export class ExclaimPipe {
          transform(v: string) { return v + '!'; }
        }

        @Component({
          selector: 'app-chained',
          template: '{{ name() | upper | exclaim }}',
          imports: [UpperPipe, ExclaimPipe]
        })
        export class ChainedComponent {
          name = signal('hello');
        }
      `, 'chained.ts');

      expectCompiles(result);
      // Two pipe instructions
      const pipeMatches = result.match(/ɵɵpipe\(/g);
      expect(pipeMatches?.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('Component Options', () => {
    it('handles OnPush change detection', () => {
      const result = compile(`
        import { Component, ChangeDetectionStrategy } from '@angular/core';
        @Component({
          selector: 'app-onpush',
          template: '<p>fast</p>',
          changeDetection: ChangeDetectionStrategy.OnPush
        })
        export class OnPushComponent {}
      `, 'onpush.ts');

      expectCompiles(result);
      expect(result).toContain('changeDetection: 0');
    });

    it('handles ViewEncapsulation.None', () => {
      const result = compile(`
        import { Component, ViewEncapsulation } from '@angular/core';
        @Component({
          selector: 'app-no-encap',
          template: '<p>global</p>',
          encapsulation: ViewEncapsulation.None
        })
        export class NoEncapComponent {}
      `, 'no-encap.ts');

      expectCompiles(result);
      expect(result).toContain('encapsulation: 2');
    });

    it('handles ViewEncapsulation.ShadowDom', () => {
      const result = compile(`
        import { Component, ViewEncapsulation } from '@angular/core';
        @Component({
          selector: 'app-shadow',
          template: '<p>shadow</p>',
          encapsulation: ViewEncapsulation.ShadowDom
        })
        export class ShadowComponent {}
      `, 'shadow.ts');

      expectCompiles(result);
      expect(result).toContain('encapsulation: 3');
    });

    it('generates imports for templateUrl and styleUrls', () => {
      const result = compile(`
        import { Component } from '@angular/core';
        @Component({
          selector: 'app-external',
          templateUrl: './external.component.html',
          styleUrls: ['./external.component.css']
        })
        export class ExternalComponent {}
      `, 'external.ts');

      expectCompiles(result);
      expect(result).toContain('ɵcmp');
      expect(result).toContain('./external.component.html?raw');
      expect(result).toContain('./external.component.css');
    });

    it('compiles component using inject()', () => {
      const result = compile(`
        import { Component, inject, signal } from '@angular/core';
        @Component({
          selector: 'app-injected',
          template: '{{ data() }}'
        })
        export class InjectedComponent {
          private http = inject(Object);
          data = signal('loaded');
        }
      `, 'injected.ts');

      expectCompiles(result);
      expect(result).toContain('ɵcmp');
    });
  });

  describe('Same-file Resolution', () => {
    it('resolves selectors without external registry', () => {
      const result = compile(`
        import { Component, input, signal } from '@angular/core';

        @Component({ selector: 'app-badge', template: '<span>{{ label() }}</span>' })
        export class BadgeComponent {
          label = input('');
        }

        @Component({
          selector: 'app-profile',
          template: '<app-badge [label]="username()"></app-badge>',
          imports: [BadgeComponent]
        })
        export class ProfileComponent {
          username = signal('Alice');
        }
      `, 'profile.ts');

      expectCompiles(result);
      // Both components compiled — decorators stripped, static fields added
      expect(result).not.toContain('@Component');
      expect(result).toContain('app-badge');
      // Both get factories
      expect(result).toMatch(/BadgeComponent.*ɵfac/s);
      expect(result).toMatch(/ProfileComponent.*ɵfac/s);
      // Dependencies array references BadgeComponent
      expect(result).toContain('dependencies');
    });
  });
});
