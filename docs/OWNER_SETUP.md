# ChefTech — Secure Initial Owner Bootstrap Guide

This document describes the security architecture and step-by-step procedure for initializing the first **Owner** account in ChefTech.

---

## 1. Security Architecture Principles

In ChefTech, **privilege escalation prevention** is enforced at the database level:

1. **Client Metadata Untrusted**: Public user registrations through Supabase Auth (`supabase.auth.signUp()`) **never** grant privileged roles (`OWNER`, `MANAGER`, `CASHIER`, `WAITER`). The database trigger `handle_new_user()` strictly defaults all new accounts to `CUSTOMER`, ignoring any user-supplied `role: "OWNER"` metadata.
2. **Restricted Administrative Execution**: `EXECUTE` privileges on `public.bootstrap_initial_owner(p_email)` are strictly revoked from `public`, `anon`, and `authenticated`. Only `service_role` and PostgreSQL superusers can execute the bootstrap procedure. Normal authenticated customers cannot invoke or abuse this procedure.
3. **Global Transaction Advisory Locking**: The bootstrap procedure executes with `perform pg_advisory_xact_lock(hashtext('cheftech_owner_bootstrap_lock'));`. This acquires a genuine global transaction-level advisory lock in PostgreSQL, serializing all concurrent attempts. Simultaneous requests cannot create multiple Owners under any race condition.
4. **Permanent Subsequent Rejection**: Once an active Owner exists, any subsequent bootstrap call is permanently rejected with an exception (`Initial owner setup has already been completed`).
5. **Immutable Audit Trail**: Every role change is logged to the `public.audit_logs` table with actor, timestamp, and target details.

---

## 2. Bootstrapping Your Initial Owner Account

Follow these steps to establish your initial Owner account:

### Step 1: Register Your Owner Account
1. Register your account using your restaurant owner email address via the website (`index.html`) or the POS Cloud Setup modal.
2. At this point, your account is created with the default safe role (`CUSTOMER`).

### Step 2: Elevate to Initial Owner via Supabase SQL Editor
Because `authenticated` users cannot elevate themselves, execute the one-time bootstrap procedure directly in your Supabase project as an administrator:

1. Log in to your [Supabase Dashboard](https://supabase.com/dashboard) and select your project.
2. Navigate to the **SQL Editor**.
3. Run the bootstrap procedure:
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

### Local POS First-Run Wizard
When launching the POS for the first time on a local terminal (`http://localhost:5173`), the First-Run Setup Wizard creates your local offline credentials (encrypted with PBKDF2-SHA256, 100,000 iterations) and 4–8 digit PIN. When paired with cloud sync, run Step 2 above to elevate your cloud profile.

---

## 3. Creating Additional Staff Accounts

Once the Owner account exists:
- The Owner can create and manage additional employees (`MANAGER`, `CASHIER`, `WAITER`) via the POS **Staff Management Modal** or the Website **Admin Dashboard**.
- Non-Owner accounts are blocked by Row Level Security (RLS) and the `enforce_profile_security()` trigger from changing roles or modifying active statuses.
- The system prevents demoting or deactivating the last active Owner account.
