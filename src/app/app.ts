import { Component, signal } from '@angular/core';

@Component({
  selector: 'app-root',
  template: `
    Hello World

    Count: {{ count() }}
    
    <button (click)="increment()">Increment</button>
  `
})
export class App {
  count = signal(0);

  increment() {
    this.count.update(cnt => ++cnt);
  }
}
