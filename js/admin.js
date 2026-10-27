// Admin panel. Uses its own Firebase app instance + anonymous session.
// The username/password check is enforced by firestore.rules (see adminSessions).
import { getAdminApp, isConfigured } from "./fb.js";
import { getAuth, signInAnonymously, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc, updateDoc, deleteDoc, addDoc, collection, onSnapshot, query, orderBy,
  serverTimestamp, Timestamp, arrayUnion, writeBatch,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { money, esc, fmtDate, toast, DEFAULT_SETTINGS, DEMO_COOKIES, STATUS_LABEL } from "./common.js";
import { cookieArt, COOKIE_STYLES, PLATES, TILES } from "./cookie-art.js";

const $ = (s, r = document) => r.querySelector(s);
const loginEl = $("[data-login]");
const dashEl = $("[data-dash]");

if (!isConfigured) {
  loginEl.hidden = false;
  $("[data-login-error]").textContent = "Firebase isn't connected yet — add your config to js/firebase-config.js.";
  throw new Error("Firebase not configured");
}

const app = getAdminApp();
const auth = getAuth(app);
const db = getFirestore(app);

/* ---------------- Password hashing (PBKDF2-SHA256, 150k rounds) ---------------- */
async function hashCredentials(username, password) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: enc.encode("sweet-tooth:" + username), iterations: 150000 },
    key,
    256
  );
  return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/* ---------------- Login / logout ---------------- */
let session = null; // { username, passwordHash }
let unsubs = [];

function showLogin(msg = "") {
  unsubs.forEach((u) => u());
  unsubs = [];
  session = null;
  dashEl.hidden = true;
  loginEl.hidden = false;
  $("[data-login-error]").textContent = msg;
}

async function startSession(username, password) {
  if (!auth.currentUser) await signInAnonymously(auth);
  const uid = auth.currentUser.uid;
  const passwordHash = await hashCredentials(username, password);
  const data = { username, passwordHash, createdAt: serverTimestamp() };
  try {
    await setDoc(doc(db, "adminSessions", uid), data);
  } catch (err) {
    if (err.code !== "permission-denied") throw err;
    // First ever login: create the default ADMIN / 1234 record (rules only allow exactly that).
    try {
      await setDoc(doc(db, "admin", "config"), { username, passwordHash, updatedAt: serverTimestamp() });
      await setDoc(doc(db, "adminSessions", uid), data);
    } catch {
      throw Object.assign(new Error("Wrong username or password."), { code: "bad-login" });
    }
  }
}

$("[data-login-form]").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.currentTarget;
  const btn = $("[data-login-btn]");
  const err = $("[data-login-error]");
  err.textContent = "";
  const username = f.username.value.trim();
  const password = f.password.value;
  if (!username || !password) return (err.textContent = "Enter the username and password.");
  btn.disabled = true;
  btn.innerHTML = `<span class="spin"></span> Checking…`;
  try {
    await startSession(username, password);
    f.reset();
    await enterDashboard();
  } catch (ex) {
    console.error(ex);
    err.textContent =
      ex.code === "bad-login" ? "Wrong username or password."
      : ["auth/operation-not-allowed", "auth/admin-restricted-operation", "auth/configuration-not-found"].includes(ex.code)
        ? "Turn on the Anonymous sign-in provider in Firebase (Authentication → Sign-in method)."
        : ex.message;
  } finally {
    btn.disabled = false;
    btn.textContent = "Sign in";
  }
});

$("[data-logout]").addEventListener("click", async () => {
  try {
    if (auth.currentUser) await deleteDoc(doc(db, "adminSessions", auth.currentUser.uid));
  } catch {}
  await signOut(auth);
  showLogin();
});

async function enterDashboard() {
  const snap = await getDoc(doc(db, "adminSessions", auth.currentUser.uid));
  if (!snap.exists()) return showLogin();
  session = snap.data();
  $("[data-who]").textContent = `Signed in as ${session.username}`;
  loginEl.hidden = true;
  dashEl.hidden = false;
  watchOrders();
  watchMenu();
  watchMoney();
  loadSettingsForm();
  $("[data-creds]").username.value = session.username;
}

// Resume a session after refresh (only if it's still valid).
const stopInit = onAuthStateChanged(auth, async (u) => {
  stopInit();
  if (!u) return showLogin();
  try {
    await enterDashboard();
  } catch {
    showLogin();
  }
});

// Any permission error while signed in means the password changed elsewhere.
function onDenied(err) {
  console.error(err);
  if (err.code === "permission-denied") showLogin("Your session ended — please sign in again.");
}

/* ---------------- Tabs ---------------- */
document.querySelectorAll("[data-tab]").forEach((t) =>
  t.addEventListener("click", () => {
    document.querySelectorAll("[data-tab]").forEach((x) => x.setAttribute("aria-selected", String(x === t)));
    document.querySelectorAll("[data-panel]").forEach((p) => (p.hidden = p.dataset.panel !== t.dataset.tab));
  })
);

