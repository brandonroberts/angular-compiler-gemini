import { describe, it, expect } from 'vitest';
import { jitTransform } from './jit-transform';

function transform(code: string): string {
  return jitTransform(code, 'test.ts').code;
}

describe('JIT Transform', () => {
  describe('Decorator Conversion', () => {
    it('converts @Component to static decorators array', () => {
      const result = transform(`
        import { Component } from '@angular/core';
        @Component({ selector: 'app-test', template: '<p>hi</p>' })
        export class TestComponent {}
      `);

      // Decorator stripped from class
      expect(result).not.toMatch(/@Component/);
      // Static decorators array emitted
      expect(result).toContain('TestComponent.decorators');
      expect(result).toContain('type: Component');
      expect(result).toContain("selector: 'app-test'");
      expect(result).toContain("template: '<p>hi</p>'");
    });

    it('converts @Directive to static decorators array', () => {
      const result = transform(`
        import { Directive } from '@angular/core';
        @Directive({ selector: '[appHighlight]' })
        export class HighlightDirective {}
      `);

      expect(result).not.toMatch(/@Directive/);
      expect(result).toContain('HighlightDirective.decorators');
      expect(result).toContain('type: Directive');
    });

    it('converts @Pipe to static decorators array', () => {
      const result = transform(`
        import { Pipe } from '@angular/core';
        @Pipe({ name: 'myPipe' })
        export class MyPipe { transform(v: string) { return v; } }
      `);

      expect(result).not.toMatch(/@Pipe/);
      expect(result).toContain('MyPipe.decorators');
      expect(result).toContain('type: Pipe');
      expect(result).toContain("name: 'myPipe'");
    });

    it('converts @Injectable to static decorators array', () => {
      const result = transform(`
        import { Injectable } from '@angular/core';
        @Injectable({ providedIn: 'root' })
        export class MyService {}
      `);

      expect(result).not.toMatch(/@Injectable/);
      expect(result).toContain('MyService.decorators');
      expect(result).toContain('type: Injectable');
    });

    it('converts @NgModule to static decorators array', () => {
      const result = transform(`
        import { NgModule } from '@angular/core';
        @NgModule({ imports: [], exports: [] })
        export class MyModule {}
      `);

      expect(result).not.toMatch(/@NgModule/);
      expect(result).toContain('MyModule.decorators');
      expect(result).toContain('type: NgModule');
    });

    it('preserves decorator args', () => {
      const result = transform(`
        import { Component } from '@angular/core';
        @Component({
          selector: 'app-full',
          template: '<p>hi</p>',
          styles: [':host { color: red }'],
          standalone: true,
          imports: [SomeComponent]
        })
        export class FullComponent {}
      `);

      expect(result).toContain('args:');
      expect(result).toContain("selector: 'app-full'");
      expect(result).toContain('standalone: true');
      expect(result).toContain('SomeComponent');
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

    it('does NOT emit ɵcmp or Ivy instructions', () => {
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
      expect(result).not.toContain('X.decorators');
    });

    it('handles class without decorators', () => {
      const result = transform(`
        export class PlainClass { value = 42; }
      `);

      expect(result).toContain('PlainClass');
      expect(result).not.toContain('decorators');
    });
  });
});
