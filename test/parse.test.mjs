import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { loadCore, asFile } from './extract.mjs';
import { jpeg, sof, seg, segWithLength, exif, brokenExif, icc, mpf, adobe, jfif, notJpeg } from './fixtures.mjs';

let parseJpeg, sniff;
before(async () => ({ parseJpeg, sniff } = await loadCore()));

const parse = (bytes) => parseJpeg(asFile(bytes));
const codes = (info) => info.warnings.map((w) => w.code);

/** 例外の code を取り出す。成功してしまった場合はそれが分かるように落とす */
async function errorCode(bytes) {
  try {
    await parse(bytes);
  } catch (e) {
    return e.code;
  }
  throw new Error('エラーになるはずが成功しました');
}

describe('正常系', () => {
  test('ベースライン JPEG のヘッダを読む', async () => {
    const info = await parse(jpeg({ segments: [jfif()], sofSeg: sof({ width: 2550, height: 3300 }) }));
    assert.equal(info.width, 2550);
    assert.equal(info.height, 3300);
    assert.equal(info.components, 3);
    assert.equal(info.precision, 8);
    assert.equal(info.progressive, false);
    assert.equal(info.orientation, 1);
    assert.deepEqual(codes(info), []);
  });

  test('グレースケールと CMYK の成分数を読む', async () => {
    assert.equal((await parse(jpeg({ sofSeg: sof({ components: 1 }) }))).components, 1);
    assert.equal((await parse(jpeg({ sofSeg: sof({ components: 4 }) }))).components, 4);
  });

  test('APP14 があれば Adobe と判定する', async () => {
    assert.equal((await parse(jpeg({ segments: [adobe()] }))).adobe, true);
    assert.equal((await parse(jpeg({}))).adobe, false);
  });
});

describe('ファイル種別のスニッフィング', () => {
  test('JPEG でなければ NOT_JPEG になる', async () => {
    assert.equal(await errorCode(notJpeg.png()), 'NOT_JPEG');
  });

  for (const [kind, hint] of [
    ['png', 'PNG'],
    ['webp', 'WebP'],
    ['heic', 'HEIC/HEIF'],
    ['avif', 'AVIF'],
    ['gif', 'GIF'],
    ['pdf', 'PDF'],
    ['jxl', 'JPEG XL'],
    ['tiff', 'TIFF'],
    ['bmp', 'BMP'],
  ]) {
    test(`${kind} は種別を言い当てる`, () => {
      assert.match(sniff(notJpeg[kind]()), new RegExp(hint.replace(/[/]/g, '\\/')));
    });
  }

  test('判別できない場合は null を返し、メッセージにヒントを足さない', async () => {
    assert.equal(sniff(notJpeg.unknown()), null);
    try {
      await parse(notJpeg.unknown());
      assert.fail('エラーになるはず');
    } catch (e) {
      assert.doesNotMatch(e.message, /と判定されました/);
    }
  });
});

describe('セグメント宣言長の検証', () => {
  test('SOF の宣言長が 8 未満なら CORRUPT', async () => {
    // 宣言長を 2 にすると、修正前は次セグメントのバイトを precision として
    // 読み「255bit JPEG は非対応です」という無意味な診断になっていた
    const broken = jpeg({ sofSeg: segWithLength(0xc0, 2), sos: false });
    assert.equal(await errorCode(broken), 'CORRUPT');
  });

  test('SOF の宣言長が成分数に足りなければ CORRUPT', async () => {
    // precision/height/width/Nf は読めるが、3 成分ぶんの定義が宣言長に収まらない
    const payload = [8, 0, 120, 0, 200, 3];
    const broken = jpeg({ sofSeg: segWithLength(0xc0, 8, payload), sos: false });
    assert.equal(await errorCode(broken), 'CORRUPT');
  });

  test('宣言長が妥当な SOF は通る', async () => {
    assert.equal((await parse(jpeg({}))).width, 200);
  });

  test('短すぎる APP1 は EXIF として読まない', async () => {
    // 識別子 6 バイトを読むには len >= 8 が要る。足りなければ黙って読み飛ばす
    const info = await parse(jpeg({ segments: [segWithLength(0xe1, 4, [0x45, 0x78])] }));
    assert.equal(info.orientation, 1);
    assert.deepEqual(codes(info), []);
  });

  // 意図の記録。APP14 の len >= 7 ガードは深層防御で、公開 API からは
  // 外しても差が出ない（識別子 5 バイト目 segStart+4 と次セグメントの開始位置
  // segEnd はどちらも pos+8 で同一バイトを指すため、そのバイトが 'e' かつ
  // 0xFF である必要があり両立しない）。この検査はガードを消しても落ちない。
  test('短すぎる APP14 は Adobe と判定しない', async () => {
    const info = await parse(jpeg({ segments: [segWithLength(0xee, 6, [0x41, 0x64, 0x6f, 0x62])] }));
    assert.equal(info.adobe, false);
  });
});

