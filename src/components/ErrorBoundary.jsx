import React from "react";
import { createTranslator, getInitialLocale } from "../archiveI18n";

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
    this.t = createTranslator(getInitialLocale());
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error, errorInfo) {
    console.error(error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div role="alert" className="archive-error-boundary">
          <h1>{this.t("app.errorBoundaryTitle")}</h1>
          <p>{this.t("app.errorBoundaryBody")}</p>
          <button type="button" onClick={() => window.location.reload()}>
            {this.t("app.errorBoundaryReload")}
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
