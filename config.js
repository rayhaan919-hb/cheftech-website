/**
 * ChefTech Ordering Website — Supabase Cloud Configuration
 *
 * Set your Supabase Project URL and Anon Public Key below (or configure them
 * via the Admin Dashboard -> Cloud Setup).
 * Only place your public anon key in this browser file.
 */
const DEFAULT_SUPABASE_URL = 'https://cvbxrvwwpiduerghdcxj.supabase.co';
const DEFAULT_SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN2Ynhydnd3cGlkdWVyZ2hkY3hqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA4Nzk3OTEsImV4cCI6MjEwNjQ1NTc5MX0.jsj7ZHIKS-2yRO2vATHZ0cXtACHZQbW1WrF0vvLhzpI';

const STORAGE_KEY = 'cheftech_supabase_config';
const CURRENCY_KEY = 'cheftech_currency_symbol';
export const DEFAULT_CURRENCY_SYMBOL = 'Rs. ';

export function getCurrencySymbol() {
  try {
    return localStorage.getItem(CURRENCY_KEY) || DEFAULT_CURRENCY_SYMBOL;
  } catch {
    return DEFAULT_CURRENCY_SYMBOL;
  }
}

export function setCurrencySymbol(symbol) {
  try {
    localStorage.setItem(CURRENCY_KEY, symbol);
  } catch {
    // ignore
  }
}

export function getSupabaseConfig() {
  if (
    typeof window !== 'undefined' &&
    window.__SUPABASE_CONFIG__ &&
    window.__SUPABASE_CONFIG__.supabaseUrl &&
    window.__SUPABASE_CONFIG__.supabaseAnonKey
  ) {
    return window.__SUPABASE_CONFIG__;
  }

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      const url = String(parsed?.supabaseUrl || parsed?.url || '').trim().replace(/\/+$/, '');
      const anonKey = String(parsed?.supabaseAnonKey || parsed?.anonKey || '').trim();
      if (url && anonKey) {
        return {
          supabaseUrl: url,
          supabaseAnonKey: anonKey,
          url,
          anonKey,
        };
      }
    }
  } catch {
    // ignore storage errors
  }

  const defaultUrl = DEFAULT_SUPABASE_URL.trim().replace(/\/+$/, '');
  const defaultKey = DEFAULT_SUPABASE_ANON_KEY.trim();
  return {
    supabaseUrl: defaultUrl,
    supabaseAnonKey: defaultKey,
    url: defaultUrl,
    anonKey: defaultKey,
  };
}

export function saveSupabaseConfig(supabaseUrl, supabaseAnonKey) {
  const clean = {
    supabaseUrl: String(supabaseUrl || '').trim().replace(/\/+$/, ''),
    supabaseAnonKey: String(supabaseAnonKey || '').trim(),
  };
  try {
    if (clean.supabaseUrl && clean.supabaseAnonKey) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(clean));
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    // ignore storage errors
  }
  return clean;
}

export function isSupabaseConfigured(cfg = getSupabaseConfig()) {
  return Boolean(
    cfg &&
      cfg.supabaseUrl &&
      cfg.supabaseAnonKey &&
      /^https?:\/\/.+/i.test(cfg.supabaseUrl) &&
      cfg.supabaseAnonKey.length >= 20
  );
}
