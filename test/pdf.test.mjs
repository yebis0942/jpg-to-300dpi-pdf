import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { loadCore, asFile } from './extract.mjs';
import { jpeg, sof, exif, adobe } from './fixtures.mjs';

let parseJpeg, buildPdf, layout, fmt;
before(async () => ({ parseJpeg, buildPdf, layout, fmt } = await loadCore()));

/** JPEG から PDF を組み、バイト列とテキスト表現の両方を返す */
async function build(opts = {}) {
  const bytes = jpeg(opts);
  const file = asFile(bytes);
  const info = await parseJpeg(file);
  const blob = buildPdf(file, info);
  const buf = new Uint8Array(await blob.arrayBuffer());
  return { info, bytes, buf, text: Buffer.from(buf).toString('latin1') };
}

describe('PDF の構造', () => {
  test('xref の各オフセットが実際のオブジェクト位置を指す', async () => {
    const { text } = await build();

    const startxref = Number(text.match(/startxref\s+(\d+)/)[1]);
    assert.equal(text.slice(startxref, startxref + 4), 'xref', 'startxref が xref を指していない');

    const entries = [...text.slice(startxref).matchAll(/(\d{10}) (\d{5}) ([nf])/g)];
    assert.equal(entries.length, 6, '0 番の free + 5 オブジェクト');
    assert.equal(entries[0][3], 'f', '0 番は free エントリ');

    entries.forEach(([, offset, , type], i) => {
      if (type === 'f') return;
      const at = Number(offset);
      assert.equal(text.slice(at, at + `${i} 0 obj`.length), `${i} 0 obj`, `${i} 番のオフセットがずれている`);
    });
  });

  test('xref のエントリは厳密に 20 バイト', async () => {
    const { text } = await build();
    const body = text.slice(text.indexOf('xref\n') + 'xref\n0 6\n'.length);
    for (let i = 0; i < 6; i++) {
      const entry = body.slice(i * 20, (i + 1) * 20);
      assert.match(entry, /^\d{10} \d{5} [nf] \n$/, `${i} 番のエントリ長が 20 バイトでない`);
    }
  });

  test('画像ストリームの /Length が元の JPEG のサイズと一致する', async () => {
    const { bytes, text } = await build();
    assert.match(text, new RegExp(`/DCTDecode[^>]*/Length ${bytes.length}`));
  });

  test('JPEG のバイト列が再エンコードされずそのまま格納される', async () => {
    const { bytes, buf, text } = await build();
    const start = text.indexOf('stream\n', text.indexOf('/DCTDecode')) + 'stream\n'.length;
    assert.deepEqual(buf.slice(start, start + bytes.length), bytes);
  });

  test('trailer が 6 オブジェクトと Catalog を指す', async () => {
    const { text } = await build();
    assert.match(text, /trailer\n<< \/Size 6 \/Root 1 0 R >>/);
    assert.match(text, /1 0 obj\n<< \/Type \/Catalog \/Pages 2 0 R >>/);
    assert.ok(text.endsWith('%%EOF\n'));
  });
});

describe('カラースペース', () => {
  const cs = async (components, segments = []) => (await build({ segments, sofSeg: sof({ components }) })).text;

  test('成分数に応じた ColorSpace を選ぶ', async () => {
    assert.match(await cs(1), /\/ColorSpace \/DeviceGray/);
    assert.match(await cs(3), /\/ColorSpace \/DeviceRGB/);
    assert.match(await cs(4), /\/ColorSpace \/DeviceCMYK/);
  });

  test('Adobe の CMYK だけ Decode で反転する', async () => {
    assert.match(await cs(4, [adobe()]), /\/Decode \[1 0 1 0 1 0 1 0\]/);
  });

  test('APP14 の無い CMYK は反転しない', async () => {
    assert.doesNotMatch(await cs(4), /\/Decode/);
  });

  test('RGB は Adobe があっても反転しない', async () => {
    assert.doesNotMatch(await cs(3, [adobe()]), /\/Decode/);
  });
});

describe('300 DPI のページサイズ', () => {
  test('1px = 0.24pt で換算する', async () => {
    const { text } = await build({ sofSeg: sof({ width: 2550, height: 3300 }) });
    assert.match(text, /\/MediaBox \[0 0 612 792\]/, 'US Letter にならない');
  });

  test('端数は有効桁だけを書き、末尾の 0 を残さない', () => {
    assert.equal(fmt(0), '0');
    assert.equal(fmt(1), '0.24');
    assert.equal(fmt(10), '2.4');
    assert.equal(fmt(100), '24');
    assert.equal(fmt(2550), '612');
    assert.equal(fmt(-200), '-48');
  });
});

describe('EXIF Orientation の変換行列', () => {
  // 期待値は 2026-09-16 に mutool でレンダリングし、ImageMagick で
  // 正解画像と比較して確定したもの（RMSE 0.0027 = JPEG 再圧縮ノイズのみ。
  // 向きを取り違えた場合は 0.47）。ここを書き換えるときは同じ手順で
  // 描画結果を確認すること。
  const EXPECTED = {
    1: { page: [200, 120], cm: '200 0 0 120 0 0' },
    2: { page: [200, 120], cm: '-200 0 0 120 200 0' },
    3: { page: [200, 120], cm: '-200 0 0 -120 200 120' },
    4: { page: [200, 120], cm: '200 0 0 -120 0 120' },
    5: { page: [120, 200], cm: '0 -200 -120 0 120 200' },
    6: { page: [120, 200], cm: '0 -200 120 0 0 200' },
    7: { page: [120, 200], cm: '0 200 120 0 0 0' },
    8: { page: [120, 200], cm: '0 200 -120 0 120 0' },
  };

  for (const [o, want] of Object.entries(EXPECTED)) {
    test(`orientation ${o}`, async () => {
      const { text } = await build({
        segments: [exif({ orientation: Number(o) })],
        sofSeg: sof({ width: 200, height: 120 }),
      });
      // px をそのまま pt に読み替えた期待値を 0.24 倍して突き合わせる
      const pt = (px) => fmt(px);
      const [w, h] = want.page;
      assert.match(text, new RegExp(`/MediaBox \\[0 0 ${pt(w)} ${pt(h)}\\]`), 'ページサイズ');

      const cmPt = want.cm.split(' ').map((n) => fmt(Number(n))).join(' ');
      assert.ok(text.includes(`q ${cmPt} cm /Im0 Do Q`), `cm 行列が期待と違う: ${cmPt}`);
    });
  }

  test('5〜8 はページの縦横が入れ替わる', () => {
    const portrait = layout({ width: 200, height: 120, orientation: 6 });
    assert.deepEqual([portrait.pageW, portrait.pageH], [120, 200]);
  });
});

describe('layout() の orientation フォールバック', () => {
  // 1〜8 以外では cm 行列とページの縦横が食い違い、画像が見切れていた
  for (const bad of [9, 0, -1, 1.5, undefined, null, '6']) {
    test(`${JSON.stringify(bad)} は回転なしに正規化される`, () => {
      const r = layout({ width: 200, height: 120, orientation: bad });
      assert.deepEqual([r.pageW, r.pageH], [200, 120], 'ページサイズが入れ替わっている');
      assert.deepEqual(r.cm, [200, 0, 0, 120, 0, 0], 'cm が単位系でない');
    });
  }
});
