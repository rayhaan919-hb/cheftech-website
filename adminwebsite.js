// ===== Supabase Initialization =====
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
import { getSupabaseConfig, isSupabaseConfigured, saveSupabaseConfig } from "./config.js";

const $ = (id) => document.getElementById(id);

const cfg = getSupabaseConfig();
let supabase = null;

if (isSupabaseConfigured(cfg)) {
    supabase = createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
} else {
    $("cloudSetupBanner")?.classList.remove("hidden");
}

$("cloudConfigForm")?.addEventListener("submit", (e) => {
    e.preventDefault();
    const url = $("supabaseUrlInput")?.value.trim();
    const key = $("supabaseAnonKeyInput")?.value.trim();
    if (url && key) {
        saveSupabaseConfig(url, key);
        window.location.reload();
    }
});

function escapeHTML(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#039;"
    }[char]));
}

// H-07: Mask customer phone numbers by default in admin view (e.g. 0300-***4567)
function maskPhone(phone) {
    const raw = String(phone || "").trim();
    if (!raw || raw.length < 6) return "No phone";
    const prefix = raw.slice(0, 4);
    const suffix = raw.slice(-3);
    return `${prefix}-***${suffix}`;
}

function formatDate(value) {
    if (!value) return "Date unavailable";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "Date unavailable" : date.toLocaleString();
}

function showScreen(screen) {
    ["loginScreen", "deniedScreen", "adminPanel"].forEach(id => {
        $(id)?.classList.toggle("hidden", id !== screen);
    });
}

function setFormMessage(id, message, isError = true) {
    const el = $(id);
    if (!el) return;
    el.textContent = message;
    el.classList.remove("hidden", "text-red-500", "text-green-600");
    el.classList.add(isError ? "text-red-500" : "text-green-600");
}

// ===== L-05: Pure Web Audio API Notification Chime (No third-party audio files needed) =====
let audioCtx = null;
function playOrderChime() {
    try {
        audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
        audioCtx.resume();
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = "sine";
        osc.frequency.setValueAtTime(880, audioCtx.currentTime);
        osc.frequency.setValueAtTime(1174.66, audioCtx.currentTime + 0.12);
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        gain.gain.setValueAtTime(0.25, audioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.35);
        osc.start();
        osc.stop(audioCtx.currentTime + 0.35);
    } catch {
        // Ignore audio context restriction before user gesture
    }
}

// ===== H-04: Client-side 5-attempt / 5-minute login lockout =====
const ADMIN_LOCK_KEY = "cheftech_admin_login_lock";
const MAX_LOGIN_ATTEMPTS = 5;
const LOCK_DURATION_MS = 5 * 60 * 1000;

function getAdminLockState() {
    try {
        const raw = localStorage.getItem(ADMIN_LOCK_KEY);
        return raw ? JSON.parse(raw) : { attempts: 0, lockedUntil: 0 };
    } catch {
        return { attempts: 0, lockedUntil: 0 };
    }
}

function recordFailedAdminLogin() {
    const state = getAdminLockState();
    const now = Date.now();
    const attempts = (state.attempts || 0) + 1;
    const lockedUntil = attempts >= MAX_LOGIN_ATTEMPTS ? now + LOCK_DURATION_MS : 0;
    try {
        localStorage.setItem(
            ADMIN_LOCK_KEY,
            JSON.stringify({ attempts: lockedUntil ? 0 : attempts, lockedUntil })
        );
    } catch {
        // ignore
    }
    if (lockedUntil) {
        const mins = Math.ceil(LOCK_DURATION_MS / 60000);
        return `Too many failed sign-in attempts. Locked for ${mins} minutes.`;
    }
    return "Invalid email or password.";
}

function clearAdminLock() {
    try {
        localStorage.removeItem(ADMIN_LOCK_KEY);
    } catch {
        // ignore
    }
}

// ===== H-06: Auth gating via Supabase profiles.role ('OWNER' or 'MANAGER') =====
async function checkAdminSession(user) {
    if (!supabase || !user) {
        showScreen("loginScreen");
        return;
    }

    const { data: profile, error } = await supabase
        .from("profiles")
        .select("role, active")
        .eq("id", user.id)
        .maybeSingle();

    if (
        error ||
        !profile ||
        profile.active === false ||
        !["OWNER", "MANAGER"].includes(profile.role)
    ) {
        showScreen("deniedScreen");
        return;
    }

    showScreen("adminPanel");
    await Promise.all([
        loadCoupons(),
        loadCustomerData(),
        loadBanners(),
        loadEmailVerifySetting(),
        loadMenuItems()
    ]);
    startNewOrderListener();
}

