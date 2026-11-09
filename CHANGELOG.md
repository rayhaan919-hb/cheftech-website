# Changelog

All notable changes to **ChefTech Ordering Website** are documented in this file.

## [1.1.0] - 2026-11-09

### Security & Architecture Hardening
- **Atomic Concurrency-Safe Checkout Integration**:
  - Storefront checkout (`appwebsite.js`) now generates and transmits an `Idempotency-Key` header with every checkout submission.
  - Integration with PostgreSQL stored procedure `public.process_online_order_checkout` ensures deadlock-free inventory row locking (`ORDER BY id FOR UPDATE`), atomic coupon consumption, and atomic loyalty deductions.
  - Zero duplicate orders on network retries or double clicks.
- **Secure Owner & Staff Authentication**:
  - Removed metadata-based role assignment from `handle_new_user()`; public signups strictly default to `CUSTOMER`.
  - Added `public.bootstrap_initial_owner` support and audit logging for administrative role changes.
  - Protected against privilege escalation via frontend request tampering.
- **Edge Function Hardening**:
  - Configured explicit configurable CORS allowlist across `place-order`, `consume-coupon`, `issue-loyalty`, and `track-order`.
  - Strict Bearer token authentication returning `401 Unauthorized` on expired/invalid sessions instead of silently downgrading to guest mode.
- **Automated Testing & CI/CD**:
  - Added syntax verification test script (`npm test`) using Node.js `--check`.
  - Added GitHub Actions CI workflow (`.github/workflows/ci.yml`) validating syntax, linting, and Tailwind CSS builds.
- **Documentation**:
  - Added enterprise guides: `docs/INSTALLATION.md`, `docs/OWNER_SETUP.md`, `docs/SUPABASE_SETUP.md`, `docs/SECURITY.md`, and `docs/BACKUP_AND_RECOVERY.md`.

## [1.0.0] - 2026-11-08

### Added
- **Supabase Online Ordering Storefront (`index.html`, `appwebsite.js`)**:
  - Live category and menu loading from Supabase `categories` and `menu_items` with real-time **Sold Out** badges.
  - Delivery & Takeaway checkout with post-discount minimum delivery order validation (`Rs. 500`).
  - Authoritative server-side order creation via the `place-order` Supabase Edge Function.
  - Server-side coupon validation (`consume-coupon` Edge Function) and unified loyalty progress (`profiles.loyalty_points` + `profiles.order_count`).
  - Privacy-preserving guest order tracking (`track-order` Edge Function requiring both Order ID and Customer Phone Number) and live Supabase Realtime order status timeline for signed-in customers.
- **Restaurant Admin Dashboard (`admin.html`, `adminwebsite.js`)**:
  - Strict role verification against `public.profiles.role IN ('OWNER', 'MANAGER')` before mounting any admin controls.
  - Live Order Queue with Supabase Realtime notifications and synthesized Web Audio API chime.
  - Coupon Management with `1%–100%` discount enforcement and `>50%` confirmation prompt.
  - Promotional Banner Carousel manager (`public.banners`).
  - Customer Directory with masked phone numbers (`****1234` with click-to-reveal) and email verification toggle (`settings.require_email_verification`).
  - Built-in Cloud Setup modal for configuring Supabase Project URL and Anon Key.
