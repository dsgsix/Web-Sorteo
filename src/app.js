import { parseTicketParticipants, drawTicketWinners, normalizeNameKey, normalizeTicketId, serializeTicketParticipants, mergeTicketParticipants, resultsToCSV } from './lib/raffle.js';
import { preparePrizeImage, savePrizeImage, loadPrizeImage, deletePrizeImage } from './lib/prize-images.js';
import { readRaffleWorkbook } from './lib/workbook-import.js';

const $ = (id) => document.getElementById(id);
const STORAGE_KEY = 'sortea.workspace.v2';
const LEGACY_KEY = 'sortea.workspace.v1';
const MAX_TEXT = 200000;
const MAX_HISTORY = 100;
const MAX_STAGES = 20;
const dateFormat = new Intl.DateTimeFormat('es', { dateStyle: 'medium', timeStyle: 'short' });
const numberFormat = new Intl.NumberFormat('es');
const percentFormat = new Intl.NumberFormat('es', { style: 'percent', maximumFractionDigits: 2 });
const percent = (value) => value > 0 && value < 0.0001 ? '<0,01 %' : percentFormat.format(value);
const imageURLs = new Map();
let history = [];
let stages = [];
let sessionId = crypto.randomUUID();
let selectedStageId;
let activeDraw = null;
let isDrawing = false;
let pendingUploads = 0;
let toastTimer;
let imageRenderVersion = 0;
let storageWarningShown = false;
let isImporting = false;
let pendingImport = null;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function button(className, text, handler, label) {
  const node = element('button', className, text);
  node.type = 'button';
  if (label) node.setAttribute('aria-label', label);
  node.addEventListener('click', handler);
  return node;
}
function newStage() { return { id: crypto.randomUUID(), name: '', winnerCount: 1, imageId: null, completedDrawId: null }; }
function selectedStage() { return stages.find((stage) => stage.id === selectedStageId); }
function nextPending() { return stages.find((stage) => !stage.completedDrawId); }
function prizeName(stage) { return stage.name.trim() || `Premio ${stages.indexOf(stage) + 1}`; }
function stageName(stage) { return `Etapa ${stages.indexOf(stage) + 1}`; }
function notify(message) {
  clearTimeout(toastTimer);
  $('toast').textContent = message;
  $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 5000);
}
function showError(message, focusId) {
  $('form-error').textContent = message;
  $('form-error').hidden = false;
  if (focusId) $(focusId).focus();
}
function hideError() { $('form-error').hidden = true; }
function validTicketId(value) {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/u.test(value)) return false;
  try { normalizeTicketId(value); return true; } catch { return false; }
}
function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      version: 2, sessionId, selectedStageId,
      stages: stages.map((stage) => ({ ...stage,
        winnerCount: Number.isInteger(stage.winnerCount) && stage.winnerCount > 0 && stage.winnerCount <= 5000 ? stage.winnerCount : 1,
      })), history,
      title: $('raffle-title').value, participants: $('participants').value,
      excludeWinners: $('exclude-winners').checked,
    }));
  } catch {
    if (!storageWarningShown) {
      storageWarningShown = true;
      notify('No se pudo guardar la sesión. Mantén esta pestaña abierta y descarga tus resultados.');
    }
  }
}
function validDraw(draw) {
  return draw && typeof draw.id === 'string' && typeof draw.title === 'string' && draw.title.length <= 100 &&
    typeof draw.createdAt === 'string' && Number.isFinite(Date.parse(draw.createdAt)) &&
    Array.isArray(draw.winners) && draw.winners.length > 0 && draw.winners.length <= 5000 &&
    draw.winners.every((name) => typeof name === 'string' && name.trim() && name.length <= 200) &&
    Number.isInteger(draw.participantCount) && draw.participantCount > 0 && draw.participantCount <= 5000 &&
    (draw.winnerDetails === undefined || (Array.isArray(draw.winnerDetails) && draw.winnerDetails.length === draw.winners.length &&
      draw.winnerDetails.every((winner, index) => winner && winner.name === draw.winners[index] &&
        Number.isInteger(winner.ticketNumber) && winner.ticketNumber > 0 && Number.isInteger(winner.tickets) &&
        winner.ticketNumber <= winner.tickets && winner.tickets <= 1000000 &&
        (winner.ticketId === undefined || validTicketId(winner.ticketId)) &&
        Number.isFinite(winner.probability) && winner.probability > 0 && winner.probability <= 1)));
}
function restore() {
  try {
    const data = JSON.parse(localStorage.getItem(STORAGE_KEY) || localStorage.getItem(LEGACY_KEY) || 'null');
    if (!data) return;
    if (data.version !== 1 && data.version !== 2) throw new Error('Versión desconocida');
    history = Array.isArray(data.history) ? data.history.filter(validDraw).slice(0, MAX_HISTORY) : [];
    if (typeof data.title === 'string') $('raffle-title').value = data.title.slice(0, 100);
    if (typeof data.participants === 'string') $('participants').value = data.participants.slice(0, MAX_TEXT);
    if (typeof data.excludeWinners === 'boolean') $('exclude-winners').checked = data.excludeWinners;
    if (data.version === 2) {
      if (typeof data.sessionId === 'string') sessionId = data.sessionId;
      stages = Array.isArray(data.stages) ? data.stages.filter((stage) =>
        stage && typeof stage.id === 'string' && typeof stage.name === 'string' && stage.name.length <= 100 &&
        Number.isInteger(stage.winnerCount) && stage.winnerCount > 0 && stage.winnerCount <= 5000 &&
        (stage.imageId === null || typeof stage.imageId === 'string')
      ).slice(0, MAX_STAGES).map((stage) => ({ ...stage,
        completedDrawId: history.some((draw) => draw.id === stage.completedDrawId) ? stage.completedDrawId : null,
      })) : [];
      selectedStageId = data.selectedStageId;
    } else {
      // Earlier text lists counted unique people; keep that meaning during migration.
      const unique = new Map();
      for (const name of $('participants').value.split(/\r\n|\r|\n/u)) {
        if (name.trim()) unique.set(normalizeNameKey(name), name.trim());
      }
      $('participants').value = [...unique.values()].map((name) => `"${name.replaceAll('"', '""')}";1`).join('\n');
      stages = [newStage()];
      if (Number.isInteger(data.winnerCount) && data.winnerCount > 0 && data.winnerCount <= 5000) stages[0].winnerCount = data.winnerCount;
      notify('Tu lista e historial anterior se conservaron. Ahora puedes añadir boletos y premios.');
    }
  } catch { notify('No se pudieron recuperar todos los datos. Puedes configurar un nuevo evento.'); }
}

