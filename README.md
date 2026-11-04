# Sortea

Una web de sorteos en español que funciona en el navegador. Añade participantes, elige cuántos ganadores necesitas y realiza un sorteo sin repetir nombres en el mismo resultado.

## Desarrollo

Requiere **Node.js 22 o posterior**. No necesita instalar dependencias, configurar claves ni levantar una base de datos.

```sh
cd /workspace/Web-Sorteo
npm run dev
```

El servidor de desarrollo escucha en el puerto **5173**. Para usar otro puerto: `npm run dev -- --port 5174`. Usa un navegador moderno con JavaScript habilitado; el contexto local o HTTPS permite utilizar Web Crypto.

```sh
npm test          # Núcleo de selección aleatoria y servidor HTTP
npm run build    # Genera dist/ a partir de index.html y src/
npm run preview  # Sirve dist/ en el puerto 4173
```

Para comprobar los flujos completos en un navegador real, instala Chromium y ejecuta `npm run test:browser`. Usa `BROWSER_PATH=/ruta/a/chrome npm run test:browser` si el ejecutable no está en `/usr/bin/chromium`. La prueba abre un perfil temporal aislado y no modifica tus sorteos. En Linux de CI se ejecuta Chrome con `--no-sandbox`; esta opción se limita al navegador de pruebas. GitHub Actions ejecuta las pruebas y la compilación con cada push o pull request.

La compilación no transpila ni descarga recursos: produce un sitio estático listo para publicar. Los servidores fallan si el puerto solicitado está ocupado y solo exponen los archivos públicos de la aplicación.

Para probar el resultado compilado en lugar de los archivos de desarrollo: `BROWSER_TEST_DIST=1 npm run test:browser` después de ejecutar `npm run build`.

## Uso

- Introduce un participante por línea o importa un archivo `.txt` con ese mismo formato.
- Los nombres vacíos y duplicados se descartan; las diferencias de mayúsculas no generan participantes adicionales.
- Configura el título y el número de ganadores, y ejecuta el sorteo.
- Consulta el historial local y descarga los resultados en CSV.

Puedes añadir hasta 5.000 participantes por sorteo, con un máximo de 200 caracteres por nombre. Los archivos de texto deben usar UTF-8 y pesar menos de 1 MB; al importar se conservan los nombres existentes. Se guardan los últimos 100 sorteos. La opción «Que la suerte se reparta» excluye a los ganadores de todos los sorteos de ese historial; puedes desactivarla para volver a incluirlos. La descarga CSV protege los campos que podrían interpretarse como fórmulas en una hoja de cálculo.

La selección utiliza `crypto.getRandomValues` con muestreo sin sesgo y sin reemplazo. El sitio no constituye una certificación independiente ni un mecanismo de auditoría de concursos regulados.

## Datos y privacidad

Los participantes, la configuración y el historial se guardan en `localStorage`, dentro de este navegador y origen. No hay backend, cuentas de usuario, analítica ni envío de participantes a un servidor. Borrar los datos del sitio, cambiar de navegador o usar una sesión privada puede eliminar o aislar esos datos. Exporta los resultados que quieras conservar.

La interfaz ofrece etiquetas para formularios, navegación por teclado, estados anunciados a lectores de pantalla y adaptación a pantallas pequeñas. Respeta la preferencia del sistema de reducir movimiento.

## Publicación estática

Ejecuta `npm run build` y publica el contenido de `dist/` con cualquier servicio de hosting estático mediante HTTPS. Las rutas son relativas, de modo que también puede alojarse en una subcarpeta de GitHub Pages. Para GitHub Pages con Actions, el artefacto que debe subirse es `dist/`; la publicación se configura por separado en el repositorio.
