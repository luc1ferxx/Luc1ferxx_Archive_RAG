import "./StarBorder.css";

const StarBorder = ({
  as: Component = "div",
  children,
  className = "",
  color = "rgba(235, 206, 150, 0.74)",
  speed = "8s",
  thickness = 1,
  style,
  ...rest
}) => (
  <Component
    className={`rb-star-border ${className}`.trim()}
    style={{
      "--rb-star-color": color,
      "--rb-star-speed": speed,
      "--rb-star-thickness": `${thickness}px`,
      ...style,
    }}
    {...rest}
  >
    <span className="rb-star-border__beam rb-star-border__beam-top" aria-hidden="true" />
    <span
      className="rb-star-border__beam rb-star-border__beam-bottom"
      aria-hidden="true"
    />
    <div className="rb-star-border__content">{children}</div>
  </Component>
);

export default StarBorder;
