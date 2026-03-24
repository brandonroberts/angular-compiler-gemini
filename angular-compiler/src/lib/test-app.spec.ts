import { describe, it, expect } from 'vitest';
import { compile } from './compile';
import { scanFile, ComponentRegistry } from './registry';

function buildRegistry(files: Record<string, string>): ComponentRegistry {
  const registry: ComponentRegistry = new Map();
  for (const [fileName, code] of Object.entries(files)) {
    for (const entry of scanFile(code, fileName)) {
      registry.set(entry.className, entry);
    }
  }
  return registry;
}

function expectCompiles(result: string) {
  expect(result).toBeTruthy();
  // Check for compilation errors (thrown as Error: messages), not the word "Error" in template content
  expect(result).not.toMatch(/^Error:/m);
}

describe('Exhaustive Angular Compiler Validation', () => {

  // ─── @Component basics ────────────────────────────────────────────

  describe('Basic @Component', () => {
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
    });
  });

  // ─── Signal Inputs ────────────────────────────────────────────────

  describe('Signal Inputs', () => {
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
      // Signal inputs use array descriptor format
      expect(result).toContain('name: [');
      expect(result).toContain('id: [');
    });
  });

  // ─── Model Signals ────────────────────────────────────────────────

  describe('Model Signals', () => {
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
  });

  // ─── Signal Outputs ───────────────────────────────────────────────

  describe('Signal Outputs', () => {
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
    });
  });

  // ─── computed() and signal() ──────────────────────────────────────

  describe('computed() and signal()', () => {
    it('compiles component using computed and signal', () => {
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
    });
  });

  // ─── Signal Queries ───────────────────────────────────────────────

  describe('Signal Queries', () => {
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
      expect(result).toContain('ɵcmp');
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
      expect(result).toContain('ɵcmp');
    });
  });

  // ─── Control Flow ─────────────────────────────────────────────────

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
      expect(result).toContain('ɵcmp');
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
      expect(result).toContain('ɵcmp');
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
      expect(result).toContain('ɵcmp');
    });
  });

  // ─── @defer ───────────────────────────────────────────────────────

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
      expect(result).toContain('ɵcmp');
    });
  });

  // ─── @Directive ───────────────────────────────────────────────────

  describe('@Directive', () => {
    it('compiles directive with host bindings and listeners', () => {
      const result = compile(`
        import { Component, Directive, input, output, signal } from '@angular/core';
        @Directive({
          selector: '[appHighlight]',
          host: {
            '(mouseenter)': 'onEnter()',
            '(mouseleave)': 'onLeave()',
            '[style.backgroundColor]': 'bgColor()',
            '[class.active]': 'isActive()'
          }
        })
        export class HighlightDirective {
          color = input('yellow');
          highlighted = output<boolean>();
          bgColor = signal('');
          isActive = signal(false);
          onEnter() {}
          onLeave() {}
        }
      `, 'highlight.ts');

      expectCompiles(result);
      expect(result).toContain('ɵdir');
      expect(result).toContain('ɵfac');
      expect(result).toContain('appHighlight');
    });

    it('compiles directive with exportAs', () => {
      const result = compile(`
        import { Directive } from '@angular/core';
        @Directive({
          selector: '[appDraggable]',
          exportAs: 'draggable'
        })
        export class DraggableDirective {}
      `, 'draggable.ts');

      expectCompiles(result);
      expect(result).toContain('ɵdir');
      expect(result).toContain('draggable');
    });
  });

  // ─── @Pipe ────────────────────────────────────────────────────────

  describe('@Pipe', () => {
    it('compiles pure pipe', () => {
      const result = compile(`
        import { Pipe } from '@angular/core';
        @Pipe({ name: 'truncate' })
        export class TruncatePipe {
          transform(value: string, limit: number): string {
            return value.length > limit ? value.substring(0, limit) + '...' : value;
          }
        }
      `, 'truncate.pipe.ts');

      expectCompiles(result);
      expect(result).toContain('ɵpipe');
      expect(result).toContain('ɵfac');
      expect(result).toContain('truncate');
      expect(result).toContain('pure: true');
    });

    it('compiles impure pipe', () => {
      const result = compile(`
        import { Pipe } from '@angular/core';
        @Pipe({ name: 'timeAgo', pure: false })
        export class TimeAgoPipe {
          transform(value: Date): string { return ''; }
        }
      `, 'time-ago.pipe.ts');

      expectCompiles(result);
      expect(result).toContain('ɵpipe');
      expect(result).toContain('timeAgo');
      expect(result).toContain('pure: false');
    });
  });

  // ─── @Injectable ──────────────────────────────────────────────────

  describe('@Injectable', () => {
    it('compiles with providedIn root', () => {
      const result = compile(`
        import { Injectable } from '@angular/core';
        @Injectable({ providedIn: 'root' })
        export class DataService {}
      `, 'data.service.ts');

      expectCompiles(result);
      expect(result).toContain('ɵprov');
      expect(result).toContain('ɵfac');
      expect(result).toContain('root');
    });

    it('compiles with providedIn platform', () => {
      const result = compile(`
        import { Injectable } from '@angular/core';
        @Injectable({ providedIn: 'platform' })
        export class PlatformService {}
      `, 'platform.service.ts');

      expectCompiles(result);
      expect(result).toContain('ɵprov');
      expect(result).toContain('platform');
    });

    it('compiles without providedIn (defaults to root)', () => {
      const result = compile(`
        import { Injectable } from '@angular/core';
        @Injectable()
        export class ScopedService {}
      `, 'scoped.service.ts');

      expectCompiles(result);
      expect(result).toContain('ɵprov');
    });
  });

  // ─── Content Projection ───────────────────────────────────────────

  describe('Content Projection', () => {
    it('compiles multi-slot ng-content', () => {
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
      expect(result).toContain('ɵcmp');
      expect(result).toContain('ngContentSelectors');
    });
  });

  // ─── Bindings ─────────────────────────────────────────────────────

  describe('Event, Property, and Two-way Bindings', () => {
    it('compiles property and event bindings with registry', () => {
      const childSrc = `
        import { Component, input, output } from '@angular/core';
        @Component({ selector: 'child-cmp', template: '<span>{{ title() }}</span>' })
        export class ChildComponent {
          title = input('');
          save = output<string>();
        }
      `;

      const parentSrc = `
        import { Component, signal } from '@angular/core';
        import { ChildComponent } from './child';
        @Component({
          selector: 'app-parent',
          template: '<child-cmp [title]="myTitle()" (save)="onSave($event)"></child-cmp>',
          imports: [ChildComponent]
        })
        export class ParentComponent {
          myTitle = signal('Hello');
          onSave(val: string) {}
        }
      `;

      const registry = buildRegistry({ 'child.ts': childSrc });
      const result = compile(parentSrc, 'parent.ts', registry);

      expectCompiles(result);
      expect(result).toContain('ɵcmp');
      // Should use ɵɵproperty (not ɵɵdomProperty) since child-cmp is known
      expect(result).toContain('ɵɵproperty');
      expect(result).not.toContain('ɵɵdomProperty');
    });

    it('compiles two-way binding syntax', () => {
      const childSrc = `
        import { Component, model } from '@angular/core';
        @Component({ selector: 'app-slider', template: '<input />' })
        export class SliderComponent {
          value = model(0);
        }
      `;

      const parentSrc = `
        import { Component, signal } from '@angular/core';
        import { SliderComponent } from './slider';
        @Component({
          selector: 'app-two-way',
          template: '<app-slider [(value)]="current"></app-slider>',
          imports: [SliderComponent]
        })
        export class TwoWayComponent {
          current = signal(50);
        }
      `;

      const registry = buildRegistry({ 'slider.ts': childSrc });
      const result = compile(parentSrc, 'two-way.ts', registry);

      expectCompiles(result);
      expect(result).toContain('ɵcmp');
    });
  });

  // ─── Same-file resolution ─────────────────────────────────────────

  describe('Multiple Components in Same File', () => {
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
      // Both components compiled
      expect(result).toContain('BadgeComponent');
      expect(result).toContain('ProfileComponent');
      // ProfileComponent should reference app-badge selector
      expect(result).toContain('app-badge');
    });
  });

  // ─── Cross-file component references ──────────────────────────────

  describe('Cross-file Component References', () => {
    it('resolves component selector via registry', () => {
      const buttonSrc = `
        import { Component } from '@angular/core';
        @Component({
          selector: 'ui-button',
          template: '<button><ng-content></ng-content></button>'
        })
        export class ButtonComponent {}
      `;

      const toolbarSrc = `
        import { Component } from '@angular/core';
        import { ButtonComponent } from './button';
        @Component({
          selector: 'app-toolbar',
          template: '<ui-button>Save</ui-button><ui-button>Cancel</ui-button>',
          imports: [ButtonComponent]
        })
        export class ToolbarComponent {}
      `;

      const registry = buildRegistry({ 'button.ts': buttonSrc });

      // Verify registry
      expect(registry.get('ButtonComponent')?.selector).toBe('ui-button');

      const result = compile(toolbarSrc, 'toolbar.ts', registry);

      expectCompiles(result);
      expect(result).toContain('ɵcmp');
      // Should use ɵɵelement (not ɵɵdomElement) since ui-button is known
      expect(result).not.toContain('ɵɵdomElement');
    });
  });

  // ─── Cross-file pipe references ───────────────────────────────────

  describe('Cross-file Pipe References', () => {
    it('resolves pipe via registry', () => {
      const pipeSrc = `
        import { Pipe } from '@angular/core';
        @Pipe({ name: 'shout' })
        export class ShoutPipe {
          transform(v: string) { return v.toUpperCase() + '!'; }
        }
      `;

      const componentSrc = `
        import { Component, signal } from '@angular/core';
        import { ShoutPipe } from './shout.pipe';
        @Component({
          selector: 'app-greeting',
          template: '{{ name() | shout }}',
          imports: [ShoutPipe]
        })
        export class GreetingComponent {
          name = signal('hello');
        }
      `;

      const registry = buildRegistry({ 'shout.pipe.ts': pipeSrc });

      // Verify pipe registry entry
      expect(registry.get('ShoutPipe')?.kind).toBe('pipe');
      expect(registry.get('ShoutPipe')?.pipeName).toBe('shout');

      const result = compile(componentSrc, 'greeting.ts', registry);

      expectCompiles(result);
      expect(result).toContain('ɵcmp');
      expect(result).toContain('ShoutPipe');
    });
  });

  // ─── Cross-file directive references ──────────────────────────────

  describe('Cross-file Directive References', () => {
    it('resolves directive via registry', () => {
      const directiveSrc = `
        import { Directive, input } from '@angular/core';
        @Directive({
          selector: '[appTooltip]',
          host: { '(mouseenter)': 'show()', '(mouseleave)': 'hide()' }
        })
        export class TooltipDirective {
          text = input.required<string>();
          show() {}
          hide() {}
        }
      `;

      const componentSrc = `
        import { Component, signal } from '@angular/core';
        import { TooltipDirective } from './tooltip.directive';
        @Component({
          selector: 'app-icon',
          template: '<span appTooltip [text]="tip()">icon</span>',
          imports: [TooltipDirective]
        })
        export class IconComponent {
          tip = signal('Info');
        }
      `;

      const registry = buildRegistry({ 'tooltip.directive.ts': directiveSrc });

      expect(registry.get('TooltipDirective')?.selector).toBe('[appTooltip]');
      expect(registry.get('TooltipDirective')?.kind).toBe('directive');

      const result = compile(componentSrc, 'icon.ts', registry);

      expectCompiles(result);
      expect(result).toContain('ɵcmp');
      expect(result).toContain('TooltipDirective');
    });
  });

  // ─── inject() usage ───────────────────────────────────────────────

  describe('inject() usage', () => {
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

  // ─── changeDetection and encapsulation ────────────────────────────

  describe('changeDetection and encapsulation', () => {
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
  });

  // ─── templateUrl and styleUrls ────────────────────────────────────

  describe('templateUrl and styleUrls', () => {
    it('generates imports for external resources', () => {
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
      // Should import template as raw string
      expect(result).toContain('./external.component.html?raw');
      // Should import stylesheet
      expect(result).toContain('./external.component.css');
    });
  });

  // ─── Registry / scanFile validation ───────────────────────────────

  describe('Registry scanFile', () => {
    it('extracts component metadata', () => {
      const entries = scanFile(`
        import { Component } from '@angular/core';
        @Component({ selector: 'app-test', template: '' })
        export class TestComponent {}
      `, 'test.ts');

      expect(entries).toHaveLength(1);
      expect(entries[0].selector).toBe('app-test');
      expect(entries[0].kind).toBe('component');
      expect(entries[0].className).toBe('TestComponent');
    });

    it('extracts directive metadata', () => {
      const entries = scanFile(`
        import { Directive } from '@angular/core';
        @Directive({ selector: '[appTest]' })
        export class TestDirective {}
      `, 'test.ts');

      expect(entries).toHaveLength(1);
      expect(entries[0].selector).toBe('[appTest]');
      expect(entries[0].kind).toBe('directive');
    });

    it('extracts pipe metadata', () => {
      const entries = scanFile(`
        import { Pipe } from '@angular/core';
        @Pipe({ name: 'myPipe' })
        export class MyPipe {}
      `, 'test.ts');

      expect(entries).toHaveLength(1);
      expect(entries[0].kind).toBe('pipe');
      expect(entries[0].pipeName).toBe('myPipe');
      expect(entries[0].selector).toBe('myPipe');
    });

    it('skips files without decorators', () => {
      const entries = scanFile(`
        export class PlainClass {}
        export function helper() {}
      `, 'plain.ts');

      expect(entries).toHaveLength(0);
    });

    it('extracts multiple declarations from one file', () => {
      const entries = scanFile(`
        import { Component, Directive, Pipe } from '@angular/core';
        @Component({ selector: 'app-a', template: '' })
        export class AComponent {}
        @Directive({ selector: '[appB]' })
        export class BDirective {}
        @Pipe({ name: 'cPipe' })
        export class CPipe {}
      `, 'multi.ts');

      expect(entries).toHaveLength(3);
      expect(entries.map(e => e.kind)).toEqual(['component', 'directive', 'pipe']);
    });
  });

  // ─── Edge cases ───────────────────────────────────────────────────

  describe('Edge Cases', () => {
    it('compiles component with empty template', () => {
      const result = compile(`
        import { Component } from '@angular/core';
        @Component({ selector: 'app-empty', template: '' })
        export class EmptyComponent {}
      `, 'empty.ts');

      expectCompiles(result);
      expect(result).toContain('ɵcmp');
    });

    it('compiles component with multiple signal types', () => {
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
      expect(result).toContain('ɵcmp');
      expect(result).toContain('name: [');
      expect(result).toContain('count: [');
      expect(result).toContain('clicked: "clicked"');
      expect(result).toContain('countChange: "countChange"');
    });

    it('compiles component with nested control flow', () => {
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
      expect(result).toContain('ɵcmp');
    });
  });
});
