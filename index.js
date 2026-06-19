const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode    = require("qrcode-terminal");
const { google } = require("googleapis");
const fs   = require("fs");
const path = require("path");
const cron = require("node-cron");
const http = require("http");

// ─── CONFIGURACIÓN ────────────────────────────────────────────────────────────
const CONFIG = {
  nombre:        "Peluquería Sencillamente Bella",
  telefonoMovil: "+34 658074305",
  telefonoFijo:  "+34 93 399 69 51",
  direccion:     "Calle Otger 9, 08917 Badalona",
  zonaHoraria:   "Europe/Madrid",

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
    { id: 1,  nombre: "Corte señora",                 precio: "entre 27 y 39.50€",    duracion: 30  },
    { id: 2,  nombre: "Corte caballero",              precio: "14€",                  duracion: 30  },
    { id: 3,  nombre: "Corte niño",                   precio: "11€",                  duracion: 30  },
    { id: 4,  nombre: "Corte niña",                   precio: "entre 22 y 25€",       duracion: 40  },
    { id: 5,  nombre: "Peinar señora",                precio: "entre 16.50 y 18.50€", duracion: 45  },
    { id: 6,  nombre: "Teñir y peinar señora",        precio: "entre 33 y 47.50€",    duracion: 90,
      fases: [
        { tipo: "activo", duracion: 20 },
        { tipo: "espera", duracion: 40 },
        { tipo: "activo", duracion: 30 },
      ]
    },
    { id: 7,  nombre: "Teñir cortar y peinar señora", precio: "entre 49 y 62.50€",    duracion: 120,
      fases: [
        { tipo: "activo", duracion: 20 },
        { tipo: "espera", duracion: 40 },
        { tipo: "activo", duracion: 60 },
      ]
    },
    { id: 8,  nombre: "Mechas balayage",              precio: "entre 92 y 104€",      duracion: 120,
      fases: [
        { tipo: "activo", duracion: 20 },
        { tipo: "espera", duracion: 40 },
        { tipo: "activo", duracion: 60 },
      ]
    },
    { id: 9,  nombre: "Keratina",                     precio: "entre 90 y 150€",      duracion: 180 },
    { id: 10, nombre: "Alisado moldeado",             precio: "entre 38 y 75€",       duracion: 120 },
  ],

  margenEntreCitas: 0,
  telefonoDueno:    "34658074305",
  resumenHora:      20,
  resumenMin:       0,
};

// ─── SERVIDOR HTTP (arranca primero para healthcheck) ─────────────────────────
const PORT = process.env.PORT || 3000;
let qrImageBase64 = null;
let botConectado  = false;

const servidor = http.createServer((req, res) => {
  if (req.url === "/healthz") { res.writeHead(200); res.end("OK"); return; }
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
      <h2>⏳ Iniciando bot...</h2><p>Recarga en unos segundos.</p>
      <script>setTimeout(()=>location.reload(),5000)</script>
    </body></html>`);
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(`<!DOCTYPE html><html><body style="font-family:sans-serif;text-align:center;padding:40px;background:#f5f5f5">
    <h2>📱 Escanea este QR con WhatsApp</h2>
    <p style="color:#666">WhatsApp → Dispositivos vinculados → Vincular dispositivo</p>
    <img src="${qrImageBase64}" style="width:280px;height:280px;border:8px solid white;border-radius:12px;box-shadow:0 4px 20px rgba(0,0,0,.15)"/>
    <p style="color:#999;font-size:12px">El QR caduca cada 60 segundos. La página se recarga sola.</p>
    <script>setTimeout(()=>location.reload(),55000)</script>
  </body></html>`);
});

servidor.listen(PORT, "0.0.0.0", () => {
  console.log(`🌐 Servidor HTTP en puerto ${PORT}`);
  if (process.env.RAILWAY_PUBLIC_DOMAIN)
    console.log(`🌐 URL: https://${process.env.RAILWAY_PUBLIC_DOMAIN}`);
});

