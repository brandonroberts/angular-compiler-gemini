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

  describe('No Static Metadata', () => {
    it('does NOT emit ɵfac', () => {
      const result = transform(`
        import { Component } from '@angular/core';
        @Component({ selector: 'x', template: '' })
        export class X {}
      `);

      expect(result).not.toContain('ɵfac');
    });

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

    it('does NOT emit ɵprov', () => {
      const result = transform(`
        import { Injectable } from '@angular/core';
        @Injectable({ providedIn: 'root' })
        export class X {}
      `);

      expect(result).not.toContain('ɵprov');
    });

    it('does NOT emit ɵsignals', () => {
      const result = transform(`
        import { Component, input, model, output } from '@angular/core';
        @Component({ selector: 'x', template: '' })
        export class X {
          name = input('');
          count = model(0);
          clicked = output();
        }
      `);

      expect(result).not.toContain('ɵsignals');
    });

    it('does NOT inject i0 import', () => {
      const result = transform(`
        import { Component } from '@angular/core';
        @Component({ selector: 'x', template: '' })
        export class X {}
      `);

      expect(result).not.toContain('import * as i0');
    });
  });

  describe('Code Preservation', () => {
    it('preserves class members', () => {
      const result = transform(`
        import { Component, signal } from '@angular/core';
        @Component({ selector: 'x', template: '' })
        export class X {
          count = signal(0);
          increment() { this.count.update(c => c + 1); }
        }
      `);

      expect(result).toContain('count = signal(0)');
      expect(result).toContain('increment()');
    });

    it('preserves imports', () => {
      const result = transform(`
        import { Component, signal, input } from '@angular/core';
        @Component({ selector: 'x', template: '' })
        export class X { name = input(''); }
      `);

      expect(result).toContain("import { Component, signal, input } from '@angular/core'");
    });

    it('preserves non-Angular decorators', () => {
      const result = transform(`
        import { SomeDecorator } from 'somewhere';
        @SomeDecorator()
        export class X {}
      `);

      expect(result).toContain('@SomeDecorator');
    });

    it('preserves default exports', () => {
      const result = transform(`
        import { Component } from '@angular/core';
        @Component({ selector: 'x', template: '' })
        export default class MyPage {}
      `);

      expect(result).toContain('export default class');
      expect(result).toContain('@Component');
    });
  });
});
