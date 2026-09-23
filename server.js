require("dotenv").config();

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const { MongoClient } = require("mongodb");
const nodemailer = require("nodemailer");

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

const stripe = STRIPE_SECRET_KEY ? require("stripe")(STRIPE_SECRET_KEY) : null;

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);

const PORT = process.env.PORT || 3000;

const ALLOWED_ORIGINS = (
  process.env.ALLOWED_ORIGINS ||
  "https://market-place-shop.pages.dev,https://samft957-bot.github.io"
)
  .split(",")
  .map((s) => s.trim().replace(/\/+$/, ""))
  .filter(Boolean);

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const TOKEN_DURATION = 30 * 24 * 60 * 60 * 1000;

const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;
const CONTACT_EMAIL = process.env.CONTACT_EMAIL || "samft957@gmail.com";

if (!ADMIN_PASSWORD) {
  console.error(
    "ATTENTION : ADMIN_PASSWORD n'est pas défini. Le mode vendeur est désactivé tant que cette variable n'est pas ajoutée sur Render."
  );
}
if (!STRIPE_SECRET_KEY) {
  console.error(
    "ATTENTION : STRIPE_SECRET_KEY n'est pas défini. Les paiements sont désactivés."
  );
}
if (!STRIPE_WEBHOOK_SECRET) {
  console.error(
    "ATTENTION : STRIPE_WEBHOOK_SECRET n'est pas défini. Les commandes ne seront pas enregistrées tant que le webhook Stripe n'est pas configuré."
  );
}
if (!GMAIL_USER || !GMAIL_APP_PASSWORD) {
  console.error(
    "ATTENTION : GMAIL_USER / GMAIL_APP_PASSWORD ne sont pas définis. Le formulaire de contact ne pourra pas envoyer d'email tant que ces variables ne sont pas ajoutées sur Render."
  );
}

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || ALLOWED_ORIGINS.includes(origin)) {
        return callback(null, true);
      }
      return callback(null, false);
    },
  })
);

// ============================================================
// WEBHOOK STRIPE
// ============================================================
// IMPORTANT : déclarée AVANT express.json() pour vérifier la
// signature sur le corps brut.

app.post(
  "/stripe-webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    if (!stripe || !STRIPE_WEBHOOK_SECRET) {
      return res.status(500).send("Webhook Stripe non configuré.");
    }

    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        req.headers["stripe-signature"],
        STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error("Signature du webhook Stripe invalide :", err.message);
      return res.status(400).send("Signature invalide.");
    }

    const handled = [
      "checkout.session.completed",
      "checkout.session.async_payment_succeeded",
    ];

    if (handled.includes(event.type)) {
      if (!db) {
        return res.status(503).send("Base de données indisponible.");
      }

      try {
        await createOrderFromStripeSession(event.data.object.id);
      } catch (err) {
        console.error("Erreur création commande depuis le webhook :", err);
        return res.status(500).send("Erreur serveur.");
      }
    }

    res.json({ received: true });
  }
);

app.use(express.json({ limit: "10mb" }));

// ============================================================
// EMAIL — GMAIL
// ============================================================

const mailTransporter =
  GMAIL_USER && GMAIL_APP_PASSWORD
    ? nodemailer.createTransport({
        service: "gmail",
        auth: {
          user: GMAIL_USER,
          pass: GMAIL_APP_PASSWORD.replace(/\s/g, ""),
        },
      })
    : null;

if (mailTransporter) {
  mailTransporter.verify((error) => {
    if (error) {
      console.error("ERREUR GMAIL :", error.message);
    } else {
      console.log("GMAIL EST PRÊT !");
    }
  });
} else {
  console.error(
    "GMAIL NON CONFIGURÉ : GMAIL_USER ou GMAIL_APP_PASSWORD manque sur Render."
  );
}

const CONTACT_MAX_MESSAGES = 5;
const CONTACT_WINDOW = 15 * 60 * 1000;
const contactAttempts = new Map();

