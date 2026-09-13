const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const ts = require(path.join(root, 'node_modules/typescript'));
const { webpack } = require(path.join(root, 'node_modules/next/dist/compiled/webpack/webpack'));
const scratch = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'onogami-shift-'));
const output = path.join(root, 'artifacts');
fs.mkdirSync(scratch, { recursive: true }); fs.mkdirSync(output, { recursive: true });
let css = fs.readFileSync(path.join(root, 'app/shift/trial/shift-trial.module.css'), 'utf8');
css = css.replace(/:global\(([^)]+)\)/g, '$1');
const styles = {};
css = css.replace(/\.([a-zA-Z_][\w-]*)/g, (match, name) => { styles[name] = 'shift_' + name; return '.' + styles[name]; });
let source = fs.readFileSync(path.join(root, 'app/shift/trial/shift-trial.tsx'), 'utf8');
source = source.replace("import styles from './shift-trial.module.css';", 'const styles = ' + JSON.stringify(styles) + ';');
source = source.replace("'../../../lib/shift-trial.mjs'", JSON.stringify(path.join(root, 'lib/shift-trial.mjs')));
fs.writeFileSync(path.join(scratch, 'trial.js'), ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText);
fs.writeFileSync(path.join(scratch, 'entry.js'), "import React from 'react'; import {createRoot} from 'react-dom/client'; import Trial from './trial.js'; createRoot(document.getElementById('app')).render(React.createElement(Trial));");
webpack({ mode: 'production', target: 'web', entry: path.join(scratch, 'entry.js'), resolve: { modules: [path.join(root, 'node_modules')] }, output: { path: scratch, filename: 'bundle.js' }, devtool: false, optimization: { minimize: false, splitChunks: false, runtimeChunk: false } }, (error, stats) => {
  if (error || stats.hasErrors()) { console.error(error || stats.toString({ all: false, errors: true })); process.exitCode = 1; return; }
  let js = fs.readFileSync(path.join(scratch, 'bundle.js'), 'utf8').replace(/<\/script/gi, '<\\/script');
  js = js.split('\n').map(line => line.startsWith('/******/') ? line.trimEnd() : line).join('\n');
  const globalCss = 'html{font-family:Arial,"Hiragino Kaku Gothic ProN","Yu Gothic",sans-serif;color-scheme:light}*{box-sizing:border-box}body{margin:0}button{font:inherit}h1{margin:0}';
  const html = '<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>ONOGAMI シフト｜操作テスト</title><style>' + globalCss + css + '</style></head><body><div id="app"></div><noscript>このテスト版にはJavaScriptが必要です。ブラウザーで開いてください。</noscript><script>' + js + '</script></body></html>';
  const file = path.join(output, 'ONOGAMI_shift_test.html'); fs.writeFileSync(file, html);
  console.log(JSON.stringify({ file, bytes: Buffer.byteLength(html), errors: stats.hasErrors() }));
  fs.rmSync(scratch, { recursive: true, force: true });
});
