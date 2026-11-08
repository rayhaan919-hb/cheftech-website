# Changelog

All notable changes to **ChefTech Ordering Website** are documented in this file.

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