// ─── HELPERS DE HORARIO ───────────────────────────────────────────────────────
const DIAS = ["domingo","lunes","martes","miercoles","jueves","viernes","sabado"];
function nombreDia(f) { const [d,m,y]=f.split("/").map(Number); return DIAS[new Date(y,m-1,d).getDay()]; }
function horarioDelDia(f) { return CONFIG.horarioDias[nombreDia(f)] || null; }
function textoHorario() {
  const e={lunes:"Lunes",martes:"Martes",miercoles:"Miércoles",jueves:"Jueves",viernes:"Viernes",sabado:"Sábado",domingo:"Domingo"};
  let t="";
  for(const [d,h] of Object.entries(CONFIG.horarioDias))
    t += h ? `📅 ${e[d]}: ${h.apertura} – ${h.cierre}\n` : `🔴 ${e[d]}: Cerrado\n`;
  return t;
}

// ─── ARCHIVOS DE DATOS ────────────────────────────────────────────────────────
const DATA_DIR      = process.env.DATA_DIR || __dirname;
const AUTH_DIR      = process.env.AUTH_DIR || path.join(__dirname, "auth_info");
const CITAS_FILE    = path.join(DATA_DIR, "citas.json");
const SHEET_ID_FILE = path.join(DATA_DIR, "sheet_id.txt");

function leerCitas() {
  try { return fs.existsSync(CITAS_FILE) ? JSON.parse(fs.readFileSync(CITAS_FILE,"utf8")) : []; }
  catch { return []; }
}
function guardarCita(c) { const a=leerCitas(); a.push(c); fs.writeFileSync(CITAS_FILE,JSON.stringify(a,null,2)); }
function actualizarCitas(c) { fs.writeFileSync(CITAS_FILE,JSON.stringify(c,null,2)); }

// ─── MOTOR DE DISPONIBILIDAD ──────────────────────────────────────────────────
function horaAMin(h) { const [hh,mm]=h.split(":").map(Number); return hh*60+mm; }
function minAHora(m) { return `${Math.floor(m/60).toString().padStart(2,"0")}:${(m%60).toString().padStart(2,"0")}`; }

function bloquesCita(horaIni, servicio) {
  const info = CONFIG.servicios.find(s=>s.nombre===servicio);
  if (!info) return [{inicio:horaIni, fin:horaIni+60}];
  if (!info.fases) return [{inicio:horaIni, fin:horaIni+info.duracion}];
  const bl=[]; let cur=horaIni, act=null;
  for(const f of info.fases){
    if(f.tipo==="activo"){ if(!act) act={inicio:cur,fin:cur+f.duracion}; else act.fin=cur+f.duracion; }
    else { if(act){bl.push({...act});act=null;} }
    cur+=f.duracion;
  }
  if(act) bl.push(act);
  return bl;
}

function solapa(tIni, dur, citas) {
  const tFin=tIni+dur;
  for(const c of citas)
    for(const b of bloquesCita(horaAMin(c.hora),c.servicio))
      if(tIni<b.fin && tFin+CONFIG.margenEntreCitas>b.inicio) return true;
  return false;
}

function horasDisponibles(fecha, durMin) {
  const h=horarioDelDia(fecha); if(!h) return [];
  const citas=leerCitas().filter(c=>c.fecha===fecha&&!c.cancelada);
  const ap=horaAMin(h.apertura), ci=horaAMin(h.cierre), lib=[];
  for(let t=ap; t+durMin<=ci; t+=15) if(!solapa(t,durMin,citas)) lib.push(minAHora(t));
  return lib;
}

function horaFin(hora, servicio) {
  const info=CONFIG.servicios.find(s=>s.nombre===servicio);
  return minAHora(horaAMin(hora)+(info?info.duracion:60));
}

// ─── GOOGLE ───────────────────────────────────────────────────────────────────
const SCOPES=[
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/drive.file",
];
const TOKEN_PATH       = path.join(DATA_DIR,"token.json");
const CREDENTIALS_PATH = path.join(DATA_DIR,"credentials.json");
let calCli=null, shCli=null, sheetId=null;

