import { db, isConfigured } from "./fb.js";
import {
  addDoc, collection, doc, getDoc, setDoc, serverTimestamp, Timestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { renderChrome, mountCartDrawer, cart, money, esc, loadSettings, onCustomer, toast } from "./common.js";
import { cookieArt } from "./cookie-art.js";

renderChrome();
mountCartDrawer();

const gate = document.querySelector("[data-gate]");
const form = document.querySelector("[data-form]");
const summary = document.querySelector("[data-summary]");
const errorEl = document.querySelector("[data-error]");
const submit = document.querySelector("[data-submit]");
let user = null;
let settings = null;

function showGate(html) {
  gate.innerHTML = `<div class="panel" style="text-align:center;max-width:560px">${html}</div>`;
  form.hidden = true;
}

function renderSummary() {
  const items = cart.items();
  const sub = cart.subtotal();
  const fee = Number(settings.deliveryFee || 0);
  summary.innerHTML =
    items
      .map(
        (i) => `<div class="summary-line">
          <div>${cookieArt({ style: i.style, plate: i.plate, seed: i.id })}</div>
          <p>${esc(i.name)} <span class="mono small">× ${i.qty}</span></p>
          <p class="mono">${money(i.price * i.qty, settings.currency)}</p>
        </div>`
      )
      .join("") +
    `<div class="sum-row" style="margin-top:.8rem"><span>Subtotal</span><span class="mono">${money(sub, settings.currency)}</span></div>
     <div class="sum-row"><span>Delivery</span><span class="mono">${money(fee, settings.currency)}</span></div>
     <div class="sum-row total"><span>Total due in cash</span><span class="mono">${money(sub + fee, settings.currency)}</span></div>`;
}

async function prefill() {
  form.fullname.value = user.displayName || "";
  try {
    const snap = await getDoc(doc(db, "users", user.uid));
    if (snap.exists()) {
      const p = snap.data();
      form.fullname.value = p.name || form.fullname.value;
      form.phone.value = p.phone || "";
      form.line1.value = p.address?.line1 || "";
      form.line2.value = p.address?.line2 || "";
      form.city.value = p.address?.city || "";
      form.postcode.value = p.address?.postcode || "";
    }
  } catch (e) {
    console.warn(e);
  }
}

async function refresh() {
  settings = await loadSettings();
  if (!isConfigured) return showGate(`<p class="display-italic" style="font-size:1.6rem">Ordering is offline</p><p class="small">Firebase isn't connected yet.</p>`);
  if (!user) return showGate(`<p class="display-italic" style="font-size:1.7rem;margin:0 0 .4rem">Sign in to place your order</p><p class="small" style="margin:0 0 1.2rem">We'll use your account to show you the order status.</p><a class="btn btn-primary" href="account.html?next=checkout.html">Sign in or create account</a>`);
  if (!cart.items().length) return showGate(`<p class="display-italic" style="font-size:1.7rem;margin:0 0 .4rem">Your box is empty</p><a class="btn btn-primary" href="index.html#menu" style="margin-top:.8rem">Browse the menu</a>`);
  if (!settings.acceptingOrders) return showGate(`<p class="display-italic" style="font-size:1.7rem;margin:0 0 .4rem">The oven is resting</p><p class="small">We're not taking new orders right now. Please check back soon.</p>`);
  gate.innerHTML = "";
  form.hidden = false;
  renderSummary();
}

let prefilled = false;
onCustomer(async (u) => {
  user = u;
  await refresh();
  if (u && !prefilled) {
    prefilled = true;
    prefill();
  }
});
cart.onChange(() => refresh());

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  errorEl.textContent = "";
  const required = ["fullname", "phone", "line1", "city", "postcode"];
  let firstBad = null;
  for (const k of required) {
    const bad = !form[k].value.trim();
    form[k].setAttribute("aria-invalid", String(bad));
    if (bad && !firstBad) firstBad = form[k];
  }
  if (firstBad) {
    errorEl.textContent = "Please fill in the highlighted fields.";
    firstBad.focus();
    return;
  }

  submit.disabled = true;
  submit.innerHTML = `<span class="spin"></span> Sending…`;
  try {
    // Re-read live prices so the order always matches the current menu.
    const items = [];
    for (const i of cart.items()) {
      const snap = await getDoc(doc(db, "cookies", i.id));
      if (!snap.exists() || snap.data().available === false || snap.data().hidden) {
        throw new Error(`${i.name} is no longer available — please remove it from your box.`);
      }
      const c = snap.data();
      items.push({ cookieId: i.id, name: c.name, price: Number(c.price), qty: i.qty, style: c.style || "chocchip", plate: c.plate || "garland" });
    }
    const subtotal = Math.round(items.reduce((s, i) => s + i.price * i.qty, 0) * 100) / 100;
    if (subtotal < Number(settings.minOrder || 0)) throw new Error(`The minimum order is ${money(settings.minOrder, settings.currency)}.`);
    const deliveryFee = Number(settings.deliveryFee || 0);

    const address = {
      line1: form.line1.value.trim(),
      line2: form.line2.value.trim(),
      city: form.city.value.trim(),
      postcode: form.postcode.value.trim(),
    };
    const ref = await addDoc(collection(db, "orders"), {
      orderNumber: "ST-" + Math.random().toString(36).slice(2, 7).toUpperCase(),
      uid: user.uid,
      email: user.email || "",
      customerName: form.fullname.value.trim(),
      phone: form.phone.value.trim(),
      address,
      preferredTime: form.preferred.value.trim(),
      notes: form.notes.value.trim(),
      items,
      subtotal,
      deliveryFee,
      total: Math.round((subtotal + deliveryFee) * 100) / 100,
      currency: settings.currency,
      paymentMethod: "cash",
      status: "requested",
      statusHistory: [{ status: "requested", at: Timestamp.now() }],
      adminNote: "",
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    if (form.save.checked) {
      setDoc(doc(db, "users", user.uid), { name: form.fullname.value.trim(), phone: form.phone.value.trim(), address, email: user.email || "", updatedAt: serverTimestamp() }, { merge: true }).catch(console.warn);
    }
    cart.clear();
    location.href = `orders.html?placed=${ref.id}`;
  } catch (err) {
    console.error(err);
    errorEl.textContent = err.code === "permission-denied"
      ? "We couldn't send that order. We may have just stopped taking orders — please refresh."
      : err.message || "Something went wrong. Please try again.";
    toast("Order not sent", "err");
    submit.disabled = false;
    submit.textContent = "Send order request";
  }
});
