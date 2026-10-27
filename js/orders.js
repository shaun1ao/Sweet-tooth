import { db, isConfigured } from "./fb.js";
import {
  collection, query, where, onSnapshot, doc, updateDoc, serverTimestamp, Timestamp, arrayUnion,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { renderChrome, mountCartDrawer, onCustomer, money, esc, fmtDate, toast, STATUS_FLOW, STATUS_LABEL } from "./common.js";

renderChrome("orders");
mountCartDrawer();

const list = document.querySelector("[data-orders]");
const placed = new URLSearchParams(location.search).get("placed");
const CHECK = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.2 4.2L19 7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

if (placed) {
  document.querySelector("[data-placed]").innerHTML = `
    <div class="panel sage" style="margin-bottom:1.5rem">
      <p class="display-italic" style="font-size:1.7rem;margin:0">Order requested — thank you!</p>
      <p style="margin:.3rem 0 0">We'll review it shortly. Keep this page open to see it move to <b>Confirmed</b>.</p>
    </div>`;
}

export function tracker(status) {
  if (status === "declined" || status === "cancelled") return "";
  const idx = STATUS_FLOW.indexOf(status);
  return `<ol class="tracker" aria-label="Order progress">${STATUS_FLOW.map((s, i) => {
    const cls = i < idx || (i === idx && s === "delivered") ? "done" : i === idx ? "current" : "";
    return `<li class="${cls}" ${i === idx ? 'aria-current="step"' : ""}><span class="dot">${i < idx || s === "delivered" && i === idx ? CHECK : ""}</span>${STATUS_LABEL[s]}</li>`;
  }).join("")}</ol>`;
}

function render(orders) {
  if (!orders.length) {
    list.innerHTML = `<div class="panel" style="text-align:center"><p class="display-italic" style="font-size:1.7rem;margin:0 0 .4rem">No orders yet</p><p class="small" style="margin:0 0 1rem">Your first box is a few clicks away.</p><a class="btn btn-primary" href="index.html#menu">Browse the menu</a></div>`;
    return;
  }
  list.innerHTML = orders
    .map((o) => {
      const cur = o.currency || "£";
      const addr = [o.address?.line1, o.address?.line2, o.address?.city, o.address?.postcode].filter(Boolean).map(esc).join(", ");
      return `
      <article class="order" ${o.id === placed ? 'style="box-shadow:6px 6px 0 var(--cocoa)"' : ""}>
        <header class="order-head">
          <div><span class="order-id">${esc(o.orderNumber || o.id.slice(0, 6))}</span> <span class="small muted">&middot; ${fmtDate(o.createdAt)}</span></div>
          <span class="badge badge-${esc(o.status)}">${STATUS_LABEL[o.status] || esc(o.status)}</span>
        </header>
        <div class="order-body">
          ${tracker(o.status)}
          ${o.status === "declined" ? `<p class="order-note"><b>Sorry — we couldn't take this order.</b>${o.adminNote ? " " + esc(o.adminNote) : ""}</p>` : ""}
          ${o.status === "cancelled" ? `<p class="order-note">You cancelled this order.</p>` : ""}
          ${o.adminNote && o.status !== "declined" ? `<p class="order-note"><b>Note from the bakery:</b> ${esc(o.adminNote)}</p>` : ""}
          ${o.deliveryWindow ? `<p class="order-note" style="background:var(--lime)"><b>Delivery:</b> ${esc(o.deliveryWindow)}</p>` : ""}
          <ul class="order-items">
            ${(o.items || []).map((i) => `<li><span>${esc(i.name)} <span class="mono small">× ${i.qty}</span></span><span class="mono">${money(i.price * i.qty, cur)}</span></li>`).join("")}
            <li class="muted"><span>Delivery</span><span class="mono">${money(o.deliveryFee, cur)}</span></li>
            <li style="font-weight:600;border-top:1px dashed var(--line);padding-top:.3rem"><span>Total — cash on delivery</span><span class="mono">${money(o.total, cur)}</span></li>
          </ul>
          <p class="small muted" style="margin:0">Delivering to ${addr}</p>
          ${o.status === "requested" ? `<div><button class="btn btn-danger btn-sm" data-cancel="${esc(o.id)}">Cancel request</button></div>` : ""}
        </div>
      </article>`;
    })
    .join("");
}

list.addEventListener("click", async (e) => {
  const b = e.target.closest("[data-cancel]");
  if (!b) return;
  if (!confirm("Cancel this order request?")) return;
  b.disabled = true;
  try {
    await updateDoc(doc(db, "orders", b.dataset.cancel), {
      status: "cancelled",
      updatedAt: serverTimestamp(),
      statusHistory: arrayUnion({ status: "cancelled", at: Timestamp.now() }),
    });
    toast("Order cancelled");
  } catch (err) {
    toast("Couldn't cancel — it may already be confirmed.", "err");
    b.disabled = false;
  }
});

let unsub = null;
onCustomer((u) => {
  unsub?.();
  if (!isConfigured || !u) {
    list.innerHTML = `<div class="panel" style="text-align:center"><p class="display-italic" style="font-size:1.7rem;margin:0 0 .4rem">Sign in to see your orders</p><a class="btn btn-primary" style="margin-top:.6rem" href="account.html?next=orders.html">Sign in</a></div>`;
    return;
  }
  list.innerHTML = `<div class="skeleton" style="min-height:220px;border-radius:12px"></div>`;
  unsub = onSnapshot(
    query(collection(db, "orders"), where("uid", "==", u.uid)),
    (snap) => {
      const orders = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      orders.sort((a, b) => (b.createdAt?.toMillis?.() ?? Date.now()) - (a.createdAt?.toMillis?.() ?? Date.now()));
      render(orders);
    },
    (err) => {
      console.error(err);
      list.innerHTML = `<div class="panel">We couldn't load your orders. Please refresh.</div>`;
    }
  );
});
