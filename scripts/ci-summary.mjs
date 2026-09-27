/**
 * CI の結果の要約（共通ルール§6）：JUnit の件数・失敗・所要時間を GitHub の実行結果の Summary に書く。
 * 詳しいログと画面の記録は、実行結果の Artifacts（test-results / playwright-report）を見る。
 *   node scripts/ci-summary.mjs test-results/unit-junit.xml test-results/e2e-junit.xml
 * 読める形式：ルートの <testsuites tests= failures= time=>（Vitest・Playwright）と、
 * 末尾のコメント <!-- tests N --> <!-- fail N --> <!-- duration_ms N -->（node --test）。
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';

function summarize(xml) {
  const head = xml.match(/<testsuites\b[^>]*>/)?.[0] ?? '';
  const attr = (k) => head.match(new RegExp(`\\s${k}="([\\d.]+)"`))?.[1];
  const note = (k) => xml.match(new RegExp(`<!--\\s*${k}\\s+([\\d.]+)\\s*-->`))?.[1];
  const tests = Number(attr('tests') ?? note('tests') ?? (xml.match(/<testcase\b/g) ?? []).length);
  const failures = attr('failures') !== undefined
    ? Number(attr('failures')) + Number(attr('errors') ?? 0)
    : Number(note('fail') ?? (xml.match(/<failure\b/g) ?? []).length);
  const seconds = attr('time') !== undefined ? Number(attr('time')) : Number(note('duration_ms') ?? 0) / 1000;
  const failed = [...xml.matchAll(/<testcase\b[^>]*\bname="([^"]*)"[^>]*>\s*<failure/g)].map((m) => m[1]);
  return { tests, failures, seconds, failed };
}

const rows = [];
for (const file of process.argv.slice(2)) {
  if (!existsSync(file)) { rows.push(`| ${file} | 結果なし（前の手順で止まった） | | |`); continue; }
  const s = summarize(readFileSync(file, 'utf8'));
  rows.push(`| ${file} | ${s.tests} | ${s.failures} | ${s.seconds.toFixed(1)}秒 |`);
  for (const name of s.failed) rows.push(`| └ 失敗 | ${name} | | |`);
}
const text = [
  `### 検証結果（${process.env.GITHUB_SHA?.slice(0, 7) ?? '手元'}）`,
  '| 対象 | 件数 | 失敗 | 所要時間 |',
  '|---|---|---|---|',
  ...rows,
  '',
  '詳細は Artifacts の test-results（JUnit・失敗時の画面とトレース）と playwright-report。',
].join('\n');
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text + '\n');
console.log(text);
