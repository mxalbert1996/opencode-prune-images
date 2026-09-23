// OpenCode v2 resolves a directory-form plugin entry through a root-level
// `server.*` module, so this re-export makes `./server` and `./index` identical.
export { default } from "./index";
export * from "./index";
