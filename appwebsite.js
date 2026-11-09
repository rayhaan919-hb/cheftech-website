// ===== Back End & Supabase Initialization =====
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
import { getSupabaseConfig, isSupabaseConfigured } from "./config.js";

const supaCfg = getSupabaseConfig();
const supabase = isSupabaseConfigured()
    ? createClient(supaCfg.supabaseUrl || supaCfg.url, supaCfg.supabaseAnonKey || supaCfg.anonKey)
    : null;

// ===== State =====
let currentUser = null;
let currentProfile = null;
let cart = [];
let isLoginMode = true;
let currentOrderType = "DELIVERY";
let toastTimer = null;
let appliedCoupon = null;
let redeemLoyaltyPoints = 0;
let pastOrdersCache = [];
let pastOrdersChannel = null;
let activeOrderChannel = null;
let placingOrder = false;

let categories = [{ id: "ALL", name: "All" }];
let menuItems = [];

const LOGIN_LOCKOUT_KEY = "cheftech_web_customer_lockout";
const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_MS = 5 * 60 * 1000;
const MIN_DELIVERY_ORDER = 500;

// ===== Cart Persistence (localStorage) =====
function loadCart() {
    try {
        const savedCart = localStorage.getItem("chefTechCart");
        if (savedCart) {
            cart = JSON.parse(savedCart);
        }
    } catch (e) {
        console.warn("Failed to load cart from localStorage:", e);
    }
}
loadCart();

function saveCart() {
    try {
        localStorage.setItem("chefTechCart", JSON.stringify(cart));
    } catch (e) {
        console.warn("Failed to save cart to localStorage:", e);
    }
}

function clearCart() {
    cart = [];
    redeemLoyaltyPoints = 0;
    localStorage.removeItem("chefTechCart");
}

// ===== Small UI Helpers =====
const $ = (id) => document.getElementById(id);

function escapeHTML(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#039;"
    }[char]));
}

function showToast(message, icon = "fa-check") {
    const toast = $("toast");
    if (!toast) return;

    $("toastMessage").textContent = message;
    $("toastIcon").innerHTML = `<i class="fa-solid ${icon}"></i>`;

    toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
        toast.classList.remove("show");
    }, 2200);
}

function openModal(modal) {
    if (!modal) return;

    modal.classList.remove("hidden");
    modal.setAttribute("aria-hidden", "false");

    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            modal.classList.add("is-open");
        });
    });

    document.body.classList.add("overflow-hidden");
}

function closeModal(modal) {
    if (!modal) return;

    modal.classList.remove("is-open");
    modal.setAttribute("aria-hidden", "true");

    setTimeout(() => {
        modal.classList.add("hidden");
    }, 280);

    document.body.classList.remove("overflow-hidden");
}

function animateCartButton() {
    const btn = $("cartBtn");
    if (!btn) return;

    btn.classList.remove("cart-bump");
    void btn.offsetWidth;
    btn.classList.add("cart-bump");
}

function pricePulse(element) {
    if (!element) return;

    element.classList.remove("price-pop");
    void element.offsetWidth;
    element.classList.add("price-pop");
}

// ===== Login Lockout Helpers (H-04) =====
function getLockoutState() {
    try {
        const raw = localStorage.getItem(LOGIN_LOCKOUT_KEY);
        if (!raw) return { count: 0, lockedUntil: 0 };
        return JSON.parse(raw);
    } catch {
        return { count: 0, lockedUntil: 0 };
    }
}

function recordFailedLogin() {
    const state = getLockoutState();
    const count = (state.count || 0) + 1;
    const lockedUntil = count >= MAX_LOGIN_ATTEMPTS ? Date.now() + LOCKOUT_MS : 0;
    localStorage.setItem(LOGIN_LOCKOUT_KEY, JSON.stringify({ count, lockedUntil }));
    return { count, lockedUntil };
}

function clearLoginLockout() {
    localStorage.removeItem(LOGIN_LOCKOUT_KEY);
}

// ===== Loading Skeleton =====
function renderMenuSkeleton(count = 8) {
    const grid = $("menuGrid");
    if (!grid) return;

    grid.innerHTML = Array.from({ length: count }, () => `
        <div class="bg-white rounded-3xl overflow-hidden border border-gray-100 shadow-sm">
            <div class="skeleton h-48"></div>
            <div class="p-5 space-y-3">
                <div class="skeleton h-3 rounded w-1/4"></div>
                <div class="skeleton h-5 rounded w-3/4"></div>
                <div class="flex justify-between items-center pt-2">
                    <div class="skeleton h-6 rounded w-24"></div>
                    <div class="skeleton h-10 rounded-xl w-24"></div>
                </div>
            </div>
        </div>
    `).join("");
}

// ===== Supabase Menu Loading (M-07: keep unavailable items with Sold Out badge) =====
async function loadMenuFromSupabase() {
    if (!supabase) {
        throw new Error("SUPABASE_NOT_CONFIGURED");
    }

    const [catRes, menuRes] = await Promise.all([
        supabase.from("categories").select("*").order("sort_order", { ascending: true }),
        supabase.from("menu_items").select("*").order("name", { ascending: true })
    ]);

    if (catRes.error) throw catRes.error;
    if (menuRes.error) throw menuRes.error;

    const dbCategories = (catRes.data || [])
        .map(cat => ({
            id: cat.id,
            name: cat.name
        }))
        .filter(c => c.name);

    const dbMenuItems = (menuRes.data || [])
        .map(row => ({
            id: row.id,
            menuItemId: row.id,
            recipeId: row.recipe_id || null,
            name: row.name,
            price: Number(row.price),
            categoryId: row.category_id || "uncategorized",
            available: row.available !== false,
            img: row.image_url || ""
        }))
        .filter(item => item.name && Number.isFinite(item.price));

    const categoryMap = new Map(dbCategories.map(c => [c.id, c]));
    dbMenuItems.forEach(item => {
        if (!categoryMap.has(item.categoryId) && item.categoryId !== "uncategorized") {
            categoryMap.set(item.categoryId, {
                id: item.categoryId,
                name: item.categoryId
            });
        }
    });

    categories = [
        { id: "ALL", name: "All" },
        ...categoryMap.values()
    ];
    menuItems = dbMenuItems;

    // Reconcile cart prices & availability with authoritative server menu
    cart = cart
        .map(cartItem => {
            const latest = menuItems.find(m => m.id === (cartItem.menuItemId || cartItem.id));
            if (!latest || latest.available === false) return null;
            return {
                ...cartItem,
                name: latest.name,
                price: latest.price,
                available: latest.available
            };
        })
        .filter(Boolean);
    saveCart();
}

// ===== Categories =====
function renderCategories(activeId = "ALL") {
    const container = $("categoryContainer");
    if (!container) return;

    container.innerHTML = "";

    categories.forEach(cat => {
        const btn = document.createElement("button");
        const active = cat.id === activeId;

        btn.className = `
            category-btn
            whitespace-nowrap
            px-5
            py-2.5
            rounded-full
            font-bold
            text-sm
            ${active
                ? "active bg-orange-500 text-white"
                : "bg-gray-100/90 text-gray-600 hover:bg-gray-200"
            }
        `;

        btn.textContent = cat.name;
        btn.setAttribute("aria-pressed", String(active));

        btn.onclick = () => {
            filterMenu(cat, btn);
        };

        container.appendChild(btn);
    });
}

function filterMenu(category, btnElement) {
    document
        .querySelectorAll("#categoryContainer button")
        .forEach(btn => {
            btn.classList.remove("active", "bg-orange-500", "text-white");
            btn.classList.add("bg-gray-100/90", "text-gray-600");
            btn.setAttribute("aria-pressed", "false");
        });

    btnElement.classList.remove("bg-gray-100/90", "text-gray-600");
    btnElement.classList.add("active", "bg-orange-500", "text-white");
    btnElement.setAttribute("aria-pressed", "true");

    const filtered =
        category.id === "ALL"
            ? menuItems
            : menuItems.filter(item => item.categoryId === category.id);

    renderMenu(filtered);
}

// ===== Menu Rendering (M-07: Sold Out badge & disabled state) =====
function cardControlsHTML(id) {
    const menuItem = menuItems.find(item => item.id === id);
    if (menuItem && menuItem.available === false) {
        return `
            <button
                disabled
                class="bg-gray-200 text-gray-500 px-4 py-2.5 rounded-xl font-bold text-xs cursor-not-allowed"
            >
                Sold Out
            </button>
        `;
    }

    const cartItem = cart.find(item => item.id === id);

    if (cartItem) {
        return `
            <div class="flex items-center gap-1.5 bg-gray-900 rounded-xl px-2 py-1.5 shadow-lg">
                <button
                    onclick="changeCartQty('${escapeHTML(id)}', -1)"
                    class="w-7 h-7 rounded-lg text-white hover:bg-white/10 hover:text-orange-400 font-bold transition-colors pressable"
                    aria-label="Decrease quantity"
                >
                    −
                </button>
                <span class="text-white font-bold w-5 text-center">
                    ${cartItem.qty}
                </span>
                <button
                    onclick="changeCartQty('${escapeHTML(id)}', 1)"
                    class="w-7 h-7 rounded-lg text-white hover:bg-white/10 hover:text-orange-400 font-bold transition-colors pressable"
                    aria-label="Increase quantity"
                >
                    +
                </button>
            </div>
        `;
    }

    return `
        <button
            onclick="addToCart('${escapeHTML(id)}')"
            class="bg-gray-900 text-white px-4 py-2.5 rounded-xl hover:bg-orange-500 transition-all shadow-sm hover:shadow-lg pressable"
        >
            <i class="fa-solid fa-plus mr-1"></i>
            Add
        </button>
    `;
}