function isContactBlocked(ip) {
  const entry = contactAttempts.get(ip);

  if (!entry) return false;

  if (Date.now() > entry.resetAt) {
    contactAttempts.delete(ip);
    return false;
  }

  return entry.count >= CONTACT_MAX_MESSAGES;
}

function registerContactAttempt(ip) {
  const now = Date.now();
  const entry = contactAttempts.get(ip);

  if (!entry || now > entry.resetAt) {
    contactAttempts.set(ip, {
      count: 1,
      resetAt: now + CONTACT_WINDOW,
    });
  } else {
    entry.count += 1;
  }
}

function isValidEmail(email) {
  return (
    typeof email === "string" &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  );
}

app.post("/contact", async (req, res) => {
  try {
    if (!mailTransporter) {
      return res.status(500).json({
        error:
          "Email non configuré. Vérifie GMAIL_USER et GMAIL_APP_PASSWORD sur Render.",
      });
    }

    const ip = req.ip || "inconnue";

    if (isContactBlocked(ip)) {
      return res.status(429).json({
        error: "Trop de messages envoyés. Réessayez dans quelques minutes.",
      });
    }

    const { name, email, message } = req.body || {};

    const cleanName =
      typeof name === "string" ? name.trim().slice(0, 200) : "";

    const cleanEmail =
      typeof email === "string" ? email.trim().slice(0, 200) : "";

    const cleanMessage =
      typeof message === "string" ? message.trim().slice(0, 5000) : "";

    if (!cleanName || !cleanMessage || !isValidEmail(cleanEmail)) {
      return res.status(400).json({
        error: "Nom, email valide et message sont obligatoires.",
      });
    }

    registerContactAttempt(ip);

    await mailTransporter.sendMail({
      from: `"Market place shop" <${GMAIL_USER}>`,
      to: CONTACT_EMAIL,
      replyTo: cleanEmail,
      subject: `Message depuis Market place shop — ${cleanName}`,
      text:
        "Nouveau message depuis le formulaire de contact.\n\n" +
        `Nom : ${cleanName}\n` +
        `Email : ${cleanEmail}\n\n` +
        `Message :\n${cleanMessage}`,
    });

    console.log(`✅ Message de contact envoyé à ${CONTACT_EMAIL}`);

    return res.json({
      ok: true,
      message: "Message envoyé avec succès.",
    });
  } catch (err) {
    console.error("❌ ERREUR ENVOI EMAIL :", err);

    return res.status(500).json({
      error:
        "Impossible d'envoyer le message. Vérifie la configuration Gmail sur Render.",
    });
  }
});

// ============================================================
// MONGODB
// ============================================================

const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.MONGODB_DB_NAME || "marketplace";

let db = null;
let mongoClient = null;
let connecting = false;

async function ensureIndex(collectionName, keys, options) {
  try {
    await db.collection(collectionName).createIndex(keys, options);
  } catch (err) {
    console.error(
      "Index non créé (" + collectionName + " " + JSON.stringify(keys) + ") :",
      err.message
    );
  }
}

async function connectToDatabase() {
  if (!MONGODB_URI) {
    console.error(
      "ERREUR : la variable d'environnement MONGODB_URI n'est pas configurée. " +
        "Le serveur démarre mais /products et /orders ne fonctionneront pas " +
        "tant que MONGODB_URI n'est pas ajoutée sur Render."
    );
    return;
  }

  if (connecting || db) return;
  connecting = true;

  try {
    mongoClient = new MongoClient(MONGODB_URI, {
      serverSelectionTimeoutMS: 10000,
    });
    await mongoClient.connect();
    db = mongoClient.db(DB_NAME);

    console.log("Connecté à MongoDB Atlas (base : " + DB_NAME + ")");

    await ensureIndex("orders", { id: 1 }, { unique: true });
    await ensureIndex("orders", { stripeSessionId: 1 });
    await ensureIndex("sessions", { expiresAt: 1 }, { expireAfterSeconds: 0 });
  } catch (err) {
    db = null;
    console.error("Erreur de connexion à MongoDB Atlas :", err.message);
    console.error(
      "Vérifie : 1) MONGODB_URI correct sur Render, " +
        "2) mot de passe sans caractères non encodés, " +
        "3) 0.0.0.0/0 ajouté dans Network Access sur MongoDB Atlas."
    );

    try {
      if (mongoClient) await mongoClient.close();
    } catch (e) {
      // ignoré
    }

    mongoClient = null;
    setTimeout(connectToDatabase, 15000);
  } finally {
    connecting = false;
  }
}

