import { useGame } from "@/games/GameProvider";
import { cn } from "@/lib/utils";
import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { AnimateYFade } from "@/components/animate-y-fade";

export const GamePicker = () => {
  const navigate = useNavigate();
  const { games, activeGame, hoveredGame, setHoveredGame } = useGame();

  useEffect(() => {
    if (!hoveredGame && games.length > 0) {
      setHoveredGame(games[0]);
    }
  }, [hoveredGame, games]);

  return (
    <div className="flex flex-col h-full">
      {hoveredGame?.assets && (
        <AnimateYFade motionKey={hoveredGame.id}>
          <img src={hoveredGame.assets.logo} className="w-sm" />
        </AnimateYFade>
      )}
      <div className="flex flex-col mt-auto min-h-0 gap-8">
        <AnimateYFade motionKey={hoveredGame?.id} className="empty:invisible max-w-lg">
          <p>{hoveredGame?.description}</p>
        </AnimateYFade>
        <div className="flex items-end min-w-0 h-full overflow-x-auto gap-4 scrollbar-none">
          {games.map((game) => {
            const isHovered = hoveredGame?.id === game.id;
            return (
              <div
                className={cn("flex flex-col  items-center shrink-0 brightness-50", isHovered && "brightness-100")}
                onMouseEnter={() => !activeGame && setHoveredGame(game)}
              >
                <button
                  key={game.id}
                  className={cn(
                    "flex items-center justify-center rounded-lg border border-foreground w-44 h-24.5 relative overflow-hidden transition-all duration-300",
                    isHovered && "border-primary w-52 h-29",
                  )}
                  onClick={() => navigate(`/${game.id}`)}
                >
                  <img
                    src={game.assets?.mainBackground}
                    className="object-cover w-full h-full absolute brightness-75"
                  />
                  <img src={game.assets?.logo} className="w-1/2 relative" />
                </button>
                <p className="text-sm text-center mt-2 font-bold">{game.name}</p>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};
