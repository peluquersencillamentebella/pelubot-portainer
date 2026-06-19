const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const { google } = require("googleapis");
const fs = require("fs");
const path = require("path");
const cron = require("node-cron");

// ─── CONFIGURACIÓN ────────────────────────────────────────────────────────────
const CONFIG = {
  nombre: "Peluquería Sencillamente Bella",
  telefonoMovil:  "+34 658074305",   // Móvil / WhatsApp
  telefonoFijo:   "+34 93 399 69 51",  // Teléfono fijo
  telefono:       "+34 600 000 000",   // Número principal (usado en mensajes internos)
  direccion: "Calle Otger 9, 08917 Badalona",
  zonaHoraria: "Europe/Madrid",

  horarioDias: {
    lunes:     null,
    martes:    { apertura: "09:30", cierre: "19:00" },
    miercoles: { apertura: "09:30", cierre: "19:00" },
    jueves:    { apertura: "09:30", cierre: "19:00" },
    viernes:   { apertura: "09:30", cierre: "19:00" },
    sabado:    { apertura: "09:00", cierre: "13:00" },
    domingo:   null,
  },

  servicios: [
    { id: 1, nombre: "Corte señora",                 precio: "entre 27 y 39.50€",    duracion: 30  },
    { id: 2, nombre: "Corte caballero",              precio: "14€",                  duracion: 30  },
    { id: 3, nombre: "Corte niño",                   precio: "11€",                  duracion: 30 },
    { id: 4, nombre: "Corte niña",                   precio: "entre 22 y 25€",       duracion: 40  },
    { id: 5, nombre: "Peinar señora",                precio: "entre 16.50 y 18.50€", duracion: 45  },
    { id: 6, nombre: "Teñir y peinar señora",        precio: "entre 33 y 47.50€",    duracion: 90,
      fases: [
        { tipo: "activo", duracion: 20 },
        { tipo: "espera", duracion: 40 },
        { tipo: "activo", duracion: 30 },
      ]
    },
    { id: 7, nombre: "Teñir cortar y peinar señora", precio: "entre 49 y 62.50€",    duracion: 120,
      fases: [
        { tipo: "activo", duracion: 20 },
        { tipo: "espera", duracion: 40 },
        { tipo: "activo", duracion: 60 },
      ]
    },
    { id: 8, nombre: "Mechas balayage",              precio: "entre 92 y 104€",      duracion: 120,
      fases: [
        { tipo: "activo", duracion: 20 },
        { tipo: "espera", duracion: 40 },
        { tipo: "activo", duracion: 60 },
      ]
    },
    { id: 9, nombre: "Keratina",                     precio: "entre 90 y 150€",      duracion: 180  },
    { id: 10, nombre: "Alisado moldeado",            precio: "entre 38 y 75€",       duracion: 120  },
  ],


  margenEntreCitas: 0,
  telefonoDueno:    "34673812602",
  resumenHora:      20,
  resumenMin:       0,
};

// ─── HELPERS DE HORARIO ───────────────────────────────────────────────────────
const DIAS_SEMANA = ["domingo","lunes","martes","miercoles","jueves","viernes","sabado"];

function nombreDia(fecha) {
  const [dia, mes, anio] = fecha.split("/").map(Number);
  return DIAS_SEMANA[new Date(anio, mes - 1, dia).getDay()];
}

function horarioDelDia(fecha) {
  return CONFIG.horarioDias[nombreDia(fecha)] || null;
}

function textoHorarioSemanal() {
  const etiquetas = {
    lunes:"Lunes", martes:"Martes", miercoles:"Miércoles",
    jueves:"Jueves", viernes:"Viernes", sabado:"Sábado", domingo:"Domingo",
  };
  let t = "";
  for (const [dia, h] of Object.entries(CONFIG.horarioDias)) {
    t += h ? `📅 ${etiquetas[dia]}: ${h.apertura} – ${h.cierre}\n`
           : `🔴 ${etiquetas[dia]}: Cerrado\n`;
  }
  return t;
}

// ─── ARCHIVOS DE DATOS ────────────────────────────────────────────────────────
const CITAS_FILE    = path.join(__dirname, "citas.json");
const SHEET_ID_FILE = path.join(__dirname, "sheet_id.txt");

function leerCitas() {
  try {
    if (!fs.existsSync(CITAS_FILE)) return [];
    return JSON.parse(fs.readFileSync(CITAS_FILE, "utf8"));
  } catch { return []; }
}

function guardarCita(cita) {
  const citas = leerCitas();
  citas.push(cita);
  fs.writeFileSync(CITAS_FILE, JSON.stringify(citas, null, 2));
}

function actualizarCitas(citas) {
  fs.writeFileSync(CITAS_FILE, JSON.stringify(citas, null, 2));
}

// ─── MOTOR DE DISPONIBILIDAD ──────────────────────────────────────────────────
function horaAMinutos(hora) {
  const [hh, mm] = hora.split(":").map(Number);
  return hh * 60 + mm;
}

function minutosAHora(min) {
  return `${Math.floor(min/60).toString().padStart(2,"0")}:${(min%60).toString().padStart(2,"0")}`;
}

/**
 * Dado un servicio con fases, devuelve los bloques de tiempo que realmente
 * necesitan a la peluquera (tipo "activo"), ignorando los de espera.
 * Ejemplo tinte desde las 10:00:
 *   fase activo 20min  → ocupa 10:00–10:20
 *   fase espera 40min  → libre 10:20–11:00  ← otra cita puede entrar aquí
 *   fase activo 30min  → ocupa 11:00–11:30
 * Devuelve: [{ inicio: 600, fin: 620 }, { inicio: 660, fin: 690 }]
 */
