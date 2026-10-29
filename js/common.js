// Shared helpers: header/footer, cart, settings, toasts, formatting.
import { auth, db, isConfigured } from "./fb.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

export const DEFAULT_SETTINGS = {
  storeName: "Sweet Tooth",
  currency: "AED",
  deliveryFee: 10,
  minOrder: 30,
  acceptingOrders: true,
  deliveryArea: "We deliver within 5 miles of the bakery.",
  announcement: "Fresh batches every Monday",
};

// Shown before Firebase is connected, so the site can be previewed.
export const DEMO_COOKIES = [
  { id: "d1", name: "Brown Butter Chip", description: "Nutty brown butter, dark chocolate chunks, flaky salt.", price: 14, style: "chocchip", plate: "garland", tile: "brown", tag: "Bestseller", available: true, sort: 1 },
  { id: "d2", name: "Raspberry Thumbprint", description: "Buttery shortbread cradling a spoon of raspberry jam.", price: 12, style: "jam", plate: "floral", tile: "cream", tag: "", available: true, sort: 2 },
  { id: "d3", name: "Matcha White Choc", description: "Ceremonial matcha dough studded with white chocolate.", price: 15, style: "matcha", plate: "gold", tile: "olive", tag: "New", available: true, sort: 3 },
  { id: "d4", name: "Birthday Sprinkle", description: "Vanilla sugar cookie, pink glaze, a riot of sprinkles.", price: 13, style: "sprinkle", plate: "blush", tile: "pink", tag: "", available: true, sort: 4 },
  { id: "d5", name: "Midnight Double", description: "Cocoa dough, white chips, a molten fudgy middle.", price: 15, style: "double", plate: "mint", tile: "mustard", tag: "", available: true, sort: 5 },
  { id: "d6", name: "Red Velvet Crush", description: "Tangy red velvet with cream-cheese white chocolate.", price: 14, style: "redvelvet", plate: "sky", tile: "red", tag: "", available: true, sort: 6 },
];

export const STATUS_FLOW = ["requested", "confirmed", "baking", "out_for_delivery", "delivered"];
export const STATUS_LABEL = {
  requested: "Requested",
  confirmed: "Confirmed",
  baking: "Baking",
  out_for_delivery: "Out for delivery",
  delivered: "Delivered",
  declined: "Declined",
  cancelled: "Cancelled",
};

let settingsCache = null;
export async function loadSettings() {
  if (settingsCache) return settingsCache;
  settingsCache = { ...DEFAULT_SETTINGS };
  if (isConfigured) {
    try {
      // Don't let a slow or missing database hold up the page.
      const snap = await Promise.race([
        getDoc(doc(db, "settings", "store")),
        new Promise((_, rej) => setTimeout(() => rej(new Error("settings timeout")), 5000)),
      ]);
      if (snap.exists()) settingsCache = { ...DEFAULT_SETTINGS, ...snap.data() };
    } catch (e) {
      console.warn("Could not load settings", e);
    }
  }
  return settingsCache;
}

export function money(n, currency = settingsCache?.currency ?? DEFAULT_SETTINGS.currency) {
  // Letter codes like "AED" get a space: "AED 14.00". Symbols stay tight: "£14.00".
  const sep = /[A-Za-z]$/.test(currency) ? " " : "";
  return `${currency}${sep}${Number(n || 0).toFixed(2)}`;
}

