import "@corbits/react-ui/styles.css";
import "./styles.css";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { session } from "./lib/session.ts";

document.documentElement.classList.add("light");

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("index.html has no #root element");

createRoot(rootEl).render(<App />);
void session.start();
