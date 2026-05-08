/// <reference types="vite/client" />

import type { BrowserGameTranslatorApi } from "../preload/preload";

declare global {
  interface Window {
    bgt: BrowserGameTranslatorApi;
  }
}
