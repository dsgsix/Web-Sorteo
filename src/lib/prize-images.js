const DATABASE_NAME = 'sortea-images-v1';
const STORE_NAME = 'prizes';
const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
const MAX_STORED_BYTES = 300 * 1024;
const MAX_EDGE = 1280;
const SUPPORTED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
let databasePromise = null;
let database = null;

function storageError(error) {
  if (error?.name === 'QuotaExceededError') {
    return new Error('No queda espacio para guardar la imagen. Elimina imágenes que ya no necesites o libera espacio del navegador.');
  }
  return new Error('No se pudo acceder a las imágenes guardadas en este navegador. Comprueba que el almacenamiento del sitio esté permitido.');
}

function validateId(id) {
  if (typeof id !== 'string' || !id.trim() || id.length > 200) {
    throw new Error('El identificador del premio no es válido.');
  }
}

async function validateImageFile(file) {
  if (!(file instanceof Blob) || !SUPPORTED_TYPES.has(file.type.toLowerCase())) {
    throw new Error('Elige una imagen JPG, PNG, WebP o GIF. No se admiten archivos SVG.');
  }
  if (!file.size || file.size > MAX_UPLOAD_BYTES) {
    throw new Error('La imagen debe tener contenido y pesar como máximo 8 MB.');
  }
  // Check actual signatures as well as the declared MIME type. This rejects SVG
  // files renamed to an allowed extension before asking an image decoder to run.
  const bytes = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const matches = {
    'image/jpeg': bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
    'image/png': [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte),
    'image/gif': String.fromCharCode(...bytes.slice(0, 6)) === 'GIF87a' || String.fromCharCode(...bytes.slice(0, 6)) === 'GIF89a',
    'image/webp': String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP',
  };
  if (!matches[file.type.toLowerCase()]) {
    throw new Error('El contenido no corresponde a una imagen JPG, PNG, WebP o GIF válida.');
  }
}

async function decodeImage(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
      return { source: bitmap, width: bitmap.width, height: bitmap.height, dispose: () => bitmap.close() };
    } catch {
      // The Image fallback supports browsers whose bitmap decoder lacks a format.
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.decoding = 'async';
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error('No se pudo leer la imagen. Elige otro archivo JPG, PNG, WebP o GIF.'));
      image.src = url;
    });
    return {
      source: image, width: image.naturalWidth, height: image.naturalHeight,
      dispose: () => URL.revokeObjectURL(url),
    };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

function encodeCanvas(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob(blob => {
        if (blob) resolve(blob);
        else reject(new Error('No se pudo preparar la imagen. Prueba con otro archivo.'));
      }, type, quality);
    } catch {
      reject(new Error('No se pudo preparar la imagen. Prueba con otro archivo.'));
    }
  });
}

/** Validate, flatten onto white and compress a local image to at most 300 KiB. */
export async function preparePrizeImage(file) {
  await validateImageFile(file);
  const decoded = await decodeImage(file);
  const canvas = document.createElement('canvas');
  try {
    if (!decoded.width || !decoded.height || decoded.width * decoded.height > 80_000_000) {
      throw new Error('La imagen tiene dimensiones demasiado grandes o no es válida. Usa una imagen de hasta 80 megapíxeles.');
    }
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Este navegador no permite preparar imágenes. Prueba con un navegador actualizado.');
    let scale = Math.min(1, MAX_EDGE / Math.max(decoded.width, decoded.height));
    for (let attempt = 0; attempt < 12; attempt += 1) {
      canvas.width = Math.max(1, Math.round(decoded.width * scale));
      canvas.height = Math.max(1, Math.round(decoded.height * scale));
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(decoded.source, 0, 0, canvas.width, canvas.height);
      for (const quality of [0.85, 0.7]) {
        let blob = await encodeCanvas(canvas, 'image/webp', quality);
        // Unsupported canvas encoders silently return PNG; use JPEG instead.
        if (blob.type !== 'image/webp') blob = await encodeCanvas(canvas, 'image/jpeg', quality);
        if (blob.type !== 'image/webp' && blob.type !== 'image/jpeg') {
          throw new Error('Este navegador no permite comprimir imágenes. Prueba con un navegador actualizado.');
        }
        if (blob.size <= MAX_STORED_BYTES) return blob;
      }
      scale *= 0.78;
    }
    throw new Error('No se pudo reducir la imagen a 300 KB. Prueba con una imagen más pequeña.');
  } finally {
    decoded.dispose();
    canvas.width = 0;
    canvas.height = 0;
  }
}

