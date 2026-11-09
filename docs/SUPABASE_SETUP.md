# ChefTech — Supabase Cloud Architecture & Setup Guide

This guide details the complete configuration of the **Supabase PostgreSQL Database**, **Row Level Security (RLS)**, **Realtime engine**, and **Edge Functions** powering the ChefTech platform.

---

## 1. Architecture Overview

```
                      ┌─────────────────────────────────┐
                      │    Customer Ordering Website    │
                      │  (Vanilla JS / Tailwind / Edge) │
                      └───────────────┬─────────────────┘
                                      │
                         REST API / RPC / Realtime
                                      │
                                      ▼
                      ┌─────────────────────────────────┐
                      │      Supabase Cloud Platform    │
                      │  ┌───────────────────────────┐  │
                      │  │   PostgreSQL Database     │  │
                      │  │  - Row Level Security     │  │
                      │  │  - Inventory Movement Log │  │
                      │  │  - Transactional Checkout │  │
                      │  │  - Loyalty Ledger         │  │
                      │  └───────────────────────────┘  │
                      │  ┌───────────────────────────┐  │
                      │  │   Serverless Edge Funcs   │  │
                      │  │  - place-order            │  │
                      │  │  - track-order            │  │
                      │  │  - consume-coupon         │  │
                      │  │  - issue-loyalty          │  │
                      │  └───────────────────────────┘  │
                      └───────────────▲─────────────────┘
                                      │
                         REST API / RPC / Realtime
                                      │
                      ┌───────────────┴─────────────────┐
                      │          ChefTech POS           │
                      │ (React 19 / Dexie / Offline DB) │
                      └─────────────────────────────────┘
```

---

## 2. Migration Order

ChefTech migrations are strictly forward-only:

1. **`20261108000000_initial_schema_and_rls.sql`**:
   - Creates custom enum `user_role` (`OWNER`, `MANAGER`, `CASHIER`, `WAITER`, `CUSTOMER`).
   - Creates core tables: `profiles`, `categories`, `menu_items`, `inventory`, `recipes`, `coupons`, `online_orders`, `online_order_items`, `sales`, `sale_items`, `refunds`, `customers`, `shifts`, `expenses`, `staff`, `audit_logs`, `settings`, `banners`, `loyalty_rewards`.
   - Enables Row Level Security (RLS) on all tables.
   - Configures the `supabase_realtime` publication for instant menu & order updates.

2. **`20261109000000_security_owner_bootstrap_and_checkout.sql`**:
   - Adds `idempotency_key` constraint on `online_orders`.
   - Creates `inventory_movements` ledger table for auditing every stock movement.
   - Creates `loyalty_transactions` ledger table.
   - Replaces user creation trigger with secure, un-spoofable `handle_new_user()`.
   - Adds atomic `public.bootstrap_initial_owner(email)` procedure.
   - Adds trusted transactional checkout procedure `public.process_online_order_checkout(...)`.

---

## 3. Row Level Security (RLS) Matrix

| Table | Anonymous / Public | Customer | Staff (Cashier/Waiter) | Admin (Manager/Owner) |
| :--- | :---: | :---: | :---: | :---: |
| `menu_items` | Read | Read | Read | Full Access |
| `categories` | Read | Read | Read | Full Access |
| `banners` | Read | Read | Read | Full Access |
| `loyalty_rewards` | Read | Read | Read | Full Access |
| `online_orders` | Denied | Own Orders Only | Read & Update Status | Full Access |
| `sales` | Denied | Denied | Read & Insert | Full Access |
| `inventory` | Denied | Denied | Read & Stock Update | Full Access |
| `recipes` | Denied | Denied | Read | Full Access |
| `expenses` | Denied | Denied | Denied | Full Access |
| `staff` | Denied | Denied | Denied | Full Access |
| `audit_logs` | Denied | Denied | Insert Only | Read Only (Immutable) |

---

## 4. Edge Functions Configuration

Deploy Edge Functions using the Supabase CLI:

```bash
supabase functions deploy place-order --no-verify-jwt
supabase functions deploy track-order --no-verify-jwt
supabase functions deploy consume-coupon --no-verify-jwt
supabase functions deploy issue-loyalty --no-verify-jwt
```

### Environment Secrets for Edge Functions
Edge Functions automatically inherit `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` within the Supabase environment.

To configure allowed origins for production CORS:
```bash
supabase secrets set ALLOWED_ORIGINS="https://your-restaurant-domain.com,https://pos.your-restaurant-domain.com"
```