if (supabase) {
    supabase.auth.getSession().then(({ data }) => {
        checkAdminSession(data?.session?.user ?? null);
    });
    supabase.auth.onAuthStateChange((_event, session) => {
        checkAdminSession(session?.user ?? null);
    });
}

// ===== H-05: Email verification requirement toggle =====
async function loadEmailVerifySetting() {
    if (!supabase) return;
    const toggle = $("requireEmailVerifyToggle");
    if (!toggle) return;
    const { data } = await supabase
        .from("settings")
        .select("value")
        .eq("key", "require_email_verification")
        .maybeSingle();
    toggle.checked = data?.value?.enabled !== false;
}

$("requireEmailVerifyToggle")?.addEventListener("change", async (e) => {
    if (!supabase) return;
    const enabled = Boolean(e.target.checked);
    await supabase.from("settings").upsert({
        key: "require_email_verification",
        value: { enabled },
        updated_at: new Date().toISOString()
    });
});

// ===== Realtime New Order Listener (Appendix A5) =====
let orderChannel = null;
function startNewOrderListener() {
    if (!supabase) return;
    if (orderChannel) {
        supabase.removeChannel(orderChannel);
    }
    orderChannel = supabase
        .channel("admin-online-orders")
        .on(
            "postgres_changes",
            { event: "INSERT", schema: "public", table: "online_orders" },
            () => {
                playOrderChime();
                loadCustomerData();
            }
        )
        .subscribe();
}

$("adminLoginForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!supabase) {
        setFormMessage("adminLoginError", "Configure Supabase Cloud credentials above first.");
        return;
    }

    const lock = getAdminLockState();
    if (lock.lockedUntil > Date.now()) {
        const mins = Math.ceil((lock.lockedUntil - Date.now()) / 60000);
        setFormMessage("adminLoginError", `Too many login attempts. Try again in ${mins} min.`);
        return;
    }

    const email = $("adminEmail").value.trim();
    const password = $("adminPassword").value;

    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
        const msg = recordFailedAdminLogin();
        setFormMessage("adminLoginError", msg);
        return;
    }
    clearAdminLock();
});

$("adminSignOutBtn")?.addEventListener("click", () => supabase?.auth.signOut());
$("deniedSignOutBtn")?.addEventListener("click", () => supabase?.auth.signOut());
$("refreshAdminDataBtn")?.addEventListener("click", () => loadCustomerData());

// ===== Customer and order listing =====
async function loadCustomerData() {
    const customersContainer = $("customersTable");
    const ordersContainer = $("ordersTable");

    if (!customersContainer || !ordersContainer || !supabase) return;

    const loading = `<div class="text-center text-gray-400 py-6"><i class="fa-solid fa-spinner fa-spin"></i></div>`;
    customersContainer.innerHTML = loading;
    ordersContainer.innerHTML = loading;

    try {
        const [profilesRes, ordersRes, couponsRes] = await Promise.all([
            supabase.from("profiles").select("*"),
            supabase.from("online_orders").select("*").order("created_at", { ascending: false }).limit(200),
            supabase.from("coupons").select("*")
        ]);

        if (profilesRes.error) throw profilesRes.error;
        if (ordersRes.error) throw ordersRes.error;

        const couponsByCustomer = new Map();
        (couponsRes.data || []).forEach((coupon) => {
            if (coupon.assigned_to) {
                const assigned = couponsByCustomer.get(coupon.assigned_to) || [];
                assigned.push(coupon.code);
                couponsByCustomer.set(coupon.assigned_to, assigned);
            }
        });

        const customers = new Map(
            (profilesRes.data || []).map((prof) => [
                prof.id,
                { uid: prof.id, ...prof, orders: [] }
            ])
        );

        const orders = ordersRes.data || [];
        orders.forEach((order) => {
            const uid = order.customer_id || "guest";
            if (!customers.has(uid)) {
                customers.set(uid, {
                    uid,
                    email: "No account email",
                    orders: []
                });
            }
            customers.get(uid).orders.push(order);
        });

        renderCustomers([...customers.values()], couponsByCustomer);
        renderOrders(orders);
    } catch (error) {
        console.error("Failed to load customer data:", error);
        customersContainer.innerHTML = `<p class="text-red-500 text-sm">Could not load customers. Check Supabase RLS permissions.</p>`;
        ordersContainer.innerHTML = `<p class="text-red-500 text-sm">Could not load orders. Check Supabase RLS permissions.</p>`;
    }
}

function bindPhoneRevealButtons(root) {
    root.querySelectorAll("[data-reveal-phone]").forEach((btn) => {
        btn.addEventListener("click", () => {
            const full = btn.getAttribute("data-reveal-phone") || "";
            const span = btn.previousElementSibling;
            if (span) span.textContent = full;
            btn.remove();
        });
    });
}