function requireDatabase(req, res, next) {
  if (!db) {
    return res.status(503).json({
      error:
        "Base de données indisponible. Réessayez dans quelques secondes. " +
        "Si le problème persiste, vérifie MONGODB_URI sur Render et l'accès réseau de MongoDB Atlas.",
    });
  }
  next();
}

// ============================================================
// PRODUITS
// ============================================================

const PRODUCTS_DOC_ID = "products";

async function getProductsFromDB() {
  const doc = await db.collection("config").findOne({ _id: PRODUCTS_DOC_ID });
  return doc && Array.isArray(doc.list) ? doc.list : [];
}

async function saveProductsToDB(products) {
  await db.collection("config").updateOne(
    { _id: PRODUCTS_DOC_ID },
    { $set: { list: products, updatedAt: new Date().toISOString() } },
    { upsert: true }
  );
}

function sanitizeProducts(list) {
  if (!Array.isArray(list)) return { error: "Format invalide." };
  if (list.length > 500) return { error: "Trop d'articles (maximum 500)." };

  const out = [];
  const seen = new Set();

  for (const p of list) {
    if (!p || typeof p !== "object") return { error: "Article invalide." };

    const id = typeof p.id === "string" ? p.id.trim() : "";
    const name = typeof p.name === "string" ? p.name.trim() : "";
    const price = Number(p.price);

    if (!id || id.length > 64) return { error: "Identifiant d'article invalide." };
    if (seen.has(id)) return { error: "Identifiant d'article en double." };
    if (!name || name.length > 200) return { error: "Nom d'article invalide." };
    if (!(price > 0) || price > 100000)
      return { error: "Prix invalide pour « " + name + " »." };

    seen.add(id);

    const photo =
      typeof p.photo === "string" &&
      (p.photo.startsWith("data:image/") ||
        p.photo.startsWith("https://") ||
        p.photo.startsWith("http://"))
        ? p.photo
        : null;

    const paymentLink =
      typeof p.paymentLink === "string" && p.paymentLink.startsWith("https://")
        ? p.paymentLink.slice(0, 500)
        : null;

    out.push({
      id,
      name,
      price,
      category: typeof p.category === "string" ? p.category.slice(0, 60) : "Autre",
      description:
        typeof p.description === "string" ? p.description.slice(0, 2000) : "",
      photo,
      paymentLink,
    });
  }

  return { products: out };
}

// ============================================================
// COMMANDES
// ============================================================

async function getOrders() {
  const docs = await db
    .collection("orders")
    .find({})
    .sort({ createdAt: 1 })
    .toArray();

  return docs.map(({ _id, ...rest }) => rest);
}

async function getOrderById(orderId) {
  const doc = await db.collection("orders").findOne({ id: orderId });
  if (!doc) return null;
  const { _id, ...rest } = doc;
  return rest;
}

async function updateOrder(orderId, updateFields) {
  await db.collection("orders").updateOne({ id: orderId }, { $set: updateFields });
  return getOrderById(orderId);
}

function generateOrderId() {
  return (
    "ORD-" +
    Date.now() +
    "-" +
    Math.random().toString(36).slice(2, 8).toUpperCase()
  );
}

