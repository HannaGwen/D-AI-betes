// Entry point: starts the app and registers the offline service worker.
import { start } from "./app.js";
import { Store } from "./store.js";

start({ root: document.getElementById("app"), store: new Store() }).catch((e) => {
  document.getElementById("app").textContent = "The app could not start: " + e.message;
});

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => { navigator.serviceWorker.register("./sw.js").catch(() => { /* offline cache is optional */ }); });
}
