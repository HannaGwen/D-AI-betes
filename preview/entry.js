import { mountDemo, DEMO_PASSPHRASE } from "./demo.js";

const ribbon = document.createElement("div");
ribbon.className = "demo-ribbon";
ribbon.textContent = `DEMO with made-up sample data only. Do not enter real health data here. (Demo passphrase if it locks: ${DEMO_PASSPHRASE})`;
document.body.prepend(ribbon);
mountDemo(document.getElementById("app")).catch((e) => { document.getElementById("app").textContent = "Demo failed: " + e.message; });
