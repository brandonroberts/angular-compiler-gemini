import { HttpClient } from "@angular/common/http";
import { inject, Injectable } from "@angular/core";
import { firstValueFrom } from "rxjs";

@Injectable()
export class TodosService {
	private http = inject(HttpClient);

	get() {
		return firstValueFrom(this.http.get<any[]>('https://jsonplaceholder.typicode.com/todos'));
	}
}