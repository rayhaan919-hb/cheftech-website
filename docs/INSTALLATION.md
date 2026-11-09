# ChefTech — Complete Installation & Setup Guide

Welcome to **ChefTech**, the professional commercial restaurant management suite comprising:
1. **ChefTech POS**: High-performance, offline-capable restaurant Point of Sale with inventory, recipe tracking, staff roles, and analytics.
2. **ChefTech Website**: Customer-facing online ordering storefront and administrative management portal with live order tracking, promotional coupons, and loyalty rewards.

Both applications communicate seamlessly via **Supabase PostgreSQL & Edge Functions**.

---

## 1. System Requirements

- **Operating System**: Windows 10/11, macOS (Intel or Apple Silicon), or Linux (Ubuntu 20.04+ recommended).
- **Node.js**: Node.js `v20.x` or `v22.x` (LTS recommended).
- **Package Manager**: `npm` (v10+), `pnpm`, or `yarn`.
- **Database / Backend**: Free or Pro [Supabase](https://supabase.com) account.
- **Web Browser**: Modern Chromium-based browser (Chrome, Edge, Brave), Firefox, or Safari.

---

## 2. Setting Up Your Supabase Project

1. Log in to your [Supabase Dashboard](https://supabase.com/dashboard) and click **"New Project"**.
2. Choose your organization, assign a project name (e.g. `my-restaurant-cheftech`), select your database region, and generate a strong database password.
3. Wait 1–2 minutes for the database cluster to finish provisioning.

### Step 2.1: Run Database Schema Migrations
1. In your Supabase Dashboard, navigate to the **SQL Editor** (left sidebar).
2. Open `supabase/migrations/20261108000000_initial_schema_and_rls.sql` from the repository.
3. Paste the complete SQL into the Supabase SQL Editor and click **Run**.
4. Next, open and run `supabase/migrations/20261109000000_security_owner_bootstrap_and_checkout.sql` to apply the latest transactional checkout functions, ledgers, and security bootstrap procedure.
5. Confirm that tables (`menu_items`, `inventory`, `online_orders`, `sales`, `profiles`, etc.) appear under **Database -> Tables**.

### Step 2.2: Configure Supabase Authentication
1. Go to **Authentication -> Providers -> Email** in your Supabase Dashboard.
2. Ensure **"Enable Email provider"** is turned **ON**.
3. Under **Authentication -> Email Templates**, customize your verification and password reset emails to match your restaurant branding.

### Step 2.3: Retrieve Your API Credentials
1. Navigate to **Project Settings -> API**.
2. Note down:
   - **Project URL** (e.g. `https://xyzcompany.supabase.co`)
   - **`anon` Public Key** (e.g. `eyJhbGciOi...`)
   - **`service_role` Secret Key** (keep this confidential; only needed when deploying Edge Functions or server-side automation).

---

## 3. Deploying Supabase Edge Functions

ChefTech utilizes 4 lightweight serverless Edge Functions for financial security, guest order tracking, coupon validation, and loyalty rewards:

- `place-order`: Executes transactional checkout inside PostgreSQL with price verification, stock locking, and delivery minimum enforcement.
- `track-order`: Provides guest order tracking verified by phone suffix without leaking customer PII.
- `consume-coupon`: Validates promotional discount codes and single-use loyalty coupons.
- `issue-loyalty`: Issues loyalty points upon order completion with staff RBAC verification.

### Deployment via Supabase CLI
```bash
# 1. Install Supabase CLI (if not already installed)
npm install -g supabase

# 2. Log in to your Supabase account
supabase login

# 3. Link your local project
supabase link --project-ref your-project-id

# 4. Deploy all 4 functions with internal JWT verification handled inside the code
supabase functions deploy place-order --no-verify-jwt
supabase functions deploy track-order --no-verify-jwt
supabase functions deploy consume-coupon --no-verify-jwt
supabase functions deploy issue-loyalty --no-verify-jwt
```

---

## 4. Setting Up ChefTech POS

### Step 4.1: Install Dependencies
```bash
cd cheftech-pos
npm install
```

### Step 4.2: Configure Cloud Sync Credentials
Copy `.env.example` to `.env`:
```bash
cp .env.example .env
```
Fill in your credentials:
```env
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-public-key
```

### Step 4.3: Start the Development Server
```bash
npm run dev
```
The POS will launch at `http://localhost:5173`.

### Step 4.4: First-Run Owner Setup Wizard
When you open ChefTech POS for the first time, the secure **First-Run Owner Setup Wizard** will appear:
1. Enter your desired Owner username, display name, password (minimum 8 characters), and 4–8 digit Owner PIN.
2. Click **"Complete Setup"**.
3. ChefTech will create your local Owner account with PBKDF2-SHA256 encryption and register your Owner profile in Supabase.

---

## 5. Setting Up ChefTech Website & Admin Portal

### Step 5.1: Install Dependencies
```bash
cd cheftech-website
npm install
```

### Step 5.2: Configure Website Credentials
Open `config.js` and set your default project credentials:
```javascript
const DEFAULT_SUPABASE_URL = 'https://your-project.supabase.co';
const DEFAULT_SUPABASE_ANON_KEY = 'your-anon-public-key';
```
*(Alternatively, you can open the Website Admin Dashboard at `http://localhost:3000/admin.html` and click **"Cloud Setup"** to input your credentials directly from the browser).*

### Step 5.3: Start the Website Server
```bash
npm start
```
- **Customer Storefront**: `http://localhost:3000/`
- **Admin Management Portal**: `http://localhost:3000/admin.html`

---

## 6. Testing the End-to-End Workflow

1. Open `http://localhost:3000/admin.html` and sign in with your Owner credentials.
2. In the Admin Portal, add a Menu Item (e.g. *Zinger Burger* @ Rs. 650) with an image.
3. Open the customer storefront at `http://localhost:3000/`, add the item to your cart, and place an order.
4. Open the POS at `http://localhost:5173/`, click **"Online Orders"** in the sidebar.
5. You will see the incoming order with subtotal, items, and customer delivery details.
6. Click **"Accept"** to load the order into the POS cart and complete checkout.

---

## 7. Production Builds & Hosting

### Building POS for Production
```bash
cd cheftech-pos
npm run build
```
The production bundle is generated in `dist/`. You can host this static folder on **Cloudflare Pages**, **Vercel**, **Netlify**, or any Nginx/Apache web server.

### Hosting the Website
The website consists of static frontend assets (`index.html`, `admin.html`, `styles.css`, `appwebsite.js`) with an optional Node.js server (`server.js`). It can be hosted on **Vercel**, **Render**, **Railway**, or any standard Linux VPS.

---

## 8. Troubleshooting

| Issue | Resolution |
| :--- | :--- |
| **"Cloud 401" in POS** | Check your Supabase URL and Anon Key in `.env` or in the POS Settings modal. Ensure the user session is signed in. |
| **"Minimum order for delivery is Rs. 500"** | The default minimum delivery order threshold is Rs. 500 post-discount. Adjust this in POS Settings or ensure cart total meets Rs. 500. |
| **"Email not verified" on checkout** | Go to your inbox and confirm your email, or disable `require_email_verification` under Supabase Settings if you wish to allow unconfirmed checkouts. |
| **Offline mode operation** | ChefTech POS functions 100% offline using IndexedDB (Dexie). All offline sales and stock deductions are queued locally and automatically synchronized as soon as connectivity is restored. |
