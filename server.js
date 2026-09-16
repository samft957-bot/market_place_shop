// ============================================================
// Backend "market place shop"
// Stripe + produits + commandes + suivi bpost / Mondial Relay
// + authentification vendeur
// ============================================================

const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

const app = express();

// ============================================================
// CONFIGURATION
// ============================================================

app.use(cors());
app.use(express.json({ limit: "10mb" }));

const PORT = process.env.PORT || 3000;

// Mot de passe vendeur
// Pour Render, tu peux remplacer cette valeur par une variable
// d'environnement ADMIN_PASSWORD.
const ADMIN_PASSWORD =
  process.env.ADMIN_PASSWORD || "samFT_2011";

// Jetons vendeurs temporaires conservés en mémoire
const sellerTokens = new Map();

// Durée d'une session vendeur : 24 heures
const TOKEN_DURATION = 24 * 60 * 60 * 1000;

// ============================================================
// FICHIERS
// ============================================================

const PRODUCTS_FILE = path.join(__dirname, "products.json");
const ORDERS_FILE = path.join(__dirname, "orders.json");

// ============================================================
// OUTILS FICHIERS
// ============================================================

function readJsonFile(file, fallback) {
  try {
    if (!fs.existsSync(file)) {
      return fallback;
    }

    const raw = fs.readFileSync(file, "utf8");

    if (!raw.trim()) {
      return fallback;
    }

    return JSON.parse(raw);
  } catch (err) {
    console.error(`Erreur lecture ${file}:`, err);
    return fallback;
  }
}

function writeJsonFile(file, data) {
  fs.writeFileSync(
    file,
    JSON.stringify(data, null, 2),
    "utf8"
  );
}

function getOrders() {
  return readJsonFile(ORDERS_FILE, []);
}

function saveOrders(orders) {
  writeJsonFile(ORDERS_FILE, orders);
}

// ============================================================
// AUTHENTIFICATION VENDEUR
// ============================================================

// Vérifie le jeton envoyé par le navigateur
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
    const { password } = req.body;

    if (
      typeof password !== "string" ||
      password.length === 0
    ) {
      return res.status(400).json({
        error: "Mot de passe obligatoire.",
      });
    }

    if (password !== ADMIN_PASSWORD) {
      return res.status(401).json({
        error: "Mot de passe incorrect.",
      });
    }

    // Création d'un jeton aléatoire
    const token = crypto.randomBytes(32).toString("hex");

    const expiresAt = Date.now() + TOKEN_DURATION;

    sellerTokens.set(token, {
      expiresAt,
    });

    res.json({
      ok: true,
      token,
      expiresAt,
    });
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

app.post(
  "/admin/logout",
  authenticateSeller,
  (req, res) => {
    const authHeader = req.headers.authorization || "";
    const token = authHeader.slice(7).trim();

    sellerTokens.delete(token);

    res.json({
      ok: true,
    });
  }
);

// ============================================================
// ID COMMANDE
// ============================================================

function generateOrderId() {
  return (
    "ORD-" +
    Date.now() +
    "-" +
    Math.random()
      .toString(36)
      .slice(2, 8)
      .toUpperCase()
  );
}

// ============================================================
// LIENS DE SUIVI
// ============================================================

function getTrackingUrl(carrier, trackingNumber) {
  if (!trackingNumber) {
    return null;
  }

  const number = encodeURIComponent(
    trackingNumber.trim()
  );

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
  });
});

// ============================================================
// STRIPE - CRÉER UNE SESSION DE PAIEMENT
// ============================================================

app.post(
  "/create-checkout-session",
  async (req, res) => {
    try {
      const {
        cart,
        successUrl,
        cancelUrl,
      } = req.body;

      if (!Array.isArray(cart) || cart.length === 0) {
        return res.status(400).json({
          error: "Panier vide.",
        });
      }

      const line_items = cart.map((item) => ({
        price_data: {
          currency: "eur",

          product_data: {
            name: item.name,
          },

          unit_amount: Math.round(
            Number(item.price) * 100
          ),
        },

        quantity: Number(item.qty) || 1,
      }));

      const session =
        await stripe.checkout.sessions.create({
          mode: "payment",

          payment_method_types: ["card"],

          line_items,

          success_url: successUrl,

          cancel_url: cancelUrl,

          shipping_address_collection: {
            allowed_countries: [
              "FR",
              "BE",
              "CH",
              "LU",
            ],
          },

          metadata: {
            marketplace: "market-place-shop",
          },
        });

      res.json({
        url: session.url,
        sessionId: session.id,
      });
    } catch (err) {
      console.error(
        "Erreur création session Stripe :",
        err
      );

      res.status(500).json({
        error:
          "Impossible de créer le paiement.",
      });
    }
  }
);

// ============================================================
// STRIPE - RÉCUPÉRER UNE SESSION
// ============================================================

