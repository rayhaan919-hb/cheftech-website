# ChefTech — Backup & Disaster Recovery Guide

This guide describes backup strategies and recovery procedures for both the **Cloud Supabase Database** and the **Local POS Offline Database**.

---

## 1. Cloud Database Backups (Supabase)

Supabase PostgreSQL provides enterprise-grade data durability:

### Automatic Daily Backups
- **Free Tier**: Supabase takes daily backups of your database schema and data, retained for 1 day.
- **Pro / Enterprise Tier**: Daily backups are retained for 7 to 30 days, with available **Point-In-Time Recovery (PITR)** allowing you to roll back your database to any specific second.

To restore a backup via the dashboard:
1. In your [Supabase Dashboard](https://supabase.com/dashboard), navigate to **Project Settings -> Database -> Backups**.
2. Select your desired snapshot and click **Restore**.

### Manual Database Backups via `pg_dump`
You can create a standalone SQL snapshot of your database anytime using standard PostgreSQL tools:

```bash
# Dump the complete PostgreSQL database to a local file
pg_dump --clean --if-exists --quote-all-identifiers \
  -h db.your-project.supabase.co \
  -U postgres \
  -d postgres \
  -f cheftech_backup_$(date +%Y%m%d_%H%M%S).sql
```

To restore from a `pg_dump` backup file:
```bash
psql -h db.your-project.supabase.co -U postgres -d postgres -f cheftech_backup_20261109.sql
```

---

## 2. POS Local Offline Database Backups (Dexie / IndexedDB)

ChefTech POS stores all operational records (menu, recipes, inventory, sales, shifts, staff) in browser-backed IndexedDB via Dexie.

### Exporting a Local Backup
1. In ChefTech POS, log in as an **Owner** or **Manager**.
2. Open the **Admin Settings Modal** (click **"Admin Settings"** in the sidebar after entering your Owner PIN).
3. Scroll to the **Data Backup & Restore** section.
4. Click **"Download Backup File"**.
5. ChefTech generates an encrypted, checksum-verified JSON backup file named `cheftech-pos-backup-YYYY-MM-DD.json` containing:
   - Complete sales history
   - Inventory levels
   - Recipes and modifiers
   - CRM customer records
   - Staff, shifts, and payroll records
   - Settings and configurations
   - SHA-256 integrity hash

### Restoring from a Local Backup
1. In the **Admin Settings Modal**, click **"Restore Backup"**.
2. Select your `cheftech-pos-backup-YYYY-MM-DD.json` file.
3. ChefTech verifies the SHA-256 checksum and schema validity before importing.
4. Click **Confirm** to restore your records.

---

## 3. Recommended Restaurant Backup Routine

1. **Daily**: Enable Supabase automated backups on your cloud project.
2. **Weekly / End-of-Shift**: Export a local JSON backup from the POS Admin Settings and store it on an external USB drive or secure cloud storage.
3. **Before Major Updates**: Take a manual `pg_dump` snapshot prior to running any new schema migration.
