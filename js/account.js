import { auth, db, isConfigured } from "./fb.js";
import {
  GoogleAuthProvider, signInWithPopup, signInWithRedirect, createUserWithEmailAndPassword,
  signInWithEmailAndPassword, sendPasswordResetEmail, updateProfile, sendEmailVerification,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { doc, getDoc, setDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { renderChrome, mountCartDrawer, onCustomer, customerSignOut, toast } from "./common.js";

renderChrome("account");
mountCartDrawer();

const out = document.querySelector("[data-signed-out]");
const inn = document.querySelector("[data-signed-in]");
const form = document.querySelector("[data-auth-form]");
const errorEl = document.querySelector("[data-error]");
const submit = document.querySelector("[data-submit]");
const nameField = document.querySelector("[data-name-field]");
const pwHint = document.querySelector("[data-pw-hint]");
const next = new URLSearchParams(location.search).get("next");
// Only allow redirects to our own pages.
const safeNext = next && /^[a-z-]+\.html$/.test(next) ? next : null;
let mode = "signin";

const MESSAGES = {
  "auth/invalid-credential": "That email and password don't match.",
  "auth/invalid-login-credentials": "That email and password don't match.",
  "auth/wrong-password": "That email and password don't match.",
  "auth/user-not-found": "There's no account with that email yet.",
  "auth/email-already-in-use": "An account with that email already exists — try signing in.",
  "auth/weak-password": "Please choose a password with at least 8 characters.",
  "auth/invalid-email": "That email address doesn't look right.",
  "auth/too-many-requests": "Too many attempts. Please wait a minute and try again.",
  "auth/popup-closed-by-user": "The Google window was closed before signing in.",
  "auth/unauthorized-domain": "This website address isn't authorised in Firebase yet (Authentication → Settings → Authorised domains).",
  "auth/operation-not-allowed": "This sign-in method isn't switched on in Firebase yet.",
  "auth/configuration-not-found": "Sign-in isn't set up in Firebase yet (Authentication → Get started).",
};
const friendly = (e) => MESSAGES[e.code] || e.message || "Something went wrong.";

function setMode(m) {
  mode = m;
  document.querySelectorAll("[data-tab]").forEach((t) => t.setAttribute("aria-selected", String(t.dataset.tab === m)));
  nameField.hidden = m !== "signup";
  pwHint.hidden = m !== "signup";
  form.password.autocomplete = m === "signup" ? "new-password" : "current-password";
  submit.textContent = m === "signup" ? "Create account" : "Sign in";
  errorEl.textContent = "";
}
document.querySelectorAll("[data-tab]").forEach((t) => t.addEventListener("click", () => setMode(t.dataset.tab)));

function busy(btn, on, label) {
  btn.disabled = on;
  btn.innerHTML = on ? `<span class="spin"></span> Please wait…` : label;
}

async function ensureProfile(u, name) {
  const ref = doc(db, "users", u.uid);
  const snap = await getDoc(ref);
  if (!snap.exists()) await setDoc(ref, { name: name || u.displayName || "", email: u.email || "", createdAt: serverTimestamp() });
}

function done() {
  if (safeNext) location.href = safeNext;
}

document.querySelector("[data-google]").addEventListener("click", async (e) => {
  if (!isConfigured) return toast("Firebase isn't connected yet", "err");
  const btn = e.currentTarget;
  const label = btn.innerHTML;
  errorEl.textContent = "";
  btn.disabled = true;
  try {
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: "select_account" });
    const cred = await signInWithPopup(auth, provider);
    await ensureProfile(cred.user);
    done();
  } catch (err) {
    if (err.code === "auth/popup-blocked") return signInWithRedirect(auth, new GoogleAuthProvider());
    errorEl.textContent = friendly(err);
  } finally {
    btn.disabled = false;
    btn.innerHTML = label;
  }
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!isConfigured) return toast("Firebase isn't connected yet", "err");
  errorEl.textContent = "";
  const email = form.email.value.trim();
  const pw = form.password.value;
  if (!email || !pw) return (errorEl.textContent = "Please enter your email and password.");
  if (mode === "signup" && pw.length < 8) return (errorEl.textContent = "Please choose a password with at least 8 characters.");
  const label = submit.textContent;
  busy(submit, true);
  try {
    if (mode === "signup") {
      const cred = await createUserWithEmailAndPassword(auth, email, pw);
      const name = form.dname.value.trim();
      if (name) await updateProfile(cred.user, { displayName: name });
      await ensureProfile(cred.user, name);
      sendEmailVerification(cred.user).catch(() => {});
      toast("Account created — welcome!");
    } else {
      await signInWithEmailAndPassword(auth, email, pw);
    }
    done();
  } catch (err) {
    errorEl.textContent = friendly(err);
  } finally {
    busy(submit, false, label);
  }
});

document.querySelector("[data-forgot]").addEventListener("click", async () => {
  const email = form.email.value.trim();
  if (!email) {
    errorEl.textContent = "Type your email above first, then press “Forgot your password?”.";
    form.email.focus();
    return;
  }
  try {
    await sendPasswordResetEmail(auth, email);
    toast("If that email has an account, a reset link is on its way.");
  } catch (err) {
    errorEl.textContent = friendly(err);
  }
});

/* ---------- Signed-in profile ---------- */
const profile = document.querySelector("[data-profile]");
let current = null;

onCustomer(async (u) => {
  current = u;
  out.hidden = !!u;
  inn.hidden = !u;
  if (!u) return;
  if (safeNext) return done();
  document.querySelector("[data-hi]").textContent = (u.displayName || "friend").split(" ")[0];
  document.querySelector("[data-email]").textContent = `Signed in as ${u.email || "Google user"}`;
  try {
    const snap = await getDoc(doc(db, "users", u.uid));
    const p = snap.exists() ? snap.data() : {};
    profile.pname.value = p.name || u.displayName || "";
    profile.phone.value = p.phone || "";
    profile.line1.value = p.address?.line1 || "";
    profile.line2.value = p.address?.line2 || "";
    profile.city.value = p.address?.city || "";
    profile.postcode.value = p.address?.postcode || "";
  } catch (e) {
    console.warn(e);
  }
});

profile.addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = profile.querySelector("[data-save]");
  busy(btn, true);
  try {
    await setDoc(
      doc(db, "users", current.uid),
      {
        name: profile.pname.value.trim(),
        phone: profile.phone.value.trim(),
        email: current.email || "",
        address: { line1: profile.line1.value.trim(), line2: profile.line2.value.trim(), city: profile.city.value.trim(), postcode: profile.postcode.value.trim() },
        updatedAt: serverTimestamp(),
      },
      { merge: true }
    );
    toast("Details saved");
  } catch (err) {
    toast("Couldn't save — " + err.message, "err");
  } finally {
    busy(btn, false, "Save details");
  }
});

document.querySelector("[data-signout]").addEventListener("click", async () => {
  await customerSignOut();
  toast("Signed out");
});

if (!isConfigured) out.hidden = false;
