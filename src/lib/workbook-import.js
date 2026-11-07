const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 25 * 1024 * 1024;
const MAX_ENTRIES = 2000;
const MAX_ROWS = 100000;
const XML_NAMESPACE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
  return value >>> 0;
});

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

function failure(message) { return new Error(`No se pudo importar el Excel: ${message}`); }
function child(node, name) { return [...node.children].find((item) => item.localName === name); }
function children(node, name) { return [...node.children].filter((item) => item.localName === name); }
function descendants(node, name) { return [...node.getElementsByTagNameNS('*', name)]; }

function decodeText(bytes) {
  try {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le', { fatal: true }).decode(bytes);
    if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be', { fatal: true }).decode(bytes);
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch { throw failure('hay texto con una codificación no válida. Guarda el archivo de nuevo como .xlsx.'); }
}

function parseXML(bytes, filename) {
  if (typeof DOMParser !== 'function') throw failure('usa un navegador moderno para leer archivos .xlsx.');
  const text = decodeText(bytes);
  if (/<!DOCTYPE|<!ENTITY/iu.test(text)) throw failure('el archivo contiene declaraciones XML no admitidas.');
  const document = new DOMParser().parseFromString(text, 'application/xml');
  if (document.documentElement.localName === 'parsererror' || document.getElementsByTagName('parsererror').length) {
    throw failure(`el documento ${filename} no es válido.`);
  }
  return document;
}

/** Read only ZIP members needed for the workbook, without extracting files. */
async function openArchive(file) {
  if (!(file instanceof Blob) || !file.size || file.size > MAX_FILE_BYTES) {
    throw failure('elige un archivo .xlsx con contenido y de hasta 10 MB.');
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 22 || data.getUint32(0, true) !== 0x04034b50) {
    throw failure('el archivo no es un .xlsx válido o está protegido por contraseña.');
  }
  let end = -1;
  for (let position = bytes.length - 22; position >= Math.max(0, bytes.length - 65557); position--) {
    if (data.getUint32(position, true) === 0x06054b50 && position + 22 + data.getUint16(position + 20, true) === bytes.length) {
      end = position; break;
    }
  }
  if (end === -1) throw failure('el archivo está incompleto o no es un libro .xlsx compatible.');
  const entryCount = data.getUint16(end + 10, true);
  const centralSize = data.getUint32(end + 12, true);
  const centralOffset = data.getUint32(end + 16, true);
  if (data.getUint16(end + 4, true) || data.getUint16(end + 6, true)
      || data.getUint16(end + 8, true) !== entryCount || entryCount > MAX_ENTRIES || entryCount === 0xffff
      || centralOffset + centralSize !== end) {
    throw failure('el archivo usa un formato ZIP no compatible o tiene demasiados componentes.');
  }
  const entries = new Map();
  let position = centralOffset;
  let totalExpanded = 0;
  for (let index = 0; index < entryCount; index++) {
    if (position + 46 > end || data.getUint32(position, true) !== 0x02014b50) throw failure('la estructura del libro está dañada.');
    const flags = data.getUint16(position + 8, true);
    const method = data.getUint16(position + 10, true);
    const crc = data.getUint32(position + 16, true);
    const compressedSize = data.getUint32(position + 20, true);
    const expandedSize = data.getUint32(position + 24, true);
    const filenameLength = data.getUint16(position + 28, true);
    const extraLength = data.getUint16(position + 30, true);
    const commentLength = data.getUint16(position + 32, true);
    const localOffset = data.getUint32(position + 42, true);
    const nextPosition = position + 46 + filenameLength + extraLength + commentLength;
    if (nextPosition > end || flags & 1 || ![0, 8].includes(method) || localOffset >= centralOffset) {
      throw failure('el libro está cifrado, dañado o usa una compresión no compatible.');
    }
    const filename = decodeText(bytes.subarray(position + 46, position + 46 + filenameLength));
    if (!filename || filename.startsWith('/') || filename.includes('\\') || filename.split('/').includes('..') || entries.has(filename)) {
      throw failure('el archivo contiene rutas duplicadas o no válidas.');
    }
    totalExpanded += expandedSize;
    if (expandedSize > MAX_EXPANDED_BYTES || totalExpanded > MAX_EXPANDED_BYTES) throw failure('el libro supera el límite de 25 MB descomprimidos.');
    entries.set(filename, { flags, method, crc, compressedSize, expandedSize, localOffset });
    position = nextPosition;
  }
  if (position !== end) throw failure('el índice del libro no es válido.');
  const cache = new Map();

  async function read(filename) {
    if (cache.has(filename)) return cache.get(filename);
    const entry = entries.get(filename);
    if (!entry) throw failure(`falta el componente ${filename}.`);
    const offset = entry.localOffset;
    if (offset + 30 > centralOffset || data.getUint32(offset, true) !== 0x04034b50
        || data.getUint16(offset + 6, true) & 1 || data.getUint16(offset + 8, true) !== entry.method) {
      throw failure('uno de los componentes del libro está dañado.');
    }
    const filenameLength = data.getUint16(offset + 26, true);
    const start = offset + 30 + filenameLength + data.getUint16(offset + 28, true);
    if (start + entry.compressedSize > centralOffset
        || decodeText(bytes.subarray(offset + 30, offset + 30 + filenameLength)) !== filename) throw failure('un componente del libro no coincide con su índice.');
    const compressed = bytes.subarray(start, start + entry.compressedSize);
    let result;
    if (entry.method === 0) result = compressed;
    else {
      let stream;
      try { stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('deflate-raw')); }
      catch { throw failure('este navegador no permite descomprimir Excel. Actualízalo o importa un CSV.'); }
      const reader = stream.getReader();
      const chunks = [];
      let length = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          length += chunk.value.length;
          if (length > entry.expandedSize || length > MAX_EXPANDED_BYTES) {
            await reader.cancel(); throw failure('un componente supera el tamaño declarado.');
          }
          chunks.push(chunk.value);
        }
      } catch (error) {
        if (error.message?.startsWith('No se pudo importar')) throw error;
        throw failure('no se pudo descomprimir un componente del libro.');
      }
      result = new Uint8Array(length);
      let cursor = 0;
      for (const chunk of chunks) { result.set(chunk, cursor); cursor += chunk.length; }
    }
    if (result.length !== entry.expandedSize || crc32(result) !== entry.crc) throw failure('falló la comprobación de integridad del libro.');
    cache.set(filename, result);
    return result;
  }
  return { has: (filename) => entries.has(filename), xml: async (filename) => parseXML(await read(filename), filename) };
}