function renderCardControls(id) {
    const box = document.getElementById(`qtyBox-${id}`);
    if (box) {
        box.innerHTML = cardControlsHTML(id);
    }
}

function renderMenu(items) {
    const grid = $("menuGrid");
    if (!grid) return;

    grid.innerHTML = "";

    if (!items.length) {
        grid.innerHTML = `
            <div class="col-span-full py-20 text-center reveal is-visible">
                <div class="w-16 h-16 rounded-2xl bg-orange-50 text-orange-500 grid place-items-center mx-auto mb-4">
                    <i class="fa-solid fa-utensils text-xl"></i>
                </div>
                <h3 class="font-bold text-xl text-gray-800">
                    No items in this category
                </h3>
                <p class="text-gray-500 mt-1">
                    Try another category.
                </p>
            </div>
        `;
        return;
    }

    items.forEach((item, index) => {
        const card = document.createElement("article");
        const isSoldOut = item.available === false;

        card.className = `
            menu-card
            reveal
            bg-white
            rounded-[2rem]
            shadow-[0_4px_30px_-12px_rgba(15,23,42,0.1)]
            overflow-hidden
            border
            border-gray-100/60
            ${isSoldOut ? "opacity-75" : "hover:-translate-y-1 hover:shadow-[0_12px_40px_-12px_rgba(15,23,42,0.15)]"}
            transition-all
            duration-300
            ease-out
        `;

        card.style.transitionDelay = `${Math.min(index * 28, 220)}ms`;

        const categoryName = categories.find(c => c.id === item.categoryId)?.name || "";

        const imgSrc = item.img && String(item.img).trim()
            ? String(item.img).trim()
            : `https://placehold.co/800x600?text=${encodeURIComponent(item.name)}`;

        card.innerHTML = `
            <div class="relative overflow-hidden bg-gray-50">
                <img
                    src="${escapeHTML(imgSrc)}"
                    alt="${escapeHTML(item.name)}"
                    loading="lazy"
                    decoding="async"
                    class="w-full h-52 object-cover ${isSoldOut ? "grayscale" : ""}"
                >
                ${categoryName ? `
                    <div class="absolute left-4 top-4 px-3 py-1 rounded-full bg-white/80 backdrop-blur-sm text-[10px] font-semibold uppercase tracking-[0.14em] text-gray-600">
                        ${escapeHTML(categoryName)}
                    </div>
                ` : ""}
                ${isSoldOut ? `
                    <div class="absolute right-4 top-4 px-3 py-1 rounded-full bg-red-600 text-white text-[10px] font-bold uppercase tracking-wider shadow">
                        Sold Out
                    </div>
                ` : ""}
            </div>
            <div class="px-5 pt-4 pb-5">
                <h3 class="text-[15px] font-semibold text-gray-800 leading-snug tracking-tight min-h-[2.4rem]">
                    ${escapeHTML(item.name)}
                </h3>
                <div class="flex justify-between items-center mt-4">
                    <span class="text-lg font-semibold text-gray-900 tracking-tight">
                        Rs. ${Number(item.price).toLocaleString()}
                    </span>
                    <div id="qtyBox-${escapeHTML(item.id)}">
                        ${cardControlsHTML(item.id)}
                    </div>
                </div>
            </div>
        `;

        const image = card.querySelector("img");
        if (image) {
            image.addEventListener(
                "error",
                () => {
                    image.src = `https://placehold.co/800x600?text=${encodeURIComponent(item.name)}`;
                },
                { once: true }
            );
        }

        grid.appendChild(card);

        requestAnimationFrame(() => {
            card.classList.add("is-visible");
        });
    });
}

// ===== Cart & Totals (M-03: clamp discountPercent to 0..100) =====
function updateCartCount() {
    const counter = $("cartCount");
    const bottomNavCounter = $("bottomNavCartCount");

    if (!counter && !bottomNavCounter) return;

    const count = cart.reduce((sum, item) => sum + item.qty, 0);

    if (counter) counter.textContent = count;
    if (bottomNavCounter) bottomNavCounter.textContent = count;

    if (count > 0) {
        counter?.classList.add("animate-bounce");
        bottomNavCounter?.classList.add("animate-bounce");

        setTimeout(() => {
            counter?.classList.remove("animate-bounce");
            bottomNavCounter?.classList.remove("animate-bounce");
        }, 450);
    }
}

function getCartSubtotal() {
    return cart.reduce((sum, item) => sum + (item.price * item.qty), 0);
}

function getDiscountAmount() {
    const subtotal = getCartSubtotal();
    let couponDiscount = 0;
    if (appliedCoupon) {
        const clampedPercent = Math.max(0, Math.min(100, Number(appliedCoupon.discountPercent) || 0));
        couponDiscount = Math.round(subtotal * (clampedPercent / 100));
    }
    const maxRedeemable = Math.max(0, subtotal - couponDiscount);
    const loyaltyDiscount = Math.min(Math.max(0, redeemLoyaltyPoints), maxRedeemable);
    return Math.min(subtotal, couponDiscount + loyaltyDiscount);
}

function getCartTotal() {
    return Math.max(0, getCartSubtotal() - getDiscountAmount());
}

// ===== Coupons (S-06, M-03: Server-side validation, clamped 0..100) =====
function isCouponExpired(expiresAt) {
    if (!expiresAt) return false;
    const expiry = new Date(expiresAt);
    return expiry.getTime() < Date.now();
}

function setCouponMessage(message, isError = true) {
    const el = $("couponMessage");
    if (!el) return;

    el.textContent = message;
    el.classList.remove("hidden", "text-red-500", "text-green-600");
    el.classList.add(isError ? "text-red-500" : "text-green-600");
}

async function applyCoupon() {
    const input = $("couponCodeInput");
    if (!input) return;

    const code = input.value.trim().toUpperCase();
    if (!code) {
        setCouponMessage("Please enter a coupon code.");
        return;
    }

    try {
        // Validate via consume-coupon Edge Function with consume: false
        let couponData = null;
        const { data: fnData, error: fnErr } = await supabase.functions.invoke("consume-coupon", {
            body: { code, consume: false }
        });

        if (!fnErr && fnData && fnData.valid) {
            const c = fnData.coupon || fnData;
            couponData = {
                code: c.code || fnData.code || code,
                discountPercent: Math.max(
                    0,
                    Math.min(100, Number(c.discount_percent ?? c.discountPercent ?? fnData.discount_percent ?? fnData.discountPercent) || 0)
                )
            };
        } else {
            // Fallback read from coupons table via RLS
            const { data: row, error } = await supabase
                .from("coupons")
                .select("*")
                .eq("code", code)
                .maybeSingle();

            if (error || !row) {
                setCouponMessage(fnData?.error || "Invalid coupon code.");
                return;
            }
            if (!row.active) {
                setCouponMessage("This coupon is no longer active.");
                return;
            }
            if (row.single_use && row.used) {
                setCouponMessage("This coupon has already been used.");
                return;
            }
            if (!row.single_use && row.max_uses && (row.used_count || 0) >= row.max_uses) {
                setCouponMessage("This coupon has reached its usage limit.");
                return;
            }
            if (row.assigned_to && (!currentUser || row.assigned_to !== currentUser.id)) {
                setCouponMessage("This coupon is assigned to a specific customer account. Please sign in.");
                return;
            }
            if (isCouponExpired(row.expires_at)) {
                setCouponMessage("This coupon has expired.");
                return;
            }
            couponData = {
                code: row.code,
                discountPercent: Math.max(0, Math.min(100, Number(row.discount_percent) || 0))
            };
        }

        appliedCoupon = couponData;

        input.disabled = true;
        $("applyCouponBtn").textContent = "Remove";
        $("applyCouponBtn").onclick = removeCoupon;

        setCouponMessage(`Coupon applied: ${couponData.discountPercent}% off`, false);

        renderCartModal();
        renderFloatingCart();
    } catch (error) {
        console.error("Coupon validation error:", error);
        setCouponMessage("Could not validate coupon. Try again.");
    }
}

function removeCoupon() {
    appliedCoupon = null;

    const input = $("couponCodeInput");
    if (input) {
        input.disabled = false;
        input.value = "";
    }

    const applyBtn = $("applyCouponBtn");
    if (applyBtn) {
        applyBtn.textContent = "Apply";
        applyBtn.onclick = applyCoupon;
    }

    const messageEl = $("couponMessage");
    if (messageEl) {
        messageEl.classList.add("hidden");
    }

    renderCartModal();
    renderFloatingCart();
}

