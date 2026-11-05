# Sortea

Una web de sorteos en español con boletos, premios por etapas e imágenes. Prepara un evento, asigna boletos a cada persona y sortea sus premios desde el navegador.

## Desarrollo

Requiere **Node.js 22 o posterior**. No necesita instalar dependencias, configurar claves ni levantar una base de datos.

```sh
cd /workspace/Web-Sorteo
npm run dev
```

El servidor de desarrollo escucha en el puerto **5173**. Para usar otro puerto: `npm run dev -- --port 5174`. Usa un navegador moderno con JavaScript habilitado; el contexto local o HTTPS permite utilizar Web Crypto.

```sh
npm test          # Boletos, selección aleatoria y servidor HTTP
npm run build    # Genera dist/ a partir de index.html y src/
npm run preview  # Sirve dist/ en el puerto 4173
```

Para comprobar los flujos completos en un navegador real, instala Chromium y ejecuta `npm run test:browser`. Usa `BROWSER_PATH=/ruta/a/chrome npm run test:browser` si el ejecutable no está en `/usr/bin/chromium`. La prueba abre un perfil temporal aislado y no modifica tus sorteos. En Linux de CI se ejecuta Chrome con `--no-sandbox`; esta opción se limita al navegador de pruebas. GitHub Actions ejecuta las pruebas y la compilación con cada push o pull request.

La compilación no transpila ni descarga recursos: produce un sitio estático listo para publicar. Los servidores fallan si el puerto solicitado está ocupado y solo exponen los archivos públicos de la aplicación.

Para probar el resultado compilado en lugar de los archivos de desarrollo: `BROWSER_TEST_DIST=1 npm run test:browser` después de ejecutar `npm run build`.

## Uso

- Introduce una persona por línea. Un nombre sin cantidad equivale a un boleto; `Ana;5` o `Ana,5` asigna cinco boletos.
- Repetir un nombre **suma boletos**: `Ana;2`, `ana` y `Ana;3` se combinan en una sola persona con seis boletos. Se ignoran diferencias de mayúsculas, espacios y normalización Unicode.
- Importa texto UTF-8 con el mismo formato. Se conservan los participantes existentes y se suman los boletos de los nombres que ya estaban. También se admite una cabecera `Nombre;Boletos`. Encierra entre comillas los nombres que contengan comas o punto y coma.
- Configura hasta **20 etapas**, cada una con nombre de premio, cantidad de ganadores e imagen opcional. Puedes añadir, quitar y ordenar las etapas pendientes; se sortean en ese orden.
- Sortea una etapa y prepara la siguiente. Los resultados identifican a la persona y el número del boleto premiado. Consulta el historial y descarga cada resultado en CSV con su premio y sus boletos.

La tabla de participantes muestra personas, boletos y probabilidad. Cada boleto elegible tiene la misma oportunidad: una persona con tres de los diez boletos restantes tiene un 30 % de probabilidad en la próxima extracción. Si una etapa selecciona varios ganadores, las probabilidades se recalculan al retirar cada boleto o persona seleccionada; la probabilidad mostrada no es una garantía de ganar durante toda la etapa.

Con **«Un premio por persona»** activado, cada persona puede ganar una sola vez en todas las etapas del evento. Al desactivarlo, una persona puede ganar varios premios mediante boletos diferentes; un boleto premiado nunca vuelve a participar dentro del mismo evento. **«Empezar otra sesión»** prepara un nuevo evento: reinicia las etapas y las exclusiones y conserva los participantes, los premios, sus imágenes y el historial. Los sorteos de eventos anteriores no reducen las oportunidades del nuevo evento. Borrar el historial requiere confirmación y también reinicia las etapas.

Puedes añadir hasta 5.000 personas, 200 caracteres por nombre y 1.000.000 de boletos por persona; el total no puede superar 4.294.967.296 boletos. Las cantidades deben ser enteros positivos. Los archivos de participantes deben pesar menos de 1 MB. Se guardan los últimos 100 resultados. La descarga CSV protege los campos que podrían interpretarse como fórmulas en una hoja de cálculo.

Las fotos de premios aceptan **JPG, PNG, WebP o GIF de hasta 8 MB**. Se validan, se ajustan a un máximo de 1.280 píxeles por lado y se recomprimen a WebP o JPEG de hasta 300 KiB antes de guardarlas. Las imágenes animadas se convierten en una imagen estática y no se admiten SVG. Puedes retirar o sustituir una foto sin subirla a ningún servidor.

La selección utiliza `crypto.getRandomValues` con muestreo sin sesgo y sin reemplazo de boletos. El sitio no constituye una certificación independiente ni un mecanismo de auditoría de concursos regulados.

## Datos y privacidad

Los participantes, las etapas, la configuración y el historial se guardan en `localStorage`. Las fotos se guardan como archivos comprimidos en **IndexedDB**, sin llenar `localStorage` con imágenes. Todo queda dentro de este navegador y origen: no hay backend, cuentas de usuario, analítica, sincronización ni envío de participantes o fotos a un servidor. Borrar los datos del sitio, cambiar de navegador o usar una sesión privada puede eliminar o aislar esos datos. Exporta los resultados que quieras conservar. Los datos de la versión anterior se migran al abrir la aplicación.

La interfaz ofrece etiquetas para formularios, navegación por teclado, estados anunciados a lectores de pantalla y adaptación a pantallas pequeñas. Respeta la preferencia del sistema de reducir movimiento.

## Publicación estática

Ejecuta `npm run build` y publica el contenido de `dist/` con cualquier servicio de hosting estático mediante HTTPS. Las rutas son relativas, de modo que también puede alojarse en una subcarpeta de GitHub Pages. Para GitHub Pages con Actions, el artefacto que debe subirse es `dist/`; la publicación se configura por separado en el repositorio.
