// ============================================================
// Backend "market place shop" : Stripe + stockage des produits
// ============================================================
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

// La clé secrète Stripe est lue depuis les variables d'environnement
// Render (Settings > Environment > STRIPE_SECRET_KEY), jamais écrite ici.
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" })); // 10mb pour accepter les photos en base64

const PORT = process.env.PORT || 3000;
const PRODUCTS_FILE = path.join(__dirname, "products.json");

// ---------- Route de test ----------
app.get("/", (req, res) => {
  res.send("Backend market place shop : en ligne.");
});

// ---------- Paiement Stripe ----------
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
        unit_amount: Math.round(item.price * 100), // Stripe attend des centimes
      },
      quantity: item.qty || 1,
    }));

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items,
      success_url: successUrl,
      cancel_url: cancelUrl,
      shipping_address_collection: { allowed_countries: ["FR", "BE", "CH", "LU"] },
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("Erreur création session Stripe", err);
    res.status(500).json({ error: "Impossible de créer le paiement." });
  }
});

// ---------- Produits partagés ----------
// ⚠️ Sur le plan gratuit de Render, ce fichier peut être réinitialisé si le
// service redémarre après une inactivité (pas de disque permanent).
app.get("/products", (req, res) => {
  try {
    if (!fs.existsSync(PRODUCTS_FILE)) {
      return res.json({ products: [] });
    }
    const raw = fs.readFileSync(PRODUCTS_FILE, "utf8");
    res.json({ products: JSON.parse(raw) });
  } catch (err) {
    console.error("Erreur lecture products.json", err);
    res.status(500).json({ error: "Impossible de lire les produits." });
  }
});

app.post("/products", (req, res) => {
  try {
    const { products } = req.body;
    if (!Array.isArray(products)) {
      return res.status(400).json({ error: "Format invalide." });
    }
    fs.writeFileSync(PRODUCTS_FILE, JSON.stringify(products, null, 2));
    res.json({ ok: true });
  } catch (err) {
    console.error("Erreur écriture products.json", err);
    res.status(500).json({ error: "Impossible de sauvegarder les produits." });
  }
});

app.listen(PORT, () => {
  console.log(`Serveur démarré sur le port ${PORT}`);
});