function openDatabase() {
  if (databasePromise) return databasePromise;
  if (!globalThis.indexedDB) return Promise.reject(storageError());

  databasePromise = new Promise((resolve, reject) => {
    let settled = false;
    let request;
    let timer;
    const fail = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      databasePromise = null;
      reject(error);
    };
    try {
      request = indexedDB.open(DATABASE_NAME, 1);
    } catch (error) {
      // A microtask lets the assignment to databasePromise finish before reset.
      queueMicrotask(() => fail(storageError(error)));
      return;
    }
    timer = setTimeout(() => fail(new Error('El almacenamiento de imágenes no respondió. Cierra otras pestañas del sitio y vuelve a intentarlo.')), 8000);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME);
    };
    request.onerror = () => fail(storageError(request.error));
    request.onblocked = () => fail(new Error('Otra pestaña está bloqueando las imágenes. Cierra las otras pestañas de Sortea y vuelve a intentarlo.'));
    request.onsuccess = () => {
      const opened = request.result;
      if (settled) { opened.close(); return; }
      settled = true;
      clearTimeout(timer);
      database = opened;
      const reset = () => {
        if (database === opened) { database = null; databasePromise = null; }
      };
      opened.onversionchange = () => { reset(); opened.close(); };
      opened.onclose = reset;
      resolve(opened);
    };
  });
  return databasePromise;
}

async function runTransaction(mode, operation) {
  const connection = await openDatabase();
  return new Promise((resolve, reject) => {
    let settled = false;
    let transaction;
    let timer;
    let result;
    let requestError;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(result);
    };
    try {
      transaction = connection.transaction(STORE_NAME, mode);
      const request = operation(transaction.objectStore(STORE_NAME));
      request.onsuccess = () => { result = request.result; };
      request.onerror = () => { requestError = request.error; };
      transaction.oncomplete = () => finish();
      transaction.onabort = () => finish(storageError(requestError || transaction.error));
      transaction.onerror = () => { requestError ||= transaction.error; };
      timer = setTimeout(() => {
        finish(new Error('El almacenamiento de imágenes tardó demasiado. Vuelve a intentarlo.'));
        try { transaction.abort(); } catch { /* It may have completed just before timeout. */ }
      }, 10000);
    } catch (error) {
      finish(storageError(error));
    }
  });
}

/** Commit an image Blob independently of the lightweight raffle settings. */
export async function savePrizeImage(id, blob) {
  validateId(id);
  if (!(blob instanceof Blob) || !SUPPORTED_TYPES.has(blob.type.toLowerCase()) || !blob.size || blob.size > MAX_STORED_BYTES) {
    throw new Error('Prepara una imagen válida de hasta 300 KB antes de guardarla.');
  }
  await runTransaction('readwrite', store => store.put(blob, id));
}

/** Return null for a missing image; storage failures are reported to the caller. */
export async function loadPrizeImage(id) {
  validateId(id);
  const blob = await runTransaction('readonly', store => store.get(id));
  if (blob === undefined) return null;
  if (!(blob instanceof Blob) || !SUPPORTED_TYPES.has(blob.type.toLowerCase())) {
    throw new Error('La imagen guardada está dañada. Vuelve a subirla para este premio.');
  }
  return blob;
}

export async function deletePrizeImage(id) {
  validateId(id);
  await runTransaction('readwrite', store => store.delete(id));
}
