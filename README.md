# LinkExtract

1. `cp server/.env.example server/.env` (optional: set TIMEZONE)
2. `npm run install:all`
3. `npm run dev` → open http://localhost:5173
4. Production: `npm run build && npm start` → http://localhost:5000 (Express serves the built client)

Requires Node 18+. No database: nothing is stored.