// Idempotent : si Stripe renvoie le même événement plusieurs fois, on ne crée
// qu’une seule commande.
async function createOrderFromStripeSession(stripeSessionId) {
  const session = await stripe.checkout.sessions.retrieve(stripeSessionId, {
    expand: ["line_items"],
  });

  if (session.payment_status !== "paid") {
    return null;
  }

  const shipping =
    (session.collected_information && session.collected_information.shipping_details) ||
    session.shipping_details ||
    null;

  const items = ((session.line_items && session.line_items.data) || []).map((li) => ({
    name: li.description,
    qty: li.quantity,
    unitPrice:
      li.price && typeof li.price.unit_amount === "number"
        ? li.price.unit_amount / 100
        : null,
    total:
      typeof li.amount_total === "number" ? li.amount_total / 100 : null,
  }));

  const now = new Date().toISOString();

  const orderWithoutSession = {
    stripeSessionId,
    id: generateOrderId(),
    items,
    customer: {
      email: (session.customer_details && session.customer_details.email) || null,
      name: (session.customer_details && session.customer_details.name) || null,
      shippingAddress: shipping
        ? { name: shipping.name || null, ...(shipping.address || {}) }
        : null,
    },
    paymentStatus: "paid",
    amountTotal:
      typeof session.amount_total === "number" ? session.amount_total / 100 : null,
    currency: session.currency || "eur",
    shipping: {
      carrier: null,
      trackingNumber: null,
      trackingUrl: null,
      status: "not_shipped",
    },
    createdAt: now,
    updatedAt: now,
  };

  const result = await db.collection("orders").updateOne(
    { stripeSessionId },
    { $setOnInsert: orderWithoutSession },
    { upsert: true }
  );

  if (result.upsertedCount) {
    console.log("Nouvelle commande enregistrée : " + orderWithoutSession.id);
  }

  return getOrderByStripeSessionId(stripeSessionId);
}

async function getOrderByStripeSessionId(stripeSessionId) {
  const doc = await db.collection("orders").findOne({ stripeSessionId });
  if (!doc) return null;
  const { _id, ...rest } = doc;
  return rest;
}

// ============================================================
// AUTHENTIFICATION VENDEUR
// ============================================================

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

async function createSellerSession() {
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = Date.now() + TOKEN_DURATION;

  await db.collection("sessions").insertOne({
    _id: hashToken(token),
    createdAt: new Date(),
    expiresAt: new Date(expiresAt),
  });

  return { token, expiresAt };
}

async function authenticateSeller(req, res, next) {
  const authHeader = req.headers.authorization || "";

  if (!authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Authentification vendeur requise." });
  }

  const token = authHeader.slice(7).trim();

  if (!token) {
    return res.status(401).json({ error: "Jeton vendeur manquant." });
  }

  if (!db) {
    return res.status(503).json({ error: "Base de données indisponible." });
  }

  try {
    const session = await db.collection("sessions").findOne({
      _id: hashToken(token),
    });

    if (!session) {
      return res.status(401).json({ error: "Session vendeur invalide." });
    }

    if (session.expiresAt.getTime() < Date.now()) {
      await db.collection("sessions").deleteOne({ _id: session._id });
      return res.status(401).json({ error: "Session vendeur expirée." });
    }

    req.seller = true;
    next();
  } catch (err) {
    console.error("Erreur vérification session vendeur :", err);
    res.status(500).json({ error: "Impossible de vérifier la session." });
  }
}

const LOGIN_MAX_FAILURES = 8;
const LOGIN_WINDOW = 15 * 60 * 1000;
const loginFailures = new Map();

function isLoginBlocked(ip) {
  const entry = loginFailures.get(ip);
  if (!entry) return false;
  if (Date.now() > entry.resetAt) {
    loginFailures.delete(ip);
    return false;
  }
  return entry.count >= LOGIN_MAX_FAILURES;
}

function registerLoginFailure(ip) {
  const now = Date.now();
  const entry = loginFailures.get(ip);

  if (!entry || now > entry.resetAt) {
    loginFailures.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW });
  } else {
    entry.count += 1;
  }
}

