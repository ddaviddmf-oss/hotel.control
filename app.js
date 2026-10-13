"use strict";

/* =====================================================================
   Utilidades
   ===================================================================== */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const lista = (obj) => Object.values(obj || {});
const pad = (n) => String(n).padStart(2, "0");
const dinero = (n) => "$" + (Number(n) || 0).toLocaleString("es-MX", { maximumFractionDigits: 2 });
const hora = (ts) => new Date(ts).toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" });
const porNumero = (a, b) => String(a.numero).localeCompare(String(b.numero), "es", { numeric: true });
const porNombre = (a, b) => String(a.nombre).localeCompare(String(b.nombre), "es");
const hoyISO = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

function duracion(ms) {
  const t = Math.floor(Math.abs(ms) / 1000);
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  return h > 0 ? `${h}h ${pad(m)}m` : `${m}m ${pad(s)}s`;
}
function hace(ts) {
  const min = Math.floor((Date.now() - ts) / 60000);
  if (!ts || min < 1) return "hace un momento";
  if (min < 60) return `hace ${min} min`;
  return `hace ${Math.floor(min / 60)} h ${min % 60} min`;
}

const ESTADOS = {
  libre: { txt: "Libre", cls: "libre" },
  ocupada: { txt: "Ocupada", cls: "ocupada" },
  sucia: { txt: "Por limpiar", cls: "sucia" },
  limpiando: { txt: "Limpiando", cls: "limpiando" },
  mantenimiento: { txt: "Mantenimiento", cls: "mant" },
};

/* =====================================================================
   Almacenamiento local
   ===================================================================== */
const LS = { estado: "hotel:estado", cola: "hotel:cola", sync: "hotel:syncUrl", prefs: "hotel:prefs" };
function leerLS(k, def) { try { const v = localStorage.getItem(k); return v == null ? def : JSON.parse(v); } catch { return def; } }
function escribirLS(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* sin espacio o modo privado */ } }

const prefs = Object.assign({ sonido: true, pantalla: false, personal: [], tab: "habitaciones" }, leerLS(LS.prefs, {}));
const guardarPrefs = () => escribirLS(LS.prefs, prefs);

function semilla() {
  const habitaciones = {};
  for (let i = 1; i <= 10; i++) {
    const id = "h" + (100 + i);
    habitaciones[id] = { id, numero: String(100 + i), tipo: i <= 6 ? "Sencilla" : "Doble", estado: "libre" };
  }
  const productos = {};
  [
    ["Jabón", "pza", 40, 10, 1],
    ["Papel higiénico", "rollo", 60, 15, 2],
    ["Shampoo", "pza", 40, 10, 1],
    ["Toallas", "pza", 30, 8, 2],
    ["Sábanas", "juego", 20, 5, 1],
    ["Agua embotellada", "botella", 48, 12, 2],
    ["Vasos desechables", "pza", 100, 20, 2],
  ].forEach(([nombre, unidad, stock, minimo, porHabitacion]) => {
    const id = "p" + uid();
    productos[id] = { id, nombre, unidad, stock, minimo, porHabitacion };
  });
  const tarifas = {};
  [["3 horas", 180, 350], ["6 horas", 360, 550], ["12 horas", 720, 800], ["Noche (24 h)", 1440, 1100]].forEach(([nombre, minutos, precio], i) => {
    const id = "t" + i;
    tarifas[id] = { id, nombre, minutos, precio, orden: i };
  });
  return { config: { nombreHotel: "Mi Hotel", avisoMin: 10 }, habitaciones, productos, tarifas, reportes: {}, historial: {} };
}

// Firebase elimina los objetos vacíos, así que siempre se reconstruye la forma completa.
function normalizar(d) {
  d = d || {};
  return {
    config: Object.assign({ nombreHotel: "Mi Hotel", avisoMin: 10 }, d.config || {}),
    habitaciones: d.habitaciones || {},
    productos: d.productos || {},
    tarifas: d.tarifas || {},
    reportes: d.reportes || {},
    historial: d.historial || {},
  };
}

let state = normalizar(leerLS(LS.estado, null) || semilla());
let cola = leerLS(LS.cola, []);
const ui = { tab: "habitaciones", filtro: "todas", dia: null, vistas: new Set(), silencioHasta: Date.now() + 5000, renderPendiente: false, modal: null };

function setPath(obj, path, value) {
  const partes = path.split("/").filter(Boolean);
  if (!partes.length) return value;
  let o = obj;
  for (let i = 0; i < partes.length - 1; i++) {
    if (typeof o[partes[i]] !== "object" || o[partes[i]] === null) o[partes[i]] = {};
    o = o[partes[i]];
  }
  const k = partes[partes.length - 1];
  if (value === null || value === undefined) delete o[k];
  else o[k] = value;
  return obj;
}

/** Único punto de escritura: guarda local, encola para la nube y redibuja. */
function escribir(path, value) {
  if (value === undefined) value = null;
  state = normalizar(setPath(state, path, value));
  escribirLS(LS.estado, state);
  if (sync.url) {
    cola.push({ path, value });
    escribirLS(LS.cola, cola);
    vaciarCola();
  }
  programarRender();
}

function log(tipo, texto, monto) {
  const id = "e" + uid();
  const e = { id, ts: Date.now(), tipo, texto };
  if (monto) e.monto = monto;
  escribir(`historial/${id}`, e);
}

/* =====================================================================
   Sincronización (Firebase Realtime Database por REST + streaming)
   ===================================================================== */
const sync = { url: "", es: null, estado: "local" };

function syncUrlGuardada() {
  const u = leerLS(LS.sync, "") || (window.HOTEL_CONFIG && window.HOTEL_CONFIG.firebaseUrl) || "";
  return String(u).trim();
}
function fbUrl(path) {
  const [base, query] = sync.url.split("?");
  return `${base.replace(/\/+$/, "")}/hotel${path ? "/" + path : ""}.json${query ? "?" + query : ""}`;
}

function marcarSync(estado) {
  sync.estado = estado;
  const txt = { local: "💾 Solo este dispositivo", conectando: "⏳ Conectando…", ok: "🟢 Sincronizado", error: "🔴 Sin conexión" }[estado];
  const el = $("#sync");
  if (el) { el.textContent = txt + (cola.length && estado !== "local" ? ` (${cola.length} pendientes)` : ""); }
}

function conectarSync() {
  if (sync.es) { sync.es.close(); sync.es = null; }
  sync.url = syncUrlGuardada();
  if (!sync.url) return marcarSync("local");
  marcarSync("conectando");
  let es;
  try { es = new EventSource(fbUrl("")); } catch { return marcarSync("error"); }
  sync.es = es;
  es.addEventListener("put", (ev) => recibir(ev, false));
  es.addEventListener("patch", (ev) => recibir(ev, true));
  es.addEventListener("cancel", () => {
    marcarSync("error");
    toast("<b>Sincronización rechazada</b><br>Revisa las reglas de tu base de datos de Firebase.", "urgente");
  });
  es.onopen = () => { marcarSync("ok"); vaciarCola(); };
  es.onerror = () => marcarSync(navigator.onLine ? "conectando" : "error");
}

function recibir(ev, esPatch) {
  let msg;
  try { msg = JSON.parse(ev.data); } catch { return; }
  if (!msg) return;
  const { path, data } = msg;
  if (esPatch) {
    for (const [k, v] of Object.entries(data || {})) state = setPath(state, `${path}/${k}`, v);
  } else if (path === "/") {
    if (data === null) {
      // Base vacía: este dispositivo la inicializa con sus datos.
      fetch(fbUrl(""), { method: "PUT", body: JSON.stringify(state) }).catch(() => {});
    } else {
      state = normalizar(data);
      for (const op of cola) state = setPath(state, op.path, op.value); // cambios locales aún no enviados
    }
  } else {
    state = setPath(state, path, data);
  }
  state = normalizar(state);
  escribirLS(LS.estado, state);
  marcarSync("ok");
  programarRender();
}

