import { describe, it, expect } from 'vitest';
import { jitTransform } from './jit-transform';

function transform(code: string): string {
  return jitTransform(code, 'test.ts').code;
}

describe('JIT Transform', () => {
  describe('Decorator Preservation', () => {
    it('preserves @Component decorator', () => {
      const result = transform(`
        import { Component } from '@angular/core';
        @Component({ selector: 'app-test', template: '<p>hi</p>' })
        export class TestComponent {}
      `);

      expect(result).toContain('@Component');
      expect(result).toContain("selector: 'app-test'");
      expect(result).toContain("template: '<p>hi</p>'");
    });

    it('preserves @Directive decorator', () => {
      const result = transform(`
        import { Directive } from '@angular/core';
        @Directive({ selector: '[appHighlight]' })
        export class HighlightDirective {}
      `);

      expect(result).toContain('@Directive');
      expect(result).toContain('[appHighlight]');
    });

    it('preserves @Pipe decorator', () => {
      const result = transform(`
        import { Pipe } from '@angular/core';
        @Pipe({ name: 'myPipe' })
        export class MyPipe { transform(v: string) { return v; } }
      `);

      expect(result).toContain('@Pipe');
      expect(result).toContain("name: 'myPipe'");
    });

    it('preserves @Injectable decorator', () => {
      const result = transform(`
        import { Injectable } from '@angular/core';
        @Injectable({ providedIn: 'root' })
        export class MyService {}
      `);

      expect(result).toContain('@Injectable');
      expect(result).toContain("providedIn: 'root'");
    });

    it('preserves @NgModule decorator', () => {
      const result = transform(`
        import { NgModule } from '@angular/core';
        @NgModule({ imports: [], exports: [] })
        export class MyModule {}
      `);

      expect(result).toContain('@NgModule');
    });
  });

  describe('Factory Emission', () => {
    it('emits ɵfac for components', () => {
      const result = transform(`
        import { Component } from '@angular/core';
        @Component({ selector: 'x', template: '' })
        export class X {}
      `);

      expect(result).toContain('ɵfac');
      expect(result).toContain('new (__ngFactoryType__ || X)()');
    });

    it('emits ɵfac for directives', () => {
      const result = transform(`
        import { Directive } from '@angular/core';
        @Directive({ selector: '[x]' })
        export class X {}
      `);

      expect(result).toContain('ɵfac');
    });

    it('emits ɵfac for pipes', () => {
      const result = transform(`
        import { Pipe } from '@angular/core';
        @Pipe({ name: 'x' })
        export class X { transform(v: any) { return v; } }
      `);

      expect(result).toContain('ɵfac');
    });

    it('emits ɵfac for injectables', () => {
      const result = transform(`
        import { Injectable } from '@angular/core';
        @Injectable()
        export class X {}
      `);

      expect(result).toContain('ɵfac');
    });
  });

  describe('No Template Compilation', () => {
    it('does NOT emit ɵcmp', () => {
      const result = transform(`
        import { Component } from '@angular/core';
        @Component({ selector: 'x', template: '<p>{{ title }}</p>' })
        export class X { title = 'hello'; }
      `);

      expect(result).not.toContain('ɵcmp');
      expect(result).not.toContain('ɵɵdefineComponent');
      expect(result).not.toContain('ɵɵelementStart');
      expect(result).not.toContain('ɵɵdomElementStart');
      expect(result).not.toContain('ɵɵtextInterpolate');
    });

    it('does NOT emit ɵdir', () => {
      const result = transform(`
        import { Directive } from '@angular/core';
        @Directive({ selector: '[x]' })
        export class X {}
      `);

      expect(result).not.toContain('ɵdir');
      expect(result).not.toContain('ɵɵdefineDirective');
    });

    it('does NOT emit ɵpipe', () => {
      const result = transform(`
        import { Pipe } from '@angular/core';
        @Pipe({ name: 'x' })
        export class X { transform(v: any) { return v; } }
      `);

      expect(result).not.toContain('ɵpipe');
      expect(result).not.toContain('ɵɵdefinePipe');
    });
  });

  describe('Signal Metadata', () => {
    it('emits ɵsignals for signal inputs', () => {
      const result = transform(`
        import { Component, input } from '@angular/core';
        @Component({ selector: 'x', template: '' })
        export class X {
          name = input<string>();
          id = input.required<number>();
        }
      `);

      expect(result).toContain('ɵsignals');
      expect(result).toContain('inputs');
      expect(result).toContain('name');
      expect(result).toContain('id');
      // Required flag
      expect(result).toContain('required: true');
      expect(result).toContain('required: false');
    });

    it('emits ɵsignals for model signals', () => {
      const result = transform(`
        import { Component, model } from '@angular/core';
        @Component({ selector: 'x', template: '' })
        export class X {
          value = model(0);
        }
      `);

      expect(result).toContain('ɵsignals');
      expect(result).toContain('models');
      expect(result).toContain('"value"');
    });

    it('emits ɵsignals for signal outputs', () => {
      const result = transform(`
        import { Component, output } from '@angular/core';
        @Component({ selector: 'x', template: '' })
        export class X {
          clicked = output<void>();
        }
      `);

      expect(result).toContain('ɵsignals');
      expect(result).toContain('outputs');
      expect(result).toContain('"clicked"');
    });

    it('emits ɵsignals for signal queries', () => {
      const result = transform(`
        import { Component, viewChild, contentChildren } from '@angular/core';
        @Component({ selector: 'x', template: '' })
        export class X {
          myRef = viewChild('ref');
          items = contentChildren('item');
        }
      `);

      expect(result).toContain('ɵsignals');
      expect(result).toContain('queries');
      expect(result).toContain('myRef');
      expect(result).toContain('"view"');
      expect(result).toContain('items');
      expect(result).toContain('"content"');
    });

    it('does NOT emit ɵsignals when no signal APIs are used', () => {
      const result = transform(`
        import { Component } from '@angular/core';
        @Component({ selector: 'x', template: '' })
        export class X {
          count = 0;
          increment() { this.count++; }
        }
      `);

      expect(result).not.toContain('ɵsignals');
    });

    it('emits all signal types together', () => {
      const result = transform(`
        import { Component, input, model, output, viewChild } from '@angular/core';
        @Component({ selector: 'x', template: '' })
        export class X {
          name = input('default');
          count = model(0);
          clicked = output<void>();
          myRef = viewChild('ref');
        }
      `);

      expect(result).toContain('ɵsignals');
      expect(result).toContain('inputs');
      expect(result).toContain('models');
      expect(result).toContain('outputs');
      expect(result).toContain('queries');
    });
  });

  describe('Edge Cases', () => {
    it('skips non-Angular decorators', () => {
      const result = transform(`
        import { SomeDecorator } from 'somewhere';
        @SomeDecorator()
        export class X {}
      `);

      expect(result).toContain('@SomeDecorator');
      expect(result).not.toContain('ɵfac');
    });

    it('handles class without decorators', () => {
      const result = transform(`
        export class PlainClass { value = 42; }
      `);

      expect(result).toContain('PlainClass');
      expect(result).not.toContain('ɵfac');
    });

    it('handles default export', () => {
      const result = transform(`
        import { Component } from '@angular/core';
        @Component({ selector: 'x', template: '' })
        export default class MyPage {}
      `);

      expect(result).toContain('@Component');
      expect(result).toContain('ɵfac');
      expect(result).toContain('export default');
    });

    it('injects i0 import', () => {
      const result = transform(`
        import { Component } from '@angular/core';
        @Component({ selector: 'x', template: '' })
        export class X {}
      `);

      expect(result).toContain('import * as i0 from "@angular/core"');
    });
  });
});
