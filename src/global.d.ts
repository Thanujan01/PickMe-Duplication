/// <reference types="google.maps" />

declare global {
  interface Window {
    /** Present once the Google Maps JS API script has loaded. */
    google?: typeof google;
  }
}

export {};
