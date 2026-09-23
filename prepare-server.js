const fs = require("fs");
const path = require("path");

// The deployed server.js contained two copies of the contact endpoint. The
// second copy redeclared const/functions and made Node fail before startup.
// Keep this migration idempotent so an existing Render deployment can recover
// without requiring a manual edit of the service filesystem.
const serverPath = path.join(__dirname, "server.js");
let source = fs.readFileSync(serverPath, "utf8");

const marker = "// Limitation anti-spam : 5 messages par IP toutes les 15 minutes.";
const first = source.indexOf(marker);
const second = source.indexOf(marker, first + marker.length);
const databaseMarker = "// ============================================================\n// MONGODB — CONNEXION\n// ============================================================";

if (first !== -1 && second !== -1) {
  const databaseStart = source.indexOf(databaseMarker, second);
  if (databaseStart === -1) {
    throw new Error("Impossible de localiser la section MongoDB dans server.js");
  }
  source = source.slice(0, second) + source.slice(databaseStart);
}

// The idempotency query for Stripe must also persist the session id. Without
// it, Stripe retries could create duplicate orders.
const orderMarker = "const orderWithoutSession = {";
const stripeField = "    stripeSessionId,\n";
const orderStart = source.indexOf(orderMarker);
if (orderStart !== -1) {
  const firstField = source.indexOf("\n", orderStart) + 1;
  if (!source.slice(firstField, firstField + 40).includes("stripeSessionId")) {
    source = source.slice(0, firstField) + stripeField + source.slice(firstField);
  }
}

fs.writeFileSync(serverPath, source);