/* ---------------- Ask dialog ---------------- */
function ask({ title, label, value = "", ok = "Save" }) {
  const dlg = $("[data-ask]");
  $("[data-ask-title]").textContent = title;
  $("[data-ask-label]").textContent = label;
  $("[data-ask-ok]").textContent = ok;
  const input = $("[data-ask-input]");
  input.value = value;
  dlg.returnValue = "";
  dlg.showModal();
  input.focus();
  return new Promise((res) => dlg.addEventListener("close", () => res(dlg.returnValue === "ok" ? input.value.trim() : null), { once: true }));
}

/* ---------------- Orders ---------------- */
let orders = [];
let menu = [];
let costs = new Map(); // cookieId -> { batchCost, batchQty, unitCost } (private)
let finance = new Map(); // orderId -> snapshot (private)
let expenses = [];
let currency = DEFAULT_SETTINGS.currency;
let filter = "pending";
const FILTERS = {
  pending: { label: "Needs approval", test: (o) => o.status === "requested" },
  active: { label: "In progress", test: (o) => ["confirmed", "baking", "out_for_delivery"].includes(o.status) },
  done: { label: "Delivered", test: (o) => o.status === "delivered" },
  closed: { label: "Declined / cancelled", test: (o) => ["declined", "cancelled"].includes(o.status) },
  all: { label: "All", test: () => true },
};
const NEXT = {
  confirmed: { to: "baking", label: "Start baking" },
  baking: { to: "out_for_delivery", label: "Out for delivery" },
  out_for_delivery: { to: "delivered", label: "Delivered & cash collected" },
};

function renderFilters() {
  $("[data-filters]").innerHTML = Object.entries(FILTERS)
    .map(([k, f]) => `<button class="chip" data-filter="${k}" aria-pressed="${k === filter}">${f.label} (${orders.filter(f.test).length})</button>`)
    .join("");
}
$("[data-filters]").addEventListener("click", (e) => {
  const b = e.target.closest("[data-filter]");
  if (!b) return;
  filter = b.dataset.filter;
  renderOrders();
});

function renderStats() {
  const pending = orders.filter(FILTERS.pending.test).length;
  const active = orders.filter(FILTERS.active.test).length;
  const delivered = orders.filter(FILTERS.done.test);
  const revenue = delivered.reduce((s, o) => s + Number(o.total || 0), 0);
  $("[data-stats]").innerHTML = `
    <div class="stat lime"><b>${pending}</b><span>Awaiting approval</span></div>
    <div class="stat"><b>${active}</b><span>In progress</span></div>
    <div class="stat"><b>${delivered.length}</b><span>Delivered</span></div>
    <div class="stat"><b>${money(revenue, currency)}</b><span>Cash collected</span></div>`;
  $("[data-pending-count]").textContent = pending ? `(${pending})` : "";
  document.title = pending ? `(${pending}) Admin — Sweet Tooth` : "Admin — Sweet Tooth";
}

function priceWarning(o) {
  const byId = new Map(menu.map((c) => [c.id, c]));
  const off = (o.items || []).filter((i) => byId.has(i.cookieId) && Number(byId.get(i.cookieId).price) !== Number(i.price));
  const sum = Math.round((o.items || []).reduce((s, i) => s + i.price * i.qty, 0) * 100) / 100;
  const msgs = [];
  if (off.length) msgs.push(`Price differs from the current menu for: ${off.map((i) => esc(i.name)).join(", ")}.`);
  if (Math.abs(sum + Number(o.deliveryFee || 0) - Number(o.total || 0)) > 0.01) msgs.push("Total doesn't add up — check before approving.");
  return msgs.length ? `<p class="warn">${msgs.join(" ")}</p>` : "";
}