function renderCustomers(customers, couponsByCustomer) {
    const container = $("customersTable");
    const summary = $("customersSummary");

    if (!container) return;

    const sortedCustomers = customers.sort((first, second) => second.orders.length - first.orders.length);
    if (summary) summary.textContent = `${sortedCustomers.length} customer${sortedCustomers.length === 1 ? "" : "s"}`;

    if (!sortedCustomers.length) {
        container.innerHTML = `<p class="text-gray-400 text-sm">No customer records yet.</p>`;
        return;
    }

    container.innerHTML = sortedCustomers.map((customer) => {
        const latestOrder = customer.orders[0];
        const contact = latestOrder?.customer || {};
        const phone = contact.phone || customer.phone || "";
        const assignedCoupons = couponsByCustomer.get(customer.uid) || [];
        const usedCoupons = [...new Set(customer.orders.map((order) => order.coupon_code).filter(Boolean))];

        return `
            <article class="border border-gray-100 rounded-2xl p-4">
                <div class="flex flex-col sm:flex-row sm:justify-between gap-3">
                    <div class="min-w-0">
                        <h3 class="font-bold text-gray-900">${escapeHTML(contact.name || customer.name || customer.email || "Customer")}</h3>
                        <p class="text-sm text-gray-500 break-words">${escapeHTML(customer.email || "No account email")}</p>
                        <p class="text-sm text-gray-500">
                            <span>${escapeHTML(maskPhone(phone))}</span>
                            ${phone ? `<button type="button" data-reveal-phone="${escapeHTML(phone)}" class="ml-1.5 text-xs text-orange-600 hover:underline font-semibold">Reveal</button>` : ""}
                            ${contact.address ? ` · ${escapeHTML(contact.address)}` : ""}
                        </p>
                    </div>
                    <div class="sm:text-right text-sm shrink-0">
                        <p class="font-bold text-gray-900">${customer.orders.length} order${customer.orders.length === 1 ? "" : "s"} · ${Number(customer.loyalty_points || 0)} pts</p>
                        <p class="text-gray-500">${latestOrder ? `Last order: ${escapeHTML(formatDate(latestOrder.created_at))}` : "No orders yet"}</p>
                    </div>
                </div>
                <div class="mt-3 text-xs text-gray-500">
                    Coupons used: <span class="font-semibold text-gray-700">${escapeHTML(usedCoupons.join(", ") || "None")}</span>
                    ${assignedCoupons.length ? ` · Assigned: <span class="font-semibold text-gray-700">${escapeHTML(assignedCoupons.join(", "))}</span>` : ""}
                </div>
            </article>
        `;
    }).join("");

    bindPhoneRevealButtons(container);
}

function renderOrders(orders) {
    const container = $("ordersTable");
    const summary = $("ordersSummary");

    if (!container) return;
    if (summary) summary.textContent = `${orders.length} order${orders.length === 1 ? "" : "s"}`;

    if (!orders.length) {
        container.innerHTML = `<p class="text-gray-400 text-sm">No online orders yet.</p>`;
        return;
    }

    container.innerHTML = orders.map((order) => {
        const customer = order.customer || {};
        const phone = customer.phone || "";
        const items = (order.items || []).map((item) => `${item.name} x ${item.qty}`).join(", ");

        return `
            <article class="border border-gray-100 rounded-2xl p-4">
                <div class="flex flex-col sm:flex-row sm:justify-between gap-3">
                    <div class="min-w-0">
                        <div class="flex items-center gap-2 flex-wrap">
                            <h3 class="font-bold text-gray-900">${escapeHTML(customer.name || "Customer")}</h3>
                            <span class="text-xs font-bold uppercase text-orange-600">${escapeHTML(order.status || "PENDING")}</span>
                        </div>
                        <p class="text-sm text-gray-500">${escapeHTML(formatDate(order.created_at))} · ${escapeHTML(order.order_type || "DELIVERY")}</p>
                        <p class="text-sm text-gray-700 mt-2">${escapeHTML(items || "No items recorded")}</p>
                        <p class="text-xs text-gray-500 mt-1">
                            <span>${escapeHTML(maskPhone(phone))}</span>
                            ${phone ? `<button type="button" data-reveal-phone="${escapeHTML(phone)}" class="ml-1.5 text-orange-600 hover:underline font-semibold">Reveal</button>` : ""}
                            ${customer.address ? ` · ${escapeHTML(customer.address)}` : ""}
                        </p>
                    </div>
                    <div class="sm:text-right shrink-0">
                        <p class="font-black text-gray-900">Rs. ${Number(order.total || 0).toLocaleString()}</p>
                        <p class="text-xs text-gray-500">Coupon: <span class="font-semibold">${escapeHTML(order.coupon_code || "None")}</span></p>
                        ${Number(order.discount_amount || 0) > 0 ? `<p class="text-xs text-green-600">Saved Rs. ${Number(order.discount_amount).toLocaleString()}</p>` : ""}
                    </div>
                </div>
            </article>
        `;
    }).join("");

    bindPhoneRevealButtons(container);
}

