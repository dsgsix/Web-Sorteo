const UINT32_RANGE = 2 ** 32;
const MAX_PARTICIPANTS = 5000;
const MAX_TICKETS_PER_PERSON = 1000000;

function displayName(value) {
  return value.normalize('NFC').trim().replace(/\s+/gu, ' ');
}

export function normalizeNameKey(value) {
  if (typeof value !== 'string') throw new TypeError('El nombre debe ser texto.');
  return displayName(value).toLocaleLowerCase('es');
}

const nameKey = normalizeNameKey;

/** Read one participant per line and keep the first spelling of each name. */
export function parseParticipants(text) {
  if (typeof text !== 'string') {
    throw new TypeError('La lista de participantes debe ser texto.');
  }

  const names = [];
  const seen = new Set();
  let duplicateCount = 0;

  for (const line of text.split(/\r\n|\n|\r/u)) {
    const name = displayName(line);
    if (!name) continue;
    const key = nameKey(name);
    if (seen.has(key)) {
      duplicateCount += 1;
    } else {
      names.push(name);
      seen.add(key);
    }
  }

  return { names, duplicateCount };
}

function lineError(line, message) {
  return new RangeError(`Línea ${line}: ${message}`);
}

/** Read CSV records while retaining physical line numbers for useful errors. */
function ticketRecords(text) {
  const records = [];
  let fields = [];
  let field = '';
  let quoted = false;
  let quoteClosed = false;
  let delimiter = null;
  let line = 1;
  let recordLine = 1;

  function finishField() {
    fields.push(field.trim());
    field = '';
    quoteClosed = false;
  }

  function finishRecord() {
    finishField();
    if (fields.length > 1 || fields[0]) records.push({ fields, line: recordLine });
    fields = [];
    delimiter = null;
    recordLine = line + 1;
  }

  text = text.replace(/^\uFEFF/u, '');
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '\0') throw lineError(line, 'usa un archivo de texto UTF-8.');
    if (char === '"') {
      if (quoted && text[index + 1] === '"') { field += '"'; index += 1; }
      else if (quoted) { quoted = false; quoteClosed = true; }
      else if (!quoteClosed && !field.trim()) { quoted = true; field = ''; }
      else throw lineError(line, 'las comillas deben encerrar todo el nombre.');
      continue;
    }
    if (char === '\n' || char === '\r') {
      if (char === '\r' && text[index + 1] === '\n') index += 1;
      if (quoted) field += '\n';
      else finishRecord();
      line += 1;
      continue;
    }
    if (!quoted && (char === ',' || char === ';')) {
      if (delimiter && delimiter !== char) throw lineError(recordLine, 'usa un solo separador: coma o punto y coma.');
      delimiter = char;
      finishField();
      continue;
    }
    if (quoteClosed && char.trim()) throw lineError(line, 'hay texto después de las comillas de cierre.');
    field += char;
  }
  if (quoted) throw lineError(recordLine, 'falta cerrar las comillas del nombre.');
  finishRecord();
  return records;
}

/** One name is one ticket; repeated names and explicit quantities add tickets. */
export function parseTicketParticipants(text) {
  if (typeof text !== 'string') throw new TypeError('La lista de participantes debe ser texto.');
  const participants = [];
  const byName = new Map();
  let totalTickets = 0;
  let firstRecord = true;

  for (const { fields, line } of ticketRecords(text)) {
    if (firstRecord && fields.length === 2
        && ['nombre', 'participante', 'name'].includes(nameKey(fields[0]))
        && ['boletos', 'cantidad', 'tickets'].includes(nameKey(fields[1]))) {
      firstRecord = false;
      continue;
    }
    firstRecord = false;
    if (fields.length > 2) throw lineError(line, 'se esperan nombre y cantidad; encierra entre comillas los nombres con coma.');
    const name = displayName(fields[0]);
    if (!name) throw lineError(line, 'el participante necesita un nombre.');
    if (name.length > 200) throw lineError(line, 'cada nombre puede tener hasta 200 caracteres.');
    if (fields.length === 2 && !/^\d+$/u.test(fields[1])) {
      throw lineError(line, 'la cantidad de boletos debe ser un entero entre 1 y 1.000.000.');
    }
    const tickets = fields.length === 1 ? 1 : Number(fields[1]);
    if (!Number.isSafeInteger(tickets) || tickets < 1 || tickets > MAX_TICKETS_PER_PERSON) {
      throw lineError(line, 'la cantidad de boletos debe estar entre 1 y 1.000.000.');
    }
    const key = nameKey(name);
    const existing = byName.get(key);
    if (existing && existing.tickets + tickets > MAX_TICKETS_PER_PERSON) {
      throw lineError(line, 'un participante no puede acumular más de 1.000.000 de boletos.');
    }
    if (!existing && participants.length >= MAX_PARTICIPANTS) {
      throw lineError(line, 'puedes incluir hasta 5.000 participantes.');
    }
    if (totalTickets + tickets > UINT32_RANGE) {
      throw lineError(line, 'el total no puede superar 4.294.967.296 boletos.');
    }
    if (existing) existing.tickets += tickets;
    else {
      const participant = { name, tickets };
      participants.push(participant);
      byName.set(key, participant);
    }
    totalTickets += tickets;
  }
  return { participants, totalTickets };
}

