# PokéScan

Scanner de cartes Pokémon (FR) sans abonnement : une page web qui s'ouvre dans Safari et s'ajoute à l'écran d'accueil.

- `index.html`, `app.js`, `style.css` : l'app
- `scan.js` : reconnaissance des cartes (empreinte visuelle + lecture du numéro)
- `tools/build_db.py` : construit `db/` (empreintes de toutes les cartes FR de TCGdex)
- `.github/workflows/build-db.yml` : reconstruit la base chaque lundi (nouvelles cartes)

Ce dépôt ne contient aucune donnée personnelle : la collection est dans le dépôt privé `pokescan-data`.
Données des cartes et prix : [TCGdex](https://tcgdex.dev) (prix Cardmarket).
