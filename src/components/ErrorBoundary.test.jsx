import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import ErrorBoundary from "./ErrorBoundary";

function Bomb() {
  throw new Error("kaboom");
}

describe("ErrorBoundary", () => {
  test("renders children when nothing throws", () => {
    render(
      <ErrorBoundary>
        <p>All good</p>
      </ErrorBoundary>
    );

    expect(screen.getByText("All good")).toBeInTheDocument();
  });

  test("renders fallback UI when a child throws", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    render(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>
    );

    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByText("Something went wrong")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reload workspace" })).toBeInTheDocument();

    spy.mockRestore();
  });

  test("reload button calls window.location.reload", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const reloadMock = vi.fn();

    Object.defineProperty(window, "location", {
      value: { ...window.location, reload: reloadMock },
      writable: true,
    });

    render(
      <ErrorBoundary>
        <Bomb />
      </ErrorBoundary>
    );

    const button = screen.getByRole("button", { name: "Reload workspace" });
    await userEvent.click(button);

    expect(reloadMock).toHaveBeenCalledTimes(1);

    spy.mockRestore();
  });
});
