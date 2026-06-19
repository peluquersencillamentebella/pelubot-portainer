/**
 * Ejecuta este script UNA SOLA VEZ para autorizar Google Calendar + Sheets.
 * Uso: node autorizarGoogle.js "4/0AdkVLPxIaGQ7cJpBk8_f7cHvrnree7vtfbF3w_thJS2wRnKBeph9rwRmGvhpvdonafE_vA"
 */
const { google } = require("googleapis");
const fs = require("fs");
const path = require("path");

const SCOPES = [
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/drive.file",
];
const TOKEN_PATH       = path.join(__dirname, "token.json");
const CREDENTIALS_PATH = path.join(__dirname, "credentials.json");

async function main() {
  const codigo = process.argv[2];
  if (!codigo) {
    console.error("❌ Debes pasar el código como argumento.");
    console.error('   Uso: node autorizarGoogle.js "4/0AX4XfWh..."');
    process.exit(1);
  }
  if (!fs.existsSync(CREDENTIALS_PATH)) {
    console.error("❌ No se encontró credentials.json.");
    process.exit(1);
  }
  const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, "utf8"));
  const { client_secret, client_id, redirect_uris } = credentials.installed || credentials.web;
  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
  try {
    const { tokens } = await oAuth2Client.getToken(codigo);
    oAuth2Client.setCredentials(tokens);
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
    console.log("\n✅ Google Calendar + Sheets autorizados correctamente!");
    console.log("   Token guardado en token.json.");
    console.log("   Ahora inicia el bot con: npm start\n");
  } catch (err) {
    console.error("❌ Error al obtener el token:", err.message);
    console.error("   El código puede haber expirado. Vuelve a ejecutar npm start para obtener uno nuevo.");
  }
}
main();