async function inicializarGoogle() {
  try {
    if(process.env.GOOGLE_CREDENTIALS&&!fs.existsSync(CREDENTIALS_PATH))
      fs.writeFileSync(CREDENTIALS_PATH,process.env.GOOGLE_CREDENTIALS);
    if(process.env.GOOGLE_TOKEN&&!fs.existsSync(TOKEN_PATH))
      fs.writeFileSync(TOKEN_PATH,process.env.GOOGLE_TOKEN);
    if(!fs.existsSync(CREDENTIALS_PATH)){console.log("⚠️  Sin credentials.json");return;}
    if(!fs.existsSync(TOKEN_PATH)){console.log("⚠️  Sin token.json");return;}
    const creds=JSON.parse(fs.readFileSync(CREDENTIALS_PATH,"utf8"));
    const {client_secret,client_id,redirect_uris}=creds.installed||creds.web;
    const auth=new google.auth.OAuth2(client_id,client_secret,redirect_uris[0]);
    auth.setCredentials(JSON.parse(fs.readFileSync(TOKEN_PATH,"utf8")));
    calCli=google.calendar({version:"v3",auth});
    shCli =google.sheets({version:"v4",auth});
    console.log("✅ Google Calendar y Sheets conectados.");
    await inicializarSheet();
  } catch(e){console.error("❌ Error Google:",e.message);}
}

async function inicializarSheet() {
  try {
    if(fs.existsSync(SHEET_ID_FILE)){
      sheetId=fs.readFileSync(SHEET_ID_FILE,"utf8").trim();
      console.log(`📊 Sheets: https://docs.google.com/spreadsheets/d/${sheetId}`);
      await fmtCabecera(); return;
    }
    const r=await shCli.spreadsheets.create({resource:{
      properties:{title:`📅 Citas – ${CONFIG.nombre}`},
      sheets:[{properties:{title:"Citas",sheetId:0}},{properties:{title:"Resumen",sheetId:1}}],
    }});
    sheetId=r.data.spreadsheetId;
    fs.writeFileSync(SHEET_ID_FILE,sheetId);
    console.log(`📊 Hoja creada: https://docs.google.com/spreadsheets/d/${sheetId}`);
    await fmtCabecera(); await fmtResumen();
    for(const c of leerCitas()) await addFila(c,false);
  } catch(e){console.error("❌ Error Sheet:",e.message);}
}

async function fmtCabecera() {
  if(!shCli||!sheetId) return;
  try {
    await shCli.spreadsheets.values.update({spreadsheetId:sheetId,range:"Citas!A1:M1",valueInputOption:"RAW",
      resource:{values:[["ID","Nombre","Teléfono","Servicio","Precio","Fecha","Hora","Fin","Duración","Estado","Reservado","R.24h","R.2h"]]}});
    await shCli.spreadsheets.batchUpdate({spreadsheetId:sheetId,resource:{requests:[
      {repeatCell:{range:{sheetId:0,startRowIndex:0,endRowIndex:1,startColumnIndex:0,endColumnIndex:13},
        cell:{userEnteredFormat:{backgroundColor:{red:.18,green:.18,blue:.18},
          textFormat:{foregroundColor:{red:1,green:1,blue:1},bold:true},horizontalAlignment:"CENTER"}},
        fields:"userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)"}},
      {updateSheetProperties:{properties:{sheetId:0,gridProperties:{frozenRowCount:1}},fields:"gridProperties.frozenRowCount"}},
      {autoResizeDimensions:{dimensions:{sheetId:0,dimension:"COLUMNS",startIndex:0,endIndex:13}}},
    ]}});
  } catch(e){console.error("❌ Cabecera:",e.message);}
}

