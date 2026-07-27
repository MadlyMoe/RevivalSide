import { Layout } from "@/Layout";
import "./App.css";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { lazy, Suspense } from "react";
import { revivalsideConfig } from "@/games/revivalside/config";
import { GamePicker } from "@/pages/GamePicker";
import { Providers } from "@/components/providers";

const Settings = lazy(() => import("@/pages/Settings").then((m) => ({ default: m.Settings })));

const GAMES = [revivalsideConfig];

const router = createMemoryRouter([
  {
    path: "/",
    element: (
      <Providers games={GAMES}>
        <Layout />
      </Providers>
    ),
    children: [
      {
        index: true,
        element: (
          <Suspense>
            <GamePicker />
          </Suspense>
        ),
      },
      {
        path: "settings",
        element: (
          <Suspense>
            <Settings />
          </Suspense>
        ),
      },
      ...GAMES.map((game) => ({
        path: `${game.id}`,
        children: game.routes,
      })),
    ],
  },
]);

function App() {
  if (!import.meta.env.DEV) {
    document.oncontextmenu = (event) => {
      event.preventDefault();
    };
  }

  return <RouterProvider router={router} />;
}

export default App;