function bloquesOcupadosCita(horaIni, servicio) {
  const info = CONFIG.servicios.find(s => s.nombre === servicio);
  if (!info) return [{ inicio: horaIni, fin: horaIni + 60 + CONFIG.margenEntreCitas }];

  // Sin fases: un solo bloque
  if (!info.fases) {
    return [{ inicio: horaIni, fin: horaIni + info.duracion + CONFIG.margenEntreCitas }];
  }

  // Con fases: construir bloques activos fusionando los contiguos
  const bloques = [];
  let cursor = horaIni;
  let bloqueActual = null;

  for (const fase of info.fases) {
    if (fase.tipo === "activo") {
      if (!bloqueActual) bloqueActual = { inicio: cursor, fin: cursor + fase.duracion };
      else bloqueActual.fin = cursor + fase.duracion; // fusionar activos contiguos
    } else {
      // fase de espera: cerrar bloque activo si hay uno abierto
      if (bloqueActual) {
        bloques.push({ ...bloqueActual });
        bloqueActual = null;
      }
    }
    cursor += fase.duracion;
  }
  // Cerrar último bloque activo
  if (bloqueActual) {
    bloqueActual.fin += CONFIG.margenEntreCitas;
    bloques.push(bloqueActual);
  } else if (bloques.length) {
    bloques[bloques.length - 1].fin += CONFIG.margenEntreCitas;
  }

  return bloques;
}

/**
 * Para una nueva cita de duracionMin minutos comenzando en tIni,
 * comprueba si solapa con algún bloque ocupado de las citas existentes.
 * También respeta las ventanas de espera: una cita corta PUEDE entrar
 * en el hueco de espera de un tinte siempre que quepa entera.
 */
function solapaConCitasExistentes(tIni, duracionMin, citasDelDia) {
  const tFin = tIni + duracionMin;

  for (const cita of citasDelDia) {
    const bloques = bloquesOcupadosCita(horaAMinutos(cita.hora), cita.servicio);
    for (const b of bloques) {
      // Solapa si los rangos se cruzan
      if (tIni < b.fin && tFin + CONFIG.margenEntreCitas > b.inicio) return true;
    }
  }
  return false;
}

function calcularHorasDisponibles(fecha, duracionMin) {
  const horarioDia = horarioDelDia(fecha);
  if (!horarioDia) return [];

  const citasDelDia = leerCitas().filter(c => c.fecha === fecha && !c.cancelada);
  const apertura    = horaAMinutos(horarioDia.apertura);
  const cierre      = horaAMinutos(horarioDia.cierre);
  const libres      = [];

  for (let t = apertura; t + duracionMin <= cierre; t += 15) {
    if (!solapaConCitasExistentes(t, duracionMin, citasDelDia))
      libres.push(minutosAHora(t));
  }
  return libres;
}

// ─── GOOGLE AUTH + CALENDAR + SHEETS ─────────────────────────────────────────
const SCOPES = [
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/drive.file",
];
const TOKEN_PATH       = path.join(__dirname, "token.json");
const CREDENTIALS_PATH = path.join(__dirname, "credentials.json");

let calendarClient = null;
let sheetsClient   = null;
let sheetId        = null;

async function inicializarGoogle() {
  try {
    if (process.env.GOOGLE_CREDENTIALS && !fs.existsSync(CREDENTIALS_PATH))
      fs.writeFileSync(CREDENTIALS_PATH, process.env.GOOGLE_CREDENTIALS);
    if (process.env.GOOGLE_TOKEN && !fs.existsSync(TOKEN_PATH))
      fs.writeFileSync(TOKEN_PATH, process.env.GOOGLE_TOKEN);

    if (!fs.existsSync(CREDENTIALS_PATH)) {
      console.log("⚠️  credentials.json no encontrado – Google desactivado.");
      return;
    }

    const creds = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, "utf8"));
    const { client_secret, client_id, redirect_uris } = creds.installed || creds.web;
    const auth = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

    if (!fs.existsSync(TOKEN_PATH)) {
      const url = auth.generateAuthUrl({ access_type: "offline", scope: SCOPES });
      console.log("\n🔑 AUTORIZA GOOGLE:");
      console.log("   Abre este enlace:\n   " + url);
      console.log('   Luego ejecuta: node autorizarGoogle.js "CODIGO"\n');
      return;
    }

    auth.setCredentials(JSON.parse(fs.readFileSync(TOKEN_PATH, "utf8")));
    calendarClient = google.calendar({ version: "v3", auth });
    sheetsClient   = google.sheets({ version: "v4", auth });
    const drive    = google.drive({ version: "v3", auth });

    console.log("✅ Google Calendar y Sheets conectados.");
    await inicializarSheet(drive);
  } catch (e) {
    console.error("❌ Error Google:", e.message);
  }
}