function renderOrders() {
  renderFilters();
  renderStats();
  const shown = orders.filter(FILTERS[filter].test);
  const el = $("[data-admin-orders]");
  if (!shown.length) {
    el.innerHTML = `<div class="panel" style="text-align:center"><p class="display-italic" style="font-size:1.5rem;margin:0">Nothing here right now.</p></div>`;
    return;
  }
  el.innerHTML = shown
    .map((o) => {
      const cur = o.currency || currency;
      const a = o.address || {};
      const addr = [a.line1, a.line2, a.city, a.postcode].filter(Boolean).join(", ");
      const next = NEXT[o.status];
      return `
      <article class="order">
        <header class="order-head">
          <div><span class="order-id">${esc(o.orderNumber || o.id.slice(0, 6))}</span> <span class="small muted">&middot; ${fmtDate(o.createdAt)}</span></div>
          <span class="badge badge-${esc(o.status)}">${STATUS_LABEL[o.status] || esc(o.status)}</span>
        </header>
        <div class="order-body">
          <div class="split" style="gap:1.2rem">
            <dl class="kv">
              <dt>Customer</dt><dd>${esc(o.customerName)}${o.email ? ` <span class="small muted">${esc(o.email)}</span>` : ""}</dd>
              <dt>Phone</dt><dd><a href="tel:${esc(o.phone)}">${esc(o.phone)}</a></dd>
              <dt>Address</dt><dd><a href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(addr)}" target="_blank" rel="noopener">${esc(addr)}</a></dd>
              ${o.preferredTime ? `<dt>Wants it</dt><dd>${esc(o.preferredTime)}</dd>` : ""}
              ${o.notes ? `<dt>Notes</dt><dd>${esc(o.notes)}</dd>` : ""}
              <dt>Payment</dt><dd>Cash on delivery</dd>
            </dl>
            <ul class="order-items">
              ${(o.items || []).map((i) => `<li><span>${esc(i.name)} <span class="mono small">× ${i.qty}</span></span><span class="mono">${money(i.price * i.qty, cur)}</span></li>`).join("")}
              <li class="muted"><span>Delivery</span><span class="mono">${money(o.deliveryFee, cur)}</span></li>
              <li style="font-weight:600;border-top:1px dashed var(--line);padding-top:.3rem"><span>Collect in cash</span><span class="mono">${money(o.total, cur)}</span></li>
            </ul>
          </div>
          ${o.status === "requested" ? priceWarning(o) : ""}
          ${o.deliveryWindow ? `<p class="order-note" style="background:var(--lime)"><b>Delivery:</b> ${esc(o.deliveryWindow)}</p>` : ""}
          ${o.adminNote ? `<p class="order-note"><b>Note to customer:</b> ${esc(o.adminNote)}</p>` : ""}
          <div class="admin-actions">
            ${o.status === "requested" ? `<button class="btn btn-primary btn-sm" data-act="approve" data-id="${o.id}">Approve</button><button class="btn btn-danger btn-sm" data-act="decline" data-id="${o.id}">Decline</button>` : ""}
            ${next ? `<button class="btn btn-primary btn-sm" data-act="next" data-to="${next.to}" data-id="${o.id}">${next.label}</button>` : ""}
            ${!["declined", "cancelled", "delivered"].includes(o.status) ? `<button class="btn btn-ghost btn-sm" data-act="window" data-id="${o.id}">Set delivery time</button>` : ""}
            <button class="btn btn-ghost btn-sm" data-act="note" data-id="${o.id}">Note to customer</button>
            ${["declined", "cancelled", "delivered"].includes(o.status) ? `<button class="btn btn-danger btn-sm" data-act="delete" data-id="${o.id}">Delete</button>` : ""}
          </div>
        </div>
      </article>`;
    })
    .join("");
}

async function setStatus(id, status, extra = {}) {
  const batch = writeBatch(db);
  batch.update(doc(db, "orders", id), {
    status,
    ...extra,
    updatedAt: serverTimestamp(),
    statusHistory: arrayUnion({ status, at: Timestamp.now() }),
  });
  // Lock in revenue + cost for this order in a private, admin-only record.
  const o = orders.find((x) => x.id === id);
  if (status === "delivered" && o) batch.set(doc(db, "orderFinance", id), financeFor(o, Timestamp.now()));
  await batch.commit();
  toast(`Order marked ${STATUS_LABEL[status].toLowerCase()}`);
}

$("[data-admin-orders]").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-act]");
  if (!b) return;
  const o = orders.find((x) => x.id === b.dataset.id);
  try {
    b.disabled = true;
    switch (b.dataset.act) {
      case "approve": {
        const win = await ask({ title: "Approve order", label: "Delivery time to show the customer (optional)", value: o.preferredTime || "", ok: "Approve" });
        if (win === null) break;
        await setStatus(o.id, "confirmed", win ? { deliveryWindow: win } : {});
        break;
      }
      case "decline": {
        const why = await ask({ title: "Decline order", label: "Reason the customer will see (optional)", ok: "Decline order" });
        if (why === null) break;
        await setStatus(o.id, "declined", { adminNote: why });
        break;
      }
      case "next":
        await setStatus(o.id, b.dataset.to);
        break;
      case "window": {
        const win = await ask({ title: "Delivery time", label: "e.g. Saturday 2–4pm", value: o.deliveryWindow || "" });
        if (win === null) break;
        await updateDoc(doc(db, "orders", o.id), { deliveryWindow: win, updatedAt: serverTimestamp() });
        toast("Delivery time saved");
        break;
      }
      case "note": {
        const note = await ask({ title: "Note to customer", label: "Shown on their order page", value: o.adminNote || "" });
        if (note === null) break;
        await updateDoc(doc(db, "orders", o.id), { adminNote: note, updatedAt: serverTimestamp() });
        toast("Note saved");
        break;
      }
      case "delete":
        if (confirm(`Delete order ${o.orderNumber || o.id}? This can't be undone.${o.status === "delivered" ? " Its money record stays in the Money tab." : ""}`)) {
          await deleteDoc(doc(db, "orders", o.id));
          toast("Order deleted");
        }
        break;
    }
  } catch (err) {
    onDenied(err);
    toast("That didn't save — " + err.message, "err");
  } finally {
    b.disabled = false;
  }
});

