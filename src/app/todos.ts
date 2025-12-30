import { Component, inject, signal } from '@angular/core';
import { TodosService } from './todos-service';

@Component({
  selector: 'app-todos',
  template: `
    <h2>
      Todos
    </h2>

    <ul>
      @for(todo of todos(); track todo.id) {
        <li>{{ todo.title }}
      }
    <ul>
  `
})
export class Todos {
  todos = signal<any[]>([]);
  todosService = inject(TodosService);

  constructor() {
    this.todosService.get().then(todos => this.todos.set(todos.slice(0, 10)));
  }
}