// ─── GOOGLE SHEETS ────────────────────────────────────────────────────────────
async function inicializarSheet() {
  try {
    if (fs.existsSync(SHEET_ID_FILE)) {
      sheetId = fs.readFileSync(SHEET_ID_FILE, "utf8").trim();
      console.log(`📊 Sheets: https://docs.google.com/spreadsheets/d/${sheetId}`);
      await formatearCabecera();
      return;
    }

    const res = await sheetsClient.spreadsheets.create({
      resource: {
        properties: { title: `📅 Citas – ${CONFIG.nombre}` },
        sheets: [
          { properties: { title: "Citas",   sheetId: 0 } },
          { properties: { title: "Resumen", sheetId: 1 } },
        ],
      },
    });

    sheetId = res.data.spreadsheetId;
    fs.writeFileSync(SHEET_ID_FILE, sheetId);
    console.log(`📊 Hoja creada: https://docs.google.com/spreadsheets/d/${sheetId}`);

    await formatearCabecera();
    await formatearResumen();

    const citas = leerCitas();
    for (const c of citas) await agregarFilaSheet(c, false);
    if (citas.length) console.log(`📊 ${citas.length} citas sincronizadas.`);
  } catch (e) {
    console.error("❌ Error iniciando Sheet:", e.message);
  }
}

async function formatearCabecera() {
  if (!sheetsClient || !sheetId) return;
  try {
    await sheetsClient.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: "Citas!A1:M1",
      valueInputOption: "RAW",
      resource: { values: [["ID","Nombre","Teléfono","Servicio","Precio","Fecha","Hora","Fin estimado","Duración (min)","Estado","Reservado el","R. 24h","R. 2h"]] },
    });
    await sheetsClient.spreadsheets.batchUpdate({
      spreadsheetId: sheetId,
      resource: { requests: [
        { repeatCell: {
            range: { sheetId:0, startRowIndex:0, endRowIndex:1, startColumnIndex:0, endColumnIndex:13 },
            cell: { userEnteredFormat: {
              backgroundColor: { red:0.18, green:0.18, blue:0.18 },
              textFormat: { foregroundColor:{red:1,green:1,blue:1}, bold:true, fontSize:10 },
              horizontalAlignment: "CENTER",
            }},
            fields: "userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)",
        }},
        { updateSheetProperties: { properties:{ sheetId:0, gridProperties:{ frozenRowCount:1 }}, fields:"gridProperties.frozenRowCount" }},
        { autoResizeDimensions: { dimensions:{ sheetId:0, dimension:"COLUMNS", startIndex:0, endIndex:13 }}},
      ]},
    });
  } catch (e) { console.error("❌ Error cabecera:", e.message); }
}

async function formatearResumen() {
  if (!sheetsClient || !sheetId) return;
  try {
    await sheetsClient.spreadsheets.values.batchUpdate({
      spreadsheetId: sheetId,
      resource: {
        valueInputOption: "USER_ENTERED",
        data: [
          { range:"Resumen!A1",  values:[["📊 RESUMEN DE CITAS"]] },
          { range:"Resumen!A3",  values:[["Total confirmadas"]] },
          { range:"Resumen!B3",  values:[['=COUNTIF(Citas!J:J,"✅ Confirmada")']] },
          { range:"Resumen!A4",  values:[["Total canceladas"]] },
          { range:"Resumen!B4",  values:[['=COUNTIF(Citas!J:J,"❌ Cancelada")']] },
          { range:"Resumen!A5",  values:[["Ingresos estimados (€)"]] },
          { range:"Resumen!B5",  values:[['=SUMPRODUCT((Citas!J2:J9999="✅ Confirmada")*IFERROR(VALUE(SUBSTITUTE(Citas!E2:E9999,"€","")),0))']] },
          { range:"Resumen!A7",  values:[["Servicio más solicitado"]] },
          { range:"Resumen!B7",  values:[['=INDEX(Citas!D2:D9999,MATCH(MAX(COUNTIF(Citas!D2:D9999,Citas!D2:D9999)),COUNTIF(Citas!D2:D9999,Citas!D2:D9999),0))']] },
          { range:"Resumen!A9",  values:[["Citas de hoy"]] },
          { range:"Resumen!B9",  values:[['=COUNTIF(Citas!F:F,TEXT(TODAY(),"DD/MM/YYYY"))']] },
          { range:"Resumen!A10", values:[["Citas esta semana"]] },
          { range:"Resumen!B10", values:[['=COUNTIFS(Citas!J:J,"✅ Confirmada",Citas!F:F,">="&TEXT(TODAY()-WEEKDAY(TODAY(),2)+1,"DD/MM/YYYY"),Citas!F:F,"<="&TEXT(TODAY()-WEEKDAY(TODAY(),2)+7,"DD/MM/YYYY"))']] },
        ],
      },
    });
  } catch (e) { console.error("❌ Error resumen:", e.message); }
}

function calcularHoraFin(hora, servicio) {
  const info = CONFIG.servicios.find(s => s.nombre === servicio);
  const dur  = info ? info.duracion : 60;
  const min  = horaAMinutos(hora) + dur;
  return minutosAHora(min);
}