async function fmtResumen() {
  if(!shCli||!sheetId) return;
  try {
    await shCli.spreadsheets.values.batchUpdate({spreadsheetId:sheetId,resource:{valueInputOption:"USER_ENTERED",data:[
      {range:"Resumen!A1",values:[["📊 RESUMEN DE CITAS"]]},
      {range:"Resumen!A3",values:[["Total confirmadas"]]},  {range:"Resumen!B3",values:[['=COUNTIF(Citas!J:J,"✅ Confirmada")']]},
      {range:"Resumen!A4",values:[["Total canceladas"]]},   {range:"Resumen!B4",values:[['=COUNTIF(Citas!J:J,"❌ Cancelada")']]},
      {range:"Resumen!A5",values:[["Ingresos est. (€)"]]},  {range:"Resumen!B5",values:[['=SUMPRODUCT((Citas!J2:J9999="✅ Confirmada")*IFERROR(VALUE(SUBSTITUTE(Citas!E2:E9999,"€","")),0))']]},
      {range:"Resumen!A7",values:[["Servicio top"]]},       {range:"Resumen!B7",values:[['=INDEX(Citas!D2:D9999,MATCH(MAX(COUNTIF(Citas!D2:D9999,Citas!D2:D9999)),COUNTIF(Citas!D2:D9999,Citas!D2:D9999),0))']]},
      {range:"Resumen!A9",values:[["Citas hoy"]]},          {range:"Resumen!B9",values:[['=COUNTIF(Citas!F:F,TEXT(TODAY(),"DD/MM/YYYY"))']]},
      {range:"Resumen!A10",values:[["Citas esta semana"]]}, {range:"Resumen!B10",values:[['=COUNTIFS(Citas!J:J,"✅ Confirmada",Citas!F:F,">="&TEXT(TODAY()-WEEKDAY(TODAY(),2)+1,"DD/MM/YYYY"),Citas!F:F,"<="&TEXT(TODAY()-WEEKDAY(TODAY(),2)+7,"DD/MM/YYYY"))']]},
    ]}});
  } catch(e){console.error("❌ Resumen:",e.message);}
}

async function addFila(cita, buscar=true) {
  if(!shCli||!sheetId) return;
  try {
    const info=CONFIG.servicios.find(s=>s.nombre===cita.servicio);
    const tel=cita.telefono.replace("@c.us","").replace(/^34/,"+34 ");
    const fila=[cita.id,cita.nombre,tel,cita.servicio,cita.precio,cita.fecha,cita.hora,
      horaFin(cita.hora,cita.servicio),info?info.duracion:"—",
      cita.cancelada?"❌ Cancelada":"✅ Confirmada",
      new Date(cita.fechaReserva).toLocaleString("es-ES"),
      cita.recordatorio_24h_enviado?"✅":"⏳",cita.recordatorio_2h_enviado?"✅":"⏳"];
    if(buscar){
      const rows=await shCli.spreadsheets.values.get({spreadsheetId:sheetId,range:"Citas!A:A"});
      const idx=(rows.data.values||[]).flat().indexOf(cita.id);
      if(idx>0){
        await shCli.spreadsheets.values.update({spreadsheetId:sheetId,range:`Citas!A${idx+1}:M${idx+1}`,valueInputOption:"RAW",resource:{values:[fila]}});
        await colorFila(idx,cita.cancelada); return;
      }
    }
    const resp=await shCli.spreadsheets.values.append({spreadsheetId:sheetId,range:"Citas!A:M",valueInputOption:"RAW",insertDataOption:"INSERT_ROWS",resource:{values:[fila]}});
    const m=(resp.data.updates.updatedRange||"").match(/(\d+):/);
    if(m) await colorFila(parseInt(m[1])-1,cita.cancelada);
  } catch(e){console.error("❌ Sheets:",e.message);}
}

async function colorFila(idx,cancelada) {
  if(!shCli||!sheetId) return;
  try {
    const color=cancelada?{red:.98,green:.73,blue:.73}:{red:.85,green:.96,blue:.85};
    await shCli.spreadsheets.batchUpdate({spreadsheetId:sheetId,resource:{requests:[{repeatCell:{
      range:{sheetId:0,startRowIndex:idx,endRowIndex:idx+1,startColumnIndex:0,endColumnIndex:13},
      cell:{userEnteredFormat:{backgroundColor:color}},fields:"userEnteredFormat.backgroundColor"}}]}});
  } catch{}
}

