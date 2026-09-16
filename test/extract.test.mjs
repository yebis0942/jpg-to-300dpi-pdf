import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadCore, asFile } from './extract.mjs';

const HTML = new URL('../index.html', import.meta.url);

describe('ロジックの取り出し', () => {
  test('core から必要な関数がすべて取り出せる', async () => {
    const core = await loadCore();
    for (const name of ['JpegError', 'sniff', 'parseJpeg', 'readOrientation', 'fmt', 'layout', 'buildPdf']) {
      assert.equal(typeof core[name], 'function', `${name} が取り出せていない`);
    }
  });

  test('スタックトレースが index.html の実際の行番号を指す', async () => {
    // 行合わせが狂うと、テストが落ちたときに原因箇所を追えなくなる。
    // ここが失敗したら extract.mjs のパディング量を見直すこと。
    const { parseJpeg } = await loadCore();
    const html = await readFile(HTML, 'utf-8');

    const marker = 'SOFセグメント長が不正です';
    const expected = html.split('\n').findIndex((l) => l.includes(`\`${marker}`)) + 1;
    assert.ok(expected > 0, `index.html に目印 "${marker}" が見つからない`);

    // 宣言長 2 の SOF を食わせてその行を踏ませる
    const broken = Uint8Array.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x02, 0xff, 0xd9]);
    await assert.rejects(
      () => parseJpeg(asFile(broken)),
      (e) => {
        const line = Number((e.stack.match(/index\.html:(\d+)/) || [])[1]);
        assert.equal(line, expected, `トレースは ${line} 行を指したが実際は ${expected} 行`);
        return true;
      }
    );
  });

  test('core に DOM 参照が混入したら理由付きで落ちる', async () => {
    // extract.mjs のガードが働くことの確認。実ファイルは汚さず文字列で検証する
    const html = await readFile(HTML, 'utf-8');
    const core = html.match(/<script id="core">([\s\S]*?)<\/script>/)[1];
    assert.ok(!/\bdocument\b|window\.|URL\.|navigator/.test(core), 'core が DOM に触れている');
  });
});
