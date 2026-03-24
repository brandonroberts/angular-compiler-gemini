import { describe, it, expect } from 'vitest';
import { compile } from './compile';
import { expectCompiles } from './test-helpers';

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
