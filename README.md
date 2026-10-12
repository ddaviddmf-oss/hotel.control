# Control de Hotel

App web para tablet (también funciona en celular y PC) para controlar habitaciones, limpieza e insumos.
No necesita servidor propio ni cuentas: son archivos estáticos (`index.html`, `app.js`, `styles.css`).

## Funciones

- **Habitaciones**: estado de cada una (libre, ocupada, por limpiar, limpiando, mantenimiento) con
  **cuenta regresiva** del tiempo restante, barra de progreso y hora de salida.
  - Registrar entrada con tarifas (3 h, 6 h, 12 h, noche o personalizada), huésped/placa y nota.
  - Extender tiempo (cobra la tarifa elegida) o dar 15 min de cortesía.
  - Al registrar la salida, la habitación pasa automáticamente a **por limpiar**.
- **Limpieza**: lista de habitaciones por limpiar (las más antiguas primero), quién está limpiando y
  cuánto lleva, y próximas salidas de la siguiente hora. Al terminar se indican los insumos
  que se dejaron en la habitación y **se descuentan del inventario**.
- **Insumos**: inventario con mínimo por producto. Cuando un producto llega al mínimo o se agota,
  aparece alerta. Botón “Entrada” para registrar compras.
- **Faltantes**: cualquiera puede reportar que en una habitación falta jabón, papel, etc. (o algo
  como “foco fundido”). Se marca como repuesto/resuelto.
- **Alertas** (🔔): habitación por terminar (configurable, 15 min por defecto), tiempo excedido
  (se repite cada 10 min), faltantes reportados, stock bajo/agotado. Con sonido y notificaciones
  del sistema.
- **Historial** por día: ingresos, entradas, extensiones, limpiezas; exportable a CSV (Excel).
- **Ajustes**: nombre del hotel, tarifas, habitaciones, sonido, mantener pantalla encendida,
  respaldo/restauración y sincronización.
- Se puede **instalar** en la tablet como app (menú del navegador → “Agregar a pantalla de inicio”)
  y abre aunque falle el internet.

## Publicarla en línea (gratis) con GitHub Pages

1. Abre **GitHub Desktop** → *File → Add local repository* → elige la carpeta `hotel-control`.
2. Pulsa **Publish repository** (puede ser pública: en el repositorio solo va el código, no los datos
   del hotel).
3. En github.com abre el repositorio → **Settings → Pages** → *Source: Deploy from a branch* →
   rama `main`, carpeta `/ (root)` → **Save**.
4. En 1–2 minutos estará en https://ddaviddmf-oss.github.io/hotel.control/. Abre esa dirección en la
   tablet; nadie necesita cuenta para usarla.

Alternativa: arrastrar la carpeta a <https://app.netlify.com/drop> (requiere crear cuenta gratuita
de Netlify para que no se borre).

## Sincronizar varias tablets/celulares (opcional)

Sin esto, cada dispositivo guarda sus propios datos. Para que recepción, camaristas y gerencia vean
lo mismo en tiempo real:

1. Entra a <https://console.firebase.google.com> → **Crear proyecto** (gratis, plan Spark).
2. Menú **Compilación → Realtime Database → Crear base de datos** → elige ubicación →
   *Comenzar en modo bloqueado*.
3. En la pestaña **Reglas**, pega y publica:

   ```json
   {
     "rules": {
       "hotel": { ".read": true, ".write": true }
     }
   }
   ```

4. Copia la URL que aparece arriba (ej. `https://mi-hotel-default-rtdb.firebaseio.com`).
5. En la app: **Ajustes → Sincronizar** → pega la URL → *Guardar y conectar*. Repite en cada
   dispositivo (o ponla una sola vez en `config.js` antes de publicar).

El primer dispositivo que se conecta sube sus datos; los demás los reciben.

> **Seguridad:** con esas reglas, cualquiera que conozca la URL de la base de datos puede leer y
> modificar los datos. No guardes información sensible de huéspedes. Para mayor protección, en
> Firebase → *Configuración del proyecto → Cuentas de servicio → Secretos de la base de datos*
> obtén un secreto, cambia las reglas a `".read": false, ".write": false` y usa la URL con
> `?auth=SECRETO` al final. Así solo funcionan los dispositivos que tengan esa URL.

## Probar en la computadora

Abre `index.html` con doble clic, o mejor con un servidor local para que funcione todo
(instalación y notificaciones):

```bash
npx serve .
```