let firstLoad = true;
function watchOrders() {
  unsubs.push(
    onSnapshot(
      query(collection(db, "orders"), orderBy("createdAt", "desc")),
      (snap) => {
        const before = new Set(orders.map((o) => o.id));
        orders = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        if (!firstLoad && orders.some((o) => !before.has(o.id) && o.status === "requested")) toast("New order request!");
        firstLoad = false;
        renderOrders();
        renderMoney();
      },
      onDenied
    )
  );
}

/* ---------------- Menu ---------------- */
const fillSelect = (sel, obj, fmt = (k, v) => v) => (sel.innerHTML = Object.entries(obj).map(([k, v]) => `<option value="${k}">${fmt(k, v)}</option>`).join(""));
fillSelect($("[data-style-select]"), COOKIE_STYLES);
fillSelect($("[data-plate-select]"), PLATES);
fillSelect($("[data-tile-select]"), TILES, (k) => k[0].toUpperCase() + k.slice(1));

function renderMenu() {
  const el = $("[data-menu-list]");
  if (!menu.length) {
    el.innerHTML = `<div class="panel" style="text-align:center"><p class="display-italic" style="font-size:1.5rem;margin:0 0 .5rem">No cookies yet.</p><p class="small" style="margin:0 0 1rem">Add your first one, or start with six sample cookies you can edit.</p><button class="btn btn-ghost" data-seed>Add sample menu</button></div>`;
    return;
  }
  el.innerHTML = menu
    .map(
      (c) => `
    <div class="menu-row">
      <div class="thumb" style="background:${TILES[c.tile] || TILES.pink}">${c.imageUrl ? `<img src="${esc(c.imageUrl)}" alt="" style="border-radius:50%;aspect-ratio:1;object-fit:cover">` : cookieArt({ style: c.style, plate: c.plate, seed: c.id })}</div>
      <div>
        <h3>${esc(c.name)} ${c.tag ? `<span class="card-tag" style="position:static;margin-left:.3rem">${esc(c.tag)}</span>` : ""}</h3>
        <p class="mono small">${money(c.price, currency)} &middot; ${c.hidden ? "Hidden" : c.available === false ? "Sold out" : "On the menu"}</p>
        <p class="mono small muted">${costLine(c)}</p>
      </div>
      <div class="admin-actions">
        <button class="btn btn-ghost btn-sm" data-stock="${c.id}">${c.available === false ? "Mark in stock" : "Mark sold out"}</button>
        <button class="btn btn-primary btn-sm" data-edit="${c.id}">Edit</button>
        <button class="btn btn-danger btn-sm" data-del="${c.id}">Delete</button>
      </div>
    </div>`
    )
    .join("");
}

function costLine(c) {
  const k = costs.get(c.id);
  if (!k || k.unitCost == null) return `<span class="neg" style="color:var(--red)">No cost set</span> &middot; private`;
  const m = c.price > 0 ? Math.round(((c.price - k.unitCost) / c.price) * 100) : 0;
  return `Costs ${money(k.unitCost, currency)} each &middot; ${money(c.price - k.unitCost, currency)} profit (${m}%) &middot; private`;
}

function watchMenu() {
  unsubs.push(
    onSnapshot(
      collection(db, "cookieCosts"),
      (snap) => {
        costs = new Map(snap.docs.map((d) => [d.id, d.data()]));
        renderMenu();
        renderMoney();
      },
      onDenied
    )
  );
  unsubs.push(
    onSnapshot(
      collection(db, "cookies"),
      (snap) => {
        menu = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (a.sort ?? 999) - (b.sort ?? 999) || a.name.localeCompare(b.name));
        renderMenu();
        renderOrders();
        renderMoney();
      },
      onDenied
    )
  );
}

const editor = $("[data-editor]");
const ef = $("[data-editor-form]");
let editingId = null;