function exclusions() {
  const draws = history.filter((draw) => draw.sessionId === sessionId);
  return {
    excludeNames: $('exclude-winners').checked ? draws.flatMap((draw) => draw.winners) : [],
    excludeTickets: draws.flatMap((draw) => draw.winnerDetails || []).map(({ name, ticketNumber, ticketId }) => ({ name, ticketNumber, ticketId })),
  };
}
function participantState() {
  const parsed = parseTicketParticipants($('participants').value);
  const options = exclusions();
  const names = new Set(options.excludeNames.map(normalizeNameKey));
  const spent = new Map();
  const spentIds = new Set();
  for (const ticket of options.excludeTickets) {
    if (ticket.ticketId !== undefined) { spentIds.add(normalizeTicketId(ticket.ticketId)); continue; }
    const key = normalizeNameKey(ticket.name);
    if (!spent.has(key)) spent.set(key, new Set());
    spent.get(key).add(ticket.ticketNumber);
  }
  const available = parsed.participants.map((person) => {
    const key = normalizeNameKey(person.name);
    const used = person.ticketIds ? person.ticketIds.filter((id) => spentIds.has(normalizeTicketId(id))).length :
      [...(spent.get(key) || [])].filter((number) => number <= person.tickets).length;
    return { ...person, available: names.has(key) ? 0 : person.tickets - used };
  });
  return { ...parsed, available, eligibleTickets: available.reduce((sum, person) => sum + person.available, 0),
    eligiblePeople: available.filter((person) => person.available > 0).length, options };
}
function setStageStatus(text) {
  const dot = element('span', 'status-dot');
  $('stage-status').replaceChildren(dot, document.createTextNode(text));
}
function updateParticipants() {
  let state;
  try { state = participantState(); }
  catch (error) {
    $('participants-hint').textContent = error.message;
    $('participants-hint').classList.add('input-warning');
    $('participants').setAttribute('aria-invalid', 'true');
    $('participants-count').textContent = 'Revisa la lista';
    $('ticket-total').textContent = '—';
    $('eligible-total').textContent = '—';
    $('participants-preview-wrap').hidden = true;
    updateControls();
    return;
  }
  $('participants').removeAttribute('aria-invalid');
  $('participants-hint').classList.remove('input-warning');
  $('participants-count').textContent = `${state.participants.length} participante${state.participants.length === 1 ? '' : 's'}`;
  $('ticket-total').textContent = numberFormat.format(state.totalTickets);
  $('eligible-total').textContent = numberFormat.format(state.eligibleTickets);
  $('participants-hint').textContent = state.totalTickets ?
    `${state.eligiblePeople} personas y ${numberFormat.format(state.eligibleTickets)} boletos en juego. Los nombres repetidos suman boletos.` :
    'Un nombre por línea = 1 boleto. Usa Nombre;5 para asignar cinco.';
  $('participants-preview-wrap').hidden = !state.participants.length;
  $('participants-preview').replaceChildren();
  for (const person of state.available.slice(0, 100)) {
    const row = element('tr');
    row.append(element('td', '', person.name), element('td', '', numberFormat.format(person.tickets)),
      element('td', 'participant-ticket-ids', person.ticketIds ? `${person.ticketIds.slice(0, 12).join(', ')}${person.ticketIds.length > 12 ? ` y ${person.ticketIds.length - 12} más` : ''}` : 'Numeración interna'),
      element('td', '', state.eligibleTickets ? percent(person.available / state.eligibleTickets) : '0 %'));
    $('participants-preview').append(row);
  }
  $('participant-summary').textContent = state.participants.length > 100 ? 'Se muestran los primeros 100 participantes; todos los boletos elegibles entran al sorteo.' : 'Probabilidad al inicio de la próxima etapa; cambia al retirar ganadores.';
  if (!isDrawing && !activeDraw) setStageStatus(state.eligibleTickets ? `${numberFormat.format(state.eligibleTickets)} boletos en juego` : 'Prepara tus boletos');
  updateControls();
}

