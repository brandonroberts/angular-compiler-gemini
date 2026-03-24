import { Component } from '@angular/core';

@Component({
  selector: 'app-analog-welcome',
  styleUrl: './analog-welcome.scss',
  templateUrl: './analog-welcome.html',
})
export class AnalogWelcome {
  count = 0;

  increment() {
    this.count++;
  }
}