function updatePreview() {
  $("[data-preview]").style.background = TILES[ef.tile.value];
  $("[data-preview]").innerHTML = ef.imageUrl.value
    ? `<img src="${esc(ef.imageUrl.value)}" alt="" style="border-radius:50%;aspect-ratio:1;object-fit:cover">`
    : cookieArt({ style: ef.cstyle.value, plate: ef.plate.value, seed: editingId || ef.cname.value || "new" });
}
function updateMargin() {
  const out = $("[data-margin]");
  const bc = ef.batchCost.value, bq = ef.batchQty.value;
  const price = Number(ef.price.value);
  if (bc === "" || bq === "" || !(Number(bq) > 0)) {
    out.textContent = "Leave blank if you don't know yet — profit will show as “no cost set”.";
    return;
  }
  const unit = Number(bc) / Number(bq);
  const profit = price - unit;
  const pct = price > 0 ? Math.round((profit / price) * 100) : 0;
  out.innerHTML = `<b>${money(unit, currency)}</b> per cookie to make &middot; you earn <b style="color:${profit < 0 ? "var(--red)" : "inherit"}">${money(profit, currency)}</b> each (${pct}% margin)`;
}
ef.addEventListener("input", () => {
  updatePreview();
  updateMargin();
});

function openEditor(c = null) {
  editingId = c?.id || null;
  $("[data-ed-title]").textContent = c ? `Edit ${c.name}` : "Add a cookie";
  $("[data-ed-error]").textContent = "";
  ef.cname.value = c?.name || "";
  ef.price.value = c?.price ?? "";
  ef.description.value = c?.description || "";
  ef.cstyle.value = c?.style || "chocchip";
  ef.plate.value = c?.plate || "garland";
  ef.tile.value = c?.tile || Object.keys(TILES)[menu.length % Object.keys(TILES).length];
  ef.tag.value = c?.tag || "";
  ef.sort.value = c?.sort ?? menu.length + 1;
  ef.imageUrl.value = c?.imageUrl || "";
  ef.available.checked = c ? c.available !== false : true;
  ef.chidden.checked = !!c?.hidden;
  const k = c ? costs.get(c.id) : null;
  ef.batchCost.value = k?.batchCost ?? "";
  ef.batchQty.value = k?.batchQty ?? "";
  updatePreview();
  updateMargin();
  editor.showModal();
  ef.cname.focus();
}

$("[data-new-cookie]").addEventListener("click", () => openEditor());

ef.addEventListener("submit", async (e) => {
  if (e.submitter?.value !== "save") return; // cancel just closes
  e.preventDefault();
  const err = $("[data-ed-error]");
  const name = ef.cname.value.trim();
  const price = Math.round(Number(ef.price.value) * 100) / 100;
  if (!name) return (err.textContent = "Give the cookie a name.");
  if (ef.price.value === "" || !(price >= 0)) return (err.textContent = "Enter a price, e.g. 3.50");
  const url = ef.imageUrl.value.trim();
  if (url && !/^https:\/\//i.test(url)) return (err.textContent = "Photo URL must start with https://");
  const hasCost = ef.batchCost.value !== "" || ef.batchQty.value !== "";
  const batchCost = Math.round(Number(ef.batchCost.value) * 100) / 100;
  const batchQty = Math.round(Number(ef.batchQty.value));
  if (hasCost && (!(batchCost >= 0) || ef.batchCost.value === "")) return (err.textContent = "Enter the batch cost, e.g. 6.00 — or clear both cost boxes.");
  if (hasCost && !(batchQty >= 1)) return (err.textContent = "Enter how many cookies the batch makes (1 or more).");
  const data = {
    name,
    price,
    description: ef.description.value.trim(),
    style: ef.cstyle.value,
    plate: ef.plate.value,
    tile: ef.tile.value,
    tag: ef.tag.value.trim(),
    sort: Number(ef.sort.value) || 0,
    imageUrl: url,
    available: ef.available.checked,
    hidden: ef.chidden.checked,
    updatedAt: serverTimestamp(),
  };
  const btn = $("[data-ed-save]");
  btn.disabled = true;
  try {
    let id = editingId;
    if (id) await updateDoc(doc(db, "cookies", id), data);
    else id = (await addDoc(collection(db, "cookies"), { ...data, createdAt: serverTimestamp() })).id;
    // Cost goes to the private collection, never onto the public cookie.
    if (hasCost) {
      await setDoc(doc(db, "cookieCosts", id), { batchCost, batchQty, unitCost: Math.round((batchCost / batchQty) * 10000) / 10000, updatedAt: serverTimestamp() });
    } else if (costs.has(id)) {
      await deleteDoc(doc(db, "cookieCosts", id));
    }
    editor.close();
    toast(`${name} saved`);
  } catch (ex) {
    onDenied(ex);
    err.textContent = ex.message;
  } finally {
    btn.disabled = false;
  }
});

$("[data-menu-list]").addEventListener("click", async (e) => {
  const edit = e.target.closest("[data-edit]");
  const del = e.target.closest("[data-del]");
  const stock = e.target.closest("[data-stock]");
  try {
    if (edit) openEditor(menu.find((c) => c.id === edit.dataset.edit));
    if (stock) {
      const c = menu.find((x) => x.id === stock.dataset.stock);
      await updateDoc(doc(db, "cookies", c.id), { available: c.available === false, updatedAt: serverTimestamp() });
    }
    if (del) {
      const c = menu.find((x) => x.id === del.dataset.del);
      if (confirm(`Delete ${c.name} from the menu?`)) {
        await deleteDoc(doc(db, "cookies", c.id));
        if (costs.has(c.id)) await deleteDoc(doc(db, "cookieCosts", c.id));
        toast(`${c.name} deleted`);
      }
    }
    if (e.target.closest("[data-seed]")) {
      const batch = writeBatch(db);
      DEMO_COOKIES.forEach(({ id, ...c }) => batch.set(doc(collection(db, "cookies")), { ...c, imageUrl: "", hidden: false, createdAt: serverTimestamp(), updatedAt: serverTimestamp() }));
      await batch.commit();
      toast("Sample menu added — edit anything you like");
    }
  } catch (ex) {
    onDenied(ex);
    toast(ex.message, "err");
  }
});

/* ---------------- Settings ---------------- */
const sf = $("[data-settings]");
async function loadSettingsForm() {
  const snap = await getDoc(doc(db, "settings", "store"));
  const s = { ...DEFAULT_SETTINGS, ...(snap.exists() ? snap.data() : {}) };
  currency = s.currency;
  sf.acceptingOrders.checked = !!s.acceptingOrders;
  sf.currency.value = s.currency;
  sf.deliveryFee.value = s.deliveryFee;
  sf.minOrder.value = s.minOrder;
  sf.announcement.value = s.announcement;
  sf.deliveryArea.value = s.deliveryArea;
  renderOrders();
  renderMenu();
  renderMoney();
}
sf.addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("[data-save-settings]");
  btn.disabled = true;
  try {
    const data = {
      acceptingOrders: sf.acceptingOrders.checked,
      currency: sf.currency.value.trim() || "£",
      deliveryFee: Math.max(0, Number(sf.deliveryFee.value) || 0),
      minOrder: Math.max(0, Number(sf.minOrder.value) || 0),
      announcement: sf.announcement.value.trim(),
      deliveryArea: sf.deliveryArea.value.trim(),
      updatedAt: serverTimestamp(),
    };
    await setDoc(doc(db, "settings", "store"), data, { merge: true });
    currency = data.currency;
    renderOrders();
    renderMenu();
    toast("Settings saved");
  } catch (ex) {
    onDenied(ex);
    toast(ex.message, "err");
  } finally {
    btn.disabled = false;
  }
});

