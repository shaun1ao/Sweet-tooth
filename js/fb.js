// Firebase setup shared by every page.
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

export const isConfigured =
  !!firebaseConfig.apiKey && !String(firebaseConfig.apiKey).startsWith("PASTE");

// Customer app (Google + email/password sign-in).
export const app = isConfigured ? initializeApp(firebaseConfig) : null;
export const auth = app ? getAuth(app) : null;
export const db = app ? getFirestore(app) : null;

// The admin panel uses its own named app so its anonymous session never
// signs a customer out in the same browser (and vice versa).
let adminApp = null;
export function getAdminApp() {
  if (!isConfigured) return null;
  if (!adminApp) adminApp = initializeApp(firebaseConfig, "sweet-tooth-admin");
  return adminApp;
}