// ===== Coupon creation (M-03: 1..100 clamp & >50% confirmation) =====
async function resolveUidByEmail(email) {
    if (!email || !supabase) return null;
    const { data } = await supabase
        .from("profiles")
        .select("id")
        .ilike("email", email.trim())
        .maybeSingle();
    return data?.id || null;
}

$("couponForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!supabase) return;

    const code = $("couponCodeField").value.trim().toUpperCase();
    const rawDiscount = Number($("couponDiscountField").value);
    const discountPercent = Math.min(100, Math.max(1, Math.round(rawDiscount || 0)));
    const type = $("couponTypeField").value;
    const assignedEmail = $("couponAssignedEmailField").value.trim();
    const maxUsesRaw = $("couponMaxUsesField").value;
    const expiryRaw = $("couponExpiryField").value;

    if (!code || !Number.isFinite(rawDiscount) || rawDiscount < 1 || rawDiscount > 100) {
        setFormMessage("couponFormMessage", "Coupon code and a discount between 1% and 100% are required.");
        return;
    }

    if (
        discountPercent > 50 &&
        !window.confirm(`Are you sure you want to create a high-discount coupon (${discountPercent}% off)?`)
    ) {
        return;
    }

    try {
        let assignedTo = null;
        if (assignedEmail) {
            assignedTo = await resolveUidByEmail(assignedEmail);
            if (!assignedTo) {
                setFormMessage(
                    "couponFormMessage",
                    "No customer account found for that email (they must sign up at least once)."
                );
                return;
            }
        }

        const { error } = await supabase.from("coupons").upsert({
            code,
            discount_percent: discountPercent,
            type,
            assigned_to: assignedTo,
            active: true,
            single_use: type === "loyalty",
            used: false,
            used_count: 0,
            max_uses: maxUsesRaw ? Math.max(1, Number(maxUsesRaw)) : null,
            expires_at: expiryRaw ? new Date(expiryRaw).toISOString() : null
        });

        if (error) throw error;

        setFormMessage("couponFormMessage", `Coupon ${code} created (${discountPercent}% off).`, false);
        $("couponForm").reset();
        await loadCoupons();
    } catch (error) {
        console.error("Coupon creation error:", error);
        setFormMessage("couponFormMessage", error.message || "Could not create coupon.");
    }
});

// ===== Coupon listing (Already OK #5: escape code and type) =====
async function loadCoupons() {
    const container = $("couponsTable");
    if (!container || !supabase) return;

    container.innerHTML = `<div class="text-center text-gray-400 py-6"><i class="fa-solid fa-spinner fa-spin"></i></div>`;

    try {
        const { data: rows, error } = await supabase
            .from("coupons")
            .select("*")
            .order("created_at", { ascending: false });

        if (error) throw error;

        if (!rows || !rows.length) {
            container.innerHTML = `<p class="text-gray-400 text-sm">No coupons yet.</p>`;
            return;
        }

        container.innerHTML = rows.map(data => {
            const safeCode = escapeHTML(data.code);
            const safeType = escapeHTML(data.type);
            const pct = Math.min(100, Math.max(0, Number(data.discount_percent || 0)));

            return `
                <div class="flex justify-between items-center border border-gray-100 rounded-2xl p-3">
                    <div>
                        <div class="font-bold">${safeCode} <span class="text-xs font-normal text-gray-400">(${safeType})</span></div>
                        <div class="text-sm text-gray-500">${pct}% off ${data.assigned_to ? "· assigned" : "· public"} · used ${Number(data.used_count || 0)}${data.max_uses ? `/${data.max_uses}` : ""}</div>
                    </div>
                    <div class="flex items-center gap-2">
                        <button data-id="${safeCode}" data-active="${data.active}" class="toggle-coupon text-xs px-3 py-1.5 rounded-full ${data.active ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-500"}">
                            ${data.active ? "Active" : "Inactive"}
                        </button>
                        <button data-id="${safeCode}" class="delete-coupon w-8 h-8 rounded-xl bg-red-50 text-red-500 hover:bg-red-100">
                            <i class="fa-solid fa-trash text-xs"></i>
                        </button>
                    </div>
                </div>
            `;
        }).join("");

        container.querySelectorAll(".toggle-coupon").forEach(btn => {
            btn.addEventListener("click", async () => {
                const code = btn.dataset.id;
                const nowActive = btn.dataset.active === "true";
                await supabase.from("coupons").update({ active: !nowActive }).eq("code", code);
                await loadCoupons();
            });
        });

        container.querySelectorAll(".delete-coupon").forEach(btn => {
            btn.addEventListener("click", async () => {
                await supabase.from("coupons").delete().eq("code", btn.dataset.id);
                await loadCoupons();
            });
        });
    } catch (error) {
        console.error("Failed to load coupons:", error);
        container.innerHTML = `<p class="text-red-500 text-sm">Could not load coupons.</p>`;
    }
}