/* ---------------- Change admin username / password ---------------- */
const cf = $("[data-creds]");
cf.addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("[data-creds-error]");
  err.textContent = "";
  const username = cf.username.value.trim();
  const pw = cf.password.value;
  if ((await hashCredentials(session.username, cf.current.value)) !== session.passwordHash) return (err.textContent = "Current password is wrong.");
  if (username.length < 3) return (err.textContent = "Username needs at least 3 characters.");
  if (pw.length < 4) return (err.textContent = "Password needs at least 4 characters.");
  if (pw !== cf.password2.value) return (err.textContent = "The new passwords don't match.");
  const btn = $("[data-save-creds]");
  btn.disabled = true;
  try {
    const passwordHash = await hashCredentials(username, pw);
    const batch = writeBatch(db);
    batch.update(doc(db, "admin", "config"), { username, passwordHash, updatedAt: serverTimestamp() });
    batch.set(doc(db, "adminSessions", auth.currentUser.uid), { username, passwordHash, createdAt: serverTimestamp() });
    await batch.commit();
    session = { username, passwordHash };
    $("[data-who]").textContent = `Signed in as ${username}`;
    cf.current.value = cf.password.value = cf.password2.value = "";
    toast("Admin login updated");
  } catch (ex) {
    onDenied(ex);
    err.textContent = ex.message;
  } finally {
    btn.disabled = false;
  }
});

/* ---------------- Money (private: revenue, costs, profit) ---------------- */
const r2 = (n) => Math.round(n * 100) / 100;

// Build a finance record for an order using the current private cookie costs.
function financeFor(o, deliveredAt) {
  const items = (o.items || []).map((i) => {
    const k = costs.get(i.cookieId);
    return { cookieId: i.cookieId, name: i.name, qty: i.qty, price: Number(i.price), unitCost: k?.unitCost ?? null };
  });
  const itemsRevenue = r2(items.reduce((s, i) => s + i.price * i.qty, 0));
  const cogs = r2(items.reduce((s, i) => s + (i.unitCost ?? 0) * i.qty, 0));
  const revenue = Number(o.total ?? itemsRevenue + Number(o.deliveryFee || 0));
  return {
    orderNumber: o.orderNumber || "",
    customerName: o.customerName || "",
    items,
    itemsRevenue,
    deliveryFee: Number(o.deliveryFee || 0),
    revenue,
    cogs,
    profit: r2(revenue - cogs),
    missingCost: items.some((i) => i.unitCost == null),
    deliveredAt,
  };
}

