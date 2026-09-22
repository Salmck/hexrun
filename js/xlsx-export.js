// Minimal, dependency-free .xlsx (OOXML spreadsheet) writer - just enough to
// export a handful of small, plain data sheets (no formulas, no cell
// styling beyond Excel's own defaults) without vendoring a third-party
// library for it. Builds a real ZIP container - STORE (uncompressed)
// entries only, since every file here is tiny and skipping DEFLATE keeps
// this simple and easy to verify byte-for-byte - with the minimum set of
// OOXML parts Excel needs to open a workbook: [Content_Types].xml,
// _rels/.rels, xl/workbook.xml, xl/_rels/workbook.xml.rels, xl/styles.xml,
// and one xl/worksheets/sheetN.xml per sheet.
//
// Usage: buildXlsxDataUrl([{ name: 'Sheet1', rows: [['a', 1], ['b', 2]] }])
// returns a `data:...;base64,...` URL ready for Game#_downloadDataUrl. A
// row is an array of cell values - numbers are written as real numeric
// cells, everything else is written as an inline string (via String(value),
// so `null`/`undefined` become the literal text "null"/"undefined" -
// callers should pass '' for a deliberately blank cell).

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

const utf8Bytes = (str) => new TextEncoder().encode(str);

const escapeXml = (value) => String(value).replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
}[c]));

// 0 -> "A", 25 -> "Z", 26 -> "AA", ... (spreadsheet column naming)
function colLetter(index) {
  let n = index + 1, s = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function sheetXml(rows) {
  const rowsXml = rows.map((row, ri) => {
    const cellsXml = row.map((value, ci) => {
      if (value === '' || value === null || value === undefined) return '';
      const ref = `${colLetter(ci)}${ri + 1}`;
      if (typeof value === 'number' && Number.isFinite(value)) {
        return `<c r="${ref}"><v>${value}</v></c>`;
      }
      return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
    }).join('');
    return `<row r="${ri + 1}">${cellsXml}</row>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<sheetData>${rowsXml}</sheetData></worksheet>`;
}

function contentTypesXml(sheetCount) {
  let overrides = '';
  for (let i = 1; i <= sheetCount; i++) {
    overrides += `<Override PartName="/xl/worksheets/sheet${i}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`;
  }
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
    `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
    `${overrides}</Types>`;
}

function rootRelsXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
    `</Relationships>`;
}

function workbookXml(sheets) {
  const sheetEls = sheets.map((s, i) =>
    `<sheet name="${escapeXml(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<sheets>${sheetEls}</sheets></workbook>`;
}

function workbookRelsXml(sheetCount) {
  let rels = '';
  for (let i = 1; i <= sheetCount; i++) {
    rels += `<Relationship Id="rId${i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i}.xml"/>`;
  }
  rels += `<Relationship Id="rId${sheetCount + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`;
}

function stylesXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>` +
    `<fills count="1"><fill><patternFill patternType="none"/></fill></fills>` +
    `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>` +
    `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
    `<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>` +
    `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>` +
    `</styleSheet>`;
}

// Packs `files` (each {name, data: Uint8Array}) into a STORE-only ZIP
// archive and returns the whole thing as one Uint8Array - a bog-standard
// local-file-header + central-directory + end-of-central-directory layout,
// just with compression method 0 throughout so no DEFLATE implementation is
// needed.
function buildZip(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const file of files) {
    const nameBytes = utf8Bytes(file.name);
    const data = file.data;
    const crc = crc32(data);
    const size = data.length;

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0, true);
    local.setUint16(8, 0, true);
    local.setUint16(10, 0, true);
    local.setUint16(12, 0, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, size, true);
    local.setUint32(22, size, true);
    local.setUint16(26, nameBytes.length, true);
    local.setUint16(28, 0, true);
    localParts.push(new Uint8Array(local.buffer), nameBytes, data);

    const central = new DataView(new ArrayBuffer(46));
    central.setUint32(0, 0x02014b50, true);
    central.setUint16(4, 20, true);
    central.setUint16(6, 20, true);
    central.setUint16(8, 0, true);
    central.setUint16(10, 0, true);
    central.setUint16(12, 0, true);
    central.setUint16(14, 0, true);
    central.setUint32(16, crc, true);
    central.setUint32(20, size, true);
    central.setUint32(24, size, true);
    central.setUint16(28, nameBytes.length, true);
    central.setUint16(30, 0, true);
    central.setUint16(32, 0, true);
    central.setUint16(34, 0, true);
    central.setUint16(36, 0, true);
    central.setUint32(38, 0, true);
    central.setUint32(42, offset, true);
    centralParts.push(new Uint8Array(central.buffer), nameBytes);

    offset += 30 + nameBytes.length + size;
  }

  const centralDirOffset = offset;
  const centralDirSize = centralParts.reduce((sum, p) => sum + p.length, 0);

  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(4, 0, true);
  eocd.setUint16(6, 0, true);
  eocd.setUint16(8, files.length, true);
  eocd.setUint16(10, files.length, true);
  eocd.setUint32(12, centralDirSize, true);
  eocd.setUint32(16, centralDirOffset, true);
  eocd.setUint16(20, 0, true);

  const out = new Uint8Array(centralDirOffset + centralDirSize + 22);
  let pos = 0;
  for (const part of localParts) { out.set(part, pos); pos += part.length; }
  for (const part of centralParts) { out.set(part, pos); pos += part.length; }
  out.set(new Uint8Array(eocd.buffer), pos);
  return out;
}

function bytesToBase64(bytes) {
  let binary = '';
  const chunkSize = 0x8000; // avoid a call-stack blowout from one huge spread/apply
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

export function buildXlsxDataUrl(sheets) {
  const files = [
    { name: '[Content_Types].xml', data: utf8Bytes(contentTypesXml(sheets.length)) },
    { name: '_rels/.rels', data: utf8Bytes(rootRelsXml()) },
    { name: 'xl/workbook.xml', data: utf8Bytes(workbookXml(sheets)) },
    { name: 'xl/_rels/workbook.xml.rels', data: utf8Bytes(workbookRelsXml(sheets.length)) },
    { name: 'xl/styles.xml', data: utf8Bytes(stylesXml()) },
    ...sheets.map((sheet, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: utf8Bytes(sheetXml(sheet.rows)) })),
  ];
  const zipBytes = buildZip(files);
  return `data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,${bytesToBase64(zipBytes)}`;
}