async function imageURL(imageId) {
  if (!imageId) return null;
  if (imageURLs.has(imageId)) return imageURLs.get(imageId);
  const blob = await loadPrizeImage(imageId);
  if (!blob) return null;
  if (!imageURLs.has(imageId)) imageURLs.set(imageId, URL.createObjectURL(blob));
  return imageURLs.get(imageId);
}
async function showPrize(imageId, name) {
  const version = ++imageRenderVersion;
  $('prize-preview').hidden = true;
  $('prize-preview').removeAttribute('src');
  $('prize-placeholder').hidden = false;
  try {
    const url = await imageURL(imageId);
    if (version !== imageRenderVersion || !url) return;
    $('prize-preview').src = url;
    $('prize-preview').alt = name;
    $('prize-preview').hidden = false;
    $('prize-placeholder').hidden = true;
  } catch { notify('No se pudo recuperar la foto del premio. El sorteo sigue disponible.'); }
}
async function cleanImage(imageId) {
  if (!imageId || stages.some((stage) => stage.imageId === imageId) || history.some((draw) => draw.prizeImageId === imageId)) return;
  if (imageURLs.has(imageId)) { URL.revokeObjectURL(imageURLs.get(imageId)); imageURLs.delete(imageId); }
  try { await deletePrizeImage(imageId); } catch { /* Unused local images do not block the workflow. */ }
}

