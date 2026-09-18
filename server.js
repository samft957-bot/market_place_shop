// ============================================================
// Backend "market place shop"
// Stripe + produits + commandes + suivi bpost / Mondial Relay
// + authentification vendeur
// + STOCKAGE PERMANENT via MongoDB Atlas (gratuit)
// ============================================================
//
// CE QUI A CHANGÉ PAR RAPPORT À LA VERSION PRÉCÉDENTE :
// Avant, les produits et commandes étaient stockés dans des
// fichiers products.json / orders.json sur le disque de Render.
// Sur le plan gratuit, ce disque est effacé à chaque redémarrage
// du serveur (mise en veille après inactivité, redéploiement...),
// donc les modifications finissaient toujours par disparaître.
//
// Maintenant, tout est stocké dans une base MongoDB Atlas
// (gratuite, hébergée en dehors de Render), qui ne redémarre
// jamais et garde les données indéfiniment, quel que soit ce qui
// se passe côté Render.
//
// ÉTAPES POUR FAIRE FONCTIONNER CETTE VERSION :
// 1. Crée un compte gratuit sur https://www.mongodb.com/cloud/atlas/register
// 2. Crée un cluster gratuit ("M0").
// 3. Dans "Network Access", ajoute l'adresse IP 0.0.0.0/0
//    (autoriser depuis n'importe où — nécessaire car Render change
//    d'adresse IP en plan gratuit).
// 4. Dans "Database Access", crée un utilisateur avec un mot de passe.
// 5. Dans "Database" > "Connect" > "Drivers", copie l'URI de connexion,
//    qui ressemble à :
//    mongodb+srv://<utilisateur>:<mot-de-passe>@cluster0.xxxxx.mongodb.net/
// 6. Sur Render, dans les "Environment Variables" de ton service,
//    ajoute une variable MONGODB_URI avec cette URI complète
//    (en remplaçant <utilisateur> et <mot-de-passe> par les vraies valeurs).
// 7. Ajoute la dépendance "mongodb" à ton package.json (voir note en bas
//    de ce fichier), puis redéploie sur Render.
// ============================================================

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const { MongoClient } = require("mongodb");

const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

const app = express();

// ============================================================
// CONFIGURATION
// ============================================================

app.use(cors());
app.use(express.json({ limit: "10mb" }));

const PORT = process.env.PORT || 3000;

// Mot de passe vendeur
// ATTENTION SÉCURITÉ : si ce dépôt GitHub est public, retire la valeur
// par défaut ci-dessous et configure uniquement ADMIN_PASSWORD sur Render.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "samFT_2011";

// Jetons vendeurs temporaires conservés en mémoire
const sellerTokens = new Map();

// Durée d'une session vendeur : 24 heures
const TOKEN_DURATION = 24 * 60 * 60 * 1000;

// ============================================================
// MONGODB — CONNEXION
// ============================================================

const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.MONGODB_DB_NAME || "marketplace";

let db = null;
let mongoClient = null;

async function connectToDatabase() {
  if (!MONGODB_URI) {
    console.error(
      "ERREUR : la variable d'environnement MONGODB_URI n'est pas configurée. " +
      "Le serveur va démarrer mais /products et /orders ne fonctionneront pas " +
      "tant que MONGODB_URI n'est pas ajoutée sur Render."
    );
    return;
  }

  try {
    mongoClient = new MongoClient(MONGODB_URI);
    await mongoClient.connect();
    db = mongoClient.db(DB_NAME);
    console.log("Connecté à MongoDB Atlas (base : " + DB_NAME + ")");

    // Index utile pour retrouver une commande rapidement par son id métier
    await db.collection("orders").createIndex({ id: 1 }, { unique: true });
    await db.collection("orders").createIndex({ stripeSessionId: 1 });
  } catch (err) {
    console.error("Erreur de connexion à MongoDB Atlas :", err);
  }
}

// Petit middleware qui bloque proprement les routes données
// si la base n'est pas connectée, plutôt que de planter le serveur.
function requireDatabase(req, res, next) {
  if (!db) {
    return res.status(503).json({
      error:
        "Base de données indisponible. Vérifie que MONGODB_URI est bien configuré sur Render et que le cluster MongoDB Atlas est accessible.",
    });
  }
  next();
}