function deliveredAtOf(o) {
  const h = (o.statusHistory || []).filter((x) => x.status === "delivered").pop();
  return h?.at || o.updatedAt || o.createdAt;
}

// Delivered orders: saved snapshot if we have one, otherwise worked out live.
function moneyRecords() {
  const recs = new Map(finance);
  for (const o of orders) if (o.status === "delivered" && !recs.has(o.id)) recs.set(o.id, { ...financeFor(o, deliveredAtOf(o)), live: true });
  return [...recs.entries()].map(([id, r]) => ({ id, ...r }));
}

const PERIODS = {
  week: { label: "7 days", from: () => Date.now() - 7 * 864e5 },
  month: { label: "This month", from: () => new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime() },
  d30: { label: "30 days", from: () => Date.now() - 30 * 864e5 },
  year: { label: "This year", from: () => new Date(new Date().getFullYear(), 0, 1).getTime() },
  all: { label: "All time", from: () => 0 },
};
let period = "month";
const ms = (t) => (t?.toMillis ? t.toMillis() : t ? new Date(t).getTime() : Date.now());

$("[data-period]").addEventListener("click", (e) => {
  const b = e.target.closest("[data-p]");
  if (!b) return;
  period = b.dataset.p;
  renderMoney();
});

function renderMoney() {
  if (!$("[data-money-stats]")) return;
  const from = PERIODS[period].from();
  $("[data-period]").innerHTML = Object.entries(PERIODS).map(([k, p]) => `<button class="chip" data-p="${k}" aria-pressed="${k === period}">${p.label}</button>`).join("");

  const recs = moneyRecords().filter((r) => ms(r.deliveredAt) >= from).sort((a, b) => ms(b.deliveredAt) - ms(a.deliveredAt));
  const exps = expenses.filter((x) => ms(x.date) >= from);
  const revenue = r2(recs.reduce((s, r) => s + r.revenue, 0));
  const cogs = r2(recs.reduce((s, r) => s + r.cogs, 0));
  const other = r2(exps.reduce((s, x) => s + Number(x.amount || 0), 0));
  const profit = r2(revenue - cogs - other);
  const margin = revenue > 0 ? Math.round((profit / revenue) * 100) : 0;
  const pending = orders.filter((o) => ["confirmed", "baking", "out_for_delivery"].includes(o.status));
  const pendingRev = r2(pending.reduce((s, o) => s + Number(o.total || 0), 0));
  const cookiesSold = recs.reduce((s, r) => s + r.items.reduce((a, i) => a + i.qty, 0), 0);

  $("[data-money-stats]").innerHTML = `
    <div class="stat lime"><b>${money(revenue, currency)}</b><span>Revenue (cash in)</span><small>${recs.length} delivered order${recs.length === 1 ? "" : "s"}</small></div>
    <div class="stat"><b>${money(cogs, currency)}</b><span>Cost to make</span><small>${cookiesSold} cookies sold</small></div>
    <div class="stat"><b>${money(other, currency)}</b><span>Other expenses</span><small>${exps.length} logged</small></div>
    <div class="stat ${profit < 0 ? "loss" : "profit"}"><b>${money(profit, currency)}</b><span>Profit</span><small>${margin}% margin</small></div>
    <div class="stat"><b>${money(recs.length ? revenue / recs.length : 0, currency)}</b><span>Average order</span></div>
    <div class="stat"><b>${money(recs.length ? r2((revenue - cogs) / recs.length) : 0, currency)}</b><span>Profit per order</span><small>before other expenses</small></div>
    <div class="stat"><b>${money(pendingRev, currency)}</b><span>Still to collect</span><small>${pending.length} approved, not delivered</small></div>
    <div class="stat"><b>${money(recs.reduce((s, r) => s + r.deliveryFee, 0), currency)}</b><span>Delivery fees</span><small>included in revenue</small></div>`;

  const missing = recs.filter((r) => r.missingCost).length;
  const noCost = menu.filter((c) => !costs.has(c.id)).length;
  $("[data-money-warn]").innerHTML = missing || noCost
    ? `<p class="warn">${missing ? `${missing} order${missing === 1 ? " has" : "s have"} cookies with no cost set, so profit looks higher than it is. ` : ""}${noCost ? `${noCost} cookie${noCost === 1 ? "" : "s"} on the menu ${noCost === 1 ? "has" : "have"} no cost yet — add it in Menu → Edit.` : ""}</p>`
    : "";

  // Per cookie
  const by = new Map();
  for (const r of recs)
    for (const i of r.items) {
      const row = by.get(i.cookieId) || { name: i.name, qty: 0, rev: 0, cost: 0, unknown: false };
      row.qty += i.qty;
      row.rev += i.price * i.qty;
      row.cost += (i.unitCost ?? 0) * i.qty;
      row.unknown ||= i.unitCost == null;
      by.set(i.cookieId, row);
    }
  const rows = [...by.values()].sort((a, b) => b.rev - a.rev - 0 || b.qty - a.qty);
  const fees = recs.reduce((s, r) => s + r.deliveryFee, 0);
  $("[data-by-cookie]").innerHTML = rows.length
    ? `<thead><tr><th>Cookie</th><th class="num">Sold</th><th class="num">Revenue</th><th class="num">Cost</th><th class="num">Profit</th><th class="num">Margin</th></tr></thead>
       <tbody>${rows.map((r) => {
         const p = r.rev - r.cost;
         return `<tr><td>${esc(r.name)}</td><td class="num">${r.qty}</td><td class="num">${money(r.rev, currency)}</td><td class="num">${r.unknown ? "?" : money(r.cost, currency)}</td><td class="num ${p < 0 ? "neg" : ""}">${money(p, currency)}</td><td class="num">${r.rev ? Math.round((p / r.rev) * 100) : 0}%</td></tr>`;
       }).join("")}
       <tr><td>Delivery fees</td><td class="num">—</td><td class="num">${money(fees, currency)}</td><td class="num">—</td><td class="num">${money(fees, currency)}</td><td class="num">—</td></tr></tbody>
       <tfoot><tr><td>Total</td><td class="num">${cookiesSold}</td><td class="num">${money(revenue, currency)}</td><td class="num">${money(cogs, currency)}</td><td class="num">${money(revenue - cogs, currency)}</td><td class="num">${revenue ? Math.round(((revenue - cogs) / revenue) * 100) : 0}%</td></tr></tfoot>`
    : `<tbody><tr><td class="muted">No delivered orders in this period yet.</td></tr></tbody>`;

  $("[data-by-order]").innerHTML = recs.length
    ? `<thead><tr><th>Order</th><th>Delivered</th><th class="num">Revenue</th><th class="num">Cost</th><th class="num">Profit</th></tr></thead>
       <tbody>${recs.slice(0, 20).map((r) => `<tr><td class="mono">${esc(r.orderNumber || r.id.slice(0, 6))}</td><td>${fmtDate(r.deliveredAt)}</td><td class="num">${money(r.revenue, currency)}</td><td class="num">${r.missingCost ? "?" : money(r.cogs, currency)}</td><td class="num ${r.profit < 0 ? "neg" : ""}">${money(r.profit, currency)}</td></tr>`).join("")}</tbody>`
    : `<tbody><tr><td class="muted">Nothing delivered yet.</td></tr></tbody>`;

  $("[data-expense-list]").innerHTML = exps.length
    ? exps.map((x) => `<div class="expense"><div><p>${esc(x.label)}</p><p class="small muted">${x.date?.toDate ? x.date.toDate().toLocaleDateString() : ""}</p></div><div style="display:flex;gap:.6rem;align-items:center"><span class="mono">${money(x.amount, currency)}</span><button class="icon-btn" style="width:38px;height:38px" data-del-exp="${x.id}" aria-label="Delete expense ${esc(x.label)}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></button></div></div>`).join("")
    : `<p class="small muted" style="margin:0">No expenses in this period.</p>`;
}