function renderStages() {
  const completed = stages.filter((stage) => stage.completedDrawId).length;
  $('stage-progress').textContent = `${completed} de ${stages.length} etapas completadas`;
  $('stages-list').replaceChildren();
  const pending = nextPending();
  for (const [index, stage] of stages.entries()) {
    const complete = Boolean(stage.completedDrawId);
    const item = element('li', `prize-card${stage.id === selectedStageId ? ' is-active' : ''}${complete ? ' is-complete' : ''}`);
    item.dataset.stageId = stage.id;
    const thumb = element('div', 'prize-thumb');
    thumb.append(element('span', '', '✧'));
    if (stage.imageId) imageURL(stage.imageId).then((url) => {
      if (!url) return;
      const image = element('img'); image.src = url; image.alt = stage.name || `Premio ${index + 1}`;
      thumb.replaceChildren(image);
    }).catch(() => {});
    const fields = element('div', 'prize-fields');
    const state = element('span', 'prize-state', `ETAPA ${String(index + 1).padStart(2, '0')} · ${complete ? 'Sorteada' : 'Pendiente'}`);
    const nameLabel = element('label', 'sr-only', `Nombre del premio de la etapa ${index + 1}`);
    const nameInput = element('input', 'prize-name');
    nameInput.id = `prize-name-${stage.id}`; nameLabel.htmlFor = nameInput.id;
    nameInput.placeholder = `Premio ${index + 1}`; nameInput.maxLength = 100; nameInput.value = stage.name;
    nameInput.disabled = complete || isDrawing;
    nameInput.addEventListener('input', () => {
      stage.name = nameInput.value;
      if (stage.id === selectedStageId && !activeDraw) $('active-stage-label').textContent = `${stageName(stage)} · ${prizeName(stage)}`;
      persist();
    });
    const controls = element('div', 'prize-controls');
    const file = element('input', 'prize-file'); file.type = 'file'; file.hidden = true;
    file.accept = 'image/jpeg,image/png,image/webp,image/gif';
    file.setAttribute('aria-label', `Imagen del premio de la etapa ${index + 1}`);
    file.disabled = complete || isDrawing;
    const upload = button('prize-upload', stage.imageId ? 'Cambiar foto' : 'Subir imagen', () => file.click());
    upload.disabled = complete || isDrawing || pendingUploads > 0;
    file.addEventListener('change', async () => {
      const selected = file.files[0]; if (!selected || isDrawing) return;
      pendingUploads++; updateControls(); upload.textContent = 'Procesando…'; upload.disabled = true;
      try {
        const blob = await preparePrizeImage(selected);
        if (!stages.includes(stage) || stage.completedDrawId) return;
        const imageId = crypto.randomUUID();
        await savePrizeImage(imageId, blob);
        const oldId = stage.imageId; stage.imageId = imageId;
        persist(); renderStages();
        if (stage.id === selectedStageId && !activeDraw) showPrize(stage.imageId, prizeName(stage));
        await cleanImage(oldId);
        notify('Imagen guardada. El premio está listo para su gran momento.');
      } catch (error) { notify(error.message || 'No se pudo guardar la imagen. Prueba con otra foto.'); }
      finally { pendingUploads--; file.value = ''; renderStages(); updateControls(); }
    });
    controls.append(upload, file);
    if (stage.imageId && !complete) controls.append(button('remove-image', 'Quitar foto', async () => {
      if (isDrawing || pendingUploads) return;
      const previous = stage.imageId; stage.imageId = null; persist(); renderStages();
      if (selectedStageId === stage.id && !activeDraw) showPrize(null, prizeName(stage));
      await cleanImage(previous);
    }));
    const countLabel = element('label', 'stage-count-label', 'Ganadores');
    const countInput = element('input', 'stage-winner-count');
    countInput.type = 'number'; countInput.min = '1'; countInput.max = '5000'; countInput.value = stage.winnerCount;
    countInput.setAttribute('aria-label', `Ganadores de la etapa ${index + 1}`); countInput.disabled = complete || isDrawing;
    countInput.addEventListener('input', () => {
      stage.winnerCount = Number(countInput.value);
      if (stage.id === selectedStageId) $('winner-count').value = countInput.value;
      hideError(); persist(); updateControls();
    });
    countLabel.append(countInput); controls.append(countLabel);
    fields.append(state, nameLabel, nameInput, controls);
    const actions = element('div', 'stage-actions');
    if (complete) actions.append(button('view-stage', 'Ver resultado', () => {
      if (!isDrawing) {
        const draw = history.find((entry) => entry.id === stage.completedDrawId);
        if (draw) { selectedStageId = stage.id; showResults(draw); renderStages(); updateControls(); persist(); }
      }
    }));
    else {
      const prepare = button('prepare-stage', stage.id === selectedStageId ? 'En escenario' : 'Preparar', () => prepareStage(stage));
      prepare.disabled = isDrawing || pendingUploads > 0 || stage.id !== pending?.id;
      actions.append(prepare);
      const reorder = element('div', 'stage-reorder');
      const up = button('move-stage move-stage-up', '↑', () => moveStage(stage, -1), `Subir etapa ${index + 1}`);
      const down = button('move-stage move-stage-down', '↓', () => moveStage(stage, 1), `Bajar etapa ${index + 1}`);
      up.disabled = isDrawing || pendingUploads > 0 || index === 0 || Boolean(stages[index - 1]?.completedDrawId);
      down.disabled = isDrawing || pendingUploads > 0 || index === stages.length - 1;
      const remove = button('remove-stage', '×', () => removeStage(stage), `Eliminar etapa ${index + 1}`);
      remove.disabled = isDrawing || pendingUploads > 0 || stages.length === 1;
      reorder.append(up, down, remove); actions.append(reorder);
    }
    item.append(thumb, fields, actions); $('stages-list').append(item);
  }
}
function moveStage(stage, delta) {
  if (isDrawing || pendingUploads || stage.completedDrawId) return;
  const index = stages.indexOf(stage), target = index + delta;
  if (target < 0 || target >= stages.length || stages[target].completedDrawId) return;
  [stages[index], stages[target]] = [stages[target], stages[index]];
  if (!activeDraw) selectedStageId = nextPending()?.id;
  renderStages(); if (!activeDraw) prepareStage(nextPending()); persist();
}
async function removeStage(stage) {
  if (isDrawing || pendingUploads || stage.completedDrawId || stages.length < 2) return;
  stages = stages.filter((entry) => entry !== stage);
  if (selectedStageId === stage.id) prepareStage(nextPending());
  renderStages(); updateControls(); persist(); await cleanImage(stage.imageId);
}
function prepareStage(stage) {
  if (!stage || stage.completedDrawId || stage !== nextPending() || isDrawing || pendingUploads) return;
  selectedStageId = stage.id; activeDraw = null;
  $('results').hidden = true; $('stage-empty').hidden = false;
  $('stage-card').setAttribute('aria-labelledby', 'stage-heading');
  $('active-stage-label').textContent = `${stageName(stage)} · ${prizeName(stage)}`;
  $('winner-count').value = stage.winnerCount;
  showPrize(stage.imageId, prizeName(stage));
  hideError(); renderStages(); updateParticipants(); persist();
}