// ============================================================
// PRODUITS — STOCKAGE MONGODB
// ============================================================
// Le frontend envoie systématiquement la LISTE COMPLÈTE des produits
// à chaque sauvegarde (voir saveProductsToStorage côté frontend).
// On stocke donc cette liste dans un unique document, ce qui reproduit
// exactement le comportement précédent (products.json) mais de façon
// permanente.

const PRODUCTS_DOC_ID = "products";

async function getProductsFromDB() {
  const doc = await db
    .collection("config")
    .findOne({ _id: PRODUCTS_DOC_ID });

  return doc && Array.isArray(doc.list) ? doc.list : [];
}

async function saveProductsToDB(products) {
  await db.collection("config").updateOne(
    { _id: PRODUCTS_DOC_ID },
    { $set: { list: products, updatedAt: new Date().toISOString() } },
    { upsert: true }
  );
}

// ============================================================
// COMMANDES — STOCKAGE MONGODB
// ============================================================
// Contrairement aux produits, les commandes sont ajoutées une par une
// et modifiées individuellement (statut, suivi...), donc chacune est
// stockée comme un document séparé dans la collection "orders".

async function getOrders() {
  const docs = await db
    .collection("orders")
    .find({})
    .sort({ createdAt: 1 })
    .toArray();

  // On retire le champ interne _id de Mongo pour garder le même format
  // qu'avant côté frontend/admin.
  return docs.map(({ _id, ...rest }) => rest);
}

async function getOrderById(orderId) {
  const doc = await db.collection("orders").findOne({ id: orderId });
  if (!doc) return null;
  const { _id, ...rest } = doc;
  return rest;
}

async function getOrderByStripeSessionId(stripeSessionId) {
  const doc = await db
    .collection("orders")
    .findOne({ stripeSessionId });
  if (!doc) return null;
  const { _id, ...rest } = doc;
  return rest;
}

async function insertOrder(order) {
  await db.collection("orders").insertOne({ ...order });
  return order;
}

async function updateOrder(orderId, updateFields) {
  await db.collection("orders").updateOne(
    { id: orderId },
    { $set: updateFields }
  );
  return getOrderById(orderId);
}

// ============================================================
// AUTHENTIFICATION VENDEUR
// ============================================================

function authenticateSeller(req, res, next) {
  const authHeader = req.headers.authorization || "";

  if (!authHeader.startsWith("Bearer ")) {
    return res.status(401).json({
      error: "Authentification vendeur requise.",
    });
  }

  const token = authHeader.slice(7).trim();

  if (!token) {
    return res.status(401).json({
      error: "Jeton vendeur manquant.",
    });
  }

  const session = sellerTokens.get(token);

  if (!session) {
    return res.status(401).json({
      error: "Session vendeur invalide.",
    });
  }

  if (Date.now() > session.expiresAt) {
    sellerTokens.delete(token);

    return res.status(401).json({
      error: "Session vendeur expirée.",
    });
  }

  req.seller = true;
  next();
}

// ============================================================
// CONNEXION VENDEUR
// ============================================================

app.post("/admin/login", (req, res) => {
  try {
    if (!ADMIN_PASSWORD) {
      return res.status(500).json({
        error:
          "ADMIN_PASSWORD n'est pas configuré sur le serveur. Ajoute cette variable d'environnement sur Render.",
      });
    }

    const { password } = req.body;

    if (typeof password !== "string" || password.length === 0) {
      return res.status(400).json({
        error: "Mot de passe obligatoire.",
      });
    }

    if (password !== ADMIN_PASSWORD) {
      return res.status(401).json({
        error: "Mot de passe incorrect.",
      });
    }

    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = Date.now() + TOKEN_DURATION;

    sellerTokens.set(token, { expiresAt });

    res.json({ ok: true, token, expiresAt });
  } catch (err) {
    console.error("Erreur connexion vendeur :", err);

    res.status(500).json({
      error: "Impossible de vérifier le mot de passe.",
    });
  }
});

// ============================================================
// DÉCONNEXION VENDEUR
// ============================================================

app.post("/admin/logout", authenticateSeller, (req, res) => {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.slice(7).trim();

  sellerTokens.delete(token);

  res.json({ ok: true });
});

// ============================================================
// ID COMMANDE
// ============================================================

function generateOrderId() {
  return (
    "ORD-" +
    Date.now() +
    "-" +
    Math.random().toString(36).slice(2, 8).toUpperCase()
  );
}

// ============================================================
// LIENS DE SUIVI
// ============================================================

function getTrackingUrl(carrier, trackingNumber) {
  if (!trackingNumber) {
    return null;
  }

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
  });
});

