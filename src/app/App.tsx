import { GameSurface } from "./GameSurface";

export function App() {
  return (
    <main className="app-shell">
      <section className="game-phone" aria-labelledby="game-title">
        <div className="camera-placeholder" aria-hidden="true">
          <div className="camera-glow camera-glow--left" />
          <div className="camera-glow camera-glow--right" />
        </div>

        <header className="game-heading">
          <p className="eyebrow">Voice-controlled platformer</p>
          <h1 id="game-title">Shouting Chickens</h1>
          <p>Tap, press Space, or use ↑ to keep the chicken dry.</p>
        </header>

        <GameSurface />

        <footer className="bootstrap-note">
          <span className="status-dot" aria-hidden="true" />
          <span>Deterministic 60 Hz world</span>
        </footer>
      </section>
    </main>
  );
}
