import { useRef } from "react";
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

  const handleMouseMove = (event) => {
    const element = elementRef.current;

    if (!element) {
      return;
    }

    const rect = element.getBoundingClientRect();
    element.style.setProperty("--rb-spotlight-x", `${event.clientX - rect.left}px`);
    element.style.setProperty("--rb-spotlight-y", `${event.clientY - rect.top}px`);
  };

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