// ============================================================
// STRIPE - CRÉER UNE SESSION DE PAIEMENT
// ============================================================

app.post("/create-checkout-session", async (req, res) => {
  try {
    const { cart, successUrl, cancelUrl } = req.body;

    if (!Array.isArray(cart) || cart.length === 0) {
      return res.status(400).json({ error: "Panier vide." });
    }

    const line_items = cart.map((item) => ({
      price_data: {
        currency: "eur",
        product_data: { name: item.name },
        unit_amount: Math.round(Number(item.price) * 100),
      },
      quantity: Number(item.qty) || 1,
    }));

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

    res.json({ url: session.url, sessionId: session.id });
  } catch (err) {
    console.error("Erreur création session Stripe :", err);

    res.status(500).json({ error: "Impossible de créer le paiement." });
  }
});

// ============================================================
// STRIPE - RÉCUPÉRER UNE SESSION
// ============================================================

app.get("/stripe-session/:sessionId", async (req, res) => {
  try {
    const session = await stripe.checkout.sessions.retrieve(
      req.params.sessionId
    );

    res.json({
      id: session.id,
      payment_status: session.payment_status,
      status: session.status,
      customer_email: session.customer_details?.email || null,
      customer_name: session.customer_details?.name || null,
      shipping_address: session.shipping_details?.address || null,
    });
  } catch (err) {
    console.error("Erreur récupération session Stripe :", err);

    res.status(500).json({
      error: "Impossible de récupérer la commande Stripe.",
    });
  }
});

// ============================================================
// PRODUITS - RÉCUPÉRER
// ============================================================

// Public : tout le monde peut voir les produits
app.get("/products", requireDatabase, async (req, res) => {
  try {
    const products = await getProductsFromDB();
    res.json({ products });
  } catch (err) {
    console.error("Erreur lecture des produits (MongoDB) :", err);

    res.status(500).json({ error: "Impossible de lire les produits." });
  }
});

// ============================================================
// PRODUITS - SAUVEGARDER
// ============================================================

// PROTÉGÉ : seul le vendeur connecté peut modifier
app.post(
  "/products",
  requireDatabase,
  authenticateSeller,
  async (req, res) => {
    try {
      const { products } = req.body;

      if (!Array.isArray(products)) {
        return res.status(400).json({ error: "Format invalide." });
      }

      await saveProductsToDB(products);

      res.json({ ok: true });
    } catch (err) {
      console.error("Erreur écriture des produits (MongoDB) :", err);

      res.status(500).json({
        error: "Impossible de sauvegarder les produits.",
      });
    }
  }
);

// ============================================================
// COMMANDES - CRÉER
// ============================================================