let vaciando = false;
async function vaciarCola() {
  if (vaciando || !sync.url || !cola.length) return;
  vaciando = true;
  try {
    while (cola.length) {
      const op = cola[0];
      const r = await fetch(fbUrl(op.path), op.value === null ? { method: "DELETE" } : { method: "PUT", body: JSON.stringify(op.value) });
      if (!r.ok) throw new Error("HTTP " + r.status);
      cola.shift();
      escribirLS(LS.cola, cola);
    }
    marcarSync(sync.es && sync.es.readyState === 1 ? "ok" : sync.estado);
  } catch {
    marcarSync("error");
  } finally {
    vaciando = false;
  }
}

function reemplazarTodo(nuevo) {
  state = normalizar(nuevo);
  escribirLS(LS.estado, state);
  cola = [];
  escribirLS(LS.cola, cola);
  if (sync.url) fetch(fbUrl(""), { method: "PUT", body: JSON.stringify(state) }).catch(() => toast("No se pudo subir a la nube", "urgente"));
  render();
}

// Conserva 90 días de historial para que la base no crezca sin límite.
function podarHistorial() {
  const limite = Date.now() - 90 * 86400000;
  const viejos = lista(state.historial).filter((e) => e.ts < limite);
  if (!viejos.length) return;
  const parche = {};
  for (const e of viejos) { delete state.historial[e.id]; parche[e.id] = null; }
  escribirLS(LS.estado, state);
  if (sync.url) fetch(fbUrl("historial"), { method: "PATCH", body: JSON.stringify(parche) }).catch(() => {});
}

/* =====================================================================
   Sonido, notificaciones, pantalla encendida
   ===================================================================== */
let audioCtx = null;
function desbloquearAudio() {
  if (!audioCtx) { try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch { return; } }
  if (audioCtx.state === "suspended") audioCtx.resume();
}
function sonar(urgente) {
  if (!prefs.sonido || !audioCtx) return;
  const notas = urgente ? [880, 660, 880, 660, 880] : [660, 990];
  notas.forEach((f, i) => {
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    const t = audioCtx.currentTime + i * 0.22;
    o.type = "sine"; o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.5, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
    o.connect(g).connect(audioCtx.destination);
    o.start(t); o.stop(t + 0.21);
  });
}
function notificar(titulo, cuerpo) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  const opts = { body: cuerpo, icon: "icon.svg", tag: titulo };
  if (navigator.serviceWorker && navigator.serviceWorker.controller) {
    navigator.serviceWorker.ready.then((r) => r.showNotification(titulo, opts)).catch(() => {});
  } else {
    try { new Notification(titulo, opts); } catch { /* algunos navegadores solo permiten vía service worker */ }
  }
}