export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export function fmtDate(ts) {
  if (!ts) return "";
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleString(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
}

/* ---------------- Toasts ---------------- */
export function toast(msg, kind = "ok") {
  let wrap = document.querySelector(".toasts");
  if (!wrap) {
    wrap = document.createElement("div");
    wrap.className = "toasts";
    wrap.setAttribute("role", "status");
    wrap.setAttribute("aria-live", "polite");
    document.body.appendChild(wrap);
  }
  const el = document.createElement("div");
  el.className = `toast toast-${kind}`;
  el.textContent = msg;
  wrap.appendChild(el);
  setTimeout(() => el.classList.add("out"), 3200);
  setTimeout(() => el.remove(), 3700);
}

/* ---------------- Cart (stored in this browser) ---------------- */
const CART_KEY = "sweettooth.cart.v1";
const listeners = new Set();

function readCart() {
  try {
    return JSON.parse(localStorage.getItem(CART_KEY)) || [];
  } catch {
    return [];
  }
}
function writeCart(items) {
  try {
    localStorage.setItem(CART_KEY, JSON.stringify(items));
  } catch {}
  listeners.forEach((fn) => fn(items));
}

export const cart = {
  items: readCart,
  onChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  add(cookie, qty = 1) {
    const items = readCart();
    const found = items.find((i) => i.id === cookie.id);
    if (found) found.qty = Math.min(99, found.qty + qty);
    else items.push({ id: cookie.id, name: cookie.name, price: Number(cookie.price), style: cookie.style, plate: cookie.plate, qty });
    writeCart(items);
  },
  setQty(id, qty) {
    let items = readCart();
    if (qty <= 0) items = items.filter((i) => i.id !== id);
    else items = items.map((i) => (i.id === id ? { ...i, qty: Math.min(99, qty) } : i));
    writeCart(items);
  },
  // Keep cart prices/names in sync with the live menu; drop removed items.
  reconcile(menu) {
    const byId = new Map(menu.map((c) => [c.id, c]));
    const items = readCart()
      .filter((i) => byId.has(i.id) && byId.get(i.id).available !== false)
      .map((i) => ({ ...i, name: byId.get(i.id).name, price: Number(byId.get(i.id).price) }));
    writeCart(items);
  },
  clear() {
    writeCart([]);
  },
  count() {
    return readCart().reduce((s, i) => s + i.qty, 0);
  },
  subtotal() {
    return readCart().reduce((s, i) => s + i.qty * i.price, 0);
  },
};
window.addEventListener("storage", (e) => e.key === CART_KEY && listeners.forEach((fn) => fn(readCart())));

/* ---------------- Auth helpers ---------------- */
// Anonymous users are never customers (the admin panel uses its own app anyway).
export function onCustomer(fn) {
  if (!isConfigured) {
    fn(null);
    return () => {};
  }
  return onAuthStateChanged(auth, (u) => fn(u && !u.isAnonymous ? u : null));
}

/* ---------------- Layout ---------------- */
const ICON = {
  bag: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 8h12l-1 12H7L6 8Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M9 8V6a3 3 0 0 1 6 0v2" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>`,
  menu: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`,
  close: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`,
};
export { ICON };

export const STAR = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5l2.6 6.1 6.4.5-4.9 4.2 1.5 6.4L12 16.4l-5.6 3.3 1.5-6.4L3 9.1l6.4-.5L12 2.5Z" fill="currentColor"/></svg>`;

export function renderChrome(active = "") {
  const header = document.querySelector("[data-header]");
  if (header) {
    header.innerHTML = `
      <div class="announce" data-announce></div>
      <nav class="nav wrap" aria-label="Main">
        <a class="brand" href="index.html" aria-label="Sweet Tooth home">
          <span class="brand-script">Sweet Tooth</span>
          <span class="brand-sub">cookie bakery</span>
        </a>
        <button class="icon-btn nav-toggle" aria-label="Open menu" aria-expanded="false" data-nav-toggle>${ICON.menu}</button>
        <div class="nav-links" data-nav-links>
          <a href="index.html#menu" ${active === "menu" ? 'aria-current="page"' : ""}>Menu</a>
          <a href="index.html#how" >How it works</a>
          <a href="orders.html" ${active === "orders" ? 'aria-current="page"' : ""}>My orders</a>
          <a href="account.html" data-account-link ${active === "account" ? 'aria-current="page"' : ""}>Sign in</a>
        </div>
        <button class="bag-btn" data-open-cart aria-label="Open your box">
          ${ICON.bag}<span class="bag-label">Your box</span><span class="bag-count" data-cart-count>0</span>
        </button>
      </nav>`;

    const toggle = header.querySelector("[data-nav-toggle]");
    const links = header.querySelector("[data-nav-links]");
    toggle.addEventListener("click", () => {
      const open = links.classList.toggle("open");
      toggle.setAttribute("aria-expanded", String(open));
      toggle.innerHTML = open ? ICON.close : ICON.menu;
    });

    const countEl = header.querySelector("[data-cart-count]");
    const updateCount = () => {
      const n = cart.count();
      countEl.textContent = n;
      countEl.classList.toggle("has", n > 0);
    };
    updateCount();
    cart.onChange(updateCount);

    onCustomer((u) => {
      const a = header.querySelector("[data-account-link]");
      a.textContent = u ? "Account" : "Sign in";
    });

    loadSettings().then((s) => {
      const el = header.querySelector("[data-announce]");
      if (!s.acceptingOrders) el.innerHTML = `<span>${STAR}</span> The oven is resting — we're not taking new orders right now <span>${STAR}</span>`;
      else if (s.announcement) el.innerHTML = `<span>${STAR}</span> ${esc(s.announcement)} &middot; cash on delivery <span>${STAR}</span>`;
      else el.remove();
    });
  }

  const footer = document.querySelector("[data-footer]");
  if (footer) {
    footer.innerHTML = `
      <div class="wrap footer-grid">
        <div>
          <p class="brand-script footer-logo">Sweet Tooth</p>
          <p class="mono small">/sw&#275;t to&#862;oth/ &nbsp;noun<br>a lifelong weakness for warm cookies.</p>
        </div>
        <div>
          <p class="eyebrow">Visit</p>
          <p><a href="index.html#menu">The menu</a><br><a href="orders.html">Track an order</a><br><a href="account.html">Your account</a></p>
        </div>
        <div>
          <p class="eyebrow">Good to know</p>
          <p class="small">Every order is baked to order and approved by hand. Payment is cash only, on delivery.</p>
        </div>
      </div>
      <div class="wrap footer-base mono small">
        <span>&copy; ${new Date().getFullYear()} Sweet Tooth</span>
        <a href="admin.html" class="admin-link">Staff</a>
      </div>`;
  }

  if (!isConfigured) {
    const b = document.createElement("div");
    b.className = "setup-banner mono small";
    b.innerHTML = `Preview mode &mdash; connect Firebase in <code>js/firebase-config.js</code> to enable sign-in and ordering.`;
    document.body.prepend(b);
  }
}

export async function customerSignOut() {
  if (auth) await signOut(auth);
}

/* ---------------- Cart drawer ---------------- */
import { cookieArt } from "./cookie-art.js";

export function mountCartDrawer() {
  const el = document.createElement("div");
  el.className = "drawer-root";
  el.innerHTML = `
    <div class="drawer-scrim" data-close-cart></div>
    <aside class="drawer" role="dialog" aria-modal="true" aria-labelledby="drawer-title" tabindex="-1">
      <header class="drawer-head">
        <h2 id="drawer-title" class="display">Your box</h2>
        <button class="icon-btn" data-close-cart aria-label="Close">${ICON.close}</button>
      </header>
      <div class="drawer-body" data-cart-body></div>
      <footer class="drawer-foot" data-cart-foot></footer>
    </aside>`;
  document.body.appendChild(el);
  const drawer = el.querySelector(".drawer");

  const open = () => {
    el.classList.add("open");
    document.body.classList.add("no-scroll");
    drawer.focus();
  };
  const close = () => {
    el.classList.remove("open");
    document.body.classList.remove("no-scroll");
  };
  document.addEventListener("click", (e) => {
    if (e.target.closest("[data-open-cart]")) open();
    if (e.target.closest("[data-close-cart]")) close();
  });
  document.addEventListener("keydown", (e) => e.key === "Escape" && close());

  const body = el.querySelector("[data-cart-body]");
  const foot = el.querySelector("[data-cart-foot]");

  async function render() {
    const s = await loadSettings();
    const items = cart.items();
    if (!items.length) {
      body.innerHTML = `<div class="empty"><p class="display-italic">Your box is empty.</p><p class="small">Pick a few favourites from the menu.</p><a class="btn btn-ghost" href="index.html#menu" data-close-cart>Browse the menu</a></div>`;
      foot.innerHTML = "";
      return;
    }
    body.innerHTML = items
      .map(
        (i) => `
      <div class="line">
        <div class="line-art">${cookieArt({ style: i.style, plate: i.plate, seed: i.id })}</div>
        <div class="line-info">
          <p class="line-name">${esc(i.name)}</p>
          <p class="mono small">${money(i.price, s.currency)} each</p>
          <div class="qty" aria-label="Quantity for ${esc(i.name)}">
            <button data-dec="${esc(i.id)}" aria-label="One fewer">&minus;</button>
            <span>${i.qty}</span>
            <button data-inc="${esc(i.id)}" aria-label="One more">+</button>
          </div>
        </div>
        <p class="line-total mono">${money(i.price * i.qty, s.currency)}</p>
      </div>`
      )
      .join("");
    const sub = cart.subtotal();
    const short = Math.max(0, (s.minOrder || 0) - sub);
    foot.innerHTML = `
      <div class="sum-row"><span>Subtotal</span><span class="mono">${money(sub, s.currency)}</span></div>
      <div class="sum-row muted"><span>Delivery</span><span class="mono">${money(s.deliveryFee, s.currency)}</span></div>
      <div class="sum-row total"><span>Total, paid in cash</span><span class="mono">${money(sub + Number(s.deliveryFee || 0), s.currency)}</span></div>
      ${short > 0 ? `<p class="note small">Add ${money(short, s.currency)} more to reach the ${money(s.minOrder, s.currency)} minimum.</p>` : ""}
      ${!s.acceptingOrders ? `<p class="note small">We're not taking orders right now.</p>` : ""}
      <a class="btn btn-primary btn-block ${short > 0 || !s.acceptingOrders ? "disabled" : ""}" href="checkout.html" ${short > 0 || !s.acceptingOrders ? 'aria-disabled="true" tabindex="-1"' : ""}>Continue to delivery</a>`;
  }
  body.addEventListener("click", (e) => {
    const inc = e.target.closest("[data-inc]");
    const dec = e.target.closest("[data-dec]");
    const items = cart.items();
    if (inc) {
      const it = items.find((i) => i.id === inc.dataset.inc);
      cart.setQty(it.id, it.qty + 1);
    }
    if (dec) {
      const it = items.find((i) => i.id === dec.dataset.dec);
      cart.setQty(it.id, it.qty - 1);
    }
  });
  cart.onChange(render);
  render();
  return { open, close };
}
