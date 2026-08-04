import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ApiProvider } from "./api.jsx";
import App from "./App.jsx";
import "./styles.css";

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <ApiProvider>
      <App />
    </ApiProvider>
  </StrictMode>,
);
