import { Component } from '@angular/core';

import { Counter } from './counter';

@Component({
  selector: 'app-root',
  template: `
    <h1>Angular</h1>

    <app-counter></app-counter>
  `,
  imports: [Counter],
})
export class App {}
