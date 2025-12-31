import { Component, computed, input, signal } from '@angular/core';

@Component({
  selector: 'app-counter',
  template: `
    Count: {{ count() }}

    <button (click)="increment()">Increment</button>
		<button (click)="decrement()">Decrement</button>

		@if(show()) {
			<div>Hello {{ name() }}</div>
		}
  `
})
export class Counter {
	name = input();
  count = signal(0);
	show = computed(() => this.count() > 5);

  increment() {
    this.count.update(cnt => ++cnt);
  }

  decrement() {
    this.count.update(cnt => --cnt);
  }	
}
