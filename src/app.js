import { parseParticipants, drawWinners, resultsToCSV } from './lib/raffle.js';

const $ = (id) => document.getElementById(id);
const STORAGE_KEY = 'sortea.workspace.v1';
const MAX_PARTICIPANTS = 5000;
const MAX_TEXT_LENGTH = 200000;
const MAX_HISTORY = 100;
const EXAMPLE = ['Ana García', 'Carlos López', 'María Rodríguez', 'Diego Pérez', 'Lucía Torres', 'Andrés Ruiz', 'Valentina Castro', 'Sofía Mendoza'];
const dateFormatter = new Intl.DateTimeFormat('es', { dateStyle: 'medium', timeStyle: 'short' });
const nameKey = (name) => name.normalize('NFC').replace(/\s+/gu, ' ').trim().toLocaleLowerCase('es');
let history = [];
let activeDraw = null;
let isDrawing = false;
let toastTimer;
let storageWarningShown = false;

function notify(message) {
  clearTimeout(toastTimer);
  $('toast').textContent = message;
  $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4500);
}

function warnStorage() {
  if (!storageWarningShown) {
    storageWarningShown = true;
    notify('No se pudo guardar en este navegador. Puedes sortear y descargar tus resultados.');
  }
}

function validDraw(draw) {
  return draw && typeof draw.id === 'string' && draw.id.length <= 100 &&
    typeof draw.title === 'string' && draw.title.length <= 100 &&
    typeof draw.createdAt === 'string' && Number.isFinite(Date.parse(draw.createdAt)) &&
    Array.isArray(draw.winners) && draw.winners.length > 0 && draw.winners.length <= MAX_PARTICIPANTS &&
    draw.winners.every((name) => typeof name === 'string' && name.trim() && name.length <= 200) &&
    new Set(draw.winners.map(nameKey)).size === draw.winners.length &&
    Number.isInteger(draw.participantCount) && draw.participantCount >= draw.winners.length &&
    draw.participantCount <= MAX_PARTICIPANTS;
}

function restore() {
  try {
    const serialized = localStorage.getItem(STORAGE_KEY);
    if (!serialized) return;
    const stored = JSON.parse(serialized);
    if (!stored || stored.version !== 1) throw new Error('Formato no reconocido');
    history = Array.isArray(stored.history) ? stored.history.filter(validDraw).slice(0, MAX_HISTORY) : [];
    if (typeof stored.title === 'string') $('raffle-title').value = stored.title.slice(0, 100);
    if (typeof stored.participants === 'string') $('participants').value = stored.participants.slice(0, MAX_TEXT_LENGTH);
    if (Number.isInteger(stored.winnerCount) && stored.winnerCount > 0 && stored.winnerCount <= MAX_PARTICIPANTS) $('winner-count').value = stored.winnerCount;
    if (typeof stored.excludeWinners === 'boolean') $('exclude-winners').checked = stored.excludeWinners;
  } catch {
    notify('No se pudieron recuperar los datos guardados. Puedes empezar un nuevo sorteo.');
  }
}

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      version: 1, title: $('raffle-title').value, participants: $('participants').value,
      winnerCount: Number($('winner-count').value), excludeWinners: $('exclude-winners').checked, history,
    }));
  } catch { warnStorage(); }
}

function participantState() {
  const parsed = parseParticipants($('participants').value);
  const previous = new Set(history.flatMap((draw) => draw.winners).map(nameKey));
  const eligible = $('exclude-winners').checked ? parsed.names.filter((name) => !previous.has(nameKey(name))) : parsed.names;
  return { ...parsed, eligible };
}

function updateParticipants() {
  const { names, duplicateCount, eligible } = participantState();
  $('participants-count').textContent = `${names.length} participante${names.length === 1 ? '' : 's'}`;
  const hints = [];
  if (duplicateCount) hints.push(`${duplicateCount} duplicado${duplicateCount === 1 ? '' : 's'} omitido${duplicateCount === 1 ? '' : 's'}.`);
  if (names.length !== eligible.length) hints.push(`${names.length - eligible.length} ya ganaron; ${eligible.length} en juego.`);
  $('participants-hint').textContent = hints.join(' ') || 'Un nombre por línea. Sin duplicados.';
  $('decrease-count').disabled = isDrawing || Number($('winner-count').value) <= 1;
  $('increase-count').disabled = isDrawing || Number($('winner-count').value) >= MAX_PARTICIPANTS;
  if (!isDrawing) setStageStatus(eligible.length ? `${eligible.length} en juego` : 'A tu ritmo');
}

function setStageStatus(text) {
  const dot = document.createElement('span');
  dot.className = 'status-dot';
  $('stage-status').replaceChildren(dot, document.createTextNode(text));
}

function showError(message, focusId) {
  $('form-error').textContent = message;
  $('form-error').hidden = false;
  if (focusId) $(focusId).focus();
}

function hideError() { $('form-error').hidden = true; }