// Add to cart (M-07: block unavailable items)
window.addToCart = (id) => {
    const item = menuItems.find(item => item.id === id);
    if (!item) return;

    if (item.available === false) {
        showToast(`${item.name} is currently sold out.`, "fa-circle-exclamation");
        return;
    }

    const existing = cart.find(cartItem => cartItem.id === id);

    if (existing) {
        existing.qty += 1;
    } else {
        cart.push({
            ...item,
            menuItemId: item.menuItemId,
            qty: 1
        });
    }

    updateCartCount();
    renderCardControls(id);
    renderFloatingCart();
    animateCartButton();
    saveCart();

    showToast(`${item.name} added to cart`, "fa-check");
};

// Remove from cart
window.removeFromCart = (id) => {
    const removed = cart.find(item => item.id === id);
    cart = cart.filter(item => item.id !== id);

    renderCartModal();
    updateCartCount();
    renderCardControls(id);
    renderFloatingCart();
    saveCart();

    if (removed) {
        showToast(`${removed.name} removed`, "fa-trash");
    }
};

// Change quantity
window.changeCartQty = (id, delta) => {
    const item = cart.find(cartItem => cartItem.id === id);
    if (!item) return;

    item.qty += delta;

    if (item.qty <= 0) {
        cart = cart.filter(cartItem => cartItem.id !== id);
    }

    renderCartModal();
    updateCartCount();
    renderCardControls(id);
    renderFloatingCart();
    animateCartButton();
    saveCart();
};

// ===== Floating Cart =====
function renderFloatingCart() {
    const panel = $("floatingCart");
    if (!panel) return;

    if (cart.length === 0) {
        panel.classList.remove("is-visible");
        return;
    }

    panel.classList.add("is-visible");

    const count = cart.reduce((sum, item) => sum + item.qty, 0);

    $("floatingCartCount").textContent = count;
    $("floatingCartTotal").textContent = `Rs. ${getCartTotal().toLocaleString()}`;

    $("floatingCartItems").innerHTML = cart.map(item => `
        <div class="flex justify-between items-center text-sm rounded-2xl px-2 py-2 hover:bg-gray-50 transition-colors">
            <div class="truncate pr-2">
                <div class="font-bold text-gray-800 truncate">
                    ${escapeHTML(item.name)}
                </div>
                <div class="text-gray-500">
                    Rs. ${Number(item.price).toLocaleString()} × ${item.qty}
                </div>
            </div>
            <div class="flex items-center gap-1 shrink-0">
                <button
                    onclick="changeCartQty('${escapeHTML(item.id)}', -1)"
                    class="w-7 h-7 rounded-lg bg-gray-100 hover:bg-gray-200 font-bold text-xs transition-colors pressable"
                >
                    −
                </button>
                <span class="font-bold w-4 text-center text-xs">
                    ${item.qty}
                </span>
                <button
                    onclick="changeCartQty('${escapeHTML(item.id)}', 1)"
                    class="w-7 h-7 rounded-lg bg-gray-100 hover:bg-gray-200 font-bold text-xs transition-colors pressable"
                >
                    +
                </button>
            </div>
        </div>
    `).join("");

    pricePulse($("floatingCartTotal"));
}

// ===== Full Cart Modal =====
function renderCartModal() {
    const list = $("cartItemsList");
    const totalDisplay = $("cartTotalDisplay");

    if (!list || !totalDisplay) return;

    if (cart.length === 0) {
        list.innerHTML = `
            <div class="text-center text-gray-400 py-12">
                <div class="w-16 h-16 rounded-2xl bg-gray-100 text-gray-400 grid place-items-center mx-auto mb-4">
                    <i class="fa-solid fa-cart-shopping text-xl"></i>
                </div>
                <p class="font-semibold">
                    Your cart is empty.
                </p>
                <p class="text-sm mt-1">
                    Add something delicious from the menu.
                </p>
            </div>
        `;
    } else {
        list.innerHTML = cart.map(item => `
            <div class="flex justify-between items-center border border-gray-100 rounded-2xl p-3 hover:shadow-sm transition-all">
                <div class="min-w-0 pr-3">
                    <div class="font-bold text-gray-800 truncate">
                        ${escapeHTML(item.name)}
                    </div>
                    <div class="text-sm text-gray-500 mt-0.5">
                        Rs. ${Number(item.price).toLocaleString()}
                    </div>
                </div>
                <div class="flex items-center gap-1.5 shrink-0">
                    <button
                        onclick="changeCartQty('${escapeHTML(item.id)}', -1)"
                        class="w-8 h-8 rounded-xl bg-gray-100 hover:bg-gray-200 font-bold transition-colors pressable"
                    >
                        −
                    </button>
                    <span class="font-black w-5 text-center">
                        ${item.qty}
                    </span>
                    <button
                        onclick="changeCartQty('${escapeHTML(item.id)}', 1)"
                        class="w-8 h-8 rounded-xl bg-gray-100 hover:bg-gray-200 font-bold transition-colors pressable"
                    >
                        +
                    </button>
                    <button
                        onclick="removeFromCart('${escapeHTML(item.id)}')"
                        class="w-8 h-8 rounded-xl bg-red-50 text-red-500 hover:bg-red-100 transition-colors pressable"
                        aria-label="Remove item"
                    >
                        <i class="fa-solid fa-trash text-xs"></i>
                    </button>
                </div>
            </div>
        `).join("");
    }

    totalDisplay.textContent = `Rs. ${getCartTotal().toLocaleString()}`;

    const discountRow = $("cartDiscountRow");
    const discountDisplay = $("cartDiscountDisplay");

    if (discountRow && discountDisplay) {
        const discount = getDiscountAmount();
        discountRow.classList.toggle("hidden", discount <= 0);
        discountDisplay.textContent = `-Rs. ${discount.toLocaleString()}`;
    }

    pricePulse(totalDisplay);
}

// ===== Past Orders =====
async function loadPastOrders() {
    if (!currentUser) {
        openModal($("authModal"));
        showToast("Please sign in to view past orders.", "fa-user");
        return;
    }

    const list = $("pastOrdersList");
    if (!list) return;

    list.innerHTML = `
        <div class="text-center text-gray-400 py-12">
            <i class="fa-solid fa-spinner fa-spin text-xl"></i>
        </div>
    `;

    openModal($("pastOrdersModal"));

    try {
        if (pastOrdersChannel) {
            supabase.removeChannel(pastOrdersChannel);
            pastOrdersChannel = null;
        }

        const fetchUserOrders = async () => {
            const { data, error } = await supabase
                .from("online_orders")
                .select("*, online_order_items(*)")
                .eq("customer_id", currentUser.id)
                .order("created_at", { ascending: false })
                .limit(20);

            if (error) throw error;

            pastOrdersCache = (data || []).map(row => ({
                id: row.id,
                status: row.status,
                orderType: row.order_type,
                total: row.total,
                createdAt: row.created_at,
                estimatedReadyTime: row.estimated_ready_time,
                items: Array.isArray(row.online_order_items) && row.online_order_items.length
                    ? row.online_order_items.map(i => ({
                        id: i.menu_item_id,
                        menuItemId: i.menu_item_id,
                        name: i.name,
                        price: i.price,
                        qty: i.qty
                    }))
                    : (row.items || [])
            }));
            renderPastOrders();
        };

        await fetchUserOrders();

        pastOrdersChannel = supabase
            .channel(`past-orders-${currentUser.id}`)
            .on(
                "postgres_changes",
                {
                    event: "*",
                    schema: "public",
                    table: "online_orders",
                    filter: `customer_id=eq.${currentUser.id}`
                },
                () => fetchUserOrders()
            )
            .subscribe();
    } catch (error) {
        console.error("Failed to load past orders:", error);
        list.innerHTML = `
            <div class="text-center text-gray-400 py-12">
                <p class="font-semibold text-gray-600">Couldn't load your past orders.</p>
                <p class="text-sm mt-1">Please try again later.</p>
            </div>
        `;
    }
}

function renderPastOrders() {
    const list = $("pastOrdersList");
    if (!list) return;

    if (!pastOrdersCache.length) {
        list.innerHTML = `
            <div class="text-center text-gray-400 py-12">
                <p class="font-semibold">No past orders yet.</p>
            </div>
        `;
        return;
    }

    list.innerHTML = pastOrdersCache.map(order => {
        const date = order.createdAt ? new Date(order.createdAt).toLocaleString() : "";
        const itemsSummary = (order.items || [])
            .map(item => `${item.name} × ${item.qty}`)
            .join(", ");

        const status = order.status || "PENDING";
        const isActive = !["COMPLETED", "REJECTED"].includes(status);

        return `
            <div class="border border-gray-100 rounded-2xl p-4 hover:shadow-md transition-shadow">
                <div class="flex justify-between items-start gap-3">
                    <div class="min-w-0">
                        <div class="flex items-center gap-2 mb-2">
                            <span class="status-badge status-${status.toLowerCase()}">
                                <i class="fa-solid ${getStatusIcon(status)} mr-1"></i>
                                ${getStatusLabel(status)}
                            </span>
                            ${isActive ? '<span class="text-xs text-orange-500 font-semibold animate-pulse">● Live</span>' : ''}
                        </div>
                        <div class="text-xs text-gray-400 mb-1">${escapeHTML(date)}</div>
                        <div class="text-sm text-gray-700 mt-1">${escapeHTML(itemsSummary)}</div>
                        ${order.estimatedReadyTime && isActive ? `
                            <div class="text-xs text-blue-600 mt-2 flex items-center gap-1">
                                <i class="fa-solid fa-clock"></i>
                                <span>Ready by ${formatEstimatedTime(order.estimatedReadyTime)}</span>
                            </div>
                        ` : ''}
                    </div>
                    <div class="text-right shrink-0">
                        <div class="font-black text-gray-900">Rs. ${Number(order.total || 0).toLocaleString()}</div>
                        ${!isActive ? `
                            <button
                                onclick="repeatOrder('${escapeHTML(order.id)}')"
                                class="mt-2 text-xs bg-gray-900 text-white px-3 py-1.5 rounded-full hover:bg-orange-500 transition-colors pressable"
                            >
                                Repeat Order
                            </button>
                        ` : ''}
                    </div>
                </div>
            </div>
        `;
    }).join("");
}

