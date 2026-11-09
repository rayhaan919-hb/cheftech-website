# ChefTech — Restaurant Online Ordering Website & Admin Dashboard (Supabase Edition)

**ChefTech Ordering Website** is a fast, mobile-first online ordering storefront (`index.html`) and companion web Admin Dashboard (`admin.html`) powered by **Supabase (PostgreSQL, Auth, Realtime, and Edge Functions)** and **Tailwind CSS**. It shares the same Supabase backend as **ChefTech POS** so menu items, stock availability, online orders, coupons, and customer loyalty rewards stay synchronized in real time.

---

## Key Features

- **Customer Storefront (`index.html` + `appwebsite.js`)**:
  - Responsive category filtering, live menu cards with **Sold Out** badges (`menu_items.available === false`), and persistent cart drawer.
  - Delivery & Takeaway checkout with post-discount minimum delivery enforcement (`Rs. 500`).
  - **Server-Verified Checkout**: Orders are submitted through the `place-order` Supabase Edge Function, which verifies email confirmation, re-computes item prices from `public.menu_items`, checks recipe stock against `public.inventory`, atomically consumes coupons, and records the order.
  - **Privacy-Safe Order Tracking**:
    - Signed-in customers automatically track their active order in real time via Supabase Realtime (`postgres_changes`).
    - Guests can track an order via the `track-order` Edge Function by providing **both** their **Order ID** and **Customer Phone Number** (returns sanitized status steps without exposing PII).
  - **Unified Loyalty & Coupons (`My Coupons` modal)**: Displays `profiles.loyalty_points` balance, `profiles.order_count % 10` progress toward the automatic 10%-off loyalty coupon, active coupons, and total savings history.
- **Admin Dashboard (`admin.html` + `adminwebsite.js`)**:
  - Role-gated to `OWNER` and `MANAGER` accounts verified against `public.profiles.role` (and enforced by PostgreSQL Row-Level Security).
  - Live Order Queue with synthesized Web Audio API notification chime (`AudioContext`), status progression (`PENDING → ACCEPTED → PREPARING → OUT_FOR_DELIVERY → COMPLETED`), and automatic loyalty issuance via the `issue-loyalty` Edge Function.
  - Coupon creation & management (clamped `1%–100%`, with confirmation prompt for discounts `> 50%`).
  - Promotional Banner Carousel management (`public.banners`).
  - Customer Directory with masked phone numbers (`****1234`, click-to-reveal) and a toggle for requiring customer email verification before checkout (`settings.require_email_verification`).

---

## Documentation Index

Comprehensive production documentation is located in the [`docs/`](./docs) directory:
- [**Installation & Deployment Guide**](./docs/INSTALLATION.md) — Step-by-step setup for development, staging, and production hosting.
- [**Owner Account & Staff Setup**](./docs/OWNER_SETUP.md) — Secure Owner bootstrap procedure, role hierarchy, and permissions.
- [**Supabase Configuration Guide**](./docs/SUPABASE_SETUP.md) — Database schema, migrations, RLS policies, and Edge Functions deployment.
- [**Security & Threat Model**](./docs/SECURITY.md) — Defense-in-depth architecture, CORS allowlists, anti-tampering, and audit logging.
- [**Backup & Disaster Recovery**](./docs/BACKUP_AND_RECOVERY.md) — Cloud backups, point-in-time recovery, and restore procedures.

---

## Quick Start

### 1. Configure Supabase Credentials

You can configure your Supabase project in any of three ways:

1. **Edit `config.js`**:
   ```js
   const DEFAULT_SUPABASE_URL = "https://your-project-id.supabase.co";
   const DEFAULT_SUPABASE_ANON_KEY = "your-public-anon-key";
   ```
2. **Use the Admin Cloud Setup Modal**:
   Open `admin.html` in your browser, click **Cloud Setup**, and paste your **Supabase Project URL** and **Supabase Anon Key**.
3. **Environment Injection**:
   Copy `.env.example` to `.env` if deploying with a build step that injects `window.__SUPABASE_CONFIG__`.

> **Security Warning**: Only use your public `anon` key in the browser. **Never** place your `service_role` key in `config.js` or any client-side file.

### 2. Apply Database Schema & Deploy Edge Functions

If you have not already set up the shared Supabase project from the POS repository:

1. Open your **Supabase Dashboard → SQL Editor** and run the migrations in order:
   - [`supabase/migrations/20261108000000_initial_schema_and_rls.sql`](./supabase/migrations/20261108000000_initial_schema_and_rls.sql)
   - [`supabase/migrations/20261109000000_security_owner_bootstrap_and_checkout.sql`](./supabase/migrations/20261109000000_security_owner_bootstrap_and_checkout.sql)
2. Deploy the 4 Edge Functions using the Supabase CLI:
   ```bash
   supabase login
   supabase link --project-ref <your-project-ref>

   supabase functions deploy place-order
   supabase functions deploy consume-coupon
   supabase functions deploy issue-loyalty
   supabase functions deploy track-order
   ```
3. **Bootstrap Initial Owner Account**:
   Sign up your owner account, then run in the SQL Editor:
   ```sql
   SELECT public.bootstrap_initial_owner('your-owner-email@example.com');
   ```

### 3. Build Tailwind CSS (When Customizing Styles)

A pre-built, minified `styles.css` is already included so you can host the directory directly on any static host (Vercel, Netlify, Cloudflare Pages, Nginx, or Apache). To rebuild `styles.css` after editing HTML/JS classes:

```bash
npm install
npm run build
```

---

## Unified Loyalty System (`M-01`)

- Every completed online or POS order awards **1 loyalty point per Rs. 100** spent (`profiles.loyalty_points`) and increments `profiles.order_count`.
- On every **10th completed order**, the `issue-loyalty` Edge Function automatically generates a single-use **10% off coupon (`LOYALxxxxxx`)** assigned to the customer's account.

---

## Privacy & Customer Data Deletion (`GDPR / PECA Compliance`)

- Customer phone numbers in the Admin Dashboard are masked by default (`****1234`) and only revealed on click.
- Guest order tracking (`track-order` Edge Function) requires both the Order ID and matching phone number and never returns customer names, phone numbers, or addresses.
- **Customer Data Deletion Procedure**: To fulfill a customer's data erasure request, run the following in the **Supabase SQL Editor**:
  ```sql
  UPDATE public.online_orders
  SET customer_name = 'REDACTED',
      customer_phone = 'REDACTED',
      customer_address = 'REDACTED',
      customer_id = NULL
  WHERE customer_phone = '<customer-phone>';

  DELETE FROM public.customers WHERE phone = '<customer-phone>';
  ```
  Then delete the user's account under **Supabase Dashboard → Authentication → Users**.
