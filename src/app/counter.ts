import { Component, computed, signal } from '@angular/core';

@Component({
  selector: 'app-counter',
  template: `
    Count: {{ count() }}

    <button (click)="increment()">Increment</button>

		@if(show()) {
			<div>Hello</div>
		}
  `
})
export class Counter {
  count = signal(0);
	show = computed(() => this.count() > 5);

  increment() {
    this.count.update(cnt => ++cnt);
  }
}