function renderHistory() {
  $('history-count').textContent = history.length;
  $('history-empty').hidden = history.length > 0;
  $('history-list').hidden = history.length === 0;
  $('clear-history').hidden = history.length === 0;
  $('history-list').replaceChildren();
  for (const draw of history) {
    const item = document.createElement('li');
    item.className = 'history-item';
    const icon = document.createElement('span');
    icon.className = 'history-symbol';
    icon.textContent = '✳';
    icon.setAttribute('aria-hidden', 'true');
    const detail = document.createElement('div');
    detail.className = 'history-detail';
    const title = document.createElement('strong');
    title.textContent = draw.title;
    const meta = document.createElement('small');
    meta.textContent = `${dateFormatter.format(new Date(draw.createdAt))} · ${draw.participantCount} participantes · ${draw.winners.length} ganador${draw.winners.length === 1 ? '' : 'es'}`;
    detail.append(title, meta);
    const winners = document.createElement('span');
    winners.className = 'history-winners';
    winners.textContent = draw.winners.join(', ');
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'Ver resultado';
    button.setAttribute('aria-label', `Ver resultado de ${draw.title}`);
    button.addEventListener('click', () => {
      if (isDrawing) return;
      showResults(draw);
      $('result-title').focus({ preventScroll: true });
      $('stage-card').scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    item.append(icon, detail, winners, button);
    $('history-list').append(item);
  }
}

function showResults(draw) {
  activeDraw = draw;
  $('stage-card').setAttribute('aria-labelledby', 'result-title');
  $('stage-empty').hidden = true;
  $('results').hidden = false;
  $('result-title').textContent = draw.winners.length === 1 ? '¡Tenemos ganador!' : '¡Tenemos ganadores!';
  $('result-raffle-title').textContent = draw.title;
  $('winner-list').replaceChildren();
  for (const [index, name] of draw.winners.entries()) {
    const item = document.createElement('li');
    const rank = document.createElement('span');
    rank.className = 'winner-rank';
    rank.textContent = index + 1;
    rank.setAttribute('aria-label', `Posición ${index + 1}`);
    const winner = document.createElement('span');
    winner.className = 'winner-name';
    winner.textContent = name;
    item.append(rank, winner);
    if (index === 0) {
      const star = document.createElement('span');
      star.className = 'winner-spark';
      star.textContent = '✳';
      star.setAttribute('aria-hidden', 'true');
      item.append(star);
    }
    $('winner-list').append(item);
  }
  $('result-date').textContent = dateFormatter.format(new Date(draw.createdAt));
  setStageStatus('Sorteo completado');
}

function celebrate() {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const colors = ['#d9ef9b', '#f3ca81', '#f7f8f2', '#a6caaa'];
  $('confetti').replaceChildren();
  for (let i = 0; i < 34; i++) {
    const piece = document.createElement('i');
    piece.style.left = `${(i * 37) % 100}%`;
    piece.style.background = colors[i % colors.length];
    piece.style.animationDelay = `${(i % 7) * 0.08}s`;
    $('confetti').append(piece);
  }
  setTimeout(() => $('confetti').replaceChildren(), 3200);
}

function lockForm(locked) {
  isDrawing = locked;
  for (const input of $('raffle-form').elements) input.disabled = locked;
  $('clear-history').disabled = locked;
  for (const button of $('history-list').querySelectorAll('button')) button.disabled = locked;
  $('draw-button-label').textContent = locked ? 'La suerte está girando…' : '¡Que empiece la suerte!';
  $('stage-card').classList.toggle('is-drawing', locked);
  $('stage-card').setAttribute('aria-busy', String(locked));
  if (!locked) updateParticipants();
}

$('raffle-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (isDrawing) return;
  hideError();
  const { names, eligible } = participantState();
  const count = Number($('winner-count').value);
  if (!names.length) return showError('La suerte necesita nombres. Añade al menos un participante.', 'participants');
  if (names.length > MAX_PARTICIPANTS) return showError(`Puedes incluir hasta ${MAX_PARTICIPANTS} participantes por sorteo.`, 'participants');
  if (names.some((name) => name.length > 200)) return showError('Cada nombre puede tener hasta 200 caracteres.', 'participants');
  if (!eligible.length) return showError('Todos estos participantes ya ganaron. Desactiva «Que la suerte se reparta» para incluirlos de nuevo.', 'exclude-winners');
  if (!Number.isInteger(count) || count < 1 || count > eligible.length) return showError(`Elige entre 1 y ${eligible.length} ganador${eligible.length === 1 ? '' : 'es'} elegible${eligible.length === 1 ? '' : 's'}.`, 'winner-count');

  let draw;
  try {
    draw = {
      id: crypto.randomUUID(), title: $('raffle-title').value.trim() || 'Un momento de suerte',
      createdAt: new Date().toISOString(), winners: drawWinners(eligible, count), participantCount: names.length,
    };
  } catch {
    return showError('Tu navegador no ofrece el generador aleatorio seguro. Abre el sitio por HTTPS o en un navegador actualizado.');
  }
  lockForm(true);
  $('results').hidden = true;
  $('stage-empty').hidden = false;
  $('stage-card').setAttribute('aria-labelledby', 'stage-heading');
  setStageStatus('Eligiendo al azar');
  $('draw-announcement').textContent = 'Sorteo en curso.';
  await new Promise((resolve) => setTimeout(resolve, matchMedia('(prefers-reduced-motion: reduce)').matches ? 80 : 1600));
  history.unshift(draw);
  history = history.slice(0, MAX_HISTORY);
  persist();
  renderHistory();
  lockForm(false);
  showResults(draw);
  celebrate();
  const announced = draw.winners.slice(0, 10).join(', ');
  $('draw-announcement').textContent = `Sorteo completado. ${draw.winners.length} ganador${draw.winners.length === 1 ? '' : 'es'}: ${announced}${draw.winners.length > 10 ? ' y más. Consulta los resultados.' : '.'}`;
  $('result-title').focus({ preventScroll: true });
  if (matchMedia('(max-width: 760px)').matches) $('stage-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
});

for (const id of ['participants', 'raffle-title', 'winner-count', 'exclude-winners']) {
  $(id).addEventListener('input', () => { hideError(); updateParticipants(); persist(); });
}
$('participants').maxLength = MAX_TEXT_LENGTH;

for (const [id, delta] of [['decrease-count', -1], ['increase-count', 1]]) {
  $(id).addEventListener('click', () => {
    const current = Number($('winner-count').value);
    $('winner-count').value = Math.max(1, Math.min(MAX_PARTICIPANTS, (Number.isFinite(current) ? Math.trunc(current) : 1) + delta));
    hideError(); updateParticipants(); persist();
  });
}

$('example-button').addEventListener('click', () => {
  const current = parseParticipants($('participants').value).names;
  $('participants').value = parseParticipants([...current, ...EXAMPLE].join('\n')).names.join('\n');
  hideError(); updateParticipants(); persist();
  notify('Añadimos ocho nombres de ejemplo sin borrar los tuyos.');
});

$('import-button').addEventListener('click', () => $('file-input').click());
$('file-input').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  try {
    if (file.size > 1024 * 1024) throw new Error('El archivo debe pesar menos de 1 MB.');
    const text = await file.text();
    if (isDrawing) return;
    if (text.includes('\0')) throw new Error('Usa un archivo de texto UTF-8, con un nombre por línea.');
    const current = $('participants').value;
    const combined = `${current}${current ? '\n' : ''}${text}`;
    if (combined.length > MAX_TEXT_LENGTH || parseParticipants(combined).names.length > MAX_PARTICIPANTS) throw new Error(`El límite es de ${MAX_PARTICIPANTS} nombres y ${MAX_TEXT_LENGTH.toLocaleString('es')} caracteres.`);
    $('participants').value = combined;
    hideError(); updateParticipants(); persist();
    notify('Lista importada. Los nombres anteriores también se conservaron.');
  } catch (error) { showError(error.message || 'No se pudo leer el archivo. Prueba con un archivo de texto UTF-8.'); }
  finally { $('file-input').value = ''; }
});