async function agregarFilaSheet(cita, buscarExistente = true) {
  if (!sheetsClient || !sheetId) return;
  try {
    const info    = CONFIG.servicios.find(s => s.nombre === cita.servicio);
    const duracion = info ? info.duracion : 60;
    const estado  = cita.cancelada ? "❌ Cancelada" : "✅ Confirmada";
    const tel     = cita.telefono.replace("@c.us","").replace(/^34/,"+34 ");

    const fila = [
      cita.id, cita.nombre, tel, cita.servicio, cita.precio,
      cita.fecha, cita.hora, calcularHoraFin(cita.hora, cita.servicio), duracion,
      estado, new Date(cita.fechaReserva).toLocaleString("es-ES"),
      cita.recordatorio_24h_enviado ? "✅" : "⏳",
      cita.recordatorio_2h_enviado  ? "✅" : "⏳",
    ];

    if (buscarExistente) {
      const rows = await sheetsClient.spreadsheets.values.get({ spreadsheetId: sheetId, range: "Citas!A:A" });
      const ids  = (rows.data.values || []).flat();
      const idx  = ids.indexOf(cita.id);
      if (idx > 0) {
        await sheetsClient.spreadsheets.values.update({
          spreadsheetId: sheetId,
          range: `Citas!A${idx+1}:M${idx+1}`,
          valueInputOption: "RAW",
          resource: { values: [fila] },
        });
        await colorearFila(idx, cita.cancelada);
        return;
      }
    }

    const resp = await sheetsClient.spreadsheets.values.append({
      spreadsheetId: sheetId,
      range: "Citas!A:M",
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      resource: { values: [fila] },
    });
    const match = (resp.data.updates.updatedRange || "").match(/(\d+):/);
    if (match) await colorearFila(parseInt(match[1]) - 1, cita.cancelada);
  } catch (e) { console.error("❌ Error Sheets:", e.message); }
}

async function colorearFila(rowIndex, cancelada) {
  if (!sheetsClient || !sheetId) return;
  try {
    const color = cancelada
      ? { red:0.98, green:0.73, blue:0.73 }
      : { red:0.85, green:0.96, blue:0.85 };
    await sheetsClient.spreadsheets.batchUpdate({
      spreadsheetId: sheetId,
      resource: { requests: [{ repeatCell: {
        range: { sheetId:0, startRowIndex:rowIndex, endRowIndex:rowIndex+1, startColumnIndex:0, endColumnIndex:13 },
        cell: { userEnteredFormat: { backgroundColor: color } },
        fields: "userEnteredFormat.backgroundColor",
      }}]},
    });
  } catch { /* silencioso */ }
}

// ─── GOOGLE CALENDAR ──────────────────────────────────────────────────────────
function parsearFechaHora(fecha, hora) {
  const [d, m, y] = fecha.split("/");
  const [hh, mm]  = hora.split(":");
  return new Date(Number(y), Number(m)-1, Number(d), Number(hh), Number(mm));
}

async function crearEventoCalendar(cita) {
  if (!calendarClient) return null;
  try {
    const inicio = parsearFechaHora(cita.fecha, cita.hora);
    const info   = CONFIG.servicios.find(s => s.nombre === cita.servicio);
    const dur    = info ? info.duracion : 60;
    const fin    = new Date(inicio.getTime() + dur * 60000);
    const res = await calendarClient.events.insert({
      calendarId: "primary",
      resource: {
        summary:     `💇 ${cita.servicio} – ${cita.nombre}`,
        description: `Cliente: ${cita.nombre}\nServicio: ${cita.servicio} (${cita.precio})\nWhatsApp: ${cita.telefono}\nDuración: ${dur} min`,
        location:    null,
        start: { dateTime: inicio.toISOString(), timeZone: CONFIG.zonaHoraria },
        end:   { dateTime: fin.toISOString(),    timeZone: CONFIG.zonaHoraria },
        reminders: { useDefault:false, overrides:[
          { method:"email", minutes: 24*60 },
          { method:"popup", minutes: 60 },
        ]},
        colorId: "3",
      },
    });
    console.log(`📆 Evento Calendar creado: ${res.data.htmlLink}`);
    return res.data.id;
  } catch (e) { console.error("❌ Error Calendar:", e.message); return null; }
}

async function eliminarEventoCalendar(eventId) {
  if (!calendarClient || !eventId) return;
  try {
    await calendarClient.events.delete({ calendarId:"primary", eventId });
    console.log(`🗑️  Evento ${eventId} eliminado.`);
  } catch (e) { console.error("❌ Error eliminando evento:", e.message); }
}

// ─── RECORDATORIOS ────────────────────────────────────────────────────────────
let whatsappClient = null;

async function enviarRecordatorio(cita, tipo) {
  if (!whatsappClient) return;
  const nombre = cita.nombre.split(" ")[0];
  const msg = tipo === "24h"
    ? `⏰ *Recordatorio – ${CONFIG.nombre}*\n\nHola *${nombre}* 👋\n\nMañana tienes cita:\n💇 *${cita.servicio}*\n📅 ${cita.fecha} a las *${cita.hora}*\n📍 ${CONFIG.direccion}\n\n_Si necesitas cancelar, escríbenos._`
    : `🔔 *¡Tu cita es hoy!*\n\nHola *${nombre}* 😊\nTe esperamos en 2 horas para tu *${cita.servicio}*\n⏰ Hora: *${cita.hora}*\n📍 ${CONFIG.direccion}\n\n¡Hasta ahora! ✂️`;
  try {
    await whatsappClient.sendMessage(cita.telefono, msg);
    console.log(`📨 Recordatorio [${tipo}] → ${cita.nombre}`);
    const citas = leerCitas();
    const idx   = citas.findIndex(c => c.id === cita.id);
    if (idx !== -1) {
      citas[idx][`recordatorio_${tipo}_enviado`] = true;
      actualizarCitas(citas);
      await agregarFilaSheet(citas[idx], true);
    }
  } catch (e) { console.error("❌ Error recordatorio:", e.message); }
}

