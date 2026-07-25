import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App, type AppProps } from "./app/App";
import "./app/App.css";

const rootElement = document.querySelector<HTMLDivElement>("#root");

if (!rootElement) {
  throw new Error("Missing #root element");
}

const developmentTestProps = import.meta.env.DEV
  ? ((window as typeof window & { __SHOUTING_CHICKENS_TEST_PROPS__?: AppProps })
      .__SHOUTING_CHICKENS_TEST_PROPS__ ?? {})
  : {};

createRoot(rootElement).render(
  <StrictMode>
    <App {...developmentTestProps} />
  </StrictMode>,
);