// ===== Image Compression Utility =====
function formatBytes(bytes) {
    if (!bytes || bytes <= 0) return "0 B";
    const units = ["B", "KB", "MB"];
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    const val = bytes / Math.pow(1024, i);
    return `${val.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

async function compressImageDetailed(file, maxWidth = 800, quality = 0.82) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.readAsDataURL(file);
        reader.onload = (event) => {
            const img = new Image();
            img.src = event.target.result;
            img.onload = () => {
                const canvas = document.createElement("canvas");
                let width = img.naturalWidth || img.width;
                let height = img.naturalHeight || img.height;

                if (width > maxWidth || height > maxWidth) {
                    if (width > height) {
                        height = Math.round((height * maxWidth) / width);
                        width = maxWidth;
                    } else {
                        width = Math.round((width * maxWidth) / height);
                        height = maxWidth;
                    }
                }

                canvas.width = width;
                canvas.height = height;

                const ctx = canvas.getContext("2d");
                ctx.imageSmoothingEnabled = true;
                ctx.imageSmoothingQuality = "high";
                ctx.drawImage(img, 0, 0, width, height);

                let dataUrl = canvas.toDataURL("image/webp", quality);
                if (!dataUrl.startsWith("data:image/webp")) {
                    dataUrl = canvas.toDataURL("image/jpeg", quality);
                }

                const headIndex = dataUrl.indexOf(",");
                const b64 = headIndex >= 0 ? dataUrl.slice(headIndex + 1) : dataUrl;
                const compressedBytes = Math.round((b64.length * 3) / 4);
                const originalBytes = file.size;
                const ratio = originalBytes > 0
                    ? Math.round((1 - compressedBytes / originalBytes) * 100)
                    : 0;

                resolve({
                    dataUrl,
                    originalBytes,
                    compressedBytes,
                    compressionRatio: Math.max(0, ratio)
                });
            };
            img.onerror = () => reject(new Error("Unable to parse image file."));
        };
        reader.onerror = () => reject(new Error("Failed to read image."));
    });
}

async function compressImage(file, maxWidth = 1000, quality = 0.78) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.readAsDataURL(file);
        reader.onload = (event) => {
            const img = new Image();
            img.src = event.target.result;
            img.onload = () => {
                const canvas = document.createElement("canvas");
                let width = img.width;
                let height = img.height;

                if (width > maxWidth) {
                    height = (height * maxWidth) / width;
                    width = maxWidth;
                }

                canvas.width = width;
                canvas.height = height;

                const ctx = canvas.getContext("2d");
                ctx.drawImage(img, 0, 0, width, height);

                const compressedDataUrl = canvas.toDataURL("image/jpeg", quality);
                resolve(compressedDataUrl);
            };
            img.onerror = reject;
        };
        reader.onerror = reject;
    });
}

// ===== Image Preview Handler =====
$("bannerImagesField")?.addEventListener("change", (event) => {
    const files = event.target.files;
    const previewContainer = $("imagePreviewContainer");
    const preview = $("imagePreview");

    if (!files.length) {
        previewContainer.classList.add("hidden");
        return;
    }

    previewContainer.classList.remove("hidden");
    preview.innerHTML = "";

    Array.from(files).forEach((file, index) => {
        const reader = new FileReader();
        reader.readAsDataURL(file);
        reader.onload = (e) => {
            const div = document.createElement("div");
            div.className = "relative";
            div.innerHTML = `
                <img src="${e.target.result}" class="w-full h-20 object-cover rounded-lg border border-gray-200">
                <span class="absolute -top-2 -right-2 bg-orange-500 text-white text-xs w-5 h-5 rounded-full flex items-center justify-center">${index + 1}</span>
            `;
            preview.appendChild(div);
        };
    });
});

// ===== Banner Management (Supabase public.banners) =====
async function loadBanners() {
    const container = $("bannersTable");
    if (!container || !supabase) return;

    container.innerHTML = `<div class="text-center text-gray-400 py-6"><i class="fa-solid fa-spinner fa-spin"></i></div>`;

    try {
        const { data: rows, error } = await supabase
            .from("banners")
            .select("*")
            .order("sort_order", { ascending: true });

        if (error) throw error;

        if (!rows || !rows.length) {
            container.innerHTML = `<p class="text-gray-400 text-sm">No banners yet.</p>`;
            return;
        }

        container.innerHTML = rows.map(data => {
            const safeId = escapeHTML(data.id);
            return `
                <div class="flex flex-col sm:flex-row justify-between items-start sm:items-center border border-gray-100 rounded-2xl p-3 gap-3">
                    <div class="flex-1">
                        <div class="font-bold text-sm">${escapeHTML(data.title)}</div>
                        <div class="text-xs text-gray-500">${escapeHTML(data.subtitle || "No description")}</div>
                    </div>
                    <div class="flex items-center gap-2 w-full sm:w-auto">
                        <button data-id="${safeId}" data-active="${data.active}" class="toggle-banner text-xs px-3 py-1.5 rounded-full ${data.active ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-500"} flex-1 sm:flex-none">
                            ${data.active ? "Active" : "Inactive"}
                        </button>
                        <button data-id="${safeId}" class="delete-banner w-8 h-8 rounded-xl bg-red-50 text-red-500 hover:bg-red-100">
                            <i class="fa-solid fa-trash text-xs"></i>
                        </button>
                    </div>
                </div>
            `;
        }).join("");

        container.querySelectorAll(".toggle-banner").forEach(btn => {
            btn.addEventListener("click", async () => {
                const id = btn.dataset.id;
                const nowActive = btn.dataset.active === "true";
                await supabase.from("banners").update({ active: !nowActive }).eq("id", id);
                await loadBanners();
            });
        });

        container.querySelectorAll(".delete-banner").forEach(btn => {
            btn.addEventListener("click", async () => {
                await supabase.from("banners").delete().eq("id", btn.dataset.id);
                await loadBanners();
            });
        });
    } catch (error) {
        console.error("Failed to load banners:", error);
        container.innerHTML = `<p class="text-red-500 text-sm">Could not load banners.</p>`;
    }
}

$("bannerForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!supabase) return;

    const files = $("bannerImagesField").files;
    const title = $("bannerTitleField").value.trim();
    const description = $("bannerDescriptionField").value.trim();
    const link = $("bannerLinkField").value.trim();
    const active = $("bannerActiveField").checked;
    const submitBtn = $("bannerSubmitBtn");

    if (!files.length || !title) {
        setFormMessage("bannerFormMessage", "At least one image and a title are required.");
        return;
    }

    submitBtn.disabled = true;
    submitBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin mr-2"></i> Saving...`;

    try {
        const compressedUrls = [];
        for (let i = 0; i < files.length; i++) {
            const dataUrl = await compressImage(files[i]);
            compressedUrls.push(dataUrl);
        }

        const { error } = await supabase.from("banners").insert({
            id: `banner_${Date.now()}`,
            title,
            subtitle: description,
            image_url: JSON.stringify(compressedUrls),
            link,
            active,
            sort_order: 0
        });

        if (error) throw error;

        setFormMessage("bannerFormMessage", `Banner created with ${compressedUrls.length} image(s).`, false);
        $("bannerForm").reset();
        $("imagePreviewContainer").classList.add("hidden");
        await loadBanners();
    } catch (error) {
        console.error("Banner creation error:", error);
        setFormMessage("bannerFormMessage", "Could not create banner. Please try again.");
    } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = "Create Banner";
    }
});

