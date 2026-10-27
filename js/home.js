import { db, isConfigured } from "./fb.js";
import { collection, onSnapshot } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { renderChrome, mountCartDrawer, cart, money, esc, loadSettings, toast, DEMO_COOKIES, STAR } from "./common.js";
import { cookieArt, TILES } from "./cookie-art.js";

renderChrome("menu");
mountCartDrawer();

// Scattered lime stars, like the definition card.
const stars = document.querySelector("[data-stars]");
[[7, 18, 30], [27, 10, 40], [62, 7, 34], [88, 16, 28], [10, 82, 36], [58, 88, 40], [93, 78, 30], [46, 30, 22]].forEach(([x, y, s], i) => {
  const el = document.createElement("span");
  el.className = "star";
  el.style.cssText = `left:${x}%;top:${y}%;width:${s}px;height:${s}px;transform:rotate(${i * 23}deg)`;
  el.innerHTML = STAR;
  stars.appendChild(el);
});

document.querySelector("[data-hero-plate] .tile").insertAdjacentHTML(
  "afterend",
  cookieArt({ style: "chocchip", plate: "garland", seed: "hero", label: "A chocolate chip cookie on a blue garland plate" })
);

const words = ["Baked to order", "Cash on delivery", "Real butter", "Small batches", "Hand approved", "Still warm"];
const half = words.map((w) => `<span>${w} ${STAR}</span>`).join("");
document.querySelector("[data-marquee]").innerHTML = half + half;

const menuEl = document.querySelector("[data-menu]");
let menu = [];

function render(settings) {
  const visible = menu.filter((c) => !c.hidden);
  if (!visible.length) {
    menuEl.innerHTML = `<div class="card" style="grid-column:1/-1"><div class="empty"><p class="display-italic">The menu is being written.</p><p class="small">Check back soon — fresh flavours are on the way.</p></div></div>`;
    return;
  }
  menuEl.innerHTML = visible
    .map((c) => {
      const sold = c.available === false;
      const bg = TILES[c.tile] || TILES.pink;
      const art = c.imageUrl
        ? `<img src="${esc(c.imageUrl)}" alt="${esc(c.name)}" loading="lazy" style="aspect-ratio:1;object-fit:cover;border-radius:50%">`
        : cookieArt({ style: c.style, plate: c.plate, seed: c.id, label: c.name });
      return `
      <article class="card ${sold ? "soldout" : ""}" style="--tile:${bg}">
        ${c.tag ? `<span class="card-tag">${esc(c.tag)}</span>` : ""}
        <div class="card-art">${art}</div>
        <div class="card-body">
          <div class="card-row">
            <h3 class="card-name">${esc(c.name)}</h3>
            <span class="card-price">${money(c.price, settings.currency)}</span>
          </div>
          <p class="card-desc">${esc(c.description || "")}</p>
          <div class="card-actions">
            ${sold
              ? `<span class="badge badge-cancelled">Sold out today</span>`
              : `<div class="qty"><button type="button" data-minus aria-label="Fewer ${esc(c.name)}">&minus;</button><input type="number" min="1" max="99" value="1" aria-label="How many ${esc(c.name)}" data-q><button type="button" data-plus aria-label="More ${esc(c.name)}">+</button></div>
                 <button class="btn btn-primary btn-sm" data-add="${esc(c.id)}" ${settings.acceptingOrders ? "" : "disabled"}>Add to box</button>`}
          </div>
        </div>
      </article>`;
    })
    .join("");
}

menuEl.addEventListener("click", (e) => {
  const card = e.target.closest(".card");
  if (!card) return;
  const q = card.querySelector("[data-q]");
  if (e.target.closest("[data-minus]")) q.value = Math.max(1, Number(q.value) - 1);
  if (e.target.closest("[data-plus]")) q.value = Math.min(99, Number(q.value) + 1);
  const add = e.target.closest("[data-add]");
  if (add) {
    const c = menu.find((m) => m.id === add.dataset.add);
    const n = Math.max(1, Math.min(99, Number(q.value) || 1));
    cart.add(c, n);
    q.value = 1;
    toast(`${n} × ${c.name} added to your box`);
  }
});

const sortMenu = (list) => list.sort((a, b) => (a.sort ?? 999) - (b.sort ?? 999) || a.name.localeCompare(b.name));

loadSettings().then((settings) => {
  document.querySelector("[data-fee]").textContent = `${money(settings.deliveryFee, settings.currency)} delivery`;
  document.querySelector("[data-area]").textContent = `${settings.deliveryArea} Minimum order ${money(settings.minOrder, settings.currency)}.`;

  if (!isConfigured) {
    menu = sortMenu([...DEMO_COOKIES]);
    render(settings);
    return;
  }
  onSnapshot(
    collection(db, "cookies"),
    (snap) => {
      menu = sortMenu(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
      cart.reconcile(menu);
      render(settings);
    },
    (err) => {
      console.error(err);
      menuEl.innerHTML = `<div class="card" style="grid-column:1/-1"><div class="empty"><p class="display-italic">We couldn't load the menu.</p><p class="small">Please refresh in a moment.</p></div></div>`;
    }
  );
});
