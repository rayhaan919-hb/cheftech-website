# ChefTech — Secure Initial Owner Bootstrap Guide

This document describes the security architecture and step-by-step procedure for initializing the first **Owner** account in ChefTech.

---

## 1. Security Architecture Principles

In ChefTech, **privilege escalation prevention** is enforced at the database level:

1. **Client Metadata Untrusted**: Public user registrations through Supabase Auth (`supabase.auth.signUp()`) **never** grant privileged roles (`OWNER`, `MANAGER`, `CASHIER`, `WAITER`). The database trigger `handle_new_user()` strictly defaults all new accounts to `CUSTOMER`, ignoring any user-supplied `role: "OWNER"` metadata.
2. **Atomic One-Time Bootstrap**: Elevation of the initial Owner account is handled exclusively through the database procedure `public.bootstrap_initial_owner(p_email)`.
3. **Race-Safe Concurrency Locking**: The bootstrap procedure executes with `perform 1 from public.profiles where role = 'OWNER' for update`. If an Owner already exists, any further attempt is permanently rejected.
4. **Immutable Audit Trail**: Every role change is logged to the `public.audit_logs` table with actor, timestamp, and target details.

---

## 2. Bootstrapping Your Initial Owner Account

You have two simple, secure methods to bootstrap your first Owner account:

### Method A: Automated via POS First-Run Wizard (Recommended)
1. Launch the ChefTech POS application in your browser (`http://localhost:5173`).
2. When prompted by the **First-Run Owner Setup Wizard**, enter your Owner details:
   - **Username** (e.g. `owner`)
   - **Full Name** (e.g. `John Doe`)
   - **Email** (e.g. `owner@yourrestaurant.com`)
   - **Password** (minimum 8 characters)
   - **Owner PIN** (4–8 digits)
3. Click **"Complete Setup"**.
4. The wizard creates your local encrypted credentials (PBKDF2-SHA256 with 100,000 iterations) and calls `public.bootstrap_initial_owner()` in Supabase to promote your account to `OWNER`.

---

### Method B: Manual Bootstrap via Supabase SQL Editor
If you registered an account via the website or Supabase Auth dashboard and need to elevate it to the initial Owner:

1. Register your account in Supabase (or on the website).
2. Open your [Supabase Dashboard](https://supabase.com/dashboard) and go to the **SQL Editor**.
3. Run the following command:
```sql
SELECT public.bootstrap_initial_owner('owner@yourrestaurant.com');
```
4. If successful, the query returns:
```json
{
  "success": true,
  "userId": "e83f...",
  "email": "owner@yourrestaurant.com",
  "role": "OWNER",
  "message": "Initial Owner successfully bootstrapped."
}
```
5. If an Owner already exists in the system, the procedure safely throws an exception:
```
ERROR: Initial owner setup has already been completed. An OWNER account already exists in this system.
```

---

## 3. Creating Additional Staff Accounts

Once the Owner account exists:
- The Owner can create and manage additional employees (`MANAGER`, `CASHIER`, `WAITER`) via the POS **Staff Management Modal** or the Website **Admin Dashboard**.
- Non-Owner accounts are blocked by Row Level Security (RLS) and the `enforce_profile_security()` trigger from changing roles or modifying active statuses.
- The system prevents demoting or deactivating the last active Owner account.