function renderHistory() {
  $('history-count').textContent = history.length;
  $('history-empty').hidden = history.length > 0;
  $('history-list').hidden = history.length === 0;
  $('clear-history').hidden = history.length === 0;
  $('history-list').replaceChildren();
  for (const draw of history) {
    const item = element('li', 'history-item');
    const detail = element('div', 'history-detail');
    detail.append(element('strong', '', `${draw.title}${draw.prize ? ` · ${draw.prize}` : ''}`),
      element('small', '', `${dateFormat.format(new Date(draw.createdAt))} · ${draw.stageName || 'Sorteo'} · ${draw.winners.length} ganador${draw.winners.length === 1 ? '' : 'es'}`));
    const view = button('', 'Ver resultado', () => {
      if (isDrawing || pendingUploads) return;
      selectedStageId = stages.find((stage) => stage.completedDrawId === draw.id)?.id;
      showResults(draw); renderStages(); updateControls();
      $('result-title').focus({ preventScroll: true }); $('stage-card').scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, `Ver resultado de ${draw.title}, ${draw.prize || 'sorteo'}`);
    item.append(element('span', 'history-symbol', '✦'), detail, element('span', 'history-winners', draw.winners.join(', ')), view);
    $('history-list').append(item);
  }
}
function showResults(draw) {
  activeDraw = draw;
  $('stage-card').setAttribute('aria-labelledby', 'result-title');
  $('stage-empty').hidden = true; $('results').hidden = false;
  $('result-title').textContent = draw.winners.length === 1 ? '¡Tenemos ganador!' : '¡Tenemos ganadores!';
  $('result-raffle-title').textContent = draw.title;
  $('active-stage-label').textContent = `${draw.stageName || 'Resultado'}${draw.prize ? ` · ${draw.prize}` : ''}`;
  showPrize(draw.prizeImageId, draw.prize || 'Premio');
  $('winner-list').replaceChildren();
  for (const [index, name] of draw.winners.entries()) {
    const item = element('li');
    const content = element('div', 'winner-content');
    content.append(element('span', 'winner-name', name));
    const ticket = draw.winnerDetails?.[index];
    if (ticket) {
      content.append(element('strong', 'winner-ticket', ticket.ticketId !== undefined ? `Boleto N.º ${ticket.ticketId}` : `Boleto interno N.º ${ticket.ticketNumber}`));
      content.append(element('small', 'winner-meta', `${numberFormat.format(ticket.tickets)} boleto${ticket.tickets === 1 ? '' : 's'} registrado${ticket.tickets === 1 ? '' : 's'} · Prob. de la persona al inicio: ${percent(ticket.probability)}`));
    }
    item.append(element('span', 'winner-rank', index + 1), content);
    $('winner-list').append(item);
  }
  $('result-date').textContent = dateFormat.format(new Date(draw.createdAt));
  setStageStatus('Premio sorteado'); updateControls();
}
function updateControls() {
  const stage = selectedStage();
  const blocked = isDrawing || pendingUploads > 0 || isImporting;
  const canDraw = stage && !stage.completedDrawId && stage === nextPending() && !activeDraw;
  $('draw-button').disabled = blocked || !canDraw;
  $('draw-button-label').textContent = isDrawing ? 'Eligiendo el boleto ganador…' : isImporting ? 'Leyendo la lista…' : pendingUploads ? 'Guardando imagen…' : canDraw ? 'Sortear este premio' : nextPending() ? 'Prepara la siguiente etapa' : 'Evento completado';
  $('winner-count').disabled = blocked || !canDraw;
  $('exclude-winners').disabled = blocked;
  $('decrease-count').disabled = blocked || !canDraw || Number($('winner-count').value) <= 1;
  $('increase-count').disabled = blocked || !canDraw || Number($('winner-count').value) >= 5000;
  $('add-stage').disabled = blocked || stages.length >= MAX_STAGES;
  $('new-session').disabled = blocked;
  $('clear-history').disabled = blocked;
  $('next-stage').hidden = !activeDraw || !nextPending();
  $('next-stage').disabled = blocked;
  for (const id of ['participants', 'raffle-title', 'import-button', 'file-input', 'example-button']) $(id).disabled = isDrawing || isImporting;
  for (const control of $('history-list').querySelectorAll('button')) control.disabled = blocked;
  $('stage-card').classList.toggle('is-drawing', isDrawing);
  $('stage-card').setAttribute('aria-busy', String(isDrawing));
}
function celebrate() {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  $('confetti').replaceChildren();
  for (let i = 0; i < 36; i++) {
    const piece = element('i'); piece.style.left = `${(i * 37) % 100}%`;
    piece.style.background = ['#d8b66a', '#fff', '#b28b40'][i % 3]; piece.style.animationDelay = `${(i % 7) * 0.08}s`;
    $('confetti').append(piece);
  }
  setTimeout(() => $('confetti').replaceChildren(), 3200);
}

$('raffle-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (isDrawing || pendingUploads || isImporting) return;
  hideError();
  const stage = selectedStage();
  if (!stage || stage.completedDrawId || stage !== nextPending() || activeDraw) return;
  let state;
  try { state = participantState(); } catch (error) { return showError(error.message, 'participants'); }
  if (!state.participants.length) return showError('Añade al menos un participante con sus boletos.', 'participants');
  if (!state.eligibleTickets) return showError('No quedan boletos elegibles. Revisa la regla de ganadores o inicia un nuevo evento.', 'exclude-winners');
  const count = Number($('winner-count').value);
  const max = Math.min(5000, $('exclude-winners').checked ? state.eligiblePeople : state.eligibleTickets);
  if (!Number.isInteger(count) || count < 1 || count > max) return showError(`Elige entre 1 y ${numberFormat.format(max)} ganadores para esta etapa.`, 'winner-count');
  let draw;
  try {
    const winnerDetails = drawTicketWinners(state.participants, count, { ...state.options, uniquePeople: $('exclude-winners').checked });
    draw = {
      id: crypto.randomUUID(), sessionId, stageId: stage.id, stageName: stageName(stage), prize: prizeName(stage),
      prizeImageId: stage.imageId, title: $('raffle-title').value.trim() || 'Mi evento de premios',
      createdAt: new Date().toISOString(), winners: winnerDetails.map((winner) => winner.name), winnerDetails,
      participantCount: state.participants.length, totalTickets: state.totalTickets, eligibleTickets: state.eligibleTickets,
    };
  } catch (error) { return showError(error.message || 'No se pudo seleccionar un boleto seguro. Abre la web por HTTPS.'); }
  isDrawing = true; renderStages(); updateControls();
  setStageStatus('El azar decide'); $('draw-announcement').textContent = `Sorteando ${draw.prize}.`;
  await new Promise((resolve) => setTimeout(resolve, matchMedia('(prefers-reduced-motion: reduce)').matches ? 80 : 1700));
  const expired = history.slice(MAX_HISTORY - 1);
  history.unshift(draw); history = history.slice(0, MAX_HISTORY); stage.completedDrawId = draw.id;
  isDrawing = false; persist(); renderStages(); renderHistory(); showResults(draw); updateParticipants(); celebrate();
  for (const entry of expired) cleanImage(entry.prizeImageId);
  $('draw-announcement').textContent = `${draw.prize}: ${draw.winnerDetails.slice(0, 10).map((winner) => `${winner.name}, boleto ${winner.ticketId ?? winner.ticketNumber}`).join('; ')}${draw.winners.length > 10 ? ' y más ganadores' : ''}.`;
  $('result-title').focus({ preventScroll: true });
  if (matchMedia('(max-width: 760px)').matches) $('stage-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
});

$('participants').maxLength = MAX_TEXT;
for (const id of ['participants', 'raffle-title', 'exclude-winners']) $(id).addEventListener('input', () => { hideError(); updateParticipants(); persist(); });
function changeCount(value) {
  const stage = selectedStage(); if (!stage || stage.completedDrawId || isDrawing) return;
  stage.winnerCount = Number(value); $('winner-count').value = value;
  const input = [...$('stages-list').querySelectorAll('.prize-card')].find((card) => card.dataset.stageId === stage.id)?.querySelector('.stage-winner-count');
  if (input) input.value = value;
  hideError(); updateControls(); persist();
}
$('winner-count').addEventListener('input', () => changeCount($('winner-count').value));
for (const [id, delta] of [['decrease-count', -1], ['increase-count', 1]]) $(id).addEventListener('click', () => changeCount(Math.max(1, Math.min(5000, (Number($('winner-count').value) || 1) + delta))));
$('example-button').addEventListener('click', () => {
  const lines = 'Ana García;5\nCarlos López;2\nMaría Rodríguez;3\nDiego Pérez;1\nLucía Torres;4';
  try {
    const combined = serializeTicketParticipants(mergeTicketParticipants(
      parseTicketParticipants($('participants').value).participants, parseTicketParticipants(lines).participants));
    if (combined.length > MAX_TEXT) throw new Error('La lista alcanzó su límite de texto.');
    parseTicketParticipants(combined); $('participants').value = combined; hideError(); updateParticipants(); persist();
    notify('Se añadieron 15 boletos de ejemplo. Los nombres repetidos suman sus boletos.');
  } catch (error) { showError(error.message, 'participants'); }
});
$('import-button').addEventListener('click', () => $('file-input').click());
$('file-input').addEventListener('change', async () => {
  const file = $('file-input').files[0]; if (!file) return;
  if (isDrawing || isImporting) return;
  isImporting = true; updateControls();
  try {
    if (/\.xlsx$/iu.test(file.name)) {
      const workbook = await readRaffleWorkbook(file);
      pendingImport = { ...workbook, text: null };
      $('import-sheet').replaceChildren();
      for (const [index, sheet] of workbook.sheets.entries()) {
        const option = element('option', '', sheet.name); option.value = String(index); $('import-sheet').append(option);
      }
      renderWorkbookPreview();
      $('import-dialog').showModal();
      return;
    }
    if (/\.xls$/iu.test(file.name)) throw new Error('Guarda el Excel como .xlsx antes de importarlo.');
    if (file.size > 1024 * 1024) throw new Error('El archivo de participantes debe pesar menos de 1 MB.');
    const text = await file.text(); if (isDrawing) return;
    if (text.includes('\0')) throw new Error('Usa un archivo TXT o CSV en UTF-8.');
    const incoming = parseTicketParticipants(text);
    const current = parseTicketParticipants($('participants').value);
    const combined = serializeTicketParticipants(mergeTicketParticipants(current.participants, incoming.participants));
    if (combined.length > MAX_TEXT) throw new Error('El contenido supera los 200.000 caracteres.');
    parseTicketParticipants(combined); $('participants').value = combined;
    hideError(); updateParticipants(); persist(); notify(incoming.participants.some((person) => person.ticketIds) ?
      'Boletos importados con sus números originales.' : 'Participantes importados. Se sumaron los boletos de los nombres existentes.');
  } catch (error) { showError(error.message || 'No se pudo leer el archivo.'); }
  finally { $('file-input').value = ''; isImporting = false; updateControls(); }
});

function renderWorkbookPreview() {
  if (!pendingImport) return;
  pendingImport.text = null;
  $('import-error').hidden = true;
  $('import-confirm').disabled = true;
  $('import-preview').replaceChildren();
  const sheet = pendingImport.sheets[Number($('import-sheet').value)];
  if (!sheet) return;
  const assigned = sheet.rows.filter((row) => row.name.trim());
  const unassigned = sheet.rows.length - assigned.length + (sheet.skippedEmpty || 0);
  $('import-warning').textContent = 'Participan todos los boletos con nombre. El estado y la fecha de pago no se utilizan para filtrar.';
  try {
    if (!assigned.length) throw new Error('Esta hoja no contiene boletos asignados a una persona.');
    const quote = (value) => `"${String(value).replaceAll('"', '""')}"`;
    const text = ['Nombre;Boleto', ...assigned.map((row) => `${quote(row.name)};${quote(row.ticketId)}`)].join('\n');
    const parsed = parseTicketParticipants(text);
    if (text.length > MAX_TEXT) throw new Error('Esta lista supera los 200.000 caracteres admitidos.');
    pendingImport.text = serializeTicketParticipants(parsed.participants);
    if (pendingImport.text.length > MAX_TEXT) throw new Error('Esta lista supera los 200.000 caracteres admitidos.');
    $('import-summary').textContent = `${numberFormat.format(parsed.totalTickets)} boletos de ${numberFormat.format(parsed.participants.length)} personas. Se omiten ${numberFormat.format(unassigned)} filas sin nombre o vacías.`;
    for (const row of assigned.slice(0, 10)) {
      const item = element('tr'); item.append(element('td', '', row.ticketId), element('td', '', row.name)); $('import-preview').append(item);
    }
    $('import-confirm').disabled = false;
  } catch (error) {
    pendingImport.text = null;
    $('import-summary').textContent = `${numberFormat.format(assigned.length)} filas con nombre; ${numberFormat.format(unassigned)} sin nombre.`;
    $('import-error').textContent = error.message || 'No se pudo validar la lista.';
    $('import-error').hidden = false;
  }
}
$('import-sheet').addEventListener('change', renderWorkbookPreview);
$('import-confirm').addEventListener('click', () => {
  if (!pendingImport?.text || isDrawing) return;
  const imported = parseTicketParticipants(pendingImport.text);
  $('participants').value = pendingImport.text;
  pendingImport = null; $('import-dialog').close();
  hideError(); updateParticipants(); persist();
  notify(`${numberFormat.format(imported.totalTickets)} boletos importados con su numeración original. Los boletos sin nombre se omitieron.`);
});
$('import-dialog').addEventListener('close', () => { pendingImport = null; });
$('add-stage').addEventListener('click', () => {
  if (isDrawing || pendingUploads || stages.length >= MAX_STAGES) return;
  const hadPending = nextPending(); const stage = newStage(); stages.push(stage);
  if (!hadPending) prepareStage(stage);
  renderStages(); updateControls(); persist();
  $('stages-list').lastElementChild?.querySelector('.prize-name').focus({ preventScroll: true });
});
$('next-stage').addEventListener('click', () => { prepareStage(nextPending()); $('stage-card').scrollIntoView({ behavior: 'smooth', block: 'center' }); });
$('copy-results').addEventListener('click', async () => {
  if (!activeDraw) return;
  const draw = activeDraw;
  const text = `${draw.title}\n${draw.stageName || 'Sorteo'} · ${draw.prize || 'Resultado'}\n${dateFormat.format(new Date(draw.createdAt))}\n\n${draw.winners.map((name, index) => `${index + 1}. ${name}${draw.winnerDetails?.[index] ? ` — boleto ${draw.winnerDetails[index].ticketId ?? draw.winnerDetails[index].ticketNumber}` : ''}`).join('\n')}`;
  try { await navigator.clipboard.writeText(text); notify('Resultado copiado con su premio y boleto ganador.'); }
  catch { notify('El navegador bloqueó la copia. Puedes descargar el CSV.'); }
});
$('download-results').addEventListener('click', () => {
  if (!activeDraw) return;
  const url = URL.createObjectURL(new Blob([resultsToCSV(activeDraw)], { type: 'text/csv;charset=utf-8;' }));
  const anchor = element('a'); anchor.href = url; anchor.download = `sortea-${activeDraw.createdAt.slice(0, 10)}.csv`;
  document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
});
for (const dialog of document.querySelectorAll('dialog')) {
  for (const close of dialog.querySelectorAll('.close-dialog')) close.addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (event) => {
    const rect = dialog.getBoundingClientRect();
    if (event.target === dialog && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) dialog.close();
  });
}
$('help-button').addEventListener('click', () => $('help-dialog').showModal());
$('clear-history').addEventListener('click', () => { if (!isDrawing && !pendingUploads) $('clear-dialog').showModal(); });
$('confirm-clear').addEventListener('click', () => {
  if (isDrawing || pendingUploads) return;
  const oldImages = history.map((draw) => draw.prizeImageId); history = [];
  for (const stage of stages) stage.completedDrawId = null;
  sessionId = crypto.randomUUID(); activeDraw = null;
  $('clear-dialog').close(); renderHistory(); prepareStage(stages[0]); persist();
  for (const imageId of oldImages) cleanImage(imageId);
  notify('Historial borrado. Las etapas y sus premios están listos para empezar.');
});
$('new-session').addEventListener('click', () => { if (!isDrawing && !pendingUploads) $('new-session-dialog').showModal(); });
$('confirm-new-session').addEventListener('click', () => {
  if (isDrawing || pendingUploads) return;
  sessionId = crypto.randomUUID();
  for (const stage of stages) stage.completedDrawId = null;
  activeDraw = null; $('new-session-dialog').close(); prepareStage(stages[0]); persist();
  notify('Nuevo evento preparado. Conservamos participantes, boletos, premios e historial.');
});

restore();
if (!stages.length) stages = [newStage()];
if (!selectedStage()) selectedStageId = nextPending()?.id || stages[stages.length - 1].id;
renderStages(); renderHistory();
const restoredStage = selectedStage();
const restoredDraw = history.find((draw) => draw.id === restoredStage?.completedDrawId);
if (restoredDraw) { $('winner-count').value = restoredStage.winnerCount; showResults(restoredDraw); }
else prepareStage(nextPending());
updateParticipants();
