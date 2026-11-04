const UINT32_RANGE = 2 ** 32;

function displayName(value) {
  return value.normalize('NFC').trim().replace(/\s+/gu, ' ');
}

function nameKey(value) {
  return displayName(value).toLocaleLowerCase('es');
}

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

function csvCell(value) {
  let text = String(value);
  // Neutralize spreadsheet formulas, including formulas after leading whitespace.
  if (/^\s*[=+\-@]/u.test(text) || /^[\t\r\n]/u.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

/** Export a draw as a UTF-8 CSV that spreadsheet applications can read safely. */
export function resultsToCSV(draw) {
  if (!draw || typeof draw.title !== 'string' || !Array.isArray(draw.winners)
      || draw.winners.some((winner) => typeof winner !== 'string' || !winner.trim())) {
    throw new TypeError('Los resultados del sorteo no son válidos.');
  }
  const date = new Date(draw.createdAt);
  if (draw.createdAt == null || Number.isNaN(date.getTime())) {
    throw new TypeError('La fecha del sorteo no es válida.');
  }
  const rows = [['Posición', 'Ganador', 'Sorteo', 'Fecha']];
  draw.winners.forEach((winner, index) => {
    rows.push([index + 1, winner, draw.title, date.toISOString()]);
  });
  return `\uFEFF${rows.map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
}
