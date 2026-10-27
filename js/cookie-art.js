// Hand-drawn style SVG cookies on vintage plates, so the menu looks good
// even without photos. Admins pick a cookie style, plate and tile colour.

export const COOKIE_STYLES = {
  chocchip: "Chocolate chip",
  double: "Double chocolate",
  jam: "Jam thumbprint",
  sprinkle: "Iced sprinkle",
  oat: "Oat & raisin",
  snicker: "Snickerdoodle",
  redvelvet: "Red velvet",
  matcha: "Matcha white choc",
  almond: "Almond shortbread",
};

export const PLATES = {
  garland: "Blue garland",
  floral: "Red floral",
  mint: "Mint scallop",
  gold: "Gold scroll",
  blush: "Blush plain",
  sky: "Powder blue",
};

export const TILES = {
  pink: "#F3AEA8",
  sage: "#B6C4A3",
  mustard: "#E2B549",
  coral: "#E4826A",
  brown: "#9E6B50",
  olive: "#8D9D6E",
  cream: "#EBD3B5",
  red: "#C9463D",
  cocoa: "#5B3A2E",
};

function seeded(seedStr) {
  let h = 2166136261;
  for (const ch of String(seedStr)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return () => {
    h += 0x6d2b79f5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function blob(cx, cy, r, rand, wobble = 2.2, n = 22) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const rr = r + (rand() - 0.5) * wobble * 2;
    pts.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr]);
  }
  let d = `M${pts[0][0].toFixed(1)},${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < n; i++) {
    const p = pts[(i + 1) % n];
    const c = pts[i];
    const mx = (c[0] + p[0]) / 2, my = (c[1] + p[1]) / 2;
    d += ` Q${c[0].toFixed(1)},${c[1].toFixed(1)} ${mx.toFixed(1)},${my.toFixed(1)}`;
  }
  return d + "Z";
}

function scatter(rand, count, maxR, fn) {
  let out = "";
  for (let i = 0; i < count; i++) {
    const a = rand() * Math.PI * 2;
    const r = Math.sqrt(rand()) * maxR;
    out += fn(100 + Math.cos(a) * r, 100 + Math.sin(a) * r, i);
  }
  return out;
}

function plateRim(kind) {
  const ring = (n, fn) => {
    let s = "";
    for (let i = 0; i < n; i++) s += `<g transform="rotate(${(360 / n) * i} 100 100)">${fn()}</g>`;
    return s;
  };
  switch (kind) {
    case "garland":
      return ring(16, () => `<path d="M94,22 q6,-6 12,0 q-6,7 -12,0Z" fill="none" stroke="#7E9BC9" stroke-width="1.6"/><circle cx="100" cy="27" r="1.3" fill="#7E9BC9"/>`);
    case "floral":
      return ring(10, () => `<circle cx="100" cy="24" r="4.2" fill="#B8474A"/><circle cx="100" cy="24" r="1.8" fill="#E8B6A7"/><path d="M90,27 q4,-5 6,-1 M110,27 q-4,-5 -6,-1" stroke="#6E8A4E" stroke-width="1.4" fill="none"/>`);
    case "mint":
      return `<circle cx="100" cy="100" r="86" fill="#CFE3C9"/><circle cx="100" cy="100" r="72" fill="#FBF6EC"/>` +
        ring(24, () => `<circle cx="100" cy="15.5" r="5" fill="#FBF6EC"/>`);
    case "gold":
      return ring(12, () => `<path d="M92,25 q8,-9 16,0 q-4,4 -8,0" fill="none" stroke="#C9A040" stroke-width="1.6"/><circle cx="100" cy="21" r="1.5" fill="#C9A040"/>`);
    case "sky":
      return `<circle cx="100" cy="100" r="86" fill="#C5D0E3"/><circle cx="100" cy="100" r="70" fill="#D8E0EE"/>`;
    case "blush":
    default:
      return `<circle cx="100" cy="100" r="86" fill="#F4D3CF"/><circle cx="100" cy="100" r="70" fill="#F8E2DE"/>`;
  }
}

function toppings(style, rand) {
  const chip = (fill) => (x, y) => {
    const s = 3 + rand() * 3;
    return `<path d="${blob(x, y, s, rand, 1.4, 6)}" fill="${fill}"/>`;
  };
  switch (style) {
    case "double":
      return { base: "#5A3426", edge: "#3E2218", top: scatter(rand, 14, 32, chip("#F2E6D3")) };
    case "redvelvet":
      return { base: "#A8323A", edge: "#7D2129", top: scatter(rand, 12, 32, chip("#F7EEE2")) };
    case "matcha":
      return { base: "#9DB27A", edge: "#748A55", top: scatter(rand, 12, 32, chip("#FBF5E8")) };
    case "jam":
      return {
        base: "#D9A86A", edge: "#B07F45",
        top: `<path d="${blob(100, 100, 14, rand, 1.2, 14)}" fill="#A3202E"/><ellipse cx="96" cy="95" rx="4" ry="2.4" fill="#E06470" opacity=".8"/>` +
          scatter(rand, 40, 38, (x, y) => `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r=".9" fill="#FFF8EE" opacity=".9"/>`),
      };
    case "sprinkle": {
      const cols = ["#E4826A", "#E2B549", "#8D9D6E", "#F3AEA8", "#7E9BC9", "#FFF"];
      return {
        base: "#EED2AA", edge: "#C9A67A",
        top: `<path d="${blob(100, 100, 33, rand, 3, 16)}" fill="#F6B8C1"/>` +
          scatter(rand, 26, 28, (x, y) => `<rect x="${(x - 3).toFixed(1)}" y="${(y - 1).toFixed(1)}" width="6" height="2" rx="1" fill="${cols[Math.floor(rand() * cols.length)]}" transform="rotate(${Math.floor(rand() * 180)} ${x.toFixed(1)} ${y.toFixed(1)})"/>`),
      };
    }
    case "oat":
      return {
        base: "#C89A62", edge: "#9C7240",
        top: scatter(rand, 18, 36, (x, y) => `<ellipse cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" rx="3.2" ry="1.6" fill="#E9CFA0" transform="rotate(${Math.floor(rand() * 180)} ${x.toFixed(1)} ${y.toFixed(1)})"/>`) +
          scatter(rand, 7, 32, chip("#4A2A22")),
      };
    case "snicker":
      return {
        base: "#EBCB98", edge: "#C79E62",
        top: `<path d="M78,92 q10,6 18,-2 M104,112 q8,-8 18,-3 M88,122 q4,-6 10,-4" stroke="#B5844F" stroke-width="1.4" fill="none"/>` +
          scatter(rand, 60, 38, (x, y) => `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${(0.6 + rand()).toFixed(1)}" fill="#9A5B2E" opacity=".75"/>`),
      };
    case "almond":
      return {
        base: "#D6AE76", edge: "#A9824C",
        top: `<circle cx="100" cy="100" r="15" fill="#6B3B25"/><ellipse cx="100" cy="100" rx="7.5" ry="11" fill="#B9774A"/><path d="M100,91 v18" stroke="#8C5432" stroke-width="1"/>` +
          scatter(rand, 30, 38, (x, y) => `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r=".9" fill="#A9824C"/>`),
      };
    case "chocchip":
    default:
      return { base: "#D4A266", edge: "#A87A42", top: scatter(rand, 13, 32, chip("#4A2A22")) };
  }
}