app.post("/admin/login", requireDatabase, async (req, res) => {
  try {
    if (!ADMIN_PASSWORD) {
      return res.status(500).json({
        error:
          "ADMIN_PASSWORD n'est pas configuré sur le serveur. Ajoute cette variable d'environnement sur Render.",
      });
    }

    const ip = req.ip || "inconnue";

    if (isLoginBlocked(ip)) {
      return res.status(429).json({
        error: "Trop de tentatives. Réessayez dans quelques minutes.",
      });
    }

    const { password } = req.body || {};

    if (typeof password !== "string" || password.length === 0) {
      return res.status(400).json({ error: "Mot de passe obligatoire." });
    }

    if (!safeEqual(password, ADMIN_PASSWORD)) {
      registerLoginFailure(ip);
      return res.status(401).json({ error: "Mot de passe incorrect." });
    }

    loginFailures.delete(ip);

    const { token, expiresAt } = await createSellerSession();

    return res.json({ ok: true, token, expiresAt });
  } catch (err) {
    console.error("Erreur connexion vendeur :", err);
    return res.status(500).json({ error: "Impossible de vérifier le mot de passe." });
  }
});

app.post("/admin/logout", requireDatabase, authenticateSeller, async (req, res) => {
  try {
    const token = (req.headers.authorization || "").slice(7).trim();
    await db.collection("sessions").deleteOne({ _id: hashToken(token) });
    return res.json({ ok: true });
  } catch (err) {
    console.error("Erreur déconnexion vendeur :", err);
    return res.status(500).json({ error: "Impossible de fermer la session." });
  }
});

// ============================================================
// TRACKING
// ============================================================

function getTrackingUrl(carrier, trackingNumber) {
  if (!trackingNumber) return null;

  const number = encodeURIComponent(trackingNumber.trim());

  if (carrier === "bpost") {
    return `https://track.bpost.cloud/btr/web/#/search?itemCode=${number}`;
  }

  if (carrier === "mondialrelay") {
    return `https://www.mondialrelay.fr/suivi-de-colis/?numeroExpedition=${number}`;
  }

  return null;
}

// ============================================================
// ROUTE DE TEST
// ============================================================

app.get("/", (req, res) => {
  res.json({
    ok: true,
    message: "Backend market place shop : en ligne.",
    database: db ? "connectée" : "non connectée (MONGODB_URI manquant ?)",
    email: mailTransporter ? "configuré" : "non configuré (GMAIL_USER / GMAIL_APP_PASSWORD manquants ?)",
  });
});

// ============================================================
// STRIPE – CRÉER UNE SESSION DE PAIEMENT
// ============================================================

function isAllowedRedirect(url) {
  try {
    return ALLOWED_ORIGINS.includes(new URL(url).origin);
  } catch (e) {
    return false;
  }
}

app.post("/create-checkout-session", requireDatabase, async (req, res) => {
  try {
    if (!stripe) {
      return res.status(500).json({
        error: "Paiement non configuré sur le serveur.",
      });
    }

    const { cart, successUrl, cancelUrl } = req.body || {};

    if (!Array.isArray(cart) || cart.length === 0 || cart.length > 50) {
      return res.status(400).json({ error: "Panier vide ou invalide." });
    }

    if (!isAllowedRedirect(successUrl) || !isAllowedRedirect(cancelUrl)) {
      return res.status(400).json({ error: "Adresse de retour non autorisée." });
    }

    const products = await getProductsFromDB();
    const byId = new Map(products.map((p) => [p.id, p]));

    const line_items = [];

    for (const item of cart) {
      const product = item && byId.get(String(item.id));

      if (!product) {
        return res.status(400).json({
          error:
            "Un article de votre panier n'est plus disponible. Rechargez la page et recommencez.",
        });
      }

      const qty = Math.min(Math.max(parseInt(item.qty, 10) || 1, 1), 20);
      const unit_amount = Math.round(Number(product.price) * 100);

      if (!Number.isInteger(unit_amount) || unit_amount < 50) {
        return res.status(400).json({
          error: "Le prix de « " + product.name + " » est invalide.",
        });
      }

      line_items.push({
        price_data: {
          currency: "eur",
          product_data: { name: String(product.name).slice(0, 250) },
          unit_amount,
        },
        quantity: qty,
      });
    }

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items,
      success_url: successUrl,
      cancel_url: cancelUrl,
      shipping_address_collection: {
        allowed_countries: ["FR", "BE", "CH", "LU"],
      },
      metadata: { marketplace: "market-place-shop" },
    });

    return res.json({ url: session.url, sessionId: session.id });
  } catch (err) {
    console.error("Erreur création session Stripe :", err);
    return res.status(500).json({ error: "Impossible de créer le paiement." });
  }
});