/** Return an unbiased random integer from zero up to maxExclusive - 1. */
export function secureRandomInt(maxExclusive) {
  if (!Number.isInteger(maxExclusive) || maxExclusive < 1 || maxExclusive > UINT32_RANGE) {
    throw new RangeError('El límite aleatorio debe ser un entero entre 1 y 2³².');
  }
  if (!globalThis.crypto?.getRandomValues) {
    throw new Error('Este navegador no ofrece aleatoriedad segura.');
  }

  // Discard the incomplete final bucket so modulo cannot favor any participant.
  const limit = UINT32_RANGE - (UINT32_RANGE % maxExclusive);
  const buffer = new Uint32Array(1);
  do {
    globalThis.crypto.getRandomValues(buffer);
  } while (buffer[0] >= limit);
  return buffer[0] % maxExclusive;
}

/** Select distinct winners with a partial Fisher–Yates shuffle. */
export function drawWinners(participants, count, randomInt = secureRandomInt) {
  if (!Array.isArray(participants) || participants.some((name) => typeof name !== 'string' || !displayName(name))) {
    throw new TypeError('Cada participante debe tener un nombre válido.');
  }
  if (new Set(participants.map(nameKey)).size !== participants.length) {
    throw new RangeError('La lista contiene participantes duplicados.');
  }
  if (!Number.isInteger(count) || count < 1 || count > participants.length) {
    throw new RangeError('El número de ganadores debe estar entre 1 y el total de participantes.');
  }
  if (typeof randomInt !== 'function') {
    throw new TypeError('El generador aleatorio debe ser una función.');
  }

  const pool = [...participants];
  for (let position = 0; position < count; position += 1) {
    const remaining = pool.length - position;
    const offset = randomInt(remaining);
    if (!Number.isInteger(offset) || offset < 0 || offset >= remaining) {
      throw new RangeError('El generador aleatorio devolvió un resultado inválido.');
    }
    const selected = position + offset;
    [pool[position], pool[selected]] = [pool[selected], pool[position]];
  }
  return pool.slice(0, count);
}

function createTicketPool(participants, { excludeNames = [], excludeTickets = [] } = {}) {
  if (!Array.isArray(participants) || participants.length > MAX_PARTICIPANTS) {
    throw new TypeError('La lista admite hasta 5.000 participantes.');
  }
  if (!Array.isArray(excludeNames) || excludeNames.some((name) => typeof name !== 'string')
      || !Array.isArray(excludeTickets)) {
    throw new TypeError('Las exclusiones del sorteo no son válidas.');
  }
  const excludedNames = new Set(excludeNames.map(nameKey));
  const excludedTickets = new Map();
  for (const ticket of excludeTickets) {
    if (!ticket || typeof ticket.name !== 'string' || !displayName(ticket.name)
        || !Number.isInteger(ticket.ticketNumber) || ticket.ticketNumber < 1
        || ticket.ticketNumber > MAX_TICKETS_PER_PERSON) {
      throw new TypeError('Cada boleto excluido necesita un nombre y un número válido.');
    }
    const key = nameKey(ticket.name);
    if (!excludedTickets.has(key)) excludedTickets.set(key, new Set());
    excludedTickets.get(key).add(ticket.ticketNumber);
  }

  const seen = new Set();
  const pool = [];
  let declaredTotal = 0;
  let totalTickets = 0;
  for (const participant of participants) {
    if (!participant || typeof participant.name !== 'string' || !displayName(participant.name)
        || displayName(participant.name).length > 200 || !Number.isInteger(participant.tickets)
        || participant.tickets < 1 || participant.tickets > MAX_TICKETS_PER_PERSON) {
      throw new TypeError('Cada participante necesita un nombre y entre 1 y 1.000.000 de boletos.');
    }
    const key = nameKey(participant.name);
    if (seen.has(key)) throw new RangeError('La lista contiene participantes duplicados; combina sus boletos primero.');
    seen.add(key);
    declaredTotal += participant.tickets;
    if (declaredTotal > UINT32_RANGE) throw new RangeError('El total no puede superar 4.294.967.296 boletos.');
    if (excludedNames.has(key)) continue;
    const removed = [...(excludedTickets.get(key) ?? [])].filter((number) => number <= participant.tickets).sort((a, b) => a - b);
    const available = participant.tickets - removed.length;
    if (!available) continue;
    pool.push({ name: displayName(participant.name), tickets: participant.tickets, available, initialAvailable: available, removed });
    totalTickets += available;
  }
  return { pool, totalTickets };
}