function resolvePart(base, target) {
  if (!target || /^[a-z][a-z\d+.-]*:/iu.test(target) || target.includes('\\') || target.includes('\0')) throw failure('hay una referencia externa no admitida.');
  const parts = target.startsWith('/') ? [] : base.split('/').slice(0, -1);
  for (const part of target.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { if (!parts.length) throw failure('hay una ruta fuera del libro.'); parts.pop(); }
    else parts.push(part);
  }
  return parts.join('/');
}
function relationsPath(part) {
  const pieces = part.split('/'); const filename = pieces.pop();
  return [...pieces, '_rels', `${filename}.rels`].join('/');
}
async function readRelations(archive, part) {
  const filename = part ? relationsPath(part) : '_rels/.rels';
  if (!archive.has(filename)) return [];
  const document = await archive.xml(filename);
  return descendants(document, 'Relationship').map((item) => ({
    id: item.getAttribute('Id'), type: item.getAttribute('Type'), external: item.getAttribute('TargetMode') === 'External',
    target: item.getAttribute('Target'),
  }));
}
function headerKey(value) { return value.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('es').replace(/[^a-z\d]/gu, ''); }
const TICKET_HEADERS = new Set(['n', 'no', 'numero', 'numeroboleto', 'numerodeboleto', 'boleto', 'ticket', 'ticketid', 'idboleto', 'numeroticket']);
const NAME_HEADERS = new Set(['nombre', 'nombres', 'nombrecompleto', 'nombrescompletos', 'participante', 'comprador', 'nombredelparticipante', 'nombresyapellidos']);
const PAYMENT_HEADERS = new Set(['fechadepago', 'fechapago', 'pagadoel', 'paymentdate']);
const STATE_HEADERS = new Set(['estado', 'status', 'estadoboleto']);

function stringContent(node) {
  // Phonetic runs are annotations and must not become part of names or numbers.
  return descendants(node, 't').filter((item) => item.parentElement?.localName !== 'rPh').map((item) => item.textContent).join('');
}
function cellValue(cell, shared, styles) {
  const type = cell.getAttribute('t');
  const valueNode = child(cell, 'v');
  if (child(cell, 'f') && !valueNode) throw failure(`la fórmula de la celda ${cell.getAttribute('r') || ''} no tiene un resultado guardado. Abre y guarda el libro en Excel.`);
  const value = valueNode?.textContent ?? '';
  if (type === 's') {
    if (!/^\d+$/u.test(value) || Number(value) >= shared.length) throw failure('hay una referencia de texto no válida.');
    return shared[Number(value)];
  }
  if (type === 'inlineStr') return child(cell, 'is') ? stringContent(child(cell, 'is')) : '';
  if (type === 'e') throw failure(`la celda ${cell.getAttribute('r') || ''} contiene un error de Excel.`);
  if (type === 'b') return value === '1' ? 'TRUE' : value === '0' ? 'FALSE' : '';
  if (type === 'str' || !value) return value;
  const number = Number(value);
  if (!Number.isFinite(number)) return value;
  const style = styles[Number(cell.getAttribute('s') || 0)];
  const format = style?.split(';')[0] || '';
  // A pure zero mask represents printed ticket identifiers such as 001.
  if (/^0+$/u.test(format) && Number.isInteger(number) && number >= 0) return String(number).padStart(format.length, '0');
  return String(number);
}
function columnName(cell) {
  const reference = cell.getAttribute('r') || '';
  const match = /^([A-Z]+)\d+$/iu.exec(reference);
  if (!match) throw failure('hay una celda sin referencia de columna válida.');
  return match[1].toUpperCase();
}