app.post("/orders", requireDatabase, async (req, res) => {
  try {
    const {
      stripeSessionId,
      items,
      customerEmail,
      customerName,
      shippingAddress,
    } = req.body;

    if (!stripeSessionId) {
      return res.status(400).json({ error: "stripeSessionId obligatoire." });
    }

    // Éviter les doublons
    const existing = await getOrderByStripeSessionId(stripeSessionId);

    if (existing) {
      return res.json({ ok: true, order: existing });
    }

    const order = {
      id: generateOrderId(),
      stripeSessionId,
      items: Array.isArray(items) ? items : [],
      customer: {
        email: customerEmail || null,
        name: customerName || null,
        shippingAddress: shippingAddress || null,
      },
      paymentStatus: "paid",
      shipping: {
        carrier: null,
        trackingNumber: null,
        trackingUrl: null,
        status: "not_shipped",
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await insertOrder(order);

    res.status(201).json({ ok: true, order });
  } catch (err) {
    console.error("Erreur création commande :", err);

    res.status(500).json({ error: "Impossible de créer la commande." });
  }
});

// ============================================================
// COMMANDES - TOUTES LES COMMANDES
// ============================================================

// Protégé : les commandes ne doivent pas être publiques
app.get("/orders", requireDatabase, authenticateSeller, async (req, res) => {
  try {
    const orders = await getOrders();
    res.json({ orders });
  } catch (err) {
    console.error("Erreur lecture commandes :", err);

    res.status(500).json({ error: "Impossible de lire les commandes." });
  }
});

// ============================================================
// COMMANDES - UNE COMMANDE
// ============================================================

// Protégé vendeur
app.get(
  "/orders/:orderId",
  requireDatabase,
  authenticateSeller,
  async (req, res) => {
    try {
      const order = await getOrderById(req.params.orderId);

      if (!order) {
        return res.status(404).json({ error: "Commande introuvable." });
      }

      res.json({ order });
    } catch (err) {
      console.error("Erreur récupération commande :", err);

      res.status(500).json({
        error: "Impossible de récupérer la commande.",
      });
    }
  }
);

// ============================================================
// AJOUTER UN NUMÉRO DE SUIVI
// ============================================================
//
// IMPORTANT :
// Le numéro doit être le vrai numéro fourni par bpost ou Mondial Relay.
// Cette route ne fabrique aucun faux numéro.
// ============================================================

app.post(
  "/orders/:orderId/tracking",
  requireDatabase,
  authenticateSeller,
  async (req, res) => {
    try {
      const { carrier, trackingNumber, status } = req.body;

      const allowedCarriers = ["bpost", "mondialrelay"];

      if (!allowedCarriers.includes(carrier)) {
        return res.status(400).json({
          error: "Transporteur invalide. Utilise bpost ou mondialrelay.",
        });
      }

      if (
        typeof trackingNumber !== "string" ||
        trackingNumber.trim().length < 3
      ) {
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

      res.json({ ok: true, order: updated });
    } catch (err) {
      console.error("Erreur ajout suivi :", err);

      res.status(500).json({ error: "Impossible d'enregistrer le suivi." });
    }
  }
);

// ============================================================
// MODIFIER LE STATUT D'EXPÉDITION
// ============================================================

app.patch(
  "/orders/:orderId/shipping-status",
  requireDatabase,
  authenticateSeller,
  async (req, res) => {
    try {
      const { status } = req.body;

      const allowedStatuses = [
        "not_shipped",
        "label_created",
        "shipped",
        "in_transit",
        "delivered",
        "cancelled",
      ];

      if (!allowedStatuses.includes(status)) {
        return res.status(400).json({
          error: "Statut d'expédition invalide.",
        });
      }

      const existing = await getOrderById(req.params.orderId);

      if (!existing) {
        return res.status(404).json({ error: "Commande introuvable." });
      }

      const currentShipping = existing.shipping || {};

      const updated = await updateOrder(req.params.orderId, {
        shipping: { ...currentShipping, status },
        updatedAt: new Date().toISOString(),
      });

      res.json({ ok: true, order: updated });
    } catch (err) {
      console.error("Erreur modification statut :", err);

      res.status(500).json({ error: "Impossible de modifier le statut." });
    }
  }
);

// ============================================================
// SUIVI CLIENT
// ============================================================

// Public : un client peut consulter son suivi
app.get("/tracking/:orderId", requireDatabase, async (req, res) => {
  try {
    const order = await getOrderById(req.params.orderId);

    if (!order) {
      return res.status(404).json({ error: "Commande introuvable." });
    }

    res.json({
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

    res.status(500).json({ error: "Impossible de récupérer le suivi." });
  }
});

// ============================================================
// CRÉATION D'EXPÉDITION
// ============================================================
//
// Cette route est préparée pour la connexion aux API officielles
// bpost / Mondial Relay. Elle ne crée PAS encore une vraie étiquette.
// ============================================================

app.post(
  "/shipping/create",
  requireDatabase,
  authenticateSeller,
  async (req, res) => {
    try {
      const { carrier, orderId } = req.body;

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

      res.status(500).json({ error: "Impossible de créer l'expédition." });
    }
  }
);

// ============================================================
// NETTOYAGE DES ANCIENS TOKENS
// ============================================================

setInterval(() => {
  const now = Date.now();

  for (const [token, session] of sellerTokens.entries()) {
    if (now > session.expiresAt) {
      sellerTokens.delete(token);
    }
  }
}, 60 * 60 * 1000);

// ============================================================
// DÉMARRAGE DU SERVEUR
// ============================================================

connectToDatabase().then(() => {
  app.listen(PORT, () => {
    console.log(`Serveur démarré sur le port ${PORT}`);
  });
});

// ============================================================
// NOTE — package.json
// ============================================================
// Ajoute "mongodb" à tes dépendances si ce n'est pas déjà fait :
//
//   npm install mongodb
//
// Ton package.json doit contenir une ligne comme celle-ci dans
// "dependencies" (la version exacte peut varier légèrement) :
//
//   "mongodb": "^6.10.0"
//
// Puis commite le package.json (et package-lock.json) mis à jour
// et redéploie sur Render — il installera "mongodb" automatiquement.
// ============================================================
