/// <reference types="vite/client" />

// The Beetle 2D player bundled into one script's text (see studio2d/build/runtime-plugin.mjs).
declare module "virtual:studio2d-runtime" {
  const code: string;
  export default code;
}