window.repeatOrder = (orderId) => {
    const order = pastOrdersCache.find(o => o.id === orderId);
    if (!order) return;

    let addedCount = 0;

    (order.items || []).forEach(orderItem => {
        const menuItem = menuItems.find(
            item => item.id === (orderItem.menuItemId || orderItem.id)
        );

        if (!menuItem || menuItem.available === false) return;

        const existing = cart.find(item => item.id === menuItem.id);

        if (existing) {
            existing.qty += orderItem.qty;
        } else {
            cart.push({ ...menuItem, qty: orderItem.qty });
        }

        addedCount += 1;
    });

    if (addedCount < (order.items || []).length) {
        showToast(
            "Some items are no longer available and were skipped.",
            "fa-circle-exclamation"
        );
    } else {
        showToast("Items added to cart", "fa-cart-shopping");
    }

    updateCartCount();
    renderFloatingCart();
    renderCartModal();

    closeModal($("pastOrdersModal"));
    openModal($("cartModal"));
};

// ===== Order Tracking (S-03: Guest tracking via track-order Edge Function with orderId + phone) =====
window.trackOrderByID = async function(orderId, phoneInput) {
    const idVal = (orderId ?? $("orderIdInput")?.value ?? "").trim();
    const phoneVal = (phoneInput ?? $("orderPhoneInput")?.value ?? "").trim();

    if (!idVal) {
        showToast("Please enter an Order ID", "fa-circle-exclamation");
        return;
    }
    if (!phoneVal) {
        showToast("Please enter the phone number used for the order", "fa-phone");
        return;
    }

    const trackingContent = $("trackingContent");
    const trackingError = $("trackingError");

    if (!trackingContent || !trackingError) return;

    trackingContent.innerHTML = `
        <div class="text-center py-12">
            <i class="fa-solid fa-spinner fa-spin text-3xl text-orange-500"></i>
            <p class="mt-3 text-gray-600">Looking up your order...</p>
        </div>
    `;
    trackingError.classList.add("hidden");

    try {
        const { data, error } = await supabase.functions.invoke("track-order", {
            body: { orderId: idVal, phone: phoneVal }
        });

        if (error || !data || data.error) {
            trackingContent.innerHTML = "";
            trackingError.textContent = data?.error || "Order not found. Please check your Order ID and phone number.";
            trackingError.classList.remove("hidden");
            return;
        }

        const ord = data.order || data;
        renderOrderTimeline({
            id: ord.id,
            status: ord.status,
            orderType: ord.orderType || ord.order_type || "DELIVERY",
            total: ord.total,
            estimatedReadyTime: ord.estimatedReadyTime || ord.estimated_ready_time,
            rejectionReason: ord.rejectionReason || ord.rejection_reason,
            pendingAt: ord.createdAt || ord.created_at,
            acceptedAt: ord.acceptedAt || ord.accepted_at,
            preparingAt: ord.preparingAt || ord.preparing_at,
            out_for_deliveryAt: ord.outForDeliveryAt || ord.out_for_delivery_at,
            completedAt: ord.completedAt || ord.completed_at
        });
    } catch (error) {
        console.error("Error tracking order:", error);
        trackingContent.innerHTML = "";
        trackingError.textContent = "Could not load order. Please try again.";
        trackingError.classList.remove("hidden");
    }
};

// Render order timeline UI
function renderOrderTimeline(order) {
    const trackingContent = $("trackingContent");
    if (!trackingContent) return;

    const orderType = order.orderType || order.order_type || "DELIVERY";
    const currentStatus = order.status || "PENDING";
    const progress = getProgressPercentage(currentStatus, orderType);

    const allSteps = {
        'DELIVERY': [
            { status: 'PENDING',          label: 'Order Placed',     icon: 'fa-clock' },
            { status: 'ACCEPTED',         label: 'Order Confirmed',  icon: 'fa-check-circle' },
            { status: 'PREPARING',        label: 'Being Prepared',   icon: 'fa-fire' },
            { status: 'OUT_FOR_DELIVERY', label: 'Out for Delivery', icon: 'fa-motorcycle' },
            { status: 'COMPLETED',        label: 'Delivered',        icon: 'fa-circle-check' }
        ],
        'TAKEAWAY': [
            { status: 'PENDING',   label: 'Order Placed',      icon: 'fa-clock' },
            { status: 'ACCEPTED',  label: 'Order Confirmed',   icon: 'fa-check-circle' },
            { status: 'PREPARING', label: 'Being Prepared',    icon: 'fa-fire' },
            { status: 'COMPLETED', label: 'Ready for Pickup',  icon: 'fa-circle-check' }
        ]
    };

    const steps = allSteps[orderType] || allSteps['DELIVERY'];
    const currentStepIndex = steps.findIndex(s => s.status === currentStatus);

    if (currentStatus === 'REJECTED') {
        trackingContent.innerHTML = `
            <div class="text-center py-8">
                <div class="w-16 h-16 rounded-full bg-red-50 text-red-500 grid place-items-center mx-auto mb-4">
                    <i class="fa-solid fa-times-circle text-2xl"></i>
                </div>
                <h3 class="text-xl font-bold text-gray-900 mb-2">Order Cancelled</h3>
                <p class="text-gray-600">This order has been cancelled.</p>
                ${order.rejectionReason ? `<p class="text-sm text-gray-500 mt-2">Reason: ${escapeHTML(order.rejectionReason)}</p>` : ''}
            </div>
        `;
        return;
    }

    const stepsHTML = steps.map((step, index) => {
        const isCompleted = index <= currentStepIndex;
        const isCurrent = index === currentStepIndex;
        const timestamp = order[`${step.status.toLowerCase()}At`] || order[`${step.status.toLowerCase()}_at`];

        return `
            <div class="timeline-step ${isCompleted ? 'completed' : ''} ${isCurrent ? 'current' : ''}">
                <div class="timeline-icon ${isCompleted ? 'bg-orange-500 text-white' : 'bg-gray-200 text-gray-400'}">
                    <i class="fa-solid ${step.icon}"></i>
                </div>
                <div class="flex items-start justify-between">
                    <div>
                        <div class="font-bold text-gray-900">${step.label}</div>
                        ${timestamp ? `<div class="text-xs text-gray-500 mt-1">${formatEstimatedTime(timestamp)}</div>` : ''}
                    </div>
                    ${isCurrent ? '<span class="status-pulse"></span>' : ''}
                </div>
            </div>
        `;
    }).join('');

    trackingContent.innerHTML = `
        <div class="p-6">
            <div class="mb-8">
                <div class="flex justify-between items-center mb-2">
                    <span class="text-sm font-semibold text-gray-700">Order Progress</span>
                    <span class="text-sm font-bold text-orange-500">${Math.round(progress)}%</span>
                </div>
                <div class="h-2 bg-gray-200 rounded-full overflow-hidden">
                    <div class="h-full bg-gradient-to-r from-orange-500 to-amber-500 transition-all duration-500" style="width: ${progress}%"></div>
                </div>
            </div>

            <div class="mb-6 p-4 rounded-2xl bg-orange-50 border border-orange-100">
                <div class="flex items-center gap-3">
                    <div class="w-10 h-10 rounded-full bg-orange-500 text-white grid place-items-center">
                        <i class="fa-solid ${getStatusIcon(currentStatus)}"></i>
                    </div>
                    <div>
                        <div class="text-xs text-orange-600 font-semibold">Current Status</div>
                        <div class="text-lg font-black text-gray-900">${getStatusLabel(currentStatus)}</div>
                    </div>
                </div>
            </div>

            ${order.estimatedReadyTime ? `
                <div class="mb-6 p-4 rounded-2xl bg-blue-50 border border-blue-100">
                    <div class="flex items-center gap-2 text-sm">
                        <i class="fa-solid fa-clock text-blue-600"></i>
                        <span class="text-gray-700">Estimated ready by</span>
                        <span class="font-bold text-blue-600">${formatEstimatedTime(order.estimatedReadyTime)}</span>
                    </div>
                </div>
            ` : ''}

            <div class="timeline">
                ${stepsHTML}
            </div>

            <div class="mt-6 pt-6 border-t border-gray-200">
                <div class="text-xs font-bold uppercase tracking-wide text-gray-500 mb-3">Order Details</div>
                <div class="space-y-2 text-sm">
                    <div class="flex justify-between">
                        <span class="text-gray-600">Order ID</span>
                        <span class="font-mono text-gray-900">${escapeHTML(order.id)}</span>
                    </div>
                    <div class="flex justify-between">
                        <span class="text-gray-600">Type</span>
                        <span class="font-semibold text-gray-900">${escapeHTML(orderType)}</span>
                    </div>
                    <div class="flex justify-between">
                        <span class="text-gray-600">Total</span>
                        <span class="font-bold text-gray-900">Rs. ${Number(order.total || 0).toLocaleString()}</span>
                    </div>
                </div>
            </div>
        </div>
    `;
}

