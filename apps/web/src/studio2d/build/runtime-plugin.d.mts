import type { Plugin } from "vite";
export declare const RUNTIME_ENTRY: string;
export declare function bundleRuntime(opts?: { minify?: boolean }): Promise<string>;
export declare function studio2dRuntimePlugin(): Plugin;