// ============================================================
// STRIPE – RÉCUPÉRER UNE SESSION
// ============================================================

app.get(
  "/stripe-session/:sessionId",
  requireDatabase,
  authenticateSeller,
  async (req, res) => {
    try {
      if (!stripe) {
        return res.status(500).json({ error: "Stripe non configuré." });
      }

      const session = await stripe.checkout.sessions.retrieve(req.params.sessionId);
      const shipping =
        (session.collected_information && session.collected_information.shipping_details) ||
        session.shipping_details ||
        null;

      return res.json({
        id: session.id,
        payment_status: session.payment_status,
        status: session.status,
        customer_email:
          (session.customer_details && session.customer_details.email) || null,
        customer_name:
          (session.customer_details && session.customer_details.name) || null,
        shipping_address: (shipping && shipping.address) || null,
      });
    } catch (err) {
      console.error("Erreur récupération session Stripe :", err);
      return res.status(500).json({ error: "Impossible de récupérer la commande Stripe." });
    }
  }
);

// ============================================================
// PRODUITS PUBLIC / PRIVÉ
// ============================================================

app.get("/products", requireDatabase, async (req, res) => {
  try {
    const products = await getProductsFromDB();
    return res.json({ products });
  } catch (err) {
    console.error("Erreur lecture des produits (MongoDB) :", err);
    return res.status(500).json({ error: "Impossible de lire les produits." });
  }
});

app.post("/products", requireDatabase, authenticateSeller, async (req, res) => {
  try {
    const result = sanitizeProducts((req.body || {}).products);

    if (result.error) {
      return res.status(400).json({ error: result.error });
    }

    await saveProductsToDB(result.products);

    return res.json({ ok: true });
  } catch (err) {
    console.error("Erreur écriture des produits (MongoDB) :", err);
    return res.status(500).json({ error: "Impossible de sauvegarder les produits." });
  }
});

// ============================================================
// COMMANDES / SUIVI
// ============================================================

app.get("/orders", requireDatabase, authenticateSeller, async (req, res) => {
  try {
    const orders = await getOrders();
    return res.json({ orders });
  } catch (err) {
    console.error("Erreur lecture commandes :", err);
    return res.status(500).json({ error: "Impossible de lire les commandes." });
  }
});

app.get("/orders/:orderId", requireDatabase, authenticateSeller, async (req, res) => {
  try {
    const order = await getOrderById(req.params.orderId);

    if (!order) {
      return res.status(404).json({ error: "Commande introuvable." });
    }

    return res.json({ order });
  } catch (err) {
    console.error("Erreur récupération commande :", err);
    return res.status(500).json({ error: "Impossible de récupérer la commande." });
  }
});

