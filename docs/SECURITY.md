# ChefTech — Security Architecture & Threat Model

This document outlines the security controls, threat mitigations, and compliance architecture implemented across the ChefTech POS and Online Ordering platform.

---

## 1. Security Architecture Principles

ChefTech adheres to a **defense-in-depth** model:

```
┌─────────────────────────────────────────────────────────────┐
│                 Client Layer (Browser / POS)                │
│  - No privileged decisions made in frontend                 │
│  - Session integrity sealed with HMAC-SHA256                │
│  - PBKDF2-SHA256 password hashing (100k rounds + salt)       │
│  - 5-attempt / 5-minute brute-force login lockout           │
└──────────────────────────────┬──────────────────────────────┘
                               │ HTTPS / TLS 1.3
                               ▼
┌─────────────────────────────────────────────────────────────┐
│               Edge Function Layer (Deno Runtime)            │
│  - Explicit configurable CORS allowlist                     │
│  - 512KB payload size protection                            │
│  - Strict Bearer token validation (no silent downgrades)    │
│  - Phone suffix verification for order tracking             │
└──────────────────────────────┬──────────────────────────────┘
                               │ Internal Encrypted Channel
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                 Database Layer (PostgreSQL)                 │
│  - Row Level Security (RLS) on all 24 tables                │
│  - Atomic transactions (`process_online_order_checkout`)    │
│  - Deadlock-free inventory row locking (`FOR UPDATE`)       │
│  - Immutable audit logs (no UPDATE or DELETE policies)      │
│  - Zero privilege escalation via signup metadata            │
└─────────────────────────────────────────────────────────────┘
```

---

## 2. Key Security Mitigations

### 2.1 Privilege Escalation Prevention
- **Metadata Sniffing Removed**: The database trigger `handle_new_user()` strictly defaults every public user to `CUSTOMER`, ignoring any client-supplied `role: "OWNER"` in `raw_user_meta_data`.
- **Atomic Bootstrap**: Elevation to `OWNER` requires calling `public.bootstrap_initial_owner(email)`. The procedure acquires a table lock on `profiles` and permanently rejects any further elevation attempts once an Owner exists.
- **Immutable Roles**: The database trigger `enforce_profile_security()` forbids any non-Owner from modifying roles or active status, prevents deactivating the last active Owner, and logs every role alteration to `audit_logs`.

### 2.2 Client-Side Session Tampering Protection
- Storing a role in `sessionStorage` or `localStorage` alone is vulnerable to browser DevTools modification (`sessionStorage.setItem('loggedUser', ...)`).
- ChefTech mitigates this by computing an **HMAC-SHA256 signature** over the session payload (`username | role | issuedAt`) using a cryptographically random, per-device key stored in Dexie settings.
- If DevTools tampering is detected, the session is instantly invalidated and logged as `SECURITY_SESSION_TAMPERED`.
- In online mode, the session is additionally re-validated against the server-side `profiles` table.

### 2.3 Transactional Checkout & Price Tamper Protection
- Online orders **never** trust browser-supplied prices, subtotals, or discount totals.
- All checkout operations execute inside the atomic PostgreSQL transaction `process_online_order_checkout`:
  1. Authoritative prices and modifier add-ons are fetched from `menu_items`.
  2. Availability is checked (`available = true`).
  3. Recipe ingredient rows in `inventory` are locked in sorted order (`ORDER BY id FOR UPDATE`) to prevent overselling and eliminate concurrency deadlocks.
  4. Stock is verified; if insufficient, the transaction rolls back with a clean error.
  5. Coupons are locked, validated, clamped (0–100%), and marked used atomically.
  6. Loyalty points are verified and deducted atomically.
  7. If any step fails, the entire transaction rolls back—preventing orphaned orders, phantom inventory deductions, or stolen coupons.

### 2.4 Idempotency Protection
- Every checkout submission accepts an `Idempotency-Key` header stored in `online_orders.idempotency_key` with a database `UNIQUE` constraint.
- Duplicate or retried requests replay the existing order without re-charging or double-deducting inventory.

### 2.5 Customer PII Protection
- Customer phone numbers in the Admin Portal are masked by default (`0300-***4567`).
- The `track-order` Edge Function verifies order ownership using the last 7 digits of the customer's phone number and returns only non-PII order status and line item names. Customer address and payment details are never leaked.

### 2.6 Immutable Audit Logging
- The `public.audit_logs` table has RLS policies permitting `SELECT` to Admins and `INSERT` to staff.
- **No `UPDATE` or `DELETE` policies exist**, ensuring that audit records cannot be altered or removed by employees.