describe('非対応の JPEG', () => {
  const cases = [
    ['算術符号化', sof({ marker: 0xc9 })],
    ['ロスレス', sof({ marker: 0xc3 })],
    ['階層', sof({ marker: 0xc5 })],
    ['12bit', sof({ precision: 12 })],
    ['DNL（高さ未定）', sof({ height: 0 })],
    ['2 成分', sof({ components: 2 })],
  ];
  for (const [label, s] of cases) {
    test(`${label} は UNSUPPORTED`, async () => {
      assert.equal(await errorCode(jpeg({ sofSeg: s })), 'UNSUPPORTED');
    });
  }

  test('SOF より前に画像データが始まったら NO_SOF', async () => {
    const bytes = Uint8Array.from([0xff, 0xd8, ...seg(0xda, [1, 1, 0, 0, 63, 0]), 0xff, 0xd9]);
    assert.equal(await errorCode(bytes), 'NO_SOF');
  });
});

describe('EXIF Orientation', () => {
  for (const o of [1, 2, 3, 4, 5, 6, 7, 8]) {
    test(`${o} をそのまま読む`, async () => {
      assert.equal((await parse(jpeg({ segments: [exif({ orientation: o })] }))).orientation, o);
    });
  }

  test('リトルエンディアンの TIFF も読む', async () => {
    const info = await parse(jpeg({ segments: [exif({ orientation: 6, littleEndian: true })] }));
    assert.equal(info.orientation, 6);
  });

  test('範囲外の値は 1 に丸める', async () => {
    assert.equal((await parse(jpeg({ segments: [exif({ orientation: 9 })] }))).orientation, 1);
    assert.equal((await parse(jpeg({ segments: [exif({ orientation: 0 })] }))).orientation, 1);
  });

  test('SHORT 型でない Orientation は無視する', async () => {
    const info = await parse(jpeg({ segments: [exif({ orientation: 6, type: 4 })] }));
    assert.equal(info.orientation, 1);
  });

  test('壊れた TIFF は EXIF_INVALID を警告し通常向きで続行する', async () => {
    const info = await parse(jpeg({ segments: [brokenExif()] }));
    assert.equal(info.orientation, 1);
    assert.deepEqual(codes(info), ['EXIF_INVALID']);
  });

  test('EXIF が無ければ警告も出ない', async () => {
    assert.deepEqual(codes(await parse(jpeg({}))), []);
  });
});

describe('警告', () => {
  test('プログレッシブ JPEG は PROGRESSIVE を警告するが変換は続行する', async () => {
    const info = await parse(jpeg({ sofSeg: sof({ marker: 0xc2 }) }));
    assert.equal(info.progressive, true);
    assert.equal(info.width, 200);
    assert.deepEqual(codes(info), ['PROGRESSIVE']);
  });

  test('ICC を持つと ICC_LOST を警告する', async () => {
    assert.deepEqual(codes(await parse(jpeg({ segments: [icc()] }))), ['ICC_LOST']);
  });

  test('ICC が分割されていても警告は 1 件に抑える', async () => {
    const chunks = [1, 2, 3, 4].map((i) => icc({ index: i, total: 4 }));
    assert.deepEqual(codes(await parse(jpeg({ segments: chunks }))), ['ICC_LOST']);
  });

  test('ICC 以外の APP2 では警告しない', async () => {
    // iPhone の JPEG は MPF を APP2 で持つ。識別子を見ずに APP2 だけで
    // 判定すると、プロファイルが無いのに警告が出てしまう
    assert.deepEqual(codes(await parse(jpeg({ segments: [mpf()] }))), []);
  });

  test('末尾に EOI が無ければ NO_EOI を警告する', async () => {
    assert.deepEqual(codes(await parse(jpeg({ eoi: false }))), ['NO_EOI']);
  });

  test('末尾が 0xFF で終わっていても EOI の欠落を見抜く', async () => {
    // 末尾 2 バイトが FF 00。0xFF だけを見て判定すると見逃す
    const info = await parse(jpeg({ eoi: false, body: [0x00, 0x11, 0xff, 0x00] }));
    assert.deepEqual(codes(info), ['NO_EOI']);
  });

  describe('ページサイズ上限', () => {
    // PDF のページ辺の上限 14400pt は 300 DPI 換算でちょうど 60000px
    test('60000px ちょうどは警告しない', async () => {
      const info = await parse(jpeg({ sofSeg: sof({ width: 60000, height: 120 }) }));
      assert.deepEqual(codes(info), []);
    });

    test('60001px で PAGE_TOO_LARGE を警告する', async () => {
      const info = await parse(jpeg({ sofSeg: sof({ width: 60001, height: 120 }) }));
      assert.deepEqual(codes(info), ['PAGE_TOO_LARGE']);
    });

    test('長辺で判定する（縦長でも拾う）', async () => {
      const info = await parse(jpeg({ sofSeg: sof({ width: 120, height: 65535 }) }));
      assert.deepEqual(codes(info), ['PAGE_TOO_LARGE']);
    });
  });

  test('複数の警告が併存する', async () => {
    const info = await parse(jpeg({ segments: [icc()], sofSeg: sof({ marker: 0xc2 }), eoi: false }));
    assert.deepEqual(codes(info).sort(), ['ICC_LOST', 'NO_EOI', 'PROGRESSIVE']);
  });
});