function iniciarCronRecordatorios() {
  cron.schedule("*/10 * * * *", async () => {
    const ahora = new Date();
    for (const cita of leerCitas()) {
      if (cita.cancelada) continue;
      const fechaCita = parsearFechaHora(cita.fecha, cita.hora);
      const diff = (fechaCita - ahora) / (1000 * 60 * 60);
      if (!cita.recordatorio_24h_enviado && diff > 0 && diff <= 24 && diff > 23.83)
        await enviarRecordatorio(cita, "24h");
      if (!cita.recordatorio_2h_enviado  && diff > 0 && diff <= 2  && diff > 1.83)
        await enviarRecordatorio(cita, "2h");
    }
  });
  console.log("⏱️  Recordatorios activos (cada 10 min)");

  const cronHora = `${CONFIG.resumenMin} ${CONFIG.resumenHora} * * *`;
  cron.schedule(cronHora, async () => { await enviarResumenDiario(); }, { timezone: CONFIG.zonaHoraria });
  console.log(`📋 Resumen diario a las ${CONFIG.resumenHora}:${String(CONFIG.resumenMin).padStart(2,"0")}`);
}

// ─── RESUMEN DIARIO ───────────────────────────────────────────────────────────
async function enviarResumenDiario() {
  if (!whatsappClient) return;
  const hoy    = new Date();
  const manana = new Date(hoy); manana.setDate(hoy.getDate() + 1);

  const fmt = (d) =>
    `${String(d.getDate()).padStart(2,"0")}/${String(d.getMonth()+1).padStart(2,"0")}/${d.getFullYear()}`;

  const fechaHoy    = fmt(hoy);
  const fechaManana = fmt(manana);
  const todas       = leerCitas();

  const citasHoy    = todas.filter(c => c.fecha === fechaHoy    && !c.cancelada).sort((a,b) => horaAMinutos(a.hora) - horaAMinutos(b.hora));
  const citasManana = todas.filter(c => c.fecha === fechaManana && !c.cancelada).sort((a,b) => horaAMinutos(a.hora) - horaAMinutos(b.hora));
  const cancelHoy   = todas.filter(c => c.fecha === fechaHoy    &&  c.cancelada);

  const ingresos = (lista) => lista.reduce((s,c) => s + parseFloat((c.precio||"0").replace("€","")) || 0, 0);

  let msg = `📊 *Resumen del día – ${CONFIG.nombre}*\n📅 *${fechaHoy}*\n${"─".repeat(28)}\n\n`;

  if (citasHoy.length === 0) {
    msg += `📭 Hoy no hay citas confirmadas.\n`;
  } else {
    msg += `💇 *Citas de hoy (${citasHoy.length}):*\n`;
    citasHoy.forEach((c,i) => {
      msg += `  ${i+1}. *${c.hora}–${calcularHoraFin(c.hora,c.servicio)}* ${c.servicio}\n      👤 ${c.nombre}\n`;
    });
    msg += `\n💰 *Ingresos estimados hoy: ${ingresos(citasHoy)}€*\n`;
  }

  if (cancelHoy.length)
    msg += `\n❌ *Cancelaciones hoy (${cancelHoy.length}):*\n` + cancelHoy.map(c => `  • ${c.hora} – ${c.nombre}`).join("\n") + "\n";

  msg += `\n${"─".repeat(28)}\n`;

  if (citasManana.length === 0) {
    msg += `\n📭 Mañana (${fechaManana}) no hay citas.\n`;
  } else {
    msg += `\n📌 *Citas de mañana (${citasManana.length}):*\n`;
    citasManana.forEach((c,i) => {
      msg += `  ${i+1}. *${c.hora}–${calcularHoraFin(c.hora,c.servicio)}* ${c.servicio}\n      👤 ${c.nombre}\n`;
    });
    msg += `\n💰 *Ingresos estimados mañana: ${ingresos(citasManana)}€*\n`;
  }

  const totalConf = todas.filter(c => !c.cancelada).length;
  const totalCanc = todas.filter(c =>  c.cancelada).length;
  const totalEur  = ingresos(todas.filter(c => !c.cancelada));

  msg += `\n${"─".repeat(28)}\n📈 *Totales acumulados:*\n  ✅ Confirmadas: ${totalConf}\n  ❌ Canceladas: ${totalCanc}\n  💶 Ingresos: ${totalEur}€\n`;
  if (sheetsClient && sheetId)
    msg += `\n📊 _Hoja de citas:_\nhttps://docs.google.com/spreadsheets/d/${sheetId}`;

  try {
    await whatsappClient.sendMessage(`${CONFIG.telefonoDueno}@c.us`, msg);
    console.log("📋 Resumen diario enviado.");
  } catch (e) { console.error("❌ Error resumen:", e.message); }
}

