import { Component } from '@angular/core';

import { Counter } from './counter';
import { Todos } from './todos';
import { RouterOutlet } from '@angular/router';

@Component({
  selector: 'app-root',
  template: `
    <router-outlet />
  `,
  imports: [RouterOutlet],
})
export class App {}