function closeTrackOrderModal() {
    if (activeOrderChannel && supabase) {
        supabase.removeChannel(activeOrderChannel);
        activeOrderChannel = null;
    }
    closeModal($("trackOrderModal"));
    if ($("orderIdInput")) $("orderIdInput").value = "";
    if ($("orderPhoneInput")) $("orderPhoneInput").value = "";
    if ($("trackingContent")) {
        $("trackingContent").innerHTML = `
            <div class="text-center py-12 text-gray-400">
                <i class="fa-solid fa-magnifying-glass text-3xl mb-3"></i>
                <p class="font-semibold">Enter your Order ID and Phone Number to track</p>
            </div>
        `;
    }
    $("trackingError")?.classList.add("hidden");
    $("trackOrderIdSection")?.classList.remove("hidden");
}

window.closeTrackOrderModal = closeTrackOrderModal;

// ===== Order Type =====
function setOrderType(type) {
    currentOrderType = type;

    const deliveryBtn = $("orderTypeDelivery");
    const takeawayBtn = $("orderTypeTakeaway");
    const addressInput = $("checkoutAddress");

    if (!deliveryBtn || !takeawayBtn || !addressInput) return;

    const active = "flex-1 py-2.5 rounded-xl text-sm font-semibold bg-orange-500 text-white shadow-sm transition-all";
    const inactive = "flex-1 py-2.5 rounded-xl text-sm font-semibold text-gray-600 transition-all";

    if (type === "DELIVERY") {
        deliveryBtn.className = active;
        takeawayBtn.className = inactive;
        addressInput.classList.remove("hidden");
        addressInput.required = true;
        $("deliveryInfoNote")?.classList.remove("hidden");
    } else {
        takeawayBtn.className = active;
        deliveryBtn.className = inactive;
        addressInput.classList.add("hidden");
        addressInput.required = false;
        $("deliveryInfoNote")?.classList.add("hidden");
    }
}

// ===== Place Order (S-04, S-05, S-06, H-05, H-07, M-02, M-04, M-07) =====
async function isEmailVerificationRequired() {
    if (!supabase) return true;
    try {
        const { data } = await supabase
            .from("settings")
            .select("value")
            .eq("key", "require_email_verification")
            .maybeSingle();
        if (data && data.value && typeof data.value.enabled === "boolean") {
            return data.value.enabled;
        }
    } catch {
        // Default to true
    }
    return true;
}

async function placeOrder() {
    // M-04: Prevent double-click duplicate submissions
    if (placingOrder) return;

    if (cart.length === 0) {
        showToast("Your cart is empty.", "fa-cart-shopping");
        return;
    }

    // H-05: If signed in, require email verification unless disabled by owner in settings
    if (currentUser) {
        const requireVerified = await isEmailVerificationRequired();
        if (requireVerified && !currentUser.email_confirmed_at) {
            showToast(
                "Please verify your email (check your inbox) before placing an order.",
                "fa-envelope-circle-check"
            );
            return;
        }
    }

    // M-07: Verify all items in cart are still available
    const unavailableItem = cart.find(cartItem => {
        const latest = menuItems.find(m => m.id === (cartItem.menuItemId || cartItem.id));
        return !latest || latest.available === false;
    });
    if (unavailableItem) {
        showToast(
            `"${unavailableItem.name}" is now sold out. Please remove it from your cart.`,
            "fa-circle-exclamation"
        );
        return;
    }

    const name = $("checkoutName").value.trim() || (currentUser?.email ? currentUser.email.split("@")[0] : "");
    const phone = $("checkoutPhone").value.trim();
    const address = $("checkoutAddress").value.trim();

    if (!name) {
        $("checkoutName").focus();
        showToast("Please enter your name.", "fa-user");
        return;
    }

    if (!phone) {
        $("checkoutPhone").focus();
        showToast("Please enter your phone number.", "fa-phone");
        return;
    }

    if (currentOrderType === "DELIVERY" && !address) {
        $("checkoutAddress").focus();
        showToast("Please enter your delivery address.", "fa-location-dot");
        return;
    }

    // M-02: Enforce minimum delivery order on final post-discount total (getCartTotal)
    if (currentOrderType === "DELIVERY" && getCartTotal() < MIN_DELIVERY_ORDER) {
        showToast(
            `Minimum order for delivery is Rs. ${MIN_DELIVERY_ORDER} after discounts.`,
            "fa-circle-exclamation"
        );
        return;
    }

    const placeBtn = $("placeOrderBtn");
    placingOrder = true;
    placeBtn.disabled = true;
    placeBtn.classList.add("loading");

    try {
        const orderPayload = {
            items: cart.map(item => ({
                menuItemId: item.menuItemId || item.id,
                qty: item.qty
            })),
            orderType: currentOrderType,
            couponCode: appliedCoupon?.code ?? null,
            loyalty_redeem_points: redeemLoyaltyPoints,
            customer: {
                name,
                phone,
                address
            }
        };

        // S-04: Authoritative server-side order creation via place-order Edge Function
        const { data, error } = await supabase.functions.invoke("place-order", {
            body: orderPayload
        });

        if (error || !data || data.error) {
            const msg = data?.error || error?.message || "Could not place order. Try again.";
            showToast(msg, "fa-circle-exclamation");
            placeBtn.classList.remove("loading");
            placeBtn.disabled = false;
            placingOrder = false;
            return;
        }

        placeBtn.classList.remove("loading");
        placeBtn.classList.add("success");

        setTimeout(() => {
            placeBtn.classList.remove("success");
            placeBtn.disabled = false;
            placingOrder = false;

            clearCart();
            removeCoupon();

            updateCartCount();
            renderFloatingCart();
            renderCartModal();

            closeModal($("cartModal"));

            const placedOrderId = data.order?.id || data.orderId || data.id || "";
            if ($("orderIdInput") && placedOrderId) $("orderIdInput").value = placedOrderId;
            if ($("orderPhoneInput") && phone) $("orderPhoneInput").value = phone;

            showToast(
                placedOrderId ? `Order ${placedOrderId} placed! Track it live.` : "Order placed successfully!",
                "fa-circle-check"
            );

            $("checkoutPhone").value = "";
            $("checkoutAddress").value = "";
        }, 1400);
    } catch (err) {
        console.error("Order submission failed:", err);
        showToast("Could not place order. Try again.", "fa-circle-exclamation");
        placeBtn.classList.remove("loading");
        placeBtn.disabled = false;
        placingOrder = false;
    }
}

// ===== Authentication State =====
async function handleAuthChange(user) {
    const loginBtn = $("loginBtn");
    const userProfile = $("userProfile");

    currentUser = user || null;

    if (user && supabase) {
        const { data: profile } = await supabase
            .from("profiles")
            .select("*")
            .eq("id", user.id)
            .maybeSingle();
        currentProfile = profile || null;
    } else {
        currentProfile = null;
    }

    if (!loginBtn || !userProfile) return;

    if (user) {
        loginBtn.classList.add("hidden");
        userProfile.classList.remove("hidden");
        userProfile.classList.add("flex");
        $("userNameDisplay").textContent = currentProfile?.full_name || user.email.split("@")[0];
    } else {
        loginBtn.classList.remove("hidden");
        userProfile.classList.add("hidden");
        userProfile.classList.remove("flex");
    }
}

if (supabase) {
    supabase.auth.getSession().then(({ data: { session } }) => {
        handleAuthChange(session?.user ?? null);
    });
    supabase.auth.onAuthStateChange((_event, session) => {
        handleAuthChange(session?.user ?? null);
    });
}

// ===== Event Wiring =====
$("brandBtn")?.addEventListener("click", () => {
    window.scrollTo({ top: 0, behavior: "smooth" });
});

$("browseMenuBtn")?.addEventListener("click", () => {
    $("menuSection")?.scrollIntoView({ behavior: "smooth", block: "start" });
});

$("cartBtn")?.addEventListener("click", () => {
    renderCartModal();
    openModal($("cartModal"));
});

$("trackOrderBtn")?.addEventListener("click", () => {
    openModal($("trackOrderModal"));
    if (currentUser) {
        autoTrackActiveOrder();
    }
});