// ─── CALENDAR ─────────────────────────────────────────────────────────────────
async function crearEvento(cita) {
  if(!calCli) return null;
  try {
    const info=CONFIG.servicios.find(s=>s.nombre===cita.servicio);
    const dur=info?info.duracion:60;
    const [d,m,y]=cita.fecha.split("/");
    const [hh,mm]=cita.hora.split(":");
    const finMin=parseInt(hh)*60+parseInt(mm)+dur;
    const fh=Math.floor(finMin/60).toString().padStart(2,"0");
    const fm=(finMin%60).toString().padStart(2,"0");
    const r=await calCli.events.insert({calendarId:"primary",resource:{
      summary:`💇 ${cita.servicio} – ${cita.nombre}`,
      description:`Cliente: ${cita.nombre}\nServicio: ${cita.servicio} (${cita.precio})\nDuración: ${dur} min`,
      location:CONFIG.direccion,
      start:{dateTime:`${y}-${m}-${d}T${hh}:${mm}:00`,timeZone:CONFIG.zonaHoraria},
      end:{  dateTime:`${y}-${m}-${d}T${fh}:${fm}:00`,timeZone:CONFIG.zonaHoraria},
      reminders:{useDefault:false,overrides:[{method:"email",minutes:24*60},{method:"popup",minutes:60}]},
      colorId:"3",
    }});
    return r.data.id;
  } catch(e){console.error("❌ Calendar:",e.message);return null;}
}

async function eliminarEvento(eventId) {
  if(!calCli||!eventId) return;
  try{await calCli.events.delete({calendarId:"primary",eventId});}catch{}
}

// ─── RECORDATORIOS ────────────────────────────────────────────────────────────
let waClient=null;

function parsearFH(fecha,hora){const[d,m,y]=fecha.split("/");return new Date(`${y}-${m}-${d}T${hora}:00`);}

async function enviarRecordatorio(cita,tipo) {
  if(!waClient) return;
  const n=cita.nombre.split(" ")[0];
  const msg=tipo==="24h"
    ?`⏰ *Recordatorio – ${CONFIG.nombre}*\n\nHola *${n}* 👋\n\nMañana tienes cita:\n💇 *${cita.servicio}*\n📅 ${cita.fecha} a las *${cita.hora}*\n📍 ${CONFIG.direccion}`
    :`🔔 *¡Tu cita es hoy!*\n\nHola *${n}* 😊\nTe esperamos en 2 horas:\n💇 *${cita.servicio}*\n⏰ *${cita.hora}*\n📍 ${CONFIG.direccion}`;
  try {
    await waClient.sendMessage(cita.telefono,msg);
    const citas=leerCitas(); const i=citas.findIndex(c=>c.id===cita.id);
    if(i!==-1){citas[i][`recordatorio_${tipo}_enviado`]=true;actualizarCitas(citas);await addFila(citas[i],true);}
  } catch(e){console.error("❌ Recordatorio:",e.message);}
}

function iniciarCron() {
  cron.schedule("*/10 * * * *",async()=>{
    const ahora=new Date();
    for(const c of leerCitas()){
      if(c.cancelada) continue;
      const diff=(parsearFH(c.fecha,c.hora)-ahora)/(1000*60*60);
      if(!c.recordatorio_24h_enviado&&diff>0&&diff<=24&&diff>23.83) await enviarRecordatorio(c,"24h");
      if(!c.recordatorio_2h_enviado &&diff>0&&diff<=2 &&diff>1.83)  await enviarRecordatorio(c,"2h");
    }
  });
  cron.schedule(`${CONFIG.resumenMin} ${CONFIG.resumenHora} * * *`,()=>resumenDiario(),{timezone:CONFIG.zonaHoraria});
  console.log("⏱️  Recordatorios activos");
}

