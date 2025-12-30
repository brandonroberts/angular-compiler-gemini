import {
  provideHttpClient,
  withFetch,
  withInterceptors,
} from '@angular/common/http';
import {
  ApplicationConfig,
  provideBrowserGlobalErrorListeners,
} from '@angular/core';
import { provideClientHydration, withEventReplay } from '@angular/platform-browser';
import { provideFileRouter, requestContextInterceptor, withExtraRoutes } from '@analogjs/router';
import Home from './pages/index.page';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideFileRouter(withExtraRoutes([
      { path: '', pathMatch: 'full', component: Home }
    ])),
    provideHttpClient(
      withFetch(),
      withInterceptors([requestContextInterceptor])
    ),
    // provideClientHydration(withEventReplay()),
  ],
};