// ─── MENSAJES DEL BOT ─────────────────────────────────────────────────────────
const MENSAJES = {
  bienvenida: (nombre) =>
    `✂️ *¡Hola${nombre ? ", "+nombre : ""}! Bienvenid@ a ${CONFIG.nombre}* ✂️\n\n` +
    `¿Qué deseas hacer?\n\n` +
    `1️⃣ Reservar una cita\n2️⃣ Ver servicios y precios\n3️⃣ Consultar horarios\n` +
    `4️⃣ Cómo llegar\n5️⃣ Cancelar mi cita\n6️⃣ Hablar con un humano\n\n_Escribe el número_ 😊`,

  menuServicios: () => {
    let t = `💇 *Nuestros Servicios* 💇\n\n`;
    CONFIG.servicios.forEach(s => { t += `• *${s.nombre}* — ${s.precio} (${s.duracion} min)\n`; });
    return t + `\nEscribe *1* para volver al menú.`;
  },

  horarios: () =>
    `🕐 *Horario de atención*\n\n` + textoHorarioSemanal() +
    `\n📍 ${CONFIG.direccion}\n📱 Móvil: *${CONFIG.telefonoMovil}*\n☎️  Fijo: *${CONFIG.telefonoFijo}*\n\n` +
    `Escribe *1* para volver al menú.`,

  ubicacion: () =>
    `📍 *¿Cómo llegar?*\n\n*${CONFIG.direccion}*\n\n` +
    `🚇 Metro: Línea 1\n🚌 Bus: Líneas M27, M28, B15, B23, B29, B82\n🚗 Parking a 300m\n\n` +
    `📱 *${CONFIG.telefonoMovil}*\n☎️  *${CONFIG.telefonoFijo}*\n\nEscribe *1* para volver al menú.`,

  seleccionarServicio: () => {
    let t = `✂️ *¿Qué servicio deseas reservar?*\n\n`;
    CONFIG.servicios.forEach(s => { t += `*${s.id}.* ${s.nombre} — ${s.precio}\n`; });
    return t + `\nEscribe el *número* del servicio:`;
  },

  seleccionarFecha: () =>
    `📅 *¿Para qué fecha quieres tu cita?*\n\nFormato: *DD/MM/AAAA*\nEjemplo: _25/06/2026_`,

  seleccionarHora: (horas, fecha) => {
    if (!horarioDelDia(fecha)) {
      const dia = nombreDia(fecha);
      return `🔴 *Lo sentimos, el ${dia.charAt(0).toUpperCase()+dia.slice(1)} estamos cerrados.*\n\n` +
        textoHorarioSemanal() + `\nElige otro día (*DD/MM/AAAA*):`;
    }
    if (!horas.length)
      return `😔 *No hay huecos disponibles ese día.*\n\nElige otra fecha (*DD/MM/AAAA*):`;
    const h = horarioDelDia(fecha);
    let t = `⏰ *¿A qué hora prefieres?*\n_(${h.apertura} – ${h.cierre})_\n\n`;
    horas.forEach((hr,i) => { t += `*${i+1}.* ${hr}\n`; });
    return t + `\nEscribe el *número*:`;
  },

  confirmarNombre: () => `👤 *¿Cuál es tu nombre completo?*`,

  resumenCita: (c) =>
    `✅ *Resumen de tu cita*\n\n💇 *${c.servicio}*\n📅 ${c.fecha}\n⏰ ${c.hora}\n👤 ${c.nombre}\n\n` +
    `📲 Recibirás recordatorios 24h y 2h antes.\n\n*1.* ✅ Confirmar\n*2.* ❌ Cancelar`,

  citaConfirmada: (c, enCalendar) =>
    `🎉 *¡Cita confirmada!*\n\nTe esperamos el *${c.fecha}* a las *${c.hora}*.\n📍 ${CONFIG.direccion}\n` +
    (enCalendar ? `📆 _Añadida a Google Calendar._\n` : ``) +
    `📲 _Recibirás recordatorios automáticos._\n\n¡Hasta pronto! 💖`,

  cancelacion: (c) =>
    `❌ *Cita cancelada*\n\n${c.servicio} del ${c.fecha} a las ${c.hora}.\n\nEscribe *menú* para reservar otra 😊`,

  noCitaEncontrada: () =>
    `🔍 No encontré cita activa con tu número.\n\n📱 *${CONFIG.telefonoMovil}*\n☎️  *${CONFIG.telefonoFijo}*\n\nEscribe *menú* para volver.`,

  derivarHumano: () =>
    `👩 *Te conectamos con el equipo*\n\nEn breve alguien te atenderá.\n\n` +
    `📱 *${CONFIG.telefonoMovil}*\n☎️  *${CONFIG.telefonoFijo}*\n\n` + textoHorarioSemanal(),

  noEntiendo: () => `😅 No he entendido. Escribe *menú* para volver al inicio.`,
};

// ─── ESTADO DE CONVERSACIONES ─────────────────────────────────────────────────
const sesiones = new Map();
function obtenerSesion(tel) {
  if (!sesiones.has(tel)) sesiones.set(tel, { paso:"inicio", cita:{} });
  return sesiones.get(tel);
}
function reiniciarSesion(tel) { sesiones.set(tel, { paso:"inicio", cita:{} }); }

