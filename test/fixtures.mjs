// JPEG のバイト列を組み立てる。
//
// parseJpeg はヘッダしか読まないため、エントロピー符号化データが妥当である
// 必要がない。そのおかげでバイナリをコミットせずに済み、壊れたセグメント長や
// 12bit、分割 ICC といった実ファイルでは作りにくいケースまで表現できる。

const bytes = (...xs) => Uint8Array.from(xs.flat(Infinity));
const u16 = (n) => [(n >> 8) & 0xff, n & 0xff];
const ascii = (s) => [...s].map((c) => c.charCodeAt(0));

/** マーカーセグメント。長さフィールドは payload + 2 で自動計算する */
export function seg(marker, payload = []) {
  const p = [...payload];
  return [0xff, marker, ...u16(p.length + 2), ...p];
}

/** 長さフィールドを故意に壊したセグメント（宣言長の検証テスト用） */
export function segWithLength(marker, declaredLength, payload = []) {
  return [0xff, marker, ...u16(declaredLength), ...payload];
}

/**
 * SOF セグメント。
 * marker: 0xC0=ベースライン, 0xC2=プログレッシブ, 0xC9=算術, 0xC3=ロスレス, 0xC5=階層
 */
export function sof({ marker = 0xc0, precision = 8, width = 200, height = 120, components = 3 } = {}) {
  const comps = [];
  for (let i = 1; i <= components; i++) comps.push(i, 0x11, 0);
  return seg(marker, [precision, ...u16(height), ...u16(width), components, ...comps]);
}

/** APP1 (EXIF)。Orientation タグだけを持つ最小の TIFF を組む */
export function exif({ orientation = 1, littleEndian = false, type = 3, count = 1 } = {}) {
  const w16 = (n) => (littleEndian ? [n & 0xff, (n >> 8) & 0xff] : u16(n));
  const w32 = (n) =>
    littleEndian
      ? [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff]
      : [(n >> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];

  const tiff = [
    ...ascii(littleEndian ? 'II' : 'MM'),
    ...w16(42),
    ...w32(8), // IFD0 は TIFF ヘッダ直後
    ...w16(1), // エントリ数
    ...w16(0x0112), // Orientation
    ...w16(type),
    ...w32(count),
    ...w16(orientation),
    ...w16(0), // 値フィールドの余り
    ...w32(0), // 次の IFD なし
  ];
  return seg(0xe1, [...ascii('Exif'), 0, 0, ...tiff]);
}

/** 壊れた TIFF を持つ APP1（EXIF_INVALID の検証用） */
export function brokenExif() {
  return seg(0xe1, [...ascii('Exif'), 0, 0, ...ascii('XX'), 0, 0, 0, 0, 0, 0]);
}

/** APP2 (ICC)。total を 2 以上にすると分割チャンクを模擬できる */
export function icc({ index = 1, total = 1 } = {}) {
  return seg(0xe2, [...ascii('ICC_PROFILE'), 0, index, total, 0x00, 0x01, 0x02, 0x03]);
}

/** ICC ではない APP2。iPhone の JPEG が持つ MPF を模擬する */
export function mpf() {
  return seg(0xe2, [...ascii('MPF'), 0, 0x4d, 0x4d, 0x00, 0x2a, 0, 0, 0, 8, 0, 0, 0, 0]);
}

/** APP14 (Adobe)。CMYK の Decode 反転判定に使われる */
export function adobe() {
  return seg(0xee, [...ascii('Adobe'), 0, 100, 0, 0, 0, 0, 0, 2]);
}

/** APP0 (JFIF)。実ファイルらしさのための埋め草 */
export function jfif() {
  return seg(0xe0, [...ascii('JFIF'), 0, 1, 2, 0, 0, 1, 0, 1, 0, 0]);
}

/**
 * JPEG 全体。
 * segments: SOF より前に置くセグメント群
 * body: SOS 以降のダミーデータ
 */
export function jpeg({ segments = [], sofSeg = sof(), sos = true, eoi = true, body = [0x00, 0x11, 0x22] } = {}) {
  const out = [0xff, 0xd8, ...segments.flat(), ...sofSeg];
  if (sos) out.push(...seg(0xda, [1, 1, 0, 0, 63, 0]), ...body);
  if (eoi) out.push(0xff, 0xd9);
  return bytes(out);
}

/** JPEG ではないファイル（sniff の検証用） */
export const notJpeg = {
  png: () => bytes(0x89, ...ascii('PNG'), 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0),
  webp: () => bytes(...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WEBP'), 0, 0, 0, 0),
  heic: () => bytes(0, 0, 0, 0x18, ...ascii('ftyp'), ...ascii('heic'), 0, 0, 0, 0),
  avif: () => bytes(0, 0, 0, 0x18, ...ascii('ftyp'), ...ascii('avif'), 0, 0, 0, 0),
  gif: () => bytes(...ascii('GIF89a'), 0, 0, 0, 0),
  pdf: () => bytes(...ascii('%PDF-1.4'), 0, 0),
  jxl: () => bytes(0xff, 0x0a, 0, 0, 0, 0),
  tiff: () => bytes(...ascii('II'), 0x2a, 0x00, 0, 0, 0, 0),
  bmp: () => bytes(...ascii('BM'), 0, 0, 0, 0, 0, 0),
  unknown: () => bytes(0x01, 0x02, 0x03, 0x04, 0x05, 0x06),
};