app.get(
  "/stripe-session/:sessionId",
  async (req, res) => {
    try {
      const session =
        await stripe.checkout.sessions.retrieve(
          req.params.sessionId
        );

      res.json({
        id: session.id,

        payment_status:
          session.payment_status,

        status:
          session.status,

        customer_email:
          session.customer_details?.email ||
          null,

        customer_name:
          session.customer_details?.name ||
          null,

        shipping_address:
          session.shipping_details?.address ||
          null,
      });
    } catch (err) {
      console.error(
        "Erreur récupération session Stripe :",
        err
      );

      res.status(500).json({
        error:
          "Impossible de récupérer la commande Stripe.",
      });
    }
  }
);

// ============================================================
// PRODUITS - RÉCUPÉRER
// ============================================================

// Public : tout le monde peut voir les produits
app.get("/products", (req, res) => {
  try {
    const products =
      readJsonFile(PRODUCTS_FILE, []);

    res.json({
      products: Array.isArray(products)
        ? products
        : [],
    });
  } catch (err) {
    console.error(
      "Erreur lecture products.json :",
      err
    );

    res.status(500).json({
      error:
        "Impossible de lire les produits.",
    });
  }
});

// ============================================================
// PRODUITS - SAUVEGARDER
// ============================================================

// PROTÉGÉ : seul le vendeur connecté peut modifier
app.post(
  "/products",
  authenticateSeller,
  (req, res) => {
    try {
      const { products } = req.body;

      if (!Array.isArray(products)) {
        return res.status(400).json({
          error: "Format invalide.",
        });
      }

      writeJsonFile(
        PRODUCTS_FILE,
        products
      );

      res.json({
        ok: true,
      });
    } catch (err) {
      console.error(
        "Erreur écriture products.json :",
        err
      );

      res.status(500).json({
        error:
          "Impossible de sauvegarder les produits.",
      });
    }
  }
);

// ============================================================
// COMMANDES - CRÉER
// ============================================================

app.post("/orders", (req, res) => {
  try {
    const {
      stripeSessionId,
      items,
      customerEmail,
      customerName,
      shippingAddress,
    } = req.body;

    if (!stripeSessionId) {
      return res.status(400).json({
        error:
          "stripeSessionId obligatoire.",
      });
    }

    const orders = getOrders();

    // Éviter les doublons
    const existing = orders.find(
      (order) =>
        order.stripeSessionId ===
        stripeSessionId
    );

    if (existing) {
      return res.json({
        ok: true,
        order: existing,
      });
    }

    const order = {
      id: generateOrderId(),

      stripeSessionId,

      items: Array.isArray(items)
        ? items
        : [],

      customer: {
        email:
          customerEmail || null,

        name:
          customerName || null,

        shippingAddress:
          shippingAddress || null,
      },

      paymentStatus: "paid",

      shipping: {
        carrier: null,

        trackingNumber: null,

        trackingUrl: null,

        status: "not_shipped",
      },

      createdAt:
        new Date().toISOString(),

      updatedAt:
        new Date().toISOString(),
    };

    orders.push(order);

    saveOrders(orders);

    res.status(201).json({
      ok: true,
      order,
    });
  } catch (err) {
    console.error(
      "Erreur création commande :",
      err
    );

    res.status(500).json({
      error:
        "Impossible de créer la commande.",
    });
  }
});

// ============================================================
// COMMANDES - TOUTES LES COMMANDES
// ============================================================

// Protégé : les commandes ne doivent pas être publiques
app.get(
  "/orders",
  authenticateSeller,
  (req, res) => {
    try {
      const orders = getOrders();

      res.json({
        orders,
      });
    } catch (err) {
      console.error(
        "Erreur lecture commandes :",
        err
      );

      res.status(500).json({
        error:
          "Impossible de lire les commandes.",
      });
    }
  }
);

// ============================================================
// COMMANDES - UNE COMMANDE
// ============================================================

// Protégé vendeur
app.get(
  "/orders/:orderId",
  authenticateSeller,
  (req, res) => {
    try {
      const orders = getOrders();

      const order = orders.find(
        (item) =>
          item.id ===
          req.params.orderId
      );

      if (!order) {
        return res.status(404).json({
          error:
            "Commande introuvable.",
        });
      }

      res.json({
        order,
      });
    } catch (err) {
      console.error(
        "Erreur récupération commande :",
        err
      );

      res.status(500).json({
        error:
          "Impossible de récupérer la commande.",
      });
    }
  }
);

// ============================================================
// AJOUTER UN NUMÉRO DE SUIVI
// ============================================================
//
// IMPORTANT :
// Le numéro doit être le vrai numéro fourni
// par bpost ou Mondial Relay.
//
// Cette route ne fabrique aucun faux numéro.
// ============================================================