async function autoTrackActiveOrder() {
    const trackingContent = $("trackingContent");
    const trackingError = $("trackingError");
    const idInputSection = $("trackOrderIdSection");

    if (!trackingContent || !supabase || !currentUser) return;

    trackingContent.innerHTML = `
        <div class="text-center py-12">
            <i class="fa-solid fa-spinner fa-spin text-3xl text-orange-500"></i>
            <p class="mt-3 text-gray-600">Looking for your active order...</p>
        </div>
    `;
    trackingError?.classList.add("hidden");
    if (idInputSection) idInputSection.classList.add("hidden");

    if (activeOrderChannel) {
        supabase.removeChannel(activeOrderChannel);
        activeOrderChannel = null;
    }

    const fetchActive = async () => {
        const { data, error } = await supabase
            .from("online_orders")
            .select("*")
            .eq("customer_id", currentUser.id)
            .order("created_at", { ascending: false })
            .limit(10);

        if (error) {
            trackingContent.innerHTML = "";
            if (trackingError) {
                trackingError.textContent = "Could not load your order. Please try again.";
                trackingError.classList.remove("hidden");
            }
            return;
        }

        const activeOrder = (data || []).find(
            o => !["COMPLETED", "REJECTED"].includes(o.status || "PENDING")
        );

        if (!activeOrder) {
            trackingContent.innerHTML = `
                <div class="text-center py-12 text-gray-400">
                    <i class="fa-solid fa-check-circle text-3xl mb-3 text-green-400"></i>
                    <p class="font-semibold text-gray-600">No active orders right now.</p>
                    <p class="text-sm mt-1">Place an order and track it here in real time.</p>
                </div>
            `;
            idInputSection?.classList.remove("hidden");
            return;
        }

        renderOrderTimeline({
            id: activeOrder.id,
            status: activeOrder.status,
            orderType: activeOrder.order_type,
            total: activeOrder.total,
            estimatedReadyTime: activeOrder.estimated_ready_time,
            rejectionReason: activeOrder.rejection_reason,
            pendingAt: activeOrder.created_at,
            acceptedAt: activeOrder.accepted_at,
            preparingAt: activeOrder.preparing_at,
            out_for_deliveryAt: activeOrder.out_for_delivery_at,
            completedAt: activeOrder.completed_at
        });
    };

    await fetchActive();

    activeOrderChannel = supabase
        .channel(`active-order-${currentUser.id}`)
        .on(
            "postgres_changes",
            {
                event: "*",
                schema: "public",
                table: "online_orders",
                filter: `customer_id=eq.${currentUser.id}`
            },
            () => fetchActive()
        )
        .subscribe();
}

// ===== Mobile Bottom Nav =====
$("bottomNavHome")?.addEventListener("click", () => {
    window.scrollTo({ top: 0, behavior: "smooth" });
});

$("bottomNavMenu")?.addEventListener("click", () => {
    $("menuSection")?.scrollIntoView({ behavior: "smooth", block: "start" });
});

$("bottomNavCart")?.addEventListener("click", () => {
    renderCartModal();
    openModal($("cartModal"));
});

$("closeCartModal")?.addEventListener("click", () => {
    closeModal($("cartModal"));
});

$("floatingCheckoutBtn")?.addEventListener("click", () => {
    renderCartModal();
    openModal($("cartModal"));
});

$("orderTypeDelivery")?.addEventListener("click", () => setOrderType("DELIVERY"));
$("orderTypeTakeaway")?.addEventListener("click", () => setOrderType("TAKEAWAY"));
$("placeOrderBtn")?.addEventListener("click", placeOrder);

$("loginBtn")?.addEventListener("click", () => openModal($("authModal")));
$("closeAuthModal")?.addEventListener("click", () => closeModal($("authModal")));

$("toggleAuthMode")?.addEventListener("click", (event) => {
    event.preventDefault();
    isLoginMode = !isLoginMode;

    $("authTitle").textContent = isLoginMode ? "Welcome Back" : "Create Account";
    $("authSubmitBtn").textContent = isLoginMode ? "Sign In" : "Register";
    $("authToggleText").textContent = isLoginMode ? "New customer?" : "Already have an account?";
    $("toggleAuthMode").textContent = isLoginMode ? "Create an account" : "Sign in instead";
});

// Auth form with 5-attempt / 5-minute lockout (H-04)
$("authForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();

    if (!supabase) {
        showToast("Supabase is not configured yet.", "fa-circle-exclamation");
        return;
    }

    const lock = getLockoutState();
    if (lock.lockedUntil && Date.now() < lock.lockedUntil) {
        const remainingMin = Math.ceil((lock.lockedUntil - Date.now()) / 60000);
        showToast(
            `Too many failed attempts. Please wait ${remainingMin} minute(s).`,
            "fa-lock"
        );
        return;
    }

    const email = $("authEmail").value.trim();
    const password = $("authPassword").value;
    const submitBtn = $("authSubmitBtn");
    const originalText = submitBtn.textContent;

    submitBtn.disabled = true;
    submitBtn.innerHTML = `
        <i class="fa-solid fa-spinner fa-spin mr-2"></i>
        ${isLoginMode ? "Signing In..." : "Creating..."}
    `;

    try {
        if (isLoginMode) {
            const { error } = await supabase.auth.signInWithPassword({ email, password });
            if (error) throw error;
            clearLoginLockout();
            showToast("Welcome back!", "fa-hand-wave");
        } else {
            const { data: signUpData, error } = await supabase.auth.signUp({ email, password });
            if (error) throw error;
            clearLoginLockout();
            if (signUpData?.session) {
                showToast("Account created and signed in!", "fa-user-check");
            } else {
                showToast("Account created! Please check your email to verify.", "fa-user-check");
            }
        }

        closeModal($("authModal"));
        $("authForm").reset();
    } catch (error) {
        if (isLoginMode) {
            recordFailedLogin();
        }
        console.error("Authentication error:", error);
        showToast(error.message || "Authentication failed.", "fa-circle-exclamation");
    } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = originalText;
    }
});

// Logout
$("logoutBtn")?.addEventListener("click", async () => {
    if (!supabase) return;
    try {
        await supabase.auth.signOut();
        showToast("Signed out successfully.", "fa-right-from-bracket");
    } catch (error) {
        console.error(error);
        showToast("Could not sign out.", "fa-circle-exclamation");
    }
});

// Past orders
$("pastOrdersBtn")?.addEventListener("click", loadPastOrders);
$("closePastOrdersModal")?.addEventListener("click", () => {
    if (pastOrdersChannel && supabase) {
        supabase.removeChannel(pastOrdersChannel);
        pastOrdersChannel = null;
    }
    closeModal($("pastOrdersModal"));
});

// ===== My Coupons & Unified Loyalty (M-01 Option B) =====
async function loadMyCoupons() {
    if (!currentUser) {
        openModal($("authModal"));
        return;
    }
    const content = $("myCouponsContent");
    if (!content) return;

    content.innerHTML = `
        <div class="text-center py-12 text-gray-400">
            <i class="fa-solid fa-spinner fa-spin text-2xl mb-3"></i>
            <p>Loading your rewards & coupons…</p>
        </div>
    `;
    openModal($("myCouponsModal"));

    try {
        const uid = currentUser.id;
        const [profileRes, couponsRes, ordersRes] = await Promise.all([
            supabase.from("profiles").select("order_count, loyalty_points").eq("id", uid).maybeSingle(),
            supabase.from("coupons").select("*").eq("assigned_to", uid),
            supabase.from("online_orders").select("coupon_code, discount_amount").eq("customer_id", uid)
        ]);

        const orderCount = profileRes.data?.order_count ?? 0;
        const loyaltyPoints = profileRes.data?.loyalty_points ?? 0;
        const coupons = (couponsRes.data || []).map(c => ({
            id: c.code,
            code: c.code,
            discountPercent: c.discount_percent,
            active: c.active,
            used: c.used
        }));
        const couponOrders = (ordersRes.data || [])
            .filter(o => o.coupon_code && Number(o.discount_amount) > 0)
            .map(o => ({
                couponCode: o.coupon_code,
                discountAmount: Number(o.discount_amount)
            }));

        renderMyCoupons(orderCount, loyaltyPoints, coupons, couponOrders);
    } catch (err) {
        console.error("loadMyCoupons error:", err);
        content.innerHTML = `<div class="text-center py-12 text-red-400"><p>Could not load coupons. Please try again.</p></div>`;
    }
}

