import { useEffect, useRef } from "react";
import "./SpotlightCard.css";

const SpotlightCard = ({
  as: Component = "div",
  children,
  className = "",
  spotlightColor = "rgba(255, 255, 255, 0.12)",
  style,
  ...rest
}) => {
  const elementRef = useRef(null);
  const mouseRef = useRef({ x: 0, y: 0 });
  const rafRef = useRef(0);

  const handleMouseMove = (event) => {
    mouseRef.current.x = event.clientX;
    mouseRef.current.y = event.clientY;

    if (rafRef.current) {
      return;
    }

    rafRef.current = requestAnimationFrame(() => {
      const element = elementRef.current;

      if (element) {
        const rect = element.getBoundingClientRect();
        element.style.setProperty("--rb-spotlight-x", `${mouseRef.current.x - rect.left}px`);
        element.style.setProperty("--rb-spotlight-y", `${mouseRef.current.y - rect.top}px`);
      }

      rafRef.current = 0;
    });
  };

  useEffect(() => () => cancelAnimationFrame(rafRef.current), []);

  return (
    <Component
      ref={elementRef}
      className={`rb-spotlight-card ${className}`.trim()}
      onMouseMove={handleMouseMove}
      style={{
        "--rb-spotlight-color": spotlightColor,
        ...style,
      }}
      {...rest}
    >
      {children}
    </Component>
  );
};

export default SpotlightCard;