async function resumenDiario() {
  if(!waClient) return;
  const hoy=new Date(), man=new Date(hoy); man.setDate(hoy.getDate()+1);
  const fmt=d=>`${String(d.getDate()).padStart(2,"0")}/${String(d.getMonth()+1).padStart(2,"0")}/${d.getFullYear()}`;
  const fh=fmt(hoy),fm=fmt(man),todas=leerCitas();
  const ch=todas.filter(c=>c.fecha===fh&&!c.cancelada).sort((a,b)=>horaAMin(a.hora)-horaAMin(b.hora));
  const cm=todas.filter(c=>c.fecha===fm&&!c.cancelada).sort((a,b)=>horaAMin(a.hora)-horaAMin(b.hora));
  const canH=todas.filter(c=>c.fecha===fh&&c.cancelada);
  const ing=l=>l.reduce((s,c)=>s+(parseFloat((c.precio||"0").replace(/[^0-9.]/g,""))||0),0);
  let msg=`📊 *Resumen – ${CONFIG.nombre}*\n📅 *${fh}*\n${"─".repeat(26)}\n\n`;
  if(!ch.length) msg+=`📭 Hoy no hay citas.\n`;
  else { msg+=`💇 *Hoy (${ch.length}):*\n`; ch.forEach((c,i)=>{msg+=`  ${i+1}. *${c.hora}–${horaFin(c.hora,c.servicio)}* ${c.servicio}\n      👤 ${c.nombre}\n`;}); msg+=`\n💰 *${ing(ch)}€ estimados*\n`; }
  if(canH.length) msg+=`\n❌ Cancelaciones: ${canH.map(c=>c.nombre).join(", ")}\n`;
  msg+=`\n${"─".repeat(26)}\n`;
  if(!cm.length) msg+=`\n📭 Mañana no hay citas.\n`;
  else { msg+=`\n📌 *Mañana (${cm.length}):*\n`; cm.forEach((c,i)=>{msg+=`  ${i+1}. *${c.hora}–${horaFin(c.hora,c.servicio)}* ${c.servicio}\n      👤 ${c.nombre}\n`;}); msg+=`\n💰 *${ing(cm)}€ estimados*\n`; }
  const conf=todas.filter(c=>!c.cancelada); const canc=todas.filter(c=>c.cancelada);
  msg+=`\n${"─".repeat(26)}\n📈 Confirmadas: ${conf.length} | Canceladas: ${canc.length} | Total: ${ing(conf)}€`;
  if(sheetId) msg+=`\n📊 https://docs.google.com/spreadsheets/d/${sheetId}`;
  try{await waClient.sendMessage(`${CONFIG.telefonoDueno}@c.us`,msg);}catch(e){console.error("❌ Resumen:",e.message);}
}

// ─── MENSAJES ─────────────────────────────────────────────────────────────────
const M={
  bienvenida:(n)=>`✂️ *¡Hola${n?", "+n:""}! Bienvenid@ a ${CONFIG.nombre}* ✂️\n\n¿Qué deseas hacer?\n\n1️⃣ Reservar una cita\n2️⃣ Ver servicios y precios\n3️⃣ Consultar horarios\n4️⃣ Cómo llegar\n5️⃣ Cancelar mi cita\n6️⃣ Hablar con un humano\n\n_Escribe el número_ 😊`,
  servicios:()=>{let t=`💇 *Nuestros Servicios* 💇\n\n`;CONFIG.servicios.forEach(s=>{t+=`• *${s.nombre}* — ${s.precio} (${s.duracion} min)\n`;});return t+`\nEscribe *1* para volver.`;},
  horarios:()=>`🕐 *Horario*\n\n`+textoHorario()+`\n📍 ${CONFIG.direccion}\n📱 *${CONFIG.telefonoMovil}*\n☎️  *${CONFIG.telefonoFijo}*\n\nEscribe *1* para volver.`,
  ubicacion:()=>`📍 *${CONFIG.direccion}*\n\n📱 *${CONFIG.telefonoMovil}*\n☎️  *${CONFIG.telefonoFijo}*\n\nEscribe *1* para volver.`,
  selServicio:()=>{let t=`✂️ *¿Qué servicio deseas?*\n\n`;CONFIG.servicios.forEach(s=>{t+=`*${s.id}.* ${s.nombre} — ${s.precio}\n`;});return t+`\nEscribe el *número*:`;},
  selFecha:()=>`📅 *¿Para qué fecha?*\n\nFormato: *DD/MM/AAAA*`,
  selHora:(hs,f)=>{
    if(!horarioDelDia(f)){const d=nombreDia(f);return `🔴 *El ${d.charAt(0).toUpperCase()+d.slice(1)} estamos cerrados.*\n\n`+textoHorario()+`\nElige otro día (*DD/MM/AAAA*):`;}
    if(!hs.length) return `😔 *No hay huecos ese día.*\n\nElige otra fecha (*DD/MM/AAAA*):`;
    const h=horarioDelDia(f); let t=`⏰ *¿A qué hora?*\n_(${h.apertura} – ${h.cierre})_\n\n`;
    hs.forEach((hr,i)=>{t+=`*${i+1}.* ${hr}\n`;});return t+`\nEscribe el *número*:`;
  },
  nombre:()=>`👤 *¿Cuál es tu nombre completo?*`,
  resumen:(c)=>`✅ *Resumen de tu cita*\n\n💇 *${c.servicio}*\n📅 ${c.fecha}\n⏰ ${c.hora}\n👤 ${c.nombre}\n\n📲 Recibirás recordatorios 24h y 2h antes.\n\n*1.* ✅ Confirmar\n*2.* ❌ Cancelar`,
  confirmada:(c,cal)=>`🎉 *¡Cita confirmada!*\n\nTe esperamos el *${c.fecha}* a las *${c.hora}*.\n📍 ${CONFIG.direccion}\n`+(cal?`📆 _Añadida a Google Calendar._\n`:``)+`📲 _Recibirás recordatorios._\n\n¡Hasta pronto! 💖`,
  cancelada:(c)=>`❌ *Cita cancelada*\n\n${c.servicio} del ${c.fecha} a las ${c.hora}.\n\nEscribe *menú* para reservar otra 😊`,
  noCita:()=>`🔍 No encontré cita activa.\n📱 *${CONFIG.telefonoMovil}*\n☎️  *${CONFIG.telefonoFijo}*`,
  humano:()=>`👩 *Te conectamos con el equipo*\n\n📱 *${CONFIG.telefonoMovil}*\n☎️  *${CONFIG.telefonoFijo}*\n\n`+textoHorario(),
  noEntiendo:()=>`😅 No entendí. Escribe *menú* para volver.`,
};