$('copy-results').addEventListener('click', async () => {
  if (!activeDraw) return;
  const text = `${activeDraw.title}\n${dateFormatter.format(new Date(activeDraw.createdAt))}\n\n${activeDraw.winners.map((name, index) => `${index + 1}. ${name}`).join('\n')}`;
  try { await navigator.clipboard.writeText(text); notify('¡Resultado copiado! Comparte la emoción.'); }
  catch { notify('El navegador bloqueó la copia. Puedes descargar el CSV.'); }
});

$('download-results').addEventListener('click', () => {
  if (!activeDraw) return;
  const url = URL.createObjectURL(new Blob([resultsToCSV(activeDraw)], { type: 'text/csv;charset=utf-8;' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `sortea-${activeDraw.createdAt.slice(0, 10)}.csv`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

for (const dialog of document.querySelectorAll('dialog')) {
  for (const close of dialog.querySelectorAll('.close-dialog')) close.addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (event) => {
    const rect = dialog.getBoundingClientRect();
    if (event.target === dialog && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) dialog.close();
  });
}
$('help-button').addEventListener('click', () => $('help-dialog').showModal());
$('clear-history').addEventListener('click', () => { if (!isDrawing) $('clear-dialog').showModal(); });
$('confirm-clear').addEventListener('click', () => {
  history = [];
  activeDraw = null;
  persist(); renderHistory(); updateParticipants();
  $('results').hidden = true;
  $('stage-empty').hidden = false;
  $('stage-card').setAttribute('aria-labelledby', 'stage-heading');
  $('clear-dialog').close();
  notify('Historial borrado. Todos vuelven a tener una oportunidad.');
  $('participants').focus({ preventScroll: true });
});

restore();
renderHistory();
updateParticipants();
if (history.length) showResults(history[0]);