// ─── LÓGICA DEL BOT ───────────────────────────────────────────────────────────
async function procesarMensaje(client, msg) {
  const telefono = msg.from;
  const texto    = msg.body.trim().toLowerCase();
  const sesion   = obtenerSesion(telefono);

  // Comandos globales
  if (["menú","menu","inicio","hola","hi","hello","buenas","buenos días","buenas tardes"].some(w => texto.includes(w))) {
    reiniciarSesion(telefono);
    const contact = await msg.getContact();
    const nombre  = contact.pushname ? contact.pushname.split(" ")[0] : "";
    await client.sendMessage(telefono, MENSAJES.bienvenida(nombre));
    return;
  }

  if (texto === "cancelar" && sesion.paso !== "confirmar_cancelacion") {
    const cita = leerCitas().find(c => c.telefono === telefono && !c.cancelada);
    if (cita) {
      sesion.citaACancelar = cita;
      await client.sendMessage(telefono,
        `❗ *¿Cancelar tu cita?*\n\n💇 ${cita.servicio}\n📅 ${cita.fecha} a las ${cita.hora}\n\n*1.* Sí\n*2.* No`);
      sesion.paso = "confirmar_cancelacion";
    } else {
      await client.sendMessage(telefono, MENSAJES.noCitaEncontrada());
    }
    return;
  }

  switch (sesion.paso) {

    case "inicio": {
      const contact = await msg.getContact();
      const nombre  = contact.pushname ? contact.pushname.split(" ")[0] : "";
      await client.sendMessage(telefono, MENSAJES.bienvenida(nombre));
      sesion.paso = "menu_principal";
      break;
    }

    case "menu_principal": {
      switch (texto) {
        case "1": await client.sendMessage(telefono, MENSAJES.seleccionarServicio()); sesion.paso = "elegir_servicio"; break;
        case "2": await client.sendMessage(telefono, MENSAJES.menuServicios());       sesion.paso = "ver_servicios";   break;
        case "3": await client.sendMessage(telefono, MENSAJES.horarios());            sesion.paso = "ver_horarios";    break;
        case "4": await client.sendMessage(telefono, MENSAJES.ubicacion());           sesion.paso = "ver_ubicacion";   break;
        case "5": {
          const cita = leerCitas().find(c => c.telefono === telefono && !c.cancelada);
          if (cita) {
            sesion.citaACancelar = cita;
            await client.sendMessage(telefono,
              `❗ *¿Cancelar tu cita?*\n\n💇 ${cita.servicio}\n📅 ${cita.fecha} a las ${cita.hora}\n\n*1.* Sí\n*2.* No`);
            sesion.paso = "confirmar_cancelacion";
          } else { await client.sendMessage(telefono, MENSAJES.noCitaEncontrada()); }
          break;
        }
        case "6": await client.sendMessage(telefono, MENSAJES.derivarHumano()); sesion.paso = "humano"; break;
        default:  await client.sendMessage(telefono, MENSAJES.noEntiendo());
      }
      break;
    }

    case "elegir_servicio": {
      const servicio = CONFIG.servicios.find(s => s.id === parseInt(texto));
      if (servicio) {
        sesion.cita.servicio = servicio.nombre;
        sesion.cita.precio   = servicio.precio;
        await client.sendMessage(telefono, MENSAJES.seleccionarFecha());
        sesion.paso = "elegir_fecha";
      } else {
        await client.sendMessage(telefono, `⚠️ Elige un número del 1 al ${CONFIG.servicios.length}.`);
      }
      break;
    }

    case "elegir_fecha": {
      if (!/^\d{2}\/\d{2}\/\d{4}$/.test(msg.body.trim())) {
        await client.sendMessage(telefono, `⚠️ Formato incorrecto. Usa *DD/MM/AAAA* (ej: _25/06/2026_)`);
        break;
      }
      if (parsearFechaHora(msg.body.trim(), "23:59") < new Date()) {
        await client.sendMessage(telefono, `⚠️ Esa fecha ya pasó. Elige una fecha futura.`);
        break;
      }
      sesion.cita.fecha = msg.body.trim();
      const info    = CONFIG.servicios.find(s => s.nombre === sesion.cita.servicio);
      const horas   = calcularHorasDisponibles(sesion.cita.fecha, info ? info.duracion : 60);
      sesion.horasDisponibles = horas;
      await client.sendMessage(telefono, MENSAJES.seleccionarHora(horas, sesion.cita.fecha));
      sesion.paso = horas.length > 0 ? "elegir_hora" : "elegir_fecha";
      break;
    }

    case "elegir_hora": {
      const horas = sesion.horasDisponibles || [];
      const idx   = parseInt(texto) - 1;
      if (idx >= 0 && idx < horas.length) {
        sesion.cita.hora = horas[idx];
        await client.sendMessage(telefono, MENSAJES.confirmarNombre());
        sesion.paso = "ingresar_nombre";
      } else {
        await client.sendMessage(telefono, `⚠️ Elige un número del 1 al ${horas.length}.`);
      }
      break;
    }

    case "ingresar_nombre": {
      if (msg.body.trim().length >= 3) {
        sesion.cita.nombre = msg.body.trim();
        await client.sendMessage(telefono, MENSAJES.resumenCita(sesion.cita));
        sesion.paso = "confirmar_cita";
      } else {
        await client.sendMessage(telefono, `⚠️ Escribe tu nombre completo.`);
      }
      break;
    }

    case "confirmar_cita": {
      if (texto === "1") {
        const cita = {
          id: Date.now().toString(),
          telefono,
          ...sesion.cita,
          fechaReserva: new Date().toISOString(),
          cancelada: false,
          recordatorio_24h_enviado: false,
          recordatorio_2h_enviado:  false,
          calendarEventId: null,
        };
        guardarCita(cita);
        console.log("📅 Nueva cita:", cita.nombre, cita.fecha, cita.hora);

        // Google Calendar
        const eventId = await crearEventoCalendar(cita);
        if (eventId) {
          const citas = leerCitas();
          const i = citas.findIndex(c => c.id === cita.id);
          if (i !== -1) { citas[i].calendarEventId = eventId; actualizarCitas(citas); }
          cita.calendarEventId = eventId;
        }

        // Google Sheets
        await agregarFilaSheet(cita, false);

        await client.sendMessage(telefono, MENSAJES.citaConfirmada(cita, !!eventId));
        reiniciarSesion(telefono);

      } else if (texto === "2") {
        await client.sendMessage(telefono, `❌ Reserva cancelada. Escribe *menú* para volver.`);
        reiniciarSesion(telefono);
      } else {
        await client.sendMessage(telefono, `Responde *1* para confirmar o *2* para cancelar.`);
      }
      break;
    }

    case "confirmar_cancelacion": {
      if (texto === "1") {
        const cita  = sesion.citaACancelar;
        const citas = leerCitas();
        const i     = citas.findIndex(c => c.id === cita.id);
        if (i !== -1) { citas[i].cancelada = true; actualizarCitas(citas); }
        await eliminarEventoCalendar(cita.calendarEventId);
        await agregarFilaSheet({ ...cita, cancelada:true }, true);
        await client.sendMessage(telefono, MENSAJES.cancelacion(cita));
        reiniciarSesion(telefono);
      } else if (texto === "2") {
        await client.sendMessage(telefono, `✅ Tu cita sigue activa. Escribe *menú* si necesitas algo más.`);
        reiniciarSesion(telefono);
      } else {
        await client.sendMessage(telefono, `*1* para cancelar, *2* para mantener.`);
      }
      break;
    }

    case "ver_servicios":
    case "ver_horarios":
    case "ver_ubicacion": {
      if (texto === "1") {
        const contact = await msg.getContact();
        const nombre  = contact.pushname ? contact.pushname.split(" ")[0] : "";
        await client.sendMessage(telefono, MENSAJES.bienvenida(nombre));
        sesion.paso = "menu_principal";
      } else {
        await client.sendMessage(telefono, `Escribe *1* para volver al menú.`);
      }
      break;
    }

    case "humano": break; // humano toma el control

    default:
      reiniciarSesion(telefono);
      await client.sendMessage(telefono, MENSAJES.bienvenida(""));
  }
}

