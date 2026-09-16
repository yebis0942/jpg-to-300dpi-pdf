// index.html の <script id="core"> を取り出して評価し、純ロジックを返す。
//
// ビルドを持ち込まないための仕組み。core は DOM に触れないので、
// 関数本体として評価するだけでテストから呼べる。一時ファイルは作らない。

import { readFile } from 'node:fs/promises';

const HTML = new URL('../index.html', import.meta.url);

const EXPORTS = ['JpegError', 'sniff', 'parseJpeg', 'readOrientation', 'fmt', 'layout', 'buildPdf'];

export async function loadCore() {
  const html = await readFile(HTML, 'utf-8');

  const m = html.match(/<script id="core">([\s\S]*?)<\/script>/);
  if (!m) {
    throw new Error(
      'index.html に <script id="core"> が見つかりません。' +
      'スクリプトを分割し直した場合は test/extract.mjs も追従させてください。'
    );
  }

  const ui = html.match(/<script id="ui">([\s\S]*?)<\/script>/);
  if (!ui) throw new Error('index.html に <script id="ui"> が見つかりません。');

  // core が DOM に触れていないこと自体もここで担保する。
  // 触れていたら new Function での評価が謎のエラーで落ちるより、先に理由を出す。
  const leaked = ['document', 'window.', 'URL.', 'navigator'].filter((k) => m[1].includes(k));
  if (leaked.length) {
    throw new Error(`core に DOM 参照が混入しています: ${leaked.join(', ')}`);
  }

  // スタックトレースが index.html の実際の行番号を指すように行を詰める。
  // new Function は本体を `function anonymous(\n) {\n` で包むので、開始タグの
  // 行番号から 3 行ぶん差し引く。ずれたら extract.test.mjs が教えてくれる。
  const tagLine = html.slice(0, html.indexOf('<script id="core">')).split('\n').length;
  const src = '\n'.repeat(Math.max(0, tagLine - 3)) + m[1] + '\n//# sourceURL=index.html';

  const fn = new Function(`${src}\nreturn { ${EXPORTS.join(', ')} };`);
  return fn();
}

/** parseJpeg / buildPdf に渡す File 相当。Blob は size / slice / arrayBuffer を満たす */
export function asFile(bytes) {
  return new Blob([bytes]);
}