let wakeLock = null;
async function aplicarPantalla() {
  try {
    if (prefs.pantalla && "wakeLock" in navigator && document.visibilityState === "visible") {
      if (!wakeLock) {
        wakeLock = await navigator.wakeLock.request("screen");
        wakeLock.addEventListener("release", () => { wakeLock = null; });
      }
    } else if (!prefs.pantalla && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch { /* no soportado */ }
}

function toast(html, nivel = "ok") {
  const el = document.createElement("div");
  el.className = "toast " + nivel;
  el.innerHTML = html;
  el.addEventListener("click", () => el.remove());
  $("#toasts").appendChild(el);
  setTimeout(() => el.remove(), nivel === "urgente" ? 10000 : 5000);
}

/* =====================================================================
   Alertas
   ===================================================================== */
function calcularAlertas() {
  const ahora = Date.now(), aviso = (state.config.avisoMin || 10) * 60000, out = [];
  for (const h of lista(state.habitaciones)) {
    if (h.estado !== "ocupada") continue;
    const r = h.fin - ahora;
    if (r <= 0) {
      // Se repite cada 10 minutos mientras la habitación siga excedida.
      out.push({ key: `venc:${h.id}:${h.fin}:${Math.floor(-r / 600000)}`, nivel: "urgente", titulo: `Hab ${h.numero}: tiempo terminado`, texto: `Excedida por ${duracion(r)}`, hab: h.id, orden: 0 });
    } else if (r <= aviso) {
      out.push({ key: `pronto:${h.id}:${h.fin}`, nivel: "aviso", titulo: `Hab ${h.numero}: termina pronto`, texto: `Quedan ${duracion(r)} (sale ${hora(h.fin)})`, hab: h.id, orden: 1 });
    }
  }
  for (const r of lista(state.reportes)) {
    out.push({ key: `rep:${r.id}`, nivel: "aviso", titulo: `Hab ${r.numero}: falta ${r.producto}`, texto: r.nota || hace(r.ts), tab: "reportes", orden: 2 });
  }
  for (const p of lista(state.productos)) {
    if (p.stock > p.minimo) continue;
    const agotado = p.stock <= 0;
    out.push({ key: `stock:${p.id}:${agotado ? 0 : 1}`, nivel: agotado ? "urgente" : "aviso", titulo: agotado ? `${p.nombre} agotado` : `${p.nombre}: queda poco`, texto: `Quedan ${p.stock} ${p.unidad || ""} (mínimo ${p.minimo})`, tab: "insumos", orden: 3 });
  }
  return out.sort((a, b) => a.orden - b.orden);
}

function revisarAlertas() {
  const alertas = calcularAlertas();
  const badge = $("#num-alertas");
  badge.hidden = !alertas.length;
  badge.textContent = alertas.length;
  $("#btn-alertas").classList.toggle("urgente", alertas.some((a) => a.nivel === "urgente"));

  const nuevas = alertas.filter((a) => !ui.vistas.has(a.key));
  nuevas.forEach((a) => ui.vistas.add(a.key));
  if (!nuevas.length || Date.now() < ui.silencioHasta) return; // al abrir la app no se dispara todo de golpe
  sonar(nuevas.some((a) => a.nivel === "urgente"));
  for (const a of nuevas.slice(0, 4)) {
    toast(`<b>${esc(a.titulo)}</b><br>${esc(a.texto)}`, a.nivel);
    notificar(a.titulo, a.texto);
  }
}

/* =====================================================================
   Vistas
   ===================================================================== */
function tarjeta(h) {
  const e = ESTADOS[h.estado] || ESTADOS.libre;
  const reps = lista(state.reportes).filter((r) => r.habitacionId === h.id).length;
  let cuerpo = "";
  if (h.estado === "ocupada") {
    cuerpo = `<div class="cuenta" data-fin="${h.fin}"></div>
      <div class="barra-prog"><i data-prog-fin="${h.fin}" data-prog-inicio="${h.inicio}"></i></div>
      <div class="sub">Sale ${hora(h.fin)} · ${h.placas ? "🚗 " + esc(h.placas) : h.llegada === "caminando" ? "🚶" : esc(h.huesped || "")}</div>`;
  } else if (h.estado === "sucia") {
    cuerpo = `<div class="sub" data-desde="${h.desde || 0}" data-pre="Desocupada "></div>`;
  } else if (h.estado === "limpiando") {
    cuerpo = `<div class="sub">${esc(h.camarista || "Limpiando")}</div><div class="sub" data-desde="${h.limpiezaInicio || 0}" data-pre="Inició "></div>`;
  } else if (h.estado === "mantenimiento") {
    cuerpo = `<div class="sub">${esc(h.motivo || "")}</div>`;
  }
  return `<button class="hab ${e.cls}" data-hab="${h.id}">
    <div class="hab-top"><span class="num">${esc(h.numero)}</span><span class="pill">${e.txt}</span></div>
    <div class="tipo">${esc(h.tipo || "")}</div>
    ${cuerpo}
    ${reps ? `<span class="rep-flag">⚠ ${reps} faltante${reps > 1 ? "s" : ""}</span>` : ""}
  </button>`;
}

function vistaHabitaciones() {
  const habs = lista(state.habitaciones).sort(porNumero);
  const filtros = [["todas", "Todas"], ["libre", "Libres"], ["ocupada", "Ocupadas"], ["sucia", "Por limpiar"], ["limpiando", "Limpiando"], ["mantenimiento", "Mantenimiento"]];
  const visibles = ui.filtro === "todas" ? habs : habs.filter((h) => h.estado === ui.filtro);
  return `<div class="filtros">${filtros.map(([k, t]) =>
      `<button class="chip ${ui.filtro === k ? "activo" : ""}" data-filtro="${k}">${t}<b>${k === "todas" ? habs.length : habs.filter((h) => h.estado === k).length}</b></button>`).join("")}</div>
    <div class="grid">${visibles.map(tarjeta).join("") || `<p class="vacio">No hay habitaciones en este estado.</p>`}</div>`;
}

function vistaLimpieza() {
  const habs = lista(state.habitaciones);
  const sucias = habs.filter((h) => h.estado === "sucia").sort((a, b) => (a.desde || 0) - (b.desde || 0));
  const limpiando = habs.filter((h) => h.estado === "limpiando").sort((a, b) => (a.limpiezaInicio || 0) - (b.limpiezaInicio || 0));
  const proximas = habs.filter((h) => h.estado === "ocupada" && h.fin - Date.now() <= 3600000).sort((a, b) => a.fin - b.fin);
  const reps = (h) => lista(state.reportes).filter((r) => r.habitacionId === h.id).map((r) => esc(r.producto)).join(", ");

  return `
  <section class="seccion"><h2>🧽 Por limpiar <span class="pill sucia">${sucias.length}</span></h2>
    ${sucias.map((h) => `<div class="fila sucia">
      <span class="num">${esc(h.numero)}</span>
      <div class="fila-info"><b>${esc(h.tipo || "")}</b><span class="muted" data-desde="${h.desde || 0}" data-pre="Desocupada "></span>
        ${reps(h) ? `<span style="color:var(--rojo)">⚠ Falta: ${reps(h)}</span>` : ""}</div>
      <div class="fila-btns">
        <button class="btn morado" data-accion="iniciar-limpieza" data-id="${h.id}">Iniciar limpieza</button>
        <button class="btn" data-accion="terminar-limpieza" data-id="${h.id}">Ya está lista</button>
      </div></div>`).join("") || `<p class="vacio">Todo limpio ✨</p>`}
  </section>
  <section class="seccion"><h2>🧹 En limpieza <span class="pill limpiando">${limpiando.length}</span></h2>
    ${limpiando.map((h) => `<div class="fila limpiando">
      <span class="num">${esc(h.numero)}</span>
      <div class="fila-info"><b>${esc(h.camarista || "Sin asignar")}</b><span class="muted" data-desde="${h.limpiezaInicio || 0}" data-pre="Inició "></span></div>
      <div class="fila-btns"><button class="btn verde" data-accion="terminar-limpieza" data-id="${h.id}">✔ Terminar</button></div></div>`).join("") || `<p class="vacio">Nadie limpiando en este momento.</p>`}
  </section>
  <section class="seccion"><h2>⏰ Próximas salidas (1 hora)</h2>
    ${proximas.map((h) => `<div class="fila ocupada">
      <span class="num">${esc(h.numero)}</span>
      <div class="fila-info"><span class="muted">Sale ${hora(h.fin)}</span></div>
      <div class="cuenta" data-fin="${h.fin}"></div></div>`).join("") || `<p class="vacio">Sin salidas en la próxima hora.</p>`}
  </section>`;
}

function vistaInsumos() {
  const prods = lista(state.productos).sort(porNombre);
  const bajos = prods.filter((p) => p.stock <= p.minimo);
  return `<div class="cabecera"><h2>Inventario de insumos</h2><button class="btn primario" data-accion="editar-producto">+ Producto</button></div>
    ${bajos.length ? `<div class="aviso-box">⚠ <b>Hay que comprar:</b> ${bajos.map((p) => `${esc(p.nombre)} (${p.stock})`).join(", ")}</div>` : ""}
    ${prods.map((p) => {
      const nivel = p.stock <= 0 ? "agotado" : p.stock <= p.minimo ? "bajo" : "ok";
      const pct = Math.max(0, Math.min(100, p.minimo ? (p.stock / (p.minimo * 3)) * 100 : 100));
      return `<div class="prod ${nivel}">
        <div class="prod-info"><b>${esc(p.nombre)}</b><small>Mínimo ${p.minimo} · se usan ${p.porHabitacion || 0} por habitación</small>
          <div class="barra-prog"><i style="width:${pct}%"></i></div></div>
        <div class="prod-stock"><span class="stock">${p.stock}</span><small>${esc(p.unidad || "")}</small></div>
        <div class="prod-btns">
          <button class="btn icono" data-accion="stock" data-id="${p.id}" data-d="-1">−1</button>
          <button class="btn icono" data-accion="stock" data-id="${p.id}" data-d="1">+1</button>
          <button class="btn verde" data-accion="entrada" data-id="${p.id}">Entrada</button>
          <button class="btn icono" data-accion="editar-producto" data-id="${p.id}" aria-label="Editar">✏️</button>
        </div></div>`;
    }).join("") || `<p class="vacio">Aún no hay productos.</p>`}`;
}

function vistaReportes() {
  const reps = lista(state.reportes).sort((a, b) => a.ts - b.ts);
  return `<div class="cabecera"><h2>Faltantes reportados</h2><button class="btn primario" data-accion="reportar">+ Reportar faltante</button></div>
    ${reps.map((r) => `<div class="fila" style="--c:var(--rojo)">
      <span class="num">${esc(r.numero)}</span>
      <div class="fila-info"><b>${esc(r.producto)}</b>${r.nota ? `<span>${esc(r.nota)}</span>` : ""}<span class="muted" data-desde="${r.ts}" data-pre="Reportado "></span></div>
      <div class="fila-btns">
        ${r.productoId && state.productos[r.productoId] ? `<button class="btn verde" data-accion="resolver" data-id="${r.id}" data-descontar="1">Repuesto<small>descuenta 1</small></button>` : ""}
        <button class="btn" data-accion="resolver" data-id="${r.id}">Resuelto</button>
      </div></div>`).join("") || `<p class="vacio">No hay faltantes pendientes 👍</p>`}`;
}

function vistaHistorial() {
  const dia = ui.dia || hoyISO();
  const [y, m, d] = dia.split("-").map(Number);
  const ini = new Date(y, m - 1, d).getTime(), fin = new Date(y, m - 1, d + 1).getTime();
  const ents = lista(state.historial).filter((e) => e.ts >= ini && e.ts < fin).sort((a, b) => b.ts - a.ts);
  const n = (t) => ents.filter((e) => e.tipo === t).length;
  const ingresos = ents.reduce((s, e) => s + (e.monto || 0), 0);
  const iconos = { entrada: "🛏️", extension: "⏩", salida: "🚪", limpieza: "🧹", reporte: "⚠️", resuelto: "✅", inventario: "📦", mantenimiento: "🔧" };
  return `<div class="cabecera"><h2>Historial</h2>
      <div style="display:flex;gap:8px;align-items:center"><input type="date" id="hist-dia" value="${dia}" style="margin:0"><button class="btn" data-accion="exportar-csv">⬇ CSV</button></div></div>
    <div class="resumen">
      <div class="tile"><small>Ingresos</small><b>${dinero(ingresos)}</b></div>
      <div class="tile"><small>Entradas</small><b>${n("entrada")}</b></div>
      <div class="tile"><small>Extensiones</small><b>${n("extension")}</b></div>
      <div class="tile"><small>Limpiezas</small><b>${n("limpieza")}</b></div>
      <div class="tile"><small>Faltantes reportados</small><b>${n("reporte")}</b></div>
    </div>
    <div class="panel">${ents.map((e) => `<div class="evento"><time>${hora(e.ts)}</time><span>${iconos[e.tipo] || "•"} ${esc(e.texto)}</span>${e.monto ? `<span class="monto">${dinero(e.monto)}</span>` : ""}</div>`).join("") || `<p class="muted">Sin movimientos este día.</p>`}</div>`;
}

function vistaAjustes() {
  const c = state.config;
  const tarifas = lista(state.tarifas).sort((a, b) => (a.orden ?? 0) - (b.orden ?? 0));
  const habs = lista(state.habitaciones).sort(porNumero);
  const permiso = "Notification" in window ? Notification.permission : "no-soportado";
  return `
  <section class="panel"><h2>General</h2>
    <div class="campos">
      <label>Nombre del hotel<input data-ajuste="nombreHotel" value="${esc(c.nombreHotel)}"></label>
      <label>Avisar cuando falten (minutos)<input type="number" min="1" inputmode="numeric" data-ajuste="avisoMin" value="${c.avisoMin}"></label>
    </div>
  </section>

  <section class="panel"><h2>Este dispositivo</h2>
    <label class="check"><input type="checkbox" data-pref="sonido" ${prefs.sonido ? "checked" : ""}> Sonido en alertas</label>
    <label class="check"><input type="checkbox" data-pref="pantalla" ${prefs.pantalla ? "checked" : ""}> Mantener la pantalla encendida</label>
    <div class="botones">
      <button class="btn" data-accion="probar-sonido">🔊 Probar sonido</button>
      <button class="btn" data-accion="activar-notif" ${permiso === "granted" || permiso === "no-soportado" ? "disabled" : ""}>
        🔔 ${permiso === "granted" ? "Notificaciones activadas" : permiso === "denied" ? "Notificaciones bloqueadas en el navegador" : permiso === "no-soportado" ? "Notificaciones no disponibles" : "Activar notificaciones"}</button>
    </div>
  </section>

  <section class="panel"><h2>Tarifas</h2>
    <div class="tabla-edit">
      <div class="renglon encab"><span>Nombre</span><span>Minutos</span><span>Precio</span><span></span></div>
      ${tarifas.map((t) => `<div class="renglon">
        <input data-tarifa="${t.id}" data-campo="nombre" value="${esc(t.nombre)}">
        <input type="number" min="1" inputmode="numeric" data-tarifa="${t.id}" data-campo="minutos" value="${t.minutos}">
        <input type="number" min="0" inputmode="decimal" data-tarifa="${t.id}" data-campo="precio" value="${t.precio}">
        <button class="btn icono peligro" data-accion="borrar-tarifa" data-id="${t.id}" aria-label="Borrar">🗑</button></div>`).join("")}
    </div>
    <div class="botones"><button class="btn" data-accion="agregar-tarifa">+ Agregar tarifa</button></div>
  </section>

  <section class="panel"><h2>Habitaciones (${habs.length})</h2>
    <div class="tabla-edit habs">
      <div class="renglon encab"><span>Número</span><span>Tipo</span><span></span></div>
      ${habs.map((h) => `<div class="renglon">
        <input data-habedit="${h.id}" data-campo="numero" value="${esc(h.numero)}">
        <input data-habedit="${h.id}" data-campo="tipo" value="${esc(h.tipo || "")}">
        <button class="btn icono peligro" data-accion="borrar-hab" data-id="${h.id}" aria-label="Borrar">🗑</button></div>`).join("")}
      <div class="renglon">
        <input id="nueva-num" placeholder="Número nuevo">
        <input id="nuevo-tipo" placeholder="Tipo (Sencilla, Doble, Suite…)">
        <button class="btn verde icono" data-accion="agregar-hab" aria-label="Agregar">＋</button></div>
    </div>
  </section>

  <section class="panel"><h2>Sincronizar varias tablets / celulares</h2>
    <p class="muted">Pega la URL de tu Firebase Realtime Database (instrucciones en el README). Todos los dispositivos con la misma URL verán lo mismo en tiempo real. Déjalo vacío para usar solo este dispositivo.</p>
    <label>URL de la base de datos<input type="url" id="sync-url" placeholder="https://mi-hotel-default-rtdb.firebaseio.com" value="${esc(leerLS(LS.sync, "") || "")}"></label>
    <p class="muted">Estado: ${$("#sync").textContent}</p>
    <div class="botones"><button class="btn primario" data-accion="guardar-sync">Guardar y conectar</button></div>
  </section>

  <section class="panel"><h2>Respaldo</h2>
    <div class="botones">
      <button class="btn" data-accion="exportar">⬇ Descargar respaldo</button>
      <label class="btn" style="margin:0;color:var(--texto)">⬆ Restaurar respaldo<input type="file" id="importar" accept="application/json,.json" hidden></label>
      <button class="btn peligro" data-accion="restablecer">Borrar todo y empezar de cero</button>
    </div>
  </section>`;
}

const vistas = { habitaciones: vistaHabitaciones, limpieza: vistaLimpieza, insumos: vistaInsumos, reportes: vistaReportes, historial: vistaHistorial, ajustes: vistaAjustes };

let rTimer = null;
function programarRender() { if (!rTimer) rTimer = setTimeout(() => { rTimer = null; render(); }, 0); }

function render() {
  // No redibujar mientras alguien escribe en un campo de la pantalla (se haría al salir del campo).
  const act = document.activeElement;
  if (act && $("#vista").contains(act) && act.matches("input:not([type]), input[type=text], input[type=number], input[type=url]")) {
    ui.renderPendiente = true;
    return;
  }
  ui.renderPendiente = false;

  document.title = `${state.config.nombreHotel} · Control`;
  $("#nombre-hotel").textContent = state.config.nombreHotel || "Hotel";

  const habs = lista(state.habitaciones);
  const cuenta = (e) => habs.filter((h) => h.estado === e).length;
  $("#contadores").innerHTML = `
    <span class="cnt libre"><b>${cuenta("libre")}</b> libres</span>
    <span class="cnt ocupada"><b>${cuenta("ocupada")}</b> ocupadas</span>
    <span class="cnt sucia"><b>${cuenta("sucia") + cuenta("limpiando")}</b> por limpiar</span>
    ${cuenta("mantenimiento") ? `<span class="cnt mant"><b>${cuenta("mantenimiento")}</b> mant.</span>` : ""}`;

  $$("#tabs [data-tab]").forEach((b) => b.classList.toggle("activo", b.dataset.tab === ui.tab));
  const setBadge = (id, n, cls = "") => { const b = $(id); b.hidden = !n; b.textContent = n; b.className = "badge " + cls; };
  setBadge("#badge-limpieza", cuenta("sucia"), "amarillo");
  setBadge("#badge-insumos", lista(state.productos).filter((p) => p.stock <= p.minimo).length);
  setBadge("#badge-reportes", lista(state.reportes).length);

  $("#vista").innerHTML = vistas[ui.tab]();

  // Si otro dispositivo cambió la habitación abierta en la ventana, actualizarla.
  if (ui.modal && ui.modal.tipo === "hab" && !$("#modal-cuerpo").contains(document.activeElement)) {
    const h = state.habitaciones[ui.modal.id];
    if (!h) cerrarModal();
    else if (h.estado !== ui.modal.estado || h.fin !== ui.modal.fin) abrirHab(h.id);
  }
  tick();
}

function tick() {
  const ahora = Date.now(), aviso = (state.config.avisoMin || 10) * 60000;
  $("#reloj").textContent = new Date().toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" });
  $$("[data-fin]").forEach((el) => {
    const r = +el.dataset.fin - ahora;
    el.innerHTML = r >= 0 ? duracion(r) : `+${duracion(r)} <small class="exc">excedido</small>`;
    el.classList.toggle("excedido", r < 0);
    el.classList.toggle("pronto", r > 0 && r <= aviso);
    const cont = el.closest(".hab, .fila");
    if (cont) { cont.classList.toggle("pronto", r > 0 && r <= aviso); cont.classList.toggle("vencida", r <= 0); }
  });
  $$("[data-prog-fin]").forEach((el) => {
    const fin = +el.dataset.progFin, ini = +el.dataset.progInicio;
    el.style.width = Math.max(0, Math.min(100, ((ahora - ini) / (fin - ini || 1)) * 100)) + "%";
  });
  $$("[data-desde]").forEach((el) => { el.textContent = (el.dataset.pre || "") + hace(+el.dataset.desde); });
  revisarAlertas();
}

/* =====================================================================
   Ventanas (modales)
   ===================================================================== */
function abrirModal(html, meta = null) {
  $("#modal-cuerpo").innerHTML = html;
  $("#modal").hidden = false;
  ui.modal = meta;
  tick();
}
function cerrarModal() {
  $("#modal").hidden = true;
  $("#modal-cuerpo").innerHTML = "";
  ui.modal = null;
}

const tarifasOrdenadas = () => lista(state.tarifas).sort((a, b) => (a.orden ?? 0) - (b.orden ?? 0) || a.minutos - b.minutos);
const basicos = (h) => ({ id: h.id, numero: h.numero, tipo: h.tipo || "" });

function abrirHab(id) {
  const h = state.habitaciones[id];
  if (!h) return;
  const e = ESTADOS[h.estado] || ESTADOS.libre;
  const reps = lista(state.reportes).filter((r) => r.habitacionId === id);
  let html = `<h2>Habitación ${esc(h.numero)} <span class="pill ${e.cls}">${e.txt}</span></h2><p class="muted">${esc(h.tipo || "")}</p>`;
  if (reps.length) html += `<div class="aviso-box">⚠ Faltantes reportados: ${reps.map((r) => esc(r.producto)).join(", ")}</div>`;

  const secundarios = (extra = "") => `<div class="botones">${extra}
      <button class="btn" data-accion="reportar" data-id="${id}">⚠ Reportar faltante</button></div>`;

  if (h.estado === "libre") {
    const ts = tarifasOrdenadas();
    html += `<h3>Registrar entrada</h3>
      <div class="tarifas">
        ${ts.map((t, i) => `<label class="tarifa"><input type="radio" name="tarifa" value="${t.id}" ${i === 0 ? "checked" : ""}><span><b>${esc(t.nombre)}</b><small>${dinero(t.precio)}</small></span></label>`).join("")}
        <label class="tarifa"><input type="radio" name="tarifa" value="otro" ${ts.length ? "" : "checked"}><span><b>Personalizado</b><small>minutos y precio</small></span></label>
      </div>
      <div class="campos" id="campos-otro" ${ts.length ? "hidden" : ""}>
        <label>Minutos<input type="number" id="ci-min" min="1" value="120" inputmode="numeric"></label>
        <label>Precio<input type="number" id="ci-precio" min="0" value="0" inputmode="decimal"></label>
      </div>
      <h3>¿Cómo llegan?</h3>
      <div class="tarifas">
        <label class="tarifa"><input type="radio" name="llegada" value="carro" checked><span><b>🚗 En carro</b><small>registrar placas</small></span></label>
        <label class="tarifa"><input type="radio" name="llegada" value="caminando"><span><b>🚶 Caminando</b><small>sin vehículo</small></span></label>
      </div>
      <div id="campos-carro">
        <label>Placas del carro<input id="ci-placas" autocomplete="off" autocapitalize="characters" placeholder="Ej. ABC-123-D" style="text-transform:uppercase"></label>
      </div>
      <div class="campos">
        <label>Nombre del huésped (opcional)<input id="ci-huesped" autocomplete="off"></label>
        <label>Nota (opcional)<input id="ci-nota" autocomplete="off"></label>
      </div>
      <div class="botones"><button class="btn primario grande" data-accion="checkin" data-id="${id}">Registrar entrada</button></div>
      ${secundarios(`<button class="btn" data-accion="mantenimiento" data-id="${id}">🔧 Mantenimiento</button>`)}`;
  } else if (h.estado === "ocupada") {
    html += `<div class="cuenta grande" data-fin="${h.fin}"></div>
      <div class="barra-prog ocupada"><i data-prog-fin="${h.fin}" data-prog-inicio="${h.inicio}"></i></div>
      <div class="datos">
        <div><small>Entrada</small>${hora(h.inicio)}</div>
        <div><small>Salida</small>${hora(h.fin)}</div>
        <div><small>Tarifa</small>${esc(h.tarifa || "")}</div>
        <div><small>Cobrado</small>${dinero(h.monto)}</div>
        ${h.llegada ? `<div><small>Llegada</small>${h.llegada === "carro" ? "🚗 En carro" : "🚶 Caminando"}</div>` : ""}
        ${h.placas ? `<div><small>Placas</small><b>${esc(h.placas)}</b></div>` : ""}
        ${h.huesped ? `<div><small>Huésped</small>${esc(h.huesped)}</div>` : ""}
        ${h.nota ? `<div><small>Nota</small>${esc(h.nota)}</div>` : ""}
      </div>
      <h3>Extender tiempo</h3>
      <div class="botones">
        ${tarifasOrdenadas().map((t) => `<button class="btn" data-accion="extender" data-id="${id}" data-tarifa="${t.id}">+ ${esc(t.nombre)}<small>${dinero(t.precio)}</small></button>`).join("")}
        <button class="btn" data-accion="extender" data-id="${id}" data-min="15">+15 min<small>sin cobro</small></button>
      </div>
      <div class="botones"><button class="btn amarillo grande" data-accion="salida" data-id="${id}">🚪 Registrar salida</button></div>
      ${secundarios()}`;
  } else if (h.estado === "sucia") {
    html += `<p data-desde="${h.desde || 0}" data-pre="Desocupada "></p>
      <div class="botones">
        <button class="btn morado grande" data-accion="iniciar-limpieza" data-id="${id}">🧹 Iniciar limpieza</button>
        <button class="btn" data-accion="terminar-limpieza" data-id="${id}">✔ Ya está lista</button>
      </div>
      ${secundarios(`<button class="btn" data-accion="mantenimiento" data-id="${id}">🔧 Mantenimiento</button>`)}`;
  } else if (h.estado === "limpiando") {
    html += `<div class="datos"><div><small>Camarista</small>${esc(h.camarista || "Sin asignar")}</div>
        <div><small>Inició</small>${hora(h.limpiezaInicio)}</div></div>
      <div class="botones"><button class="btn verde grande" data-accion="terminar-limpieza" data-id="${id}">✔ Terminar limpieza</button></div>
      ${secundarios()}`;
  } else if (h.estado === "mantenimiento") {
    html += `<div class="datos"><div><small>Motivo</small>${esc(h.motivo || "—")}</div><div><small>Desde</small>${hora(h.desde)}</div></div>
      <div class="botones">
        <button class="btn verde" data-accion="fin-mant" data-id="${id}" data-a="libre">Lista → Libre</button>
        <button class="btn amarillo" data-accion="fin-mant" data-id="${id}" data-a="sucia">Lista → Por limpiar</button>
      </div>
      ${secundarios()}`;
  }
  abrirModal(html, { tipo: "hab", id, estado: h.estado, fin: h.fin });
}

function abrirTerminarLimpieza(id) {
  const h = state.habitaciones[id];
  if (!h) return;
  const prods = lista(state.productos).sort(porNombre);
  abrirModal(`<h2>Habitación ${esc(h.numero)} lista</h2>
    <p class="muted">Insumos que se dejaron en la habitación (se descuentan del inventario):</p>
    ${prods.map((p) => `<div class="paso-fila"><span>${esc(p.nombre)} <small>(${p.stock} en almacén)</small></span>
      <div class="paso">
        <button class="btn" data-accion="paso" data-for="q-${p.id}" data-d="-1">−</button>
        <input type="number" min="0" inputmode="numeric" id="q-${p.id}" data-prod="${p.id}" value="${p.porHabitacion || 0}">
        <button class="btn" data-accion="paso" data-for="q-${p.id}" data-d="1">+</button>
      </div></div>`).join("") || `<p class="muted">No hay productos en el inventario.</p>`}
    <div class="botones"><button class="btn verde grande" data-accion="confirmar-limpieza" data-id="${id}">✔ Marcar como libre</button></div>`);
}

function abrirReportar(habId) {
  const habs = lista(state.habitaciones).sort(porNumero);
  const prods = lista(state.productos).sort(porNombre);
  abrirModal(`<h2>Reportar faltante</h2>
    <label>Habitación<select id="rep-hab">${habs.map((h) => `<option value="${h.id}" ${h.id === habId ? "selected" : ""}>${esc(h.numero)}</option>`).join("")}</select></label>
    <p class="muted">¿Qué falta o se terminó?</p>
    <div class="chips">${prods.map((p) => `<label class="chip-check"><input type="checkbox" value="${p.id}"><span>${esc(p.nombre)}</span></label>`).join("")}</div>
    <label>Otro (opcional)<input id="rep-otro" placeholder="Ej. foco fundido, control de la TV…" autocomplete="off"></label>
    <label>Nota (opcional)<input id="rep-nota" autocomplete="off"></label>
    <div class="botones"><button class="btn primario grande" data-accion="confirmar-reporte">Enviar reporte</button></div>`);
}

function abrirProducto(id) {
  const p = id ? state.productos[id] : { nombre: "", unidad: "pza", stock: 0, minimo: 5, porHabitacion: 1 };
  if (!p) return;
  abrirModal(`<h2>${id ? "Editar" : "Nuevo"} producto</h2>
    <div class="campos">
      <label>Nombre<input id="pr-nombre" value="${esc(p.nombre)}"></label>
      <label>Unidad<input id="pr-unidad" value="${esc(p.unidad || "")}" placeholder="pza, rollo, litro…"></label>
      <label>Cantidad en almacén<input type="number" min="0" inputmode="numeric" id="pr-stock" value="${p.stock}"></label>
      <label>Avisar cuando queden (mínimo)<input type="number" min="0" inputmode="numeric" id="pr-minimo" value="${p.minimo}"></label>
      <label>Se usan por habitación<input type="number" min="0" inputmode="numeric" id="pr-porhab" value="${p.porHabitacion || 0}"></label>
    </div>
    <div class="botones">
      <button class="btn primario grande" data-accion="guardar-producto" data-id="${id || ""}">Guardar</button>
      ${id ? `<button class="btn peligro" data-accion="borrar-producto" data-id="${id}">Eliminar producto</button>` : ""}
    </div>`);
}

function abrirAlertas() {
  const alertas = calcularAlertas();
  abrirModal(`<h2>Alertas (${alertas.length})</h2>
    ${alertas.map((a) => `<div class="alerta-item ${a.nivel}"><div><b>${esc(a.titulo)}</b><br><small>${esc(a.texto)}</small></div>
      ${a.hab ? `<button class="btn" data-hab="${a.hab}">Ver</button>` : `<button class="btn" data-tab="${a.tab}">Ver</button>`}</div>`).join("") || `<p class="muted">Todo en orden 👌</p>`}`);
}

/* =====================================================================
   Acciones
   ===================================================================== */
const numeroValido = (v, min = 0) => { const n = Number(v); return Number.isFinite(n) && n >= min ? n : null; };

const acciones = {
  alertas: () => abrirAlertas(),

  checkin({ id }) {
    const h = state.habitaciones[id];
    if (!h || h.estado !== "libre") return cerrarModal();
    const sel = $("input[name=tarifa]:checked")?.value;
    let minutos, precio, nombre;
    if (sel === "otro" || !sel) {
      minutos = Math.round(numeroValido($("#ci-min").value, 1) || 0);
      precio = numeroValido($("#ci-precio").value) || 0;
      nombre = `${minutos} min`;
    } else {
      const t = state.tarifas[sel];
      if (!t) return;
      ({ minutos, precio, nombre } = t);
    }
    if (!(minutos > 0)) return toast("Indica cuántos minutos", "urgente");
    const llegada = $("input[name=llegada]:checked")?.value || "caminando";
    const placas = llegada === "carro" ? $("#ci-placas").value.trim().toUpperCase() : "";
    if (llegada === "carro" && !placas) { $("#ci-placas").focus(); return toast("Escribe las placas del carro", "urgente"); }
    const ahora = Date.now(), fin = ahora + minutos * 60000;
    escribir(`habitaciones/${id}`, {
      ...basicos(h), estado: "ocupada", inicio: ahora, fin, tarifa: nombre, monto: precio, llegada, placas,
      huesped: $("#ci-huesped").value.trim(), nota: $("#ci-nota").value.trim(),
    });
    log("entrada", `Entrada hab ${h.numero} · ${nombre} · ${placas ? "🚗 " + placas : "🚶 caminando"}`, precio);
    cerrarModal();
    toast(`Hab ${esc(h.numero)} ocupada hasta las <b>${hora(fin)}</b>`);
  },

  extender({ id, tarifa, min }) {
    const h = state.habitaciones[id];
    if (!h || h.estado !== "ocupada") return;
    let minutos, precio = 0, nombre;
    if (tarifa) { const t = state.tarifas[tarifa]; if (!t) return; ({ minutos, precio, nombre } = t); }
    else { minutos = +min; nombre = `${minutos} min de cortesía`; }
    const fin = h.fin + minutos * 60000;
    escribir(`habitaciones/${id}`, { ...h, fin, monto: (h.monto || 0) + precio });
    log("extension", `Extensión hab ${h.numero} · +${nombre}`, precio);
    toast(`Hab ${esc(h.numero)}: nueva salida <b>${hora(fin)}</b>`);
    abrirHab(id);
  },

  salida({ id }) {
    const h = state.habitaciones[id];
    if (!h || h.estado !== "ocupada") return;
    if (!confirm(`¿Registrar la salida de la habitación ${h.numero}?`)) return;
    escribir(`habitaciones/${id}`, { ...basicos(h), estado: "sucia", desde: Date.now() });
    log("salida", `Salida hab ${h.numero}${h.placas ? " · 🚗 " + h.placas : ""} · estancia ${duracion(Date.now() - h.inicio)} · total ${dinero(h.monto)}`);
    cerrarModal();
    toast(`Hab ${esc(h.numero)} pasa a <b>por limpiar</b>`, "aviso");
  },

  "iniciar-limpieza"({ id }) {
    const h = state.habitaciones[id];
    if (!h) return;
    abrirModal(`<h2>Limpieza · Hab ${esc(h.numero)}</h2>
      <label>¿Quién limpia?<input id="cam-nombre" list="personal" autocomplete="off" value="${esc(prefs.personal[0] || "")}"></label>
      <datalist id="personal">${prefs.personal.map((p) => `<option value="${esc(p)}">`).join("")}</datalist>
      <div class="chips">${prefs.personal.map((p) => `<button class="btn" data-accion="poner-nombre" data-n="${esc(p)}">${esc(p)}</button>`).join("")}</div>
      <div class="botones"><button class="btn morado grande" data-accion="confirmar-inicio-limpieza" data-id="${id}">Iniciar</button></div>`);
  },
  "poner-nombre"({ n }) { $("#cam-nombre").value = n; },
  "confirmar-inicio-limpieza"({ id }) {
    const h = state.habitaciones[id];
    if (!h || (h.estado !== "sucia" && h.estado !== "limpiando")) return cerrarModal();
    const camarista = $("#cam-nombre").value.trim();
    if (camarista) { prefs.personal = [camarista, ...prefs.personal.filter((p) => p !== camarista)].slice(0, 12); guardarPrefs(); }
    escribir(`habitaciones/${id}`, { ...basicos(h), estado: "limpiando", desde: h.desde || Date.now(), limpiezaInicio: Date.now(), camarista });
    cerrarModal();
  },

  "terminar-limpieza": ({ id }) => abrirTerminarLimpieza(id),
  paso({ for: campo, d }) {
    const inp = document.getElementById(campo);
    inp.value = Math.max(0, (parseInt(inp.value, 10) || 0) + Number(d));
  },
  "confirmar-limpieza"({ id }) {
    const h = state.habitaciones[id];
    if (!h) return cerrarModal();
    const usados = [];
    $$("#modal-cuerpo input[data-prod]").forEach((inp) => {
      const p = state.productos[inp.dataset.prod];
      const q = Math.max(0, parseInt(inp.value, 10) || 0);
      if (!p || !q) return;
      escribir(`productos/${p.id}/stock`, Math.max(0, p.stock - q));
      usados.push(`${q} ${p.nombre}`);
    });
    escribir(`habitaciones/${id}`, { ...basicos(h), estado: "libre" });
    const tiempo = h.limpiezaInicio ? ` en ${duracion(Date.now() - h.limpiezaInicio)}` : "";
    log("limpieza", `Limpieza hab ${h.numero}${h.camarista ? " por " + h.camarista : ""}${tiempo}${usados.length ? " · " + usados.join(", ") : ""}`);
    cerrarModal();
    toast(`Hab ${esc(h.numero)} <b>libre</b> ✨`);
  },

  mantenimiento({ id }) {
    const h = state.habitaciones[id];
    if (!h) return;
    abrirModal(`<h2>Mantenimiento · Hab ${esc(h.numero)}</h2>
      <label>Motivo<input id="mant-motivo" placeholder="Ej. fuga en regadera, aire acondicionado…" autocomplete="off"></label>
      <div class="botones"><button class="btn grande" data-accion="confirmar-mant" data-id="${id}">🔧 Poner en mantenimiento</button></div>`);
  },
  "confirmar-mant"({ id }) {
    const h = state.habitaciones[id];
    if (!h || h.estado === "ocupada") return cerrarModal();
    const motivo = $("#mant-motivo").value.trim();
    escribir(`habitaciones/${id}`, { ...basicos(h), estado: "mantenimiento", motivo, desde: Date.now() });
    log("mantenimiento", `Hab ${h.numero} en mantenimiento${motivo ? ": " + motivo : ""}`);
    cerrarModal();
  },
  "fin-mant"({ id, a }) {
    const h = state.habitaciones[id];
    if (!h) return;
    escribir(`habitaciones/${id}`, { ...basicos(h), estado: a, ...(a === "sucia" ? { desde: Date.now() } : {}) });
    log("mantenimiento", `Hab ${h.numero} sale de mantenimiento`);
    cerrarModal();
  },

  reportar: ({ id }) => abrirReportar(id),
  "confirmar-reporte"() {
    const h = state.habitaciones[$("#rep-hab").value];
    if (!h) return;
    const items = $$("#modal-cuerpo .chips input:checked").map((c) => ({ productoId: c.value, producto: state.productos[c.value]?.nombre || "?" }));
    const otro = $("#rep-otro").value.trim();
    if (otro) items.push({ producto: otro });
    if (!items.length) return toast("Selecciona qué falta", "urgente");
    const nota = $("#rep-nota").value.trim();
    items.forEach((it, i) => {
      const id = "r" + uid() + i;
      escribir(`reportes/${id}`, { id, habitacionId: h.id, numero: h.numero, ts: Date.now(), nota, ...it });
    });
    log("reporte", `Hab ${h.numero} reporta falta de ${items.map((i) => i.producto).join(", ")}`);
    cerrarModal();
    toast("Reporte enviado", "aviso");
  },
  resolver({ id, descontar }) {
    const r = state.reportes[id];
    if (!r) return;
    const p = r.productoId && state.productos[r.productoId];
    if (descontar && p) escribir(`productos/${p.id}/stock`, Math.max(0, p.stock - 1));
    escribir(`reportes/${id}`, null);
    log("resuelto", `Hab ${r.numero}: ${r.producto} ${descontar ? "repuesto" : "resuelto"}`);
  },

  stock({ id, d }) {
    const p = state.productos[id];
    if (p) escribir(`productos/${id}/stock`, Math.max(0, p.stock + Number(d)));
  },
  entrada({ id }) {
    const p = state.productos[id];
    if (!p) return;
    abrirModal(`<h2>Entrada de ${esc(p.nombre)}</h2><p class="muted">Hay ${p.stock} ${esc(p.unidad || "")} en almacén.</p>
      <label>¿Cuántos llegaron?<input type="number" min="1" inputmode="numeric" id="ent-cant" value="${Math.max(p.minimo * 2 - p.stock, 1)}"></label>
      <div class="botones"><button class="btn verde grande" data-accion="confirmar-entrada" data-id="${id}">Agregar al inventario</button></div>`);
    setTimeout(() => $("#ent-cant")?.select(), 50);
  },
  "confirmar-entrada"({ id }) {
    const p = state.productos[id];
    const q = Math.round(numeroValido($("#ent-cant").value, 1) || 0);
    if (!p || !q) return toast("Cantidad inválida", "urgente");
    escribir(`productos/${id}/stock`, p.stock + q);
    log("inventario", `Entrada de ${q} ${p.unidad || ""} de ${p.nombre}`);
    cerrarModal();
  },
  "editar-producto": ({ id }) => abrirProducto(id),
  "guardar-producto"({ id }) {
    const nombre = $("#pr-nombre").value.trim();
    if (!nombre) return toast("Escribe el nombre", "urgente");
    id = id || "p" + uid();
    escribir(`productos/${id}`, {
      id, nombre, unidad: $("#pr-unidad").value.trim(),
      stock: Math.round(numeroValido($("#pr-stock").value) || 0),
      minimo: Math.round(numeroValido($("#pr-minimo").value) || 0),
      porHabitacion: Math.round(numeroValido($("#pr-porhab").value) || 0),
    });
    cerrarModal();
  },
  "borrar-producto"({ id }) {
    const p = state.productos[id];
    if (!p || !confirm(`¿Eliminar ${p.nombre} del inventario?`)) return;
    escribir(`productos/${id}`, null);
    cerrarModal();
  },

  "agregar-tarifa"() {
    const id = "t" + uid();
    escribir(`tarifas/${id}`, { id, nombre: "Nueva tarifa", minutos: 60, precio: 0, orden: lista(state.tarifas).length });
  },
  "borrar-tarifa"({ id }) {
    if (confirm(`¿Borrar la tarifa "${state.tarifas[id]?.nombre}"?`)) escribir(`tarifas/${id}`, null);
  },
  "agregar-hab"() {
    const numero = $("#nueva-num").value.trim();
    if (!numero) return toast("Escribe el número de la habitación", "urgente");
    if (lista(state.habitaciones).some((h) => h.numero === numero)) return toast("Ese número ya existe", "urgente");
    const id = "h" + uid();
    escribir(`habitaciones/${id}`, { id, numero, tipo: $("#nuevo-tipo").value.trim(), estado: "libre" });
    toast(`Habitación ${esc(numero)} agregada`);
  },
  "borrar-hab"({ id }) {
    const h = state.habitaciones[id];
    if (!h) return;
    if (h.estado === "ocupada") return toast("No se puede borrar una habitación ocupada", "urgente");
    if (!confirm(`¿Borrar la habitación ${h.numero}?`)) return;
    escribir(`habitaciones/${id}`, null);
    lista(state.reportes).filter((r) => r.habitacionId === id).forEach((r) => escribir(`reportes/${r.id}`, null));
  },

  "guardar-sync"() {
    const url = $("#sync-url").value.trim();
    if (url && !/^https:\/\/[^/]+\.(firebaseio\.com|firebasedatabase\.app)/.test(url)) {
      return toast("La URL debe ser de Firebase Realtime Database (https://…firebaseio.com o …firebasedatabase.app)", "urgente");
    }
    escribirLS(LS.sync, url);
    cola = [];
    escribirLS(LS.cola, cola);
    conectarSync();
    toast(url ? "Conectando con la nube…" : "Modo solo este dispositivo");
    render();
  },
  "probar-sonido"() { desbloquearAudio(); sonar(true); },
  "activar-notif"() {
    if (!("Notification" in window)) return;
    Notification.requestPermission().then(() => render());
  },
  exportar() {
    descargar(`respaldo-hotel-${hoyISO()}.json`, JSON.stringify(state, null, 2), "application/json");
  },
  "exportar-csv"() {
    const dia = ui.dia || hoyISO();
    const [y, m, d] = dia.split("-").map(Number);
    const ini = new Date(y, m - 1, d).getTime(), fin = new Date(y, m - 1, d + 1).getTime();
    const filas = lista(state.historial).filter((e) => e.ts >= ini && e.ts < fin).sort((a, b) => a.ts - b.ts);
    const csv = ["Hora,Tipo,Detalle,Monto", ...filas.map((e) => [hora(e.ts), e.tipo, `"${String(e.texto).replace(/"/g, '""')}"`, e.monto || ""].join(","))].join("\n");
    descargar(`historial-${dia}.csv`, "﻿" + csv, "text/csv");
  },
  restablecer() {
    if (!confirm("Esto borra TODAS las habitaciones, inventario e historial (también en la nube si está conectada). ¿Continuar?")) return;
    if (!confirm("¿Seguro? Esta acción no se puede deshacer.")) return;
    reemplazarTodo(semilla());
    toast("Datos reiniciados");
  },
};

function descargar(nombre, contenido, tipo) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([contenido], { type: tipo }));
  a.download = nombre;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function importar(archivo) {
  if (!archivo) return;
  archivo.text().then((txt) => {
    const datos = JSON.parse(txt);
    if (!datos || typeof datos !== "object" || !datos.habitaciones) throw new Error("formato");
    if (!confirm("¿Reemplazar todos los datos actuales con este respaldo?")) return;
    reemplazarTodo(datos);
    toast("Respaldo restaurado");
  }).catch(() => toast("El archivo no es un respaldo válido", "urgente"));
}

/* =====================================================================
   Eventos
   ===================================================================== */
document.addEventListener("click", (e) => {
  desbloquearAudio();
  if (e.target.id === "modal") return cerrarModal();
  const t = e.target.closest("[data-cerrar],[data-accion],[data-tab],[data-filtro],[data-hab]");
  if (!t || t.disabled) return;
  if (t.hasAttribute("data-cerrar")) return cerrarModal();
  if (t.dataset.accion) {
    const fn = acciones[t.dataset.accion];
    if (fn) fn(t.dataset, t);
    return;
  }
  if (t.dataset.tab) {
    ui.tab = t.dataset.tab;
    prefs.tab = ui.tab;
    guardarPrefs();
    cerrarModal();
    render();
    window.scrollTo(0, 0);
    return;
  }
  if (t.dataset.filtro) { ui.filtro = t.dataset.filtro; render(); return; }
  if (t.dataset.hab) abrirHab(t.dataset.hab);
});

document.addEventListener("change", (e) => {
  const t = e.target;
  if (t.name === "tarifa") { $("#campos-otro").hidden = t.value !== "otro"; return; }
  if (t.name === "llegada") { $("#campos-carro").hidden = t.value !== "carro"; return; }
  if (t.dataset.ajuste) {
    const v = t.type === "number" ? Math.max(1, Math.round(+t.value || 1)) : t.value.trim() || "Mi Hotel";
    escribir(`config/${t.dataset.ajuste}`, v);
    return;
  }
  if (t.dataset.tarifa) {
    const campo = t.dataset.campo;
    let v = campo === "nombre" ? t.value.trim() || "Tarifa" : Math.max(0, +t.value || 0);
    if (campo === "minutos") v = Math.max(1, Math.round(v));
    escribir(`tarifas/${t.dataset.tarifa}/${campo}`, v);
    return;
  }
  if (t.dataset.habedit) {
    const campo = t.dataset.campo, v = t.value.trim();
    if (campo === "numero") {
      if (!v) return render();
      if (lista(state.habitaciones).some((h) => h.numero === v && h.id !== t.dataset.habedit)) { toast("Ese número ya existe", "urgente"); return render(); }
    }
    escribir(`habitaciones/${t.dataset.habedit}/${campo}`, v);
    return;
  }
  if (t.dataset.pref) {
    prefs[t.dataset.pref] = t.checked;
    guardarPrefs();
    if (t.dataset.pref === "pantalla") aplicarPantalla();
    return;
  }
  if (t.id === "importar") { importar(t.files[0]); t.value = ""; return; }
  if (t.id === "hist-dia") { ui.dia = t.value || hoyISO(); render(); }
});

document.addEventListener("focusout", () => setTimeout(() => { if (ui.renderPendiente) render(); }, 0));
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("#modal").hidden) cerrarModal(); });
document.addEventListener("visibilitychange", () => {
  aplicarPantalla();
  if (document.visibilityState === "visible") render();
});
window.addEventListener("online", () => {
  vaciarCola();
  if (sync.url && (!sync.es || sync.es.readyState === 2)) conectarSync();
});

/* =====================================================================
   Arranque
   ===================================================================== */
ui.tab = vistas[prefs.tab] ? prefs.tab : "habitaciones";
escribirLS(LS.estado, state);
conectarSync();
// El aviso por defecto pasó de 15 a 10 minutos; se actualiza una sola vez en datos existentes.
if (!state.config.aviso10) {
  if (state.config.avisoMin === 15) escribir("config/avisoMin", 10);
  escribir("config/aviso10", true);
}
render();
setInterval(tick, 1000);
setInterval(vaciarCola, 15000);
setTimeout(podarHistorial, 20000);
aplicarPantalla();
if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