// ─── SESIONES ─────────────────────────────────────────────────────────────────
const sesiones=new Map();
function getSesion(id){if(!sesiones.has(id))sesiones.set(id,{paso:"inicio",cita:{}});return sesiones.get(id);}
function resetSesion(id){sesiones.set(id,{paso:"inicio",cita:{}});}

// ─── LÓGICA ───────────────────────────────────────────────────────────────────
async function procesar(client,msg) {
  const tel=msg.from, raw=msg.body.trim(), txt=raw.toLowerCase(), s=getSesion(tel);
  const send=m=>client.sendMessage(tel,m);

  if(["menú","menu","inicio","hola","hi","hello","buenas"].some(w=>txt.includes(w))){
    resetSesion(tel); const c=await msg.getContact();
    await send(M.bienvenida(c.pushname?c.pushname.split(" ")[0]:"")); return;
  }

  if(txt==="cancelar"&&s.paso!=="conf_cancel"){
    const cita=leerCitas().find(c=>c.telefono===tel&&!c.cancelada);
    if(cita){s.citaACancelar=cita;await send(`❗ *¿Cancelar?*\n\n💇 ${cita.servicio}\n📅 ${cita.fecha} a las ${cita.hora}\n\n*1.* Sí\n*2.* No`);s.paso="conf_cancel";}
    else await send(M.noCita()); return;
  }

  switch(s.paso){
    case "inicio":{const c=await msg.getContact();await send(M.bienvenida(c.pushname?c.pushname.split(" ")[0]:""));s.paso="menu";break;}
    case "menu":
      switch(txt){
        case "1":await send(M.selServicio());s.paso="srv";break;
        case "2":await send(M.servicios());s.paso="inf";break;
        case "3":await send(M.horarios());s.paso="inf";break;
        case "4":await send(M.ubicacion());s.paso="inf";break;
        case "5":{const cita=leerCitas().find(c=>c.telefono===tel&&!c.cancelada);if(cita){s.citaACancelar=cita;await send(`❗ *¿Cancelar?*\n\n💇 ${cita.servicio}\n📅 ${cita.fecha} a las ${cita.hora}\n\n*1.* Sí\n*2.* No`);s.paso="conf_cancel";}else await send(M.noCita());break;}
        case "6":await send(M.humano());s.paso="humano";break;
        default:await send(M.noEntiendo());
      }break;
    case "srv":{const srv=CONFIG.servicios.find(sv=>sv.id===parseInt(txt));if(srv){s.cita.servicio=srv.nombre;s.cita.precio=srv.precio;await send(M.selFecha());s.paso="fecha";}else await send(`⚠️ Elige del 1 al ${CONFIG.servicios.length}.`);break;}
    case "fecha":{
      if(!/^\d{2}\/\d{2}\/\d{4}$/.test(raw.trim())){await send(`⚠️ Formato *DD/MM/AAAA*`);break;}
      if(parsearFH(raw.trim(),"23:59")<new Date()){await send(`⚠️ Fecha pasada.`);break;}
      s.cita.fecha=raw.trim();
      const info=CONFIG.servicios.find(sv=>sv.nombre===s.cita.servicio);
      const hs=horasDisponibles(s.cita.fecha,info?info.duracion:60);
      s.hs=hs; await send(M.selHora(hs,s.cita.fecha));
      s.paso=hs.length>0?"hora":"fecha";break;
    }
    case "hora":{const hs=s.hs||[];const i=parseInt(txt)-1;if(i>=0&&i<hs.length){s.cita.hora=hs[i];await send(M.nombre());s.paso="nombre";}else await send(`⚠️ Elige del 1 al ${hs.length}.`);break;}
    case "nombre":{if(raw.trim().length>=3){s.cita.nombre=raw.trim();await send(M.resumen(s.cita));s.paso="conf";}else await send(`⚠️ Escribe tu nombre completo.`);break;}
    case "conf":
      if(txt==="1"){
        const cita={id:Date.now().toString(),telefono:tel,...s.cita,fechaReserva:new Date().toISOString(),cancelada:false,recordatorio_24h_enviado:false,recordatorio_2h_enviado:false,calendarEventId:null};
        guardarCita(cita);
        const eid=await crearEvento(cita);
        if(eid){const cs=leerCitas();const i=cs.findIndex(c=>c.id===cita.id);if(i!==-1){cs[i].calendarEventId=eid;actualizarCitas(cs);}cita.calendarEventId=eid;}
        await addFila(cita,false);
        await send(M.confirmada(cita,!!eid));
        resetSesion(tel);
      }else if(txt==="2"){await send(`❌ Cancelada. Escribe *menú* para volver.`);resetSesion(tel);}
      else await send(`*1* confirmar, *2* cancelar.`);break;
    case "conf_cancel":
      if(txt==="1"){
        const cita=s.citaACancelar;const cs=leerCitas();const i=cs.findIndex(c=>c.id===cita.id);
        if(i!==-1){cs[i].cancelada=true;actualizarCitas(cs);}
        await eliminarEvento(cita.calendarEventId);
        await addFila({...cita,cancelada:true},true);
        await send(M.cancelada(cita));resetSesion(tel);
      }else if(txt==="2"){await send(`✅ Cita activa. Escribe *menú* si necesitas algo.`);resetSesion(tel);}
      else await send(`*1* cancelar, *2* mantener.`);break;
    case "inf":if(txt==="1"){const c=await msg.getContact();await send(M.bienvenida(c.pushname?c.pushname.split(" ")[0]:""));s.paso="menu";}else await send(`Escribe *1* para volver.`);break;
    case "humano":break;
    default:resetSesion(tel);await send(M.bienvenida(""));
  }
}

// ─── WHATSAPP CLIENT ──────────────────────────────────────────────────────────
const client = new Client({
  authStrategy: new LocalAuth({ dataPath: AUTH_DIR }),
  puppeteer: {
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/chromium",
    args: ["--no-sandbox","--disable-setuid-sandbox","--disable-dev-shm-usage","--disable-gpu","--single-process"],
  },
});

client.on("qr", async (qr) => {
  console.log("📱 QR generado");
  qrcode.generate(qr,{small:true});
  try { const QRCode=require("qrcode"); qrImageBase64=await QRCode.toDataURL(qr,{width:300,margin:2}); }
  catch(e){ console.log("Sin qrcode:",e.message); }
});

client.on("ready", async () => {
  waClient=client; botConectado=true; qrImageBase64=null;
  console.log(`✅ Bot de ${CONFIG.nombre} conectado!`);
  await inicializarGoogle();
  iniciarCron();
});

client.on("message", async (msg) => {
  if(msg.from.includes("@g.us")||msg.from==="status@broadcast"||msg.fromMe) return;
  try{await procesar(client,msg);}catch(e){console.error("Error:",e);}
});

client.on("disconnected",(r)=>{console.log("❌ Desconectado:",r);botConectado=false;});

client.initialize();
