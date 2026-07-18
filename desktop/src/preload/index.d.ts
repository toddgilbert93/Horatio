import type { FlightrecApi } from './index';

declare global {
  interface Window {
    flightrec: FlightrecApi;
  }
}

export {};
