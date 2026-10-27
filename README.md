# TradeDesk (full stack)
Express + SQLite (better-sqlite3) + JWT backend, responsive frontend in public/index.html.

## Run
    npm install
    JWT_SECRET=your-long-random-string npm start      # http://localhost:4000

Open http://localhost:4000, create an account, add commodities.
The same page falls back to browser storage if no backend is reachable.

## API (commodity and profile routes need Authorization: Bearer <token>)
POST /api/auth/signup | POST /api/auth/login
GET/PUT /api/profile
GET /api/commodities | POST | PUT /:id
DELETE /api/commodities/:id      -> SOFT delete (sets deleted_at)
POST /api/commodities/:id/restore

## Deploy on AWS (simple)
EC2 t3.micro (Ubuntu): install Node 20+, copy this folder, npm install --omit=dev,
set JWT_SECRET and PORT=80 (or put nginx in front), run with pm2.
The SQLite file (tradedesk.db) lives next to server.js; back it up or move to RDS Postgres later.