function renderMyCoupons(orderCount, loyaltyPoints, coupons, couponOrders) {
    const content = $("myCouponsContent");
    if (!content) return;

    const progress = orderCount % 10;
    const ordersLeft = 10 - progress;
    const pct = (progress / 10) * 100;

    const activeCoupons = coupons.filter(c => c.active && !c.used);
    const usedCoupons = coupons.filter(c => !c.active || c.used);
    const totalSaved = couponOrders.reduce((sum, o) => sum + (Number(o.discountAmount) || 0), 0);

    const progressHTML = `
        <div class="bg-orange-50 border border-orange-100 rounded-2xl p-5 space-y-4">
            <div class="flex items-center justify-between gap-3">
                <div class="flex items-center gap-3">
                    <div class="w-10 h-10 rounded-full bg-orange-500 text-white grid place-items-center shrink-0">
                        <i class="fa-solid fa-star"></i>
                    </div>
                    <div>
                        <div class="font-bold text-gray-900">Unified Loyalty Rewards</div>
                        <div class="text-xs text-gray-500">Earn 1 pt per Rs. 100 spent + 10% off coupon every 10th completed order</div>
                    </div>
                </div>
                <div class="text-right shrink-0">
                    <div class="text-xs font-semibold text-orange-600 uppercase">Points Balance</div>
                    <div class="text-lg font-black text-gray-900">${Number(loyaltyPoints).toLocaleString()} pts</div>
                </div>
            </div>
            <div>
                <div class="flex justify-between text-sm font-semibold text-gray-700 mb-1">
                    <span>${progress} / 10 completed orders</span>
                    <span>${ordersLeft === 10 && orderCount > 0 ? "Coupon earned!" : ordersLeft + " more to go"}</span>
                </div>
                <div class="h-3 bg-white rounded-full overflow-hidden border border-orange-100">
                    <div class="h-full bg-gradient-to-r from-orange-500 to-amber-400 rounded-full transition-all duration-500" style="width:${pct}%"></div>
                </div>
            </div>
        </div>
    `;

    const activeCouponsHTML = activeCoupons.length ? activeCoupons.map(c => `
        <div class="flex items-center justify-between border border-green-100 bg-green-50 rounded-2xl px-4 py-3 gap-3">
            <div>
                <div class="font-mono font-bold text-gray-900 text-sm">${escapeHTML(c.id)}</div>
                <div class="text-xs text-green-700 font-semibold mt-0.5">${Number(c.discountPercent)}% off — Ready to use</div>
            </div>
            <button
                onclick="navigator.clipboard.writeText('${escapeHTML(c.id)}').then(()=>showToast('Coupon code copied!','fa-copy'))"
                class="text-xs bg-green-600 text-white px-3 py-1.5 rounded-full hover:bg-green-700 transition-colors pressable shrink-0"
            >
                <i class="fa-solid fa-copy mr-1"></i>Copy
            </button>
        </div>
    `).join("") : `<p class="text-sm text-gray-400 text-center py-3">No active coupons right now.</p>`;

    const historyHTML = usedCoupons.length ? usedCoupons.map(c => {
        const saved = couponOrders.find(o => o.couponCode === c.id);
        return `
        <div class="flex items-center justify-between border border-gray-100 rounded-2xl px-4 py-3 gap-3">
            <div>
                <div class="font-mono font-bold text-gray-500 text-sm line-through">${escapeHTML(c.id)}</div>
                <div class="text-xs text-gray-400 mt-0.5">${Number(c.discountPercent)}% off${saved ? ` — saved Rs. ${Number(saved.discountAmount).toLocaleString()}` : ""}</div>
            </div>
            <span class="text-xs bg-gray-100 text-gray-500 px-2 py-1 rounded-full font-semibold">Used</span>
        </div>
    `}).join("") : `<p class="text-sm text-gray-400 text-center py-3">No coupon history yet.</p>`;

    const totalHTML = totalSaved > 0 ? `
        <div class="flex items-center justify-between bg-gray-900 text-white rounded-2xl px-5 py-4">
            <div class="flex items-center gap-2">
                <i class="fa-solid fa-piggy-bank text-orange-400"></i>
                <span class="font-semibold">Total saved with coupons</span>
            </div>
            <span class="font-black text-orange-400 text-lg">Rs. ${totalSaved.toLocaleString()}</span>
        </div>
    ` : "";

    content.innerHTML = `
        ${progressHTML}
        ${totalHTML}
        <div>
            <div class="text-xs font-bold uppercase tracking-wide text-gray-500 mb-3">Active Coupons</div>
            <div class="space-y-2">${activeCouponsHTML}</div>
        </div>
        <div>
            <div class="text-xs font-bold uppercase tracking-wide text-gray-500 mb-3">Coupon History</div>
            <div class="space-y-2">${historyHTML}</div>
        </div>
    `;
}

// ===== Service Worker Registration =====
if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
        navigator.serviceWorker.register("./sw.js").catch(err => {
            console.warn("Service Worker registration failed:", err);
        });
    });
}

// ===== Banner Carousel =====
let bannerData = [];
let currentBannerIndex = 0;
let bannerInterval = null;

async function loadBanners() {
    if (!supabase) return;
    try {
        const { data, error } = await supabase
            .from("banners")
            .select("*")
            .eq("active", true)
            .order("sort_order", { ascending: true });

        if (error) throw error;

        bannerData = (data || []).map(row => {
            let parsedUrls = [];
            if (Array.isArray(row.image_urls) && row.image_urls.length) {
                parsedUrls = row.image_urls;
            } else if (typeof row.image_url === "string" && row.image_url.trim()) {
                const raw = row.image_url.trim();
                if (raw.startsWith("[")) {
                    try {
                        const arr = JSON.parse(raw);
                        if (Array.isArray(arr)) parsedUrls = arr;
                    } catch {
                        parsedUrls = [raw];
                    }
                } else {
                    parsedUrls = [raw];
                }
            }
            return {
                id: row.id,
                title: row.title,
                description: row.description || row.subtitle || "",
                type: row.type || "promotion",
                link: row.link,
                imageUrls: parsedUrls
            };
        });

        renderBannerCarousel();
    } catch (error) {
        console.error("Failed to load banners:", error);
        const container = $("promoBannerContainer");
        if (container) container.classList.add("hidden");
    }
}

function renderBannerCarousel() {
    const container = $("promoBannerContainer");
    const slidesWrapper = $("bannerSlides");
    const dotsContainer = $("bannerDots");

    if (!container || !slidesWrapper || !dotsContainer) return;

    if (bannerData.length === 0) {
        container.classList.add("hidden");
        return;
    }

    container.classList.remove("hidden");

    const allSlides = bannerData.flatMap(banner => {
        const images = banner.imageUrls || [];
        return images.map((imageUrl, idx) => ({
            banner,
            imageUrl,
            isPrimary: idx === 0
        }));
    });

    if (allSlides.length === 0) {
        container.classList.add("hidden");
        return;
    }

    slidesWrapper.innerHTML = allSlides.map((slide, index) => `
        <div
            class="flex-none w-full h-full relative bg-gradient-to-r from-orange-500 via-amber-500 to-orange-600"
            data-slide-index="${index}"
        >
            <div class="absolute inset-0 bg-black/10"></div>

            <div class="relative z-10 h-full flex flex-col md:flex-row items-center justify-between p-4 sm:p-6 md:p-8 gap-4">
                <div class="flex-1 text-white text-center md:text-left">
                    <h3 class="text-xl sm:text-2xl md:text-3xl font-black mb-2 sm:mb-3 leading-tight">
                        ${escapeHTML(slide.banner.title)}
                    </h3>
                    ${slide.banner.description ? `
                        <p class="text-sm sm:text-base md:text-lg text-white/90 mb-4 leading-relaxed max-w-md mx-auto md:mx-0">
                            ${escapeHTML(slide.banner.description)}
                        </p>
                    ` : ''}
                    <div class="inline-flex items-center gap-2 text-xs sm:text-sm font-semibold uppercase tracking-wide">
                        <span class="w-2 h-2 bg-white rounded-full animate-pulse"></span>
                        ${escapeHTML(slide.banner.type)} ${slide.banner.link ? '• Click to Learn More' : ''}
                    </div>
                </div>

                <div class="flex-shrink-0">
                    <img
                        src="${escapeHTML(slide.imageUrl)}"
                        alt="${escapeHTML(slide.banner.title)}"
                        class="w-24 h-24 sm:w-32 sm:h-32 md:w-40 md:h-40 rounded-2xl object-cover shadow-lg ring-4 ring-white/20"
                        loading="lazy"
                        onerror="this.src='https://placehold.co/300x300?text=Promo'"
                    />
                </div>
            </div>
        </div>
    `).join("");

    dotsContainer.innerHTML = allSlides.map((_, index) => `
        <button
            class="w-2 h-2 rounded-full transition-all duration-200 ${index === currentBannerIndex ? 'bg-white scale-125' : 'bg-white/50'}"
            onclick="goToBannerSlide(${index})"
            aria-label="Go to slide ${index + 1}"
        ></button>
    `).join("");

    dotsContainer.style.display = allSlides.length <= 1 ? 'none' : 'flex';

    updateBannerSlidePosition();
    startBannerAutoRotation();
}

function getTotalSlideCount() {
    return bannerData.reduce((total, banner) => {
        const images = banner.imageUrls || [];
        return total + images.length;
    }, 0);
}

function updateBannerSlidePosition() {
    const slidesWrapper = $("bannerSlides");
    const totalSlides = getTotalSlideCount();
    if (!slidesWrapper || totalSlides === 0) return;

    const translateX = -currentBannerIndex * 100;
    slidesWrapper.style.transform = `translateX(${translateX}%)`;

    const dots = $("bannerDots")?.querySelectorAll("button");
    if (dots) {
        dots.forEach((dot, index) => {
            dot.className = index === currentBannerIndex
                ? "w-2 h-2 rounded-full transition-all duration-200 bg-white scale-125"
                : "w-2 h-2 rounded-full transition-all duration-200 bg-white/50";
        });
    }
}

