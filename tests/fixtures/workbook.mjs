// Synthetic Excel fixture: no uploaded workbook or personal data is retained.
const encoder = new TextEncoder();
const escapeXML = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function zip(files) {
  const local = [], central = [];
  let offset = 0;
  for (const [filename, text] of Object.entries(files)) {
    const name = encoder.encode(filename), bytes = encoder.encode(text), crc = crc32(bytes);
    const header = new Uint8Array(30 + name.length), view = new DataView(header.buffer);
    view.setUint32(0, 0x04034b50, true); view.setUint16(4, 20, true); view.setUint32(14, crc, true);
    view.setUint32(18, bytes.length, true); view.setUint32(22, bytes.length, true); view.setUint16(26, name.length, true); header.set(name, 30);
    const entry = new Uint8Array(46 + name.length), directory = new DataView(entry.buffer);
    directory.setUint32(0, 0x02014b50, true); directory.setUint16(4, 20, true); directory.setUint16(6, 20, true);
    directory.setUint32(16, crc, true); directory.setUint32(20, bytes.length, true); directory.setUint32(24, bytes.length, true);
    directory.setUint16(28, name.length, true); directory.setUint32(42, offset, true); entry.set(name, 46);
    local.push(header, bytes); central.push(entry); offset += header.length + bytes.length;
  }
  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22), view = new DataView(end.buffer);
  view.setUint32(0, 0x06054b50, true); view.setUint16(8, central.length, true); view.setUint16(10, central.length, true);
  view.setUint32(12, centralSize, true); view.setUint32(16, offset, true);
  const result = new Uint8Array(offset + centralSize + 22);
  let cursor = 0;
  for (const part of [...local, ...central, end]) { result.set(part, cursor); cursor += part.length; }
  return result;
}

export function createWorkbookFixture({ duplicate = false, formulaWithoutCache = false, malformedXML = false } = {}) {
  const namespace = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  const shared = ['N°', 'Estado', 'Nombre completo', 'Fecha de pago', 'Disponible', 'Ana Pérez', 'Bruno', '001', '017', '104', '999', 'Boleto', 'Nombre', 'Invitado de prueba', 'A-007'];
  const stringCell = (column, row, value) => `<c r="${column}${row}" t="s"><v>${shared.indexOf(value)}</v></c>`;
  const row = (number, ticket, name, paid = false, numeric = false) => `<row r="${number}">${numeric ? `<c r="A${number}" s="1"><v>1</v></c>` : stringCell('A', number, ticket)}${stringCell('B', number, 'Disponible')}${name ? stringCell('C', number, name) : ''}${paid ? `<c r="D${number}"><v>46231</v></c>` : ''}</row>`;
  const firstSheet = `<worksheet xmlns="${namespace}"><sheetData><row r="1">${stringCell('A', 1, 'N°')}${stringCell('B', 1, 'Estado')}${stringCell('C', 1, 'Nombre completo')}${stringCell('D', 1, 'Fecha de pago')}</row>${row(2, '001', 'Ana Pérez', true, !duplicate)}${row(3, '017', 'Ana Pérez')}${row(4, duplicate ? '001' : '104', 'Bruno', true)}${row(5, '999', '')}<row r="6"/>${formulaWithoutCache ? '<row r="7"><c r="A7"><f>1+1</f></c><c r="C7" t="inlineStr"><is><t>Nombre de fórmula</t></is></c></row>' : ''}</sheetData></worksheet>`;
  return zip({
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>',
    '_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    'xl/workbook.xml': `<workbook xmlns="${namespace}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Control Rifa" sheetId="1" r:id="rId1"/><sheet name="Otra hoja" sheetId="2" r:id="rId2"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/><Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
    'xl/sharedStrings.xml': `<sst xmlns="${namespace}" count="${shared.length}" uniqueCount="${shared.length}">${shared.map((value) => `<si><t>${escapeXML(value)}</t></si>`).join('')}</sst>`,
    'xl/styles.xml': `<styleSheet xmlns="${namespace}"><numFmts count="1"><numFmt numFmtId="164" formatCode="000"/></numFmts><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="164"/></cellXfs></styleSheet>`,
    'xl/worksheets/sheet1.xml': malformedXML ? '<worksheet><' : firstSheet,
    'xl/worksheets/sheet2.xml': `<worksheet xmlns="${namespace}"><sheetData><row r="1">${stringCell('A', 1, 'Boleto')}${stringCell('B', 1, 'Nombre')}</row><row r="2"><c r="A2" t="inlineStr"><is><t>A-007</t></is></c><c r="B2" t="inlineStr"><is><r><t>Invitado </t></r><r><t>de prueba</t></r></is></c></row></sheetData></worksheet>`,
  });
}
