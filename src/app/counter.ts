import { Component, signal } from '@angular/core';

@Component({
  selector: 'app-counter',
  template: `
    Count: {{ count() }}

    <button (click)="increment()">Increment</button>
  `
})
export class Counter {
  count = signal(0);

  increment() {
    this.count.update(cnt => ++cnt);
  }
}