function goToBannerSlide(index) {
    const totalSlides = getTotalSlideCount();
    if (index < 0 || index >= totalSlides) return;

    currentBannerIndex = index;
    updateBannerSlidePosition();
    startBannerAutoRotation();
}

window.goToSlide = goToBannerSlide;
window.goToBannerSlide = goToBannerSlide;

function nextBannerSlide() {
    const totalSlides = getTotalSlideCount();
    if (totalSlides === 0) return;
    currentBannerIndex = (currentBannerIndex + 1) % totalSlides;
    updateBannerSlidePosition();
}

function prevBannerSlide() {
    const totalSlides = getTotalSlideCount();
    if (totalSlides === 0) return;
    currentBannerIndex = currentBannerIndex === 0 ? totalSlides - 1 : currentBannerIndex - 1;
    updateBannerSlidePosition();
}

function startBannerAutoRotation() {
    if (bannerInterval) {
        clearInterval(bannerInterval);
        bannerInterval = null;
    }

    const totalSlides = getTotalSlideCount();
    if (totalSlides <= 1) return;

    bannerInterval = setInterval(nextBannerSlide, 5000);
}

$("bannerPrevBtn")?.addEventListener("click", () => {
    prevBannerSlide();
    startBannerAutoRotation();
});

$("bannerNextBtn")?.addEventListener("click", () => {
    nextBannerSlide();
    startBannerAutoRotation();
});

$("promoBannerContainer")?.addEventListener("mouseenter", () => {
    if (bannerInterval) {
        clearInterval(bannerInterval);
        bannerInterval = null;
    }
});

$("promoBannerContainer")?.addEventListener("mouseleave", () => {
    startBannerAutoRotation();
});

let touchStartX = 0;
let touchEndX = 0;

$("promoBannerContainer")?.addEventListener("touchstart", (e) => {
    touchStartX = e.changedTouches[0].screenX;
    if (bannerInterval) clearInterval(bannerInterval);
}, { passive: true });

$("promoBannerContainer")?.addEventListener("touchend", (e) => {
    touchEndX = e.changedTouches[0].screenX;
    const swipeThreshold = 50;
    if (touchEndX < touchStartX - swipeThreshold) nextBannerSlide();
    if (touchEndX > touchStartX + swipeThreshold) prevBannerSlide();
    startBannerAutoRotation();
}, { passive: true });

document.addEventListener("DOMContentLoaded", loadBanners);

$("myCouponsBtn")?.addEventListener("click", loadMyCoupons);
$("closeMyCouponsModal")?.addEventListener("click", () => closeModal($("myCouponsModal")));

document.addEventListener("click", (e) => {
    if (e.target.closest("#myCouponsBtn")) loadMyCoupons();
});

$("applyCouponBtn")?.addEventListener("click", applyCoupon);

// ===== Close Modals by clicking outside =====
[
    $("authModal"),
    $("cartModal"),
    $("pastOrdersModal"),
    $("myCouponsModal")
].forEach(modal => {
    if (!modal) return;
    modal.addEventListener("click", (event) => {
        if (event.target === modal) {
            closeModal(modal);
        }
    });
});

// ===== Escape closes modal =====
document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;

    ["authModal", "cartModal", "pastOrdersModal", "myCouponsModal"].forEach(id => {
        const modal = $(id);
        if (modal?.classList.contains("is-open")) {
            closeModal(modal);
        }
    });
});

// ===== Scroll Reveal =====
const revealObserver = new IntersectionObserver(
    (entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                entry.target.classList.add("is-visible");
                revealObserver.unobserve(entry.target);
            }
        });
    },
    { threshold: 0.08 }
);

function observeReveals() {
    document.querySelectorAll(".reveal:not(.is-visible)").forEach(el => {
        revealObserver.observe(el);
    });
}

// ===== Scroll Effects =====
window.addEventListener(
    "scroll",
    () => {
        const nav = $("mainNav");
        const progress = $("scrollProgress");

        if (nav) {
            if (window.scrollY > 14) {
                nav.classList.add("shadow-md", "bg-white/90");
            } else {
                nav.classList.remove("shadow-md", "bg-white/90");
            }
        }

        if (progress) {
            const maxScroll = document.documentElement.scrollHeight - window.innerHeight;
            const ratio = maxScroll > 0 ? window.scrollY / maxScroll : 0;
            progress.style.transform = `scaleX(${ratio})`;
        }

        const menuSection = $("menuSection");
        const bottomNavHome = $("bottomNavHome");
        const bottomNavMenu = $("bottomNavMenu");

        if (menuSection && bottomNavHome && bottomNavMenu) {
            const isMenuActive = window.scrollY >= menuSection.offsetTop - 120;
            bottomNavHome.classList.toggle("active", !isMenuActive);
            bottomNavMenu.classList.toggle("active", isMenuActive);
        }
    },
    { passive: true }
);

// ===== Initial View =====
async function initMenu() {
    setOrderType("DELIVERY");
    renderMenuSkeleton();

    if (!isSupabaseConfigured()) {
        $("menuGrid").innerHTML = `
            <div class="col-span-full py-20 text-center">
                <div class="w-16 h-16 rounded-2xl bg-orange-50 text-orange-500 grid place-items-center mx-auto mb-4">
                    <i class="fa-solid fa-cloud text-xl"></i>
                </div>
                <h3 class="font-bold text-xl text-gray-800">
                    Cloud Database Not Configured
                </h3>
                <p class="text-gray-500 mt-1 max-w-md mx-auto">
                    Connect your Supabase project in <code class="px-1.5 py-0.5 bg-gray-100 rounded">config.js</code> or via the Admin Dashboard to load the live menu.
                </p>
            </div>
        `;
        return;
    }

    try {
        await loadMenuFromSupabase();
        renderCategories("ALL");
        renderMenu(menuItems);

        // Realtime subscription: auto-update menu and images when dishes are added/edited in POS or Admin
        if (supabase) {
            supabase
                .channel("public:menu_items_live")
                .on(
                    "postgres_changes",
                    { event: "*", schema: "public", table: "menu_items" },
                    async () => {
                        try {
                            await loadMenuFromSupabase();
                            const activeCat = document.querySelector(".category-pill.active")?.dataset?.category || "ALL";
                            renderCategories(activeCat);
                            filterCategory(activeCat);
                        } catch (err) {
                            console.warn("Realtime menu refresh error:", err);
                        }
                    }
                )
                .subscribe();
        }
    } catch (error) {
        console.error("Failed to load menu from Supabase:", error);
        $("menuGrid").innerHTML = `
            <div class="col-span-full py-20 text-center">
                <div class="w-16 h-16 rounded-2xl bg-red-50 text-red-500 grid place-items-center mx-auto mb-4">
                    <i class="fa-solid fa-wifi text-xl"></i>
                </div>
                <h3 class="font-bold text-xl text-gray-800">
                    Couldn’t load the menu
                </h3>
                <p class="text-gray-500 mt-1">
                    Please refresh and try again.
                </p>
                <button
                    onclick="location.reload()"
                    class="mt-5 px-5 py-2.5 rounded-xl bg-gray-900 text-white font-bold hover:bg-orange-500 transition-colors pressable"
                >
                    Refresh
                </button>
            </div>
        `;
    }

    renderFloatingCart();
    observeReveals();
    updateCartCount();
}

// ===== Order Tracking Utilities =====
function getStatusLabel(status) {
    const labels = {
        'PENDING':          'Order Placed',
        'ACCEPTED':         'Order Confirmed',
        'PREPARING':        'Being Prepared',
        'OUT_FOR_DELIVERY': 'Out for Delivery',
        'COMPLETED':        'Delivered',
        'REJECTED':         'Cancelled'
    };
    return labels[status] || status;
}

function getStatusIcon(status) {
    const icons = {
        'PENDING':          'fa-clock',
        'ACCEPTED':         'fa-check-circle',
        'PREPARING':        'fa-fire',
        'OUT_FOR_DELIVERY': 'fa-motorcycle',
        'COMPLETED':        'fa-circle-check',
        'REJECTED':         'fa-times-circle'
    };
    return icons[status] || 'fa-circle';
}

function formatEstimatedTime(timestamp) {
    if (!timestamp) return 'Calculating...';
    const date = new Date(timestamp);
    return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

function getProgressPercentage(currentStatus, orderType) {
    const deliverySteps = ['PENDING', 'ACCEPTED', 'PREPARING', 'OUT_FOR_DELIVERY', 'COMPLETED'];
    const takeawaySteps = ['PENDING', 'ACCEPTED', 'PREPARING', 'COMPLETED'];

    const steps = orderType === 'DELIVERY' ? deliverySteps : takeawaySteps;
    const currentIndex = steps.indexOf(currentStatus);

    if (currentIndex === -1) return 0;
    return ((currentIndex + 1) / steps.length) * 100;
}

// Start website
initMenu();