export function cookieArt({ style = "chocchip", plate = "garland", seed = "cookie", label = "" } = {}) {
  const rand = seeded(seed + style);
  const t = toppings(style, rand);
  const r = 40 + rand() * 4;
  return `<svg class="cookie-art" viewBox="0 0 200 200" role="img" aria-label="${label || COOKIE_STYLES[style] || "Cookie"} on a vintage plate">
    <ellipse cx="104" cy="108" rx="90" ry="90" fill="rgba(40,18,10,.22)"/>
    <circle cx="100" cy="100" r="90" fill="#FBF6EC"/>
    ${plateRim(plate)}
    <circle cx="100" cy="100" r="66" fill="#FBF6EC" stroke="rgba(120,90,60,.12)" stroke-width="1.5"/>
    <circle cx="100" cy="100" r="89" fill="none" stroke="rgba(120,90,60,.18)" stroke-width="1.5"/>
    <ellipse cx="103" cy="105" rx="${r}" ry="${r - 2}" fill="rgba(60,30,15,.25)"/>
    <path d="${blob(100, 100, r, rand, 2.4)}" fill="${t.base}" stroke="${t.edge}" stroke-width="2.4"/>
    <path d="${blob(98, 97, r - 9, rand, 2)}" fill="#fff" opacity=".07"/>
    ${t.top}
  </svg>`;
}