app.post(
  "/orders/:orderId/tracking",
  requireDatabase,
  authenticateSeller,
  async (req, res) => {
    try {
      const { carrier, trackingNumber, status } = req.body || {};

      const allowedCarriers = ["bpost", "mondialrelay"];

      if (!allowedCarriers.includes(carrier)) {
        return res.status(400).json({
          error: "Transporteur invalide. Utilise bpost ou mondialrelay.",
        });
      }

      if (typeof trackingNumber !== "string" || trackingNumber.trim().length < 3) {
        return res.status(400).json({ error: "Numéro de suivi invalide." });
      }

      const existing = await getOrderById(req.params.orderId);

      if (!existing) {
        return res.status(404).json({ error: "Commande introuvable." });
      }

      const cleanTrackingNumber = trackingNumber.trim();

      const updated = await updateOrder(req.params.orderId, {
        shipping: {
          carrier,
          trackingNumber: cleanTrackingNumber,
          trackingUrl: getTrackingUrl(carrier, cleanTrackingNumber),
          status: status || "shipped",
        },
        updatedAt: new Date().toISOString(),
      });

      return res.json({ ok: true, order: updated });
    } catch (err) {
      console.error("Erreur ajout suivi :", err);
      return res.status(500).json({ error: "Impossible d'enregistrer le suivi." });
    }
  }
);

app.patch(
  "/orders/:orderId/shipping-status",
  requireDatabase,
  authenticateSeller,
  async (req, res) => {
    try {
      const { status } = req.body || {};

      const allowedStatuses = [
        "not_shipped",
        "label_created",
        "shipped",
        "in_transit",
        "delivered",
        "cancelled",
      ];

      if (!allowedStatuses.includes(status)) {
        return res.status(400).json({ error: "Statut d'expédition invalide." });
      }

      const existing = await getOrderById(req.params.orderId);

      if (!existing) {
        return res.status(404).json({ error: "Commande introuvable." });
      }

      const updated = await updateOrder(req.params.orderId, {
        shipping: { ...(existing.shipping || {}), status },
        updatedAt: new Date().toISOString(),
      });

      return res.json({ ok: true, order: updated });
    } catch (err) {
      console.error("Erreur modification statut :", err);
      return res.status(500).json({ error: "Impossible de modifier le statut." });
    }
  }
);

app.get("/tracking/:orderId", requireDatabase, async (req, res) => {
  try {
    const order = await getOrderById(req.params.orderId);

    if (!order) {
      return res.status(404).json({ error: "Commande introuvable." });
    }

    return res.json({
      orderId: order.id,
      shipping: order.shipping || {
        carrier: null,
        trackingNumber: null,
        trackingUrl: null,
        status: "not_shipped",
      },
    });
  } catch (err) {
    console.error("Erreur récupération suivi :", err);
    return res.status(500).json({ error: "Impossible de récupérer le suivi." });
  }
});

app.post("/shipping/create", requireDatabase, authenticateSeller, async (req, res) => {
  try {
    const { carrier, orderId } = req.body || {};

    if (!["bpost", "mondialrelay"].includes(carrier)) {
      return res.status(400).json({ error: "Transporteur invalide." });
    }

    if (!orderId) {
      return res.status(400).json({ error: "orderId obligatoire." });
    }

    const order = await getOrderById(orderId);

    if (!order) {
      return res.status(404).json({ error: "Commande introuvable." });
    }

    return res.status(501).json({
      error:
        "Création automatique de l'expédition non configurée. Il faut connecter les identifiants/API officiels du transporteur.",
      carrier,
      orderId,
    });
  } catch (err) {
    console.error("Erreur création expédition :", err);
    return res.status(500).json({ error: "Impossible de créer l'expédition." });
  }
});

// ============================================================
// NETTOYAGE PÉRIODIQUE
// ============================================================

setInterval(() => {
  const now = Date.now();

  for (const [ip, entry] of loginFailures.entries()) {
    if (now > entry.resetAt) loginFailures.delete(ip);
  }

  for (const [ip, entry] of contactAttempts.entries()) {
    if (now > entry.resetAt) contactAttempts.delete(ip);
  }
}, 60 * 60 * 1000);

// ============================================================
// DÉMARRAGE
// ============================================================

app.listen(PORT, () => {
  console.log(`Serveur démarré sur le port ${PORT}`);
});

connectToDatabase();
