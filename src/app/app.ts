import { Component } from '@angular/core';

import { Counter } from './counter';
import { Todos } from './todos';

@Component({
  selector: 'app-root',
  template: `
    <h1>Angular</h1>

    <app-counter [name]="'Brandon'"></app-counter>

    <hr>

    <app-todos></app-todos>
  `,
  imports: [Counter, Todos],
})
export class App {}
