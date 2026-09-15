// ============================================================
// À AJOUTER dans ton server.js existant sur Render
// (celui qui gère déjà /create-checkout-session pour Stripe)
// ============================================================
//
// Ce code stocke la liste des produits dans un simple fichier JSON
// sur le serveur. C'est suffisant pour une petite boutique.
//
// ⚠️ Sur le plan gratuit de Render, le disque n'est PAS permanent :
// il peut être réinitialisé si le service redémarre après une
// période d'inactivité. Pour une solution 100% fiable, il faudrait
// une vraie base de données (Render propose des bases Postgres
// gratuites) — dis-moi si tu veux que je fasse ça à la place.

const fs = require("fs");
const path = require("path");

const PRODUCTS_FILE = path.join(__dirname, "products.json");

// Récupérer les produits
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

// Sauvegarder les produits (remplace la liste complète)
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

// ⚠️ Assure-toi que ton server.js utilise déjà :
//   app.use(express.json({ limit: "10mb" }));  // pour accepter les photos en base64
//   const cors = require("cors"); app.use(cors());
