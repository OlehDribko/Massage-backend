// Firebase JS SDK from the official CDN, pinned.
import { initializeApp } from "https://www.gstatic.com/firebasejs/13.0.0/firebase-app.js";
import {
  EmailAuthProvider,
  GoogleAuthProvider,
  createUserWithEmailAndPassword,
  getAuth,
  linkWithCredential,
  linkWithPopup,
  onAuthStateChanged,
  sendEmailVerification,
  sendPasswordResetEmail,
  signInAnonymously,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
} from "https://www.gstatic.com/firebasejs/13.0.0/firebase-auth.js";

const $ = (id) => document.getElementById(id);
const log = (label, value) => {
  const line = `${new Date().toLocaleTimeString()}  ${label}${value === undefined ? "" : `\n${JSON.stringify(value, null, 2)}`}\n\n`;
  $("log").textContent = line + $("log").textContent;
};

const response = await fetch("/firebase-config.json");
if (!response.ok) {
  $("state").textContent = "Немає firebase-config.local.json (див. tools/firebase-check/README.md)";
  throw new Error("missing config");
}
const config = await response.json();
$("project").textContent = config.projectId;
const auth = getAuth(initializeApp(config));

const showState = (user) => {
  $("state").textContent =
    user === null
      ? "Немає сесії"
      : [
          `uid: …${user.uid.slice(-6)}`,
          `anonymous: ${user.isAnonymous}`,
          `email: ${user.email ?? "—"} (verified: ${user.emailVerified})`,
          `providers: ${user.providerData.map((p) => p.providerId).join(", ") || "anonymous"}`,
        ].join("\n");
};
onAuthStateChanged(auth, showState);

const currentUser = () => {
  if (auth.currentUser === null) throw new Error("Немає сесії");
  return auth.currentUser;
};
const credentials = () => [$("email").value.trim(), $("password").value];

const api = async (method, path, { body, token = true, idToken } = {}) => {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${idToken ?? (await currentUser().getIdToken())}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let parsed = text;
  try { parsed = JSON.parse(text); } catch { /* not JSON */ }
  const extra = ["retry-after", "www-authenticate"].map((h) => res.headers.get(h) && `${h}: ${res.headers.get(h)}`).filter(Boolean).join(", ");
  log(`${method} ${path} → ${res.status}${extra ? ` (${extra})` : ""}`, parsed === "" ? undefined : parsed);
  return res.status;
};

const syncBody = () =>
  $("optin").checked ? { marketingOptIn: true, marketingConsentTextVersion: config.consentTextVersion } : undefined;

const actions = {
  guest: async () => {
    await auth.authStateReady();
    if (auth.currentUser !== null) return log("Сесія вже є — гостя не створено");
    await signInAnonymously(auth);
    log("Гостьова сесія створена");
  },
  "google-signin": async () => { await signInWithPopup(auth, new GoogleAuthProvider()); log("Вхід Google"); },
  "google-link": async () => { await linkWithPopup(currentUser(), new GoogleAuthProvider()); await currentUser().getIdToken(true); log("Гостя прив'язано до Google"); },
  refresh: async () => { await currentUser().getIdToken(true); await currentUser().reload(); showState(auth.currentUser); log("Токен оновлено"); },
  "copy-token": async () => { await navigator.clipboard.writeText(await currentUser().getIdToken()); log("Токен у буфері обміну (не вставляйте в чат)"); },
  signout: async () => { await signOut(auth); log("Вихід"); },
  signup: async () => { const [e, p] = credentials(); await createUserWithEmailAndPassword(auth, e, p); log("Акаунт створено"); },
  "link-password": async () => {
    const [e, p] = credentials();
    const result = await linkWithCredential(currentUser(), EmailAuthProvider.credential(e, p));
    log("Пароль прив'язано. Крок 2a: sync з токеном, отриманим одразу після прив'язки:");
    await api("POST", "/api/me/sync", { idToken: await result.user.getIdToken() });
    await signInWithEmailAndPassword(auth, e, p);
    log("Повторний вхід (контракт frontend), sync:");
    await api("POST", "/api/me/sync");
  },
  signin: async () => { const [e, p] = credentials(); await signInWithEmailAndPassword(auth, e, p); log("Вхід email/пароль"); },
  verify: async () => { await sendEmailVerification(currentUser()); log("Лист підтвердження надіслано"); },
  reset: async () => { await sendPasswordResetEmail(auth, credentials()[0]); log("Запит на скидання пароля надіслано"); },
  sync: () => api("POST", "/api/me/sync", { body: syncBody() }),
  me: () => api("GET", "/api/me"),
  patch: () => {
    const body = {};
    if ($("name").value.trim() !== "") body.name = $("name").value.trim();
    if ($("phone").value.trim() !== "") body.phone = $("phone").value.trim();
    return api("PATCH", "/api/me", { body });
  },
  subscribe: () => api("POST", "/api/me/marketing/subscription", { body: { consentTextVersion: config.consentTextVersion } }),
  unsubscribe: () => api("DELETE", "/api/me/marketing/subscription"),
  revoke: () => api("POST", "/api/me/sessions/revoke"),
  "no-token": () => api("GET", "/api/me", { token: false }),
  ready: () => api("GET", "/health/ready", { token: false }),
};

document.body.addEventListener("click", async (event) => {
  const action = event.target instanceof HTMLButtonElement ? event.target.dataset.action : undefined;
  if (action === undefined) return;
  try {
    await actions[action]();
  } catch (error) {
    log(`Помилка: ${error.code ?? error.message}`);
  }
});

await auth.authStateReady();
showState(auth.currentUser);