app.post(
  "/orders/:orderId/tracking",
  authenticateSeller,
  (req, res) => {
    try {
      const {
        carrier,
        trackingNumber,
        status,
      } = req.body;

      const allowedCarriers = [
        "bpost",
        "mondialrelay",
      ];

      if (
        !allowedCarriers.includes(
          carrier
        )
      ) {
        return res.status(400).json({
          error:
            "Transporteur invalide. Utilise bpost ou mondialrelay.",
        });
      }

      if (
        typeof trackingNumber !==
          "string" ||
        trackingNumber.trim()
          .length < 3
      ) {
        return res.status(400).json({
          error:
            "Numéro de suivi invalide.",
        });
      }

      const orders = getOrders();

      const index =
        orders.findIndex(
          (order) =>
            order.id ===
            req.params.orderId
        );

      if (index === -1) {
        return res.status(404).json({
          error:
            "Commande introuvable.",
        });
      }

      const cleanTrackingNumber =
        trackingNumber.trim();

      orders[index].shipping = {
        carrier,

        trackingNumber:
          cleanTrackingNumber,

        trackingUrl:
          getTrackingUrl(
            carrier,
            cleanTrackingNumber
          ),

        status:
          status || "shipped",
      };

      orders[index].updatedAt =
        new Date().toISOString();

      saveOrders(orders);

      res.json({
        ok: true,
        order: orders[index],
      });
    } catch (err) {
      console.error(
        "Erreur ajout suivi :",
        err
      );

      res.status(500).json({
        error:
          "Impossible d'enregistrer le suivi.",
      });
    }
  }
);

// ============================================================
// MODIFIER LE STATUT D'EXPÉDITION
// ============================================================

app.patch(
  "/orders/:orderId/shipping-status",
  authenticateSeller,
  (req, res) => {
    try {
      const { status } =
        req.body;

      const allowedStatuses = [
        "not_shipped",
        "label_created",
        "shipped",
        "in_transit",
        "delivered",
        "cancelled",
      ];

      if (
        !allowedStatuses.includes(
          status
        )
      ) {
        return res.status(400).json({
          error:
            "Statut d'expédition invalide.",
        });
      }

      const orders = getOrders();

      const index =
        orders.findIndex(
          (order) =>
            order.id ===
            req.params.orderId
        );

      if (index === -1) {
        return res.status(404).json({
          error:
            "Commande introuvable.",
        });
      }

      if (
        !orders[index].shipping
      ) {
        orders[index].shipping = {};
      }

      orders[index].shipping.status =
        status;

      orders[index].updatedAt =
        new Date().toISOString();

      saveOrders(orders);

      res.json({
        ok: true,
        order: orders[index],
      });
    } catch (err) {
      console.error(
        "Erreur modification statut :",
        err
      );

      res.status(500).json({
        error:
          "Impossible de modifier le statut.",
      });
    }
  }
);

// ============================================================
// SUIVI CLIENT
// ============================================================

// Public : un client peut consulter son suivi
app.get(
  "/tracking/:orderId",
  (req, res) => {
    try {
      const orders = getOrders();

      const order = orders.find(
        (item) =>
          item.id ===
          req.params.orderId
      );

      if (!order) {
        return res.status(404).json({
          error:
            "Commande introuvable.",
        });
      }

      res.json({
        orderId: order.id,

        shipping:
          order.shipping || {
            carrier: null,
            trackingNumber: null,
            trackingUrl: null,
            status: "not_shipped",
          },
      });
    } catch (err) {
      console.error(
        "Erreur récupération suivi :",
        err
      );

      res.status(500).json({
        error:
          "Impossible de récupérer le suivi.",
      });
    }
  }
);

// ============================================================
// CRÉATION D'EXPÉDITION
// ============================================================
//
// Cette route est préparée pour la connexion aux API
// officielles bpost / Mondial Relay.
//
// Elle ne crée PAS encore une vraie étiquette.
// ============================================================

app.post(
  "/shipping/create",
  authenticateSeller,
  async (req, res) => {
    try {
      const {
        carrier,
        orderId,
      } = req.body;

      if (
        ![
          "bpost",
          "mondialrelay",
        ].includes(carrier)
      ) {
        return res.status(400).json({
          error:
            "Transporteur invalide.",
        });
      }

      if (!orderId) {
        return res.status(400).json({
          error:
            "orderId obligatoire.",
        });
      }

      const orders = getOrders();

      const order = orders.find(
        (item) =>
          item.id === orderId
      );

      if (!order) {
        return res.status(404).json({
          error:
            "Commande introuvable.",
        });
      }

      return res.status(501).json({
        error:
          "Création automatique de l'expédition non configurée. Il faut connecter les identifiants/API officiels du transporteur.",

        carrier,

        orderId,
      });
    } catch (err) {
      console.error(
        "Erreur création expédition :",
        err
      );

      res.status(500).json({
        error:
          "Impossible de créer l'expédition.",
      });
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

app.listen(
  PORT,
  () => {
    console.log(
      `Serveur démarré sur le port ${PORT}`
    );
  }
);