/** Count eligible people and tickets using the same exclusions as the draw. */
export function ticketPoolSummary(participants, options = {}) {
  const { pool, totalTickets } = createTicketPool(participants, options);
  return { eligibleParticipants: pool.length, totalTickets };
}

/** Sample equal-chance tickets without expanding large ticket counts into arrays. */
export function drawTicketWinners(participants, count, {
  excludeNames = [], excludeTickets = [], uniquePeople = true, randomInt = secureRandomInt,
} = {}) {
  if (typeof uniquePeople !== 'boolean' || typeof randomInt !== 'function') {
    throw new TypeError('Las opciones del sorteo no son válidas.');
  }
  const { pool, totalTickets: initialTotal } = createTicketPool(participants, { excludeNames, excludeTickets });
  const maximum = uniquePeople ? pool.length : initialTotal;
  if (!Number.isInteger(count) || count < 1 || count > MAX_PARTICIPANTS || count > maximum) {
    throw new RangeError(`Elige entre 1 y ${Math.min(MAX_PARTICIPANTS, maximum)} ganador${maximum === 1 ? '' : 'es'} elegibles.`);
  }

  const winners = [];
  let totalTickets = initialTotal;
  for (let draw = 0; draw < count; draw += 1) {
    let offset = randomInt(totalTickets);
    if (!Number.isInteger(offset) || offset < 0 || offset >= totalTickets) {
      throw new RangeError('El generador aleatorio devolvió un resultado inválido.');
    }
    let selected;
    for (const participant of pool) {
      if (offset < participant.available) { selected = participant; break; }
      offset -= participant.available;
    }

    // Map the rank among remaining tickets back to this person's original number.
    let ticketNumber = offset + 1;
    for (const removed of selected.removed) {
      if (removed > ticketNumber) break;
      ticketNumber += 1;
    }
    winners.push({
      name: selected.name, ticketNumber, tickets: selected.tickets,
      probability: selected.initialAvailable / initialTotal,
    });
    if (uniquePeople) {
      totalTickets -= selected.available;
      selected.available = 0;
    } else {
      let index = 0;
      while (index < selected.removed.length && selected.removed[index] < ticketNumber) index += 1;
      selected.removed.splice(index, 0, ticketNumber);
      selected.available -= 1;
      totalTickets -= 1;
    }
  }
  return winners;
}

function csvCell(value) {
  let text = String(value);
  // Neutralize spreadsheet formulas, including formulas after leading whitespace.
  if (/^\s*[=+\-@]/u.test(text) || /^[\t\r\n]/u.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

/** Export a draw as a UTF-8 CSV that spreadsheet applications can read safely. */
export function resultsToCSV(draw) {
  const details = draw?.winnerDetails;
  const winners = draw?.winners ?? (Array.isArray(details) ? details.map((detail) => detail?.name) : null);
  if (!draw || typeof draw.title !== 'string' || !Array.isArray(winners)
      || winners.some((winner) => typeof winner !== 'string' || !winner.trim())) {
    throw new TypeError('Los resultados del sorteo no son válidos.');
  }
  const date = new Date(draw.createdAt);
  if (draw.createdAt == null || Number.isNaN(date.getTime())) {
    throw new TypeError('La fecha del sorteo no es válida.');
  }
  const hasDetails = details !== undefined;
  if (hasDetails && (!Array.isArray(details) || details.length !== winners.length
      || details.some((detail, index) => !detail || typeof detail.name !== 'string'
        || nameKey(detail.name) !== nameKey(winners[index]) || !Number.isInteger(detail.tickets)
        || detail.tickets < 1 || detail.tickets > MAX_TICKETS_PER_PERSON
        || !Number.isInteger(detail.ticketNumber) || detail.ticketNumber < 1 || detail.ticketNumber > detail.tickets
        || !Number.isFinite(detail.probability) || detail.probability <= 0 || detail.probability > 1))) {
    throw new TypeError('Los detalles de los boletos ganadores no son válidos.');
  }
  const rows = [['Posición', 'Ganador', 'Sorteo', 'Fecha']];
  if (hasDetails) rows[0].push('Etapa', 'Premio', 'Boleto', 'Boletos', 'Probabilidad');
  winners.forEach((winner, index) => {
    const row = [index + 1, winner, draw.title, date.toISOString()];
    if (hasDetails) {
      const detail = details[index];
      row.push(draw.stageName ?? draw.stage ?? '', draw.prize ?? '', detail.ticketNumber, detail.tickets,
        `${Number((detail.probability * 100).toPrecision(10))}%`);
    }
    rows.push(row);
  });
  return `\uFEFF${rows.map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
}
