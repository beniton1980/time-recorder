import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";

export function loadTs(relative, modules = {}, globals = {}) {
  const source = readFileSync(new URL("../../" + relative, import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, { exports, Error, Date, Intl, URLSearchParams, Request, Response,
    require(name) { if (!(name in modules)) throw new Error("Unmocked module: " + name); return modules[name]; },
    ...globals,
  });
  return exports;
}