// ===== Menu Items Management & Local Image Upload =====
let adminCategoriesCache = [];
let adminMenuItemsCache = [];

async function loadMenuItems() {
    const container = $("menuItemsTable");
    const categorySelect = $("dishCategoryField");
    if (!container || !supabase) return;

    try {
        const [catRes, itemRes] = await Promise.all([
            supabase.from("categories").select("*").order("sort_order", { ascending: true }),
            supabase.from("menu_items").select("*").order("name", { ascending: true })
        ]);

        if (catRes.error) throw catRes.error;
        if (itemRes.error) throw itemRes.error;

        adminCategoriesCache = catRes.data || [];
        adminMenuItemsCache = itemRes.data || [];

        // Populate category dropdown
        if (categorySelect) {
            categorySelect.innerHTML = `<option value="">Select category...</option>` +
                adminCategoriesCache.map(c => `<option value="${escapeHTML(c.id)}">${escapeHTML(c.name)}</option>`).join("");
        }

        if (!adminMenuItemsCache.length) {
            container.innerHTML = `<p class="col-span-full text-gray-400 text-sm py-4">No menu items found.</p>`;
            return;
        }

        const catMap = new Map(adminCategoriesCache.map(c => [c.id, c.name]));

        container.innerHTML = adminMenuItemsCache.map(item => {
            const safeId = escapeHTML(item.id);
            const categoryName = catMap.get(item.category_id) || "Uncategorized";
            const isAvail = item.available !== false;
            const imgSrc = item.image_url && String(item.image_url).trim()
                ? String(item.image_url).trim()
                : `https://placehold.co/400x300?text=${encodeURIComponent(item.name)}`;

            return `
                <div class="flex flex-col justify-between border border-gray-100 rounded-2xl p-3 bg-white shadow-sm hover:shadow transition-shadow">
                    <div class="flex gap-3 items-center">
                        <img
                            src="${escapeHTML(imgSrc)}"
                            alt="${escapeHTML(item.name)}"
                            class="w-16 h-16 rounded-xl object-cover border border-gray-100 shrink-0 ${isAvail ? '' : 'grayscale'}"
                        >
                        <div class="min-w-0 flex-1">
                            <h4 class="font-bold text-sm text-gray-900 truncate">${escapeHTML(item.name)}</h4>
                            <span class="inline-block text-[10px] font-semibold px-2 py-0.5 rounded-full bg-orange-50 text-orange-600 mt-0.5">
                                ${escapeHTML(categoryName)}
                            </span>
                            <div class="text-xs font-bold text-gray-700 mt-1">Rs. ${Number(item.price).toLocaleString()}</div>
                        </div>
                    </div>
                    <div class="flex items-center justify-between gap-2 mt-3 pt-2 border-t border-gray-50">
                        <button
                            data-id="${safeId}"
                            data-available="${isAvail}"
                            class="toggle-dish-avail text-xs px-2.5 py-1 rounded-lg ${isAvail ? 'bg-green-50 text-green-700 border border-green-200' : 'bg-gray-100 text-gray-500 border border-gray-200'} cursor-pointer"
                        >
                            ${isAvail ? 'Available' : 'Sold Out'}
                        </button>
                        <div class="flex items-center gap-1.5">
                            <button
                                data-id="${safeId}"
                                class="edit-dish-btn px-2.5 py-1 text-xs font-bold text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-lg cursor-pointer"
                            >
                                <i class="fa-solid fa-pen mr-1"></i> Edit
                            </button>
                            <button
                                data-id="${safeId}"
                                class="delete-dish-btn w-7 h-7 rounded-lg bg-red-50 text-red-500 hover:bg-red-100 flex items-center justify-center cursor-pointer"
                                title="Delete item"
                            >
                                <i class="fa-solid fa-trash text-xs"></i>
                            </button>
                        </div>
                    </div>
                </div>
            `;
        }).join("");

        // Attach event handlers
        container.querySelectorAll(".toggle-dish-avail").forEach(btn => {
            btn.addEventListener("click", async () => {
                const id = btn.dataset.id;
                const nowAvail = btn.dataset.available === "true";
                await supabase.from("menu_items").update({ available: !nowAvail }).eq("id", id);
                await loadMenuItems();
            });
        });

        container.querySelectorAll(".edit-dish-btn").forEach(btn => {
            btn.addEventListener("click", () => {
                const id = btn.dataset.id;
                const item = adminMenuItemsCache.find(i => i.id === id);
                if (!item) return;
                openDishEditor(item);
            });
        });

        container.querySelectorAll(".delete-dish-btn").forEach(btn => {
            btn.addEventListener("click", async () => {
                const id = btn.dataset.id;
                const item = adminMenuItemsCache.find(i => i.id === id);
                if (!window.confirm(`Delete "${item?.name || 'this item'}" from the menu?`)) return;
                await supabase.from("menu_items").delete().eq("id", id);
                await loadMenuItems();
            });
        });
    } catch (err) {
        console.error("Failed to load menu items in admin:", err);
        container.innerHTML = `<p class="col-span-full text-red-500 text-sm">Could not load menu items.</p>`;
    }
}