function watchMoney() {
  unsubs.push(
    onSnapshot(collection(db, "orderFinance"), (snap) => {
      finance = new Map(snap.docs.map((d) => [d.id, d.data()]));
      renderMoney();
    }, onDenied)
  );
  unsubs.push(
    onSnapshot(query(collection(db, "expenses"), orderBy("date", "desc")), (snap) => {
      expenses = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      renderMoney();
    }, onDenied)
  );
}

const xf = $("[data-expense-form]");
xf.date.valueAsDate = new Date();
xf.addEventListener("submit", async (e) => {
  e.preventDefault();
  const label = xf.label.value.trim();
  const amount = r2(Number(xf.amount.value));
  if (!label) return toast("Say what the expense was for", "err");
  if (xf.amount.value === "" || !(amount >= 0)) return toast("Enter an amount", "err");
  const [y, m, d] = (xf.date.value || new Date().toISOString().slice(0, 10)).split("-").map(Number);
  const btn = $("[data-add-expense]");
  btn.disabled = true;
  try {
    await addDoc(collection(db, "expenses"), { label, amount, date: Timestamp.fromDate(new Date(y, m - 1, d, 12)), createdAt: serverTimestamp() });
    xf.label.value = "";
    xf.amount.value = "";
    toast("Expense added");
  } catch (ex) {
    onDenied(ex);
    toast(ex.message, "err");
  } finally {
    btn.disabled = false;
  }
});

$("[data-expense-list]").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-del-exp]");
  if (!b || !confirm("Delete this expense?")) return;
  try {
    await deleteDoc(doc(db, "expenses", b.dataset.delExp));
  } catch (ex) {
    onDenied(ex);
    toast(ex.message, "err");
  }
});