function readSheet(document, name, shared, styles) {
  const sheetData = descendants(document, 'sheetData')[0];
  if (!sheetData) return null;
  const sourceRows = children(sheetData, 'row');
  if (sourceRows.length > MAX_ROWS) throw failure(`la hoja «${name}» supera las 100.000 filas.`);
  let header;
  let columns;
  for (let index = 0; index < Math.min(sourceRows.length, 50); index++) {
    const map = {};
    for (const cell of children(sourceRows[index], 'c')) {
      const key = headerKey(cellValue(cell, shared, styles).trim());
      if (TICKET_HEADERS.has(key)) map.ticket = columnName(cell);
      if (NAME_HEADERS.has(key)) map.name = columnName(cell);
      if (PAYMENT_HEADERS.has(key)) map.payment = columnName(cell);
      if (STATE_HEADERS.has(key)) map.state = columnName(cell);
    }
    if (map.ticket && map.name && map.ticket !== map.name) { header = index; columns = map; break; }
  }
  if (!columns) return null;
  const rows = [];
  let skippedEmpty = 0;
  for (let index = header + 1; index < sourceRows.length; index++) {
    const row = sourceRows[index];
    const values = {};
    for (const cell of children(row, 'c')) {
      const column = columnName(cell);
      if (Object.values(columns).includes(column)) values[column] = cellValue(cell, shared, styles).trim();
    }
    const ticketId = values[columns.ticket] || '';
    const participantName = values[columns.name] || '';
    if (!ticketId && !participantName) { skippedEmpty++; continue; }
    if (participantName && !ticketId) throw failure(`la fila ${row.getAttribute('r') || index + 1} de «${name}» tiene nombre pero no número de boleto.`);
    rows.push({ ticketId, name: participantName, hasPaymentDate: Boolean(values[columns.payment]), state: values[columns.state] || '', rowNumber: Number(row.getAttribute('r')) || index + 1 });
  }
  return { name, rows, skippedEmpty, skippedUnassigned: rows.filter((row) => !row.name).length, hasPaymentColumn: Boolean(columns.payment) };
}

/** Read ticket identifiers and participant names locally; never returns ID or phone columns. */
export async function readRaffleWorkbook(file) {
  const archive = await openArchive(file);
  const rootRelations = await readRelations(archive, '');
  const workbookRelationship = rootRelations.find((relation) => relation.type?.endsWith('/officeDocument') && !relation.external);
  const workbookPath = workbookRelationship ? resolvePart('', workbookRelationship.target) : 'xl/workbook.xml';
  const workbook = await archive.xml(workbookPath);
  const relations = await readRelations(archive, workbookPath);
  const relationById = new Map(relations.map((relation) => [relation.id, relation]));
  const sharedRelation = relations.find((relation) => relation.type?.endsWith('/sharedStrings') && !relation.external);
  const sharedPath = sharedRelation ? resolvePart(workbookPath, sharedRelation.target) : 'xl/sharedStrings.xml';
  const shared = archive.has(sharedPath) ? descendants(await archive.xml(sharedPath), 'si').map(stringContent) : [];
  const styleRelation = relations.find((relation) => relation.type?.endsWith('/styles') && !relation.external);
  const stylesPath = styleRelation ? resolvePart(workbookPath, styleRelation.target) : 'xl/styles.xml';
  let styles = [];
  if (archive.has(stylesPath)) {
    const document = await archive.xml(stylesPath);
    const formats = new Map(descendants(document, 'numFmt').map((item) => [item.getAttribute('numFmtId'), item.getAttribute('formatCode')]));
    const cellFormats = descendants(document, 'cellXfs')[0];
    if (cellFormats) styles = children(cellFormats, 'xf').map((item) => formats.get(item.getAttribute('numFmtId')) || (item.getAttribute('numFmtId') === '1' ? '0' : ''));
  }
  const sheetNodes = descendants(workbook, 'sheet');
  if (sheetNodes.length > 100) throw failure('el libro contiene más de 100 hojas.');
  const sheets = [];
  for (const node of sheetNodes) {
    const relation = relationById.get(node.getAttributeNS(XML_NAMESPACE, 'id') || node.getAttribute('r:id'));
    if (!relation || relation.external || !relation.type?.endsWith('/worksheet')) continue;
    const name = node.getAttribute('name') || `Hoja ${sheets.length + 1}`;
    const sheet = readSheet(await archive.xml(resolvePart(workbookPath, relation.target)), name, shared, styles);
    if (sheet && sheet.rows.length) sheets.push(sheet);
  }
  if (!sheets.length) throw failure('no encontramos una hoja con las columnas «N°» y «Nombre completo» o «Boleto» y «Nombre».');
  return { sheets };
}
