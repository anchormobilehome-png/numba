# Numba: website + backend in one repo

Repo layout (everything at the repo root):

    server.js  provider.js  migrate.js  schema.sql  package.json  render.yaml  .env.example  .gitignore
    public/index.html        <- the website (served by server.js)

## Deploy on Render
1. Push this folder to GitHub (index.html must be at `public/index.html`).
2. Render dashboard > New > Blueprint > pick the repo (it reads render.yaml and creates the web service + Postgres).
   Or New > Web Service manually: Build `npm install`, Start `npm run migrate && npm start`, Health check `/health`.
3. Environment variables: PAYSTACK_SECRET_KEY, APP_URL (https://your-service.onrender.com or your domain),
   ADMIN_EMAIL (the email you will register with), PROVIDER_API_KEY. DATABASE_URL and JWT_SECRET are automatic with the blueprint.
   If you use Render's EXTERNAL database URL, also set PGSSL=true.
4. Paystack dashboard > Settings > API Keys & Webhooks: Webhook URL = https://YOUR-APP/webhooks/paystack
5. Open the site, register with ADMIN_EMAIL, fund ₦100 with a Paystack test key first.

## Local run
npm install, copy .env.example to .env, `npm run migrate`, `npm start`, open http://localhost:3000
