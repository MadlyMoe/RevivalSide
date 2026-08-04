import { useEffect, useMemo, useState } from "react";
import {
  FiActivity, FiAperture, FiBookOpen, FiBox, FiDatabase, FiEdit3, FiGrid, FiHome, FiLayers,
  FiPackage, FiShield, FiUsers,
} from "react-icons/fi";
import { useApi } from "./api.jsx";
import { Button } from "./ui.jsx";
import { ModCreator, ModLoader } from "./Mods.jsx";
import { AssetApp } from "./Assets.jsx";
import { StoryApp } from "./Story.jsx";
import { UnitApp } from "./Units.jsx";

const products = {
  mod: { title: "Mod:Side", subtitle: "Mod workspace", icon: FiLayers },
  assets: { title: "Asset:Side", subtitle: "Game data and extracted assets", icon: FiGrid },
  story: { title: "Story:Side", subtitle: "Episodes, stages, and cutscenes", icon: FiBookOpen },
  units: { title: "Unit:Side", subtitle: "Playable unit authoring", icon: FiUsers },
  combat: { title: "Combat:Side", subtitle: "CombatHost simulator", icon: FiActivity },
};

function currentProduct() {
  const path = location.pathname.replace(/\/+$/, "");
  if (path.endsWith("/assets")) return "assets";
  if (path.endsWith("/story")) return "story";
  if (path.endsWith("/units")) return "units";
  if (path.endsWith("/combat")) return "combat";
  return "mod";
}

function initialModView() {
  const view = new URLSearchParams(location.search).get("view");
  return ["creator", "loader"].includes(view) ? view : "home";
}

export default function App() {
  const { basePath, request } = useApi();
  const product = useMemo(currentProduct, []);
  const definition = products[product];
  const ProductIcon = definition.icon;
  const [health, setHealth] = useState(null);
  const [error, setError] = useState("");
  const [modView, setModView] = useState(initialModView);

  useEffect(() => {
    document.title = definition.title;
    request("health").then(setHealth).catch((value) => setError(value.message));
  }, [definition.title, request]);

  function selectModView(view) {
    setModView(view);
    const url = new URL(location.href);
    if (view === "home") url.searchParams.delete("view"); else url.searchParams.set("view", view);
    history.replaceState(null, "", url);
  }

  return <div className="app-shell" data-product={product}>
    <header className="app-header">
      <a className="brand" href={basePath} aria-label="Open Mod:Side hub"><span className={`brand-icon ${product}`}><ProductIcon aria-hidden="true" /></span><span><strong>{definition.title}</strong><small>{error || (health ? `${health.tableCount.toLocaleString()} tables · ${health.assetRootAvailable ? "assets ready" : "assets unavailable"} · ${health.spineViewerAvailable ? "Spine ready" : "Spine unavailable"}` : definition.subtitle)}</small></span></a>
      <div className="header-actions">{product !== "mod" && <Button icon={FiHome} className="ghost" onClick={() => { location.href = basePath; }}>All apps</Button>}<span className="protected"><FiShield aria-hidden="true" />Base data protected</span></div>
    </header>
    {product === "mod" && <nav className="top-tabs" aria-label="Mod:Side workspaces"><Button icon={FiHome} className={modView === "home" ? "active" : "ghost"} onClick={() => selectModView("home")}>Home</Button><Button icon={FiEdit3} className={modView === "creator" ? "active" : "ghost"} onClick={() => selectModView("creator")}>Mod creator</Button><Button icon={FiPackage} className={modView === "loader" ? "active" : "ghost"} onClick={() => selectModView("loader")}>Mod loader</Button></nav>}
    <main className="workspace">
      {product === "mod" && modView === "home" && <Home basePath={basePath} onOpen={selectModView} />}
      {product === "mod" && modView === "creator" && <ModCreator />}
      {product === "mod" && modView === "loader" && <ModLoader />}
      {product === "assets" && <AssetApp />}
      {product === "story" && <StoryApp />}
      {product === "units" && <UnitApp />}
      {product === "combat" && <section className="panel combat-panel"><iframe src="http://127.0.0.1:5185/" title="Combat:Side simulator" /></section>}
    </main>
  </div>;
}

function Home({ basePath, onOpen }) {
  const core = [
    { title: "Mod Creator", copy: "Create, validate, and export mod projects", icon: FiEdit3, className: "creator", onClick: () => onOpen("creator") },
    { title: "Mod Loader", copy: "Install, activate, and order loaded mods", icon: FiPackage, className: "loader", onClick: () => onOpen("loader") },
  ];
  const apps = [
    { title: "Asset:Side", copy: "Browse game data and extracted assets", icon: FiDatabase, className: "assets", href: `${basePath}/assets` },
    { title: "Story:Side", copy: "Author episodes, stages, and cutscenes", icon: FiBookOpen, className: "story", href: `${basePath}/story` },
    { title: "Unit:Side", copy: "Create complete playable units", icon: FiUsers, className: "units", href: `${basePath}/units` },
    { title: "Combat:Side", copy: "Build and replay CombatHost battles", icon: FiActivity, className: "combat", href: `${basePath}/combat` },
    { title: "Spine 3.7 Studio", copy: "Edit and preview Spine 3.7 assets", icon: FiAperture, className: "spine", href: `${basePath}/spine/` },
  ];
  return <section className="hub-panel"><div className="hub-content"><p className="eyebrow">Mod workspace</p><h1>Build, manage, and launch your mods.</h1><p className="lead">Package content and control exactly what the private server loads.</p><SectionTitle title="Mod:Side" meta="Core tools" /><div className="card-grid core">{core.map((item) => <AppCard key={item.title} {...item} />)}</div><SectionTitle title="Side apps" meta="Specialized workspaces" /><div className="card-grid apps">{apps.map((item) => <AppCard key={item.title} {...item} />)}</div></div></section>;
}

function SectionTitle({ title, meta }) { return <div className="section-title"><h2>{title}</h2><span>{meta}</span></div>; }
function AppCard({ title, copy, icon: Icon, className, href, onClick }) {
  const content = <><span className={`app-card-icon ${className}`}><Icon aria-hidden="true" /></span><span><strong>{title}</strong><small>{copy}</small></span></>;
  return href ? <a className="app-card" href={href}>{content}</a> : <button className="app-card" type="button" onClick={onClick}>{content}</button>;
}