function openDishEditor(item = null) {
    const form = $("menuItemForm");
    if (!form) return;

    form.classList.remove("hidden");
    $("menuFormTitle").textContent = item ? `Edit: ${item.name}` : "Add New Menu Item";
    $("dishEditingId").value = item ? item.id : "";
    $("dishNameField").value = item ? item.name : "";
    $("dishPriceField").value = item ? item.price : "";
    $("dishCategoryField").value = item ? (item.category_id || "") : "";
    $("dishAvailableField").checked = item ? (item.available !== false) : true;
    $("dishImageUrlInput").value = (item && item.image_url && !item.image_url.startsWith("data:")) ? item.image_url : "";
    $("dishCompressionStatus").textContent = "";

    const preview = $("dishImagePreview");
    const placeholder = $("dishImagePlaceholder");
    const removeBtn = $("clearDishImageBtn");

    if (item && item.image_url) {
        preview.src = item.image_url;
        preview.classList.remove("hidden");
        placeholder.classList.add("hidden");
        removeBtn.classList.remove("hidden");
        $("uploadButtonLabel").textContent = "Change Photo";
    } else {
        preview.src = "";
        preview.classList.add("hidden");
        placeholder.classList.remove("hidden");
        removeBtn.classList.add("hidden");
        $("uploadButtonLabel").textContent = "Upload Local Image";
    }

    form.scrollIntoView({ behavior: "smooth", block: "start" });
}