// ─── SERVIDOR HTTP (debe arrancar ANTES que puppeteer para Railway) ───────────
const http = require("http");
let qrImageBase64 = null;
let botConectado  = false;

const PORT = process.env.PORT || 3000;

const servidor = http.createServer((req, res) => {
  // Health check de Railway
  if (req.url === "/healthz") {
    res.writeHead(200); res.end("OK"); return;
  }
  if (botConectado) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<!DOCTYPE html><html><body style="font-family:sans-serif;text-align:center;padding:40px">
      <h2>✅ Bot conectado y funcionando</h2><p>${CONFIG.nombre}</p>
    </body></html>`);
    return;
  }
  if (!qrImageBase64) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<!DOCTYPE html><html><body style="font-family:sans-serif;text-align:center;padding:40px">
      <h2>⏳ Iniciando bot...</h2>
      <p>El bot está arrancando (puede tardar 1-2 min). Recarga en unos segundos.</p>
      <script>setTimeout(()=>location.reload(),5000)</script>
    </body></html>`);
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(`<!DOCTYPE html><html><body style="font-family:sans-serif;text-align:center;padding:40px;background:#f5f5f5">
    <h2>📱 Escanea este QR con WhatsApp</h2>
    <p style="color:#666">WhatsApp → Dispositivos vinculados → Vincular dispositivo</p>
    <img src="${qrImageBase64}" style="width:280px;height:280px;border:8px solid white;border-radius:12px;box-shadow:0 4px 20px rgba(0,0,0,0.15)"/>
    <p style="color:#999;font-size:12px">El QR caduca cada 20 segundos. Si no aparece el nuevo, recarga la página.</p>
    <script>setTimeout(()=>location.reload(),18000)</script>
  </body></html>`);
});

// Arrancar el servidor INMEDIATAMENTE antes que cualquier otra cosa
servidor.listen(PORT, "0.0.0.0", () => {
  console.log(`🌐 Servidor HTTP escuchando en 0.0.0.0:${PORT}`);
  if (process.env.RAILWAY_PUBLIC_DOMAIN)
    console.log(`🌐 URL pública: https://${process.env.RAILWAY_PUBLIC_DOMAIN}`);
});

// ─── INICIALIZACIÓN DEL CLIENTE ───────────────────────────────────────────────
const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--single-process",
    ],
  },
});

// ─── EVENTOS DEL CLIENTE ──────────────────────────────────────────────────────
client.on("qr", async (qr) => {
  console.log("\n📱 QR generado — abre la URL del proyecto en el navegador\n");
  qrcode.generate(qr, { small: true });
  try {
    const QRCode = require("qrcode");
    qrImageBase64 = await QRCode.toDataURL(qr, { width: 300, margin: 2 });
  } catch {
    console.log("ℹ️  'qrcode' no instalado — usa 'npm install qrcode'");
  }
});

client.on("ready", async () => {
  whatsappClient = client;
  botConectado   = true;
  qrImageBase64  = null;
  console.log(`\n✅ Bot de ${CONFIG.nombre} conectado!\n`);
  await inicializarGoogle();
  iniciarCronRecordatorios();
});

client.on("message", async (msg) => {
  if (msg.from.includes("@g.us") || msg.from === "status@broadcast" || msg.fromMe) return;
  try { await procesarMensaje(client, msg); }
  catch (e) { console.error("Error:", e); }
});

client.on("disconnected", (r) => {
  console.log("❌ Bot desconectado:", r);
  botConectado = false;
});

client.initialize();