$("newDishBtn")?.addEventListener("click", () => openDishEditor(null));
$("closeMenuItemForm")?.addEventListener("click", () => $("menuItemForm")?.classList.add("hidden"));
$("cancelDishBtn")?.addEventListener("click", () => $("menuItemForm")?.classList.add("hidden"));

// Local image file selection & auto-compression
$("dishImageFileInput")?.addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const statusEl = $("dishCompressionStatus");
    statusEl.textContent = "Compressing...";
    statusEl.className = "text-[11px] text-orange-600 font-bold animate-pulse";

    try {
        const res = await compressImageDetailed(file, 800, 0.82);
        const preview = $("dishImagePreview");
        const placeholder = $("dishImagePlaceholder");
        const removeBtn = $("clearDishImageBtn");

        preview.src = res.dataUrl;
        preview.classList.remove("hidden");
        placeholder.classList.add("hidden");
        removeBtn.classList.remove("hidden");
        $("uploadButtonLabel").textContent = "Change Photo";

        statusEl.textContent = `Auto-compressed: ${formatBytes(res.originalBytes)} → ${formatBytes(res.compressedBytes)} (-${res.compressionRatio}%)`;
        statusEl.className = "text-[11px] text-green-700 font-semibold";
    } catch (err) {
        statusEl.textContent = err.message || "Failed to compress image";
        statusEl.className = "text-[11px] text-red-500 font-medium";
    }
});

// Clear photo
$("clearDishImageBtn")?.addEventListener("click", () => {
    const preview = $("dishImagePreview");
    const placeholder = $("dishImagePlaceholder");
    preview.src = "";
    preview.classList.add("hidden");
    placeholder.classList.remove("hidden");
    $("clearDishImageBtn")?.classList.add("hidden");
    if ($("dishImageUrlInput")) $("dishImageUrlInput").value = "";
    if ($("dishImageFileInput")) $("dishImageFileInput").value = "";
    if ($("dishCompressionStatus")) $("dishCompressionStatus").textContent = "";
    $("uploadButtonLabel").textContent = "Upload Local Image";
});

// Save Dish (Add or Edit)
$("menuItemForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!supabase) return;

    const saveBtn = $("saveDishBtn");
    const editingId = $("dishEditingId")?.value.trim();
    const name = $("dishNameField")?.value.trim();
    const price = parseFloat($("dishPriceField")?.value || "0");
    const category_id = $("dishCategoryField")?.value;
    const available = $("dishAvailableField")?.checked ?? true;

    // Image priority: preview src (dataUrl from upload) or pasted external URL
    const previewSrc = $("dishImagePreview")?.src || "";
    const pastedUrl = $("dishImageUrlInput")?.value.trim() || "";
    let finalImageUrl = "";
    if (previewSrc && previewSrc.startsWith("data:")) {
        finalImageUrl = previewSrc;
    } else if (pastedUrl) {
        finalImageUrl = pastedUrl;
    } else if (previewSrc && !previewSrc.includes("placehold.co")) {
        finalImageUrl = previewSrc;
    }

    if (!name || !price || !category_id) {
        setFormMessage("menuFormMessage", "Please fill in all required fields (Name, Price, Category).");
        return;
    }

    saveBtn.disabled = true;
    saveBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin mr-1.5"></i> Saving...`;

    try {
        const dishId = editingId || `dish_${Date.now()}`;
        const payload = {
            id: dishId,
            name,
            price,
            category_id,
            available,
            image_url: finalImageUrl,
            updated_at: new Date().toISOString()
        };

        const { error } = await supabase.from("menu_items").upsert(payload);
        if (error) throw error;

        setFormMessage("menuFormMessage", `Dish "${name}" saved successfully!`, false);
        $("menuItemForm")?.classList.add("hidden");
        await loadMenuItems();
    } catch (err) {
        console.error("Dish save failed:", err);
        setFormMessage("menuFormMessage", err.message || "Failed to save dish.");
    } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = "Save Dish";
    }
});
