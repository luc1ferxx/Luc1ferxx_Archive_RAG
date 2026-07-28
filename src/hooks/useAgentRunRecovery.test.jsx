import { renderHook, act } from "@testing-library/react";
import { useAgentRunRecovery } from "./useAgentRunRecovery";

const mockWarning = vi.fn();
vi.mock("antd", () => ({ message: { warning: (...args) => mockWarning(...args) } }));

let fetchRunsMock;
vi.mock("../archiveApi", () => ({
  fetchAgentRunRecoveryRuns: (...args) => fetchRunsMock(...args),
}));

beforeEach(() => {
  fetchRunsMock = vi.fn();
  mockWarning.mockReset();
});

const makeRuns = (items) => ({ runs: items });

describe("useAgentRunRecovery", () => {
  it("returns reference-identical runs when payload is unchanged", async () => {
    const payload = [{ id: 1, status: "pending", name: "r" }];
    fetchRunsMock.mockResolvedValue(makeRuns(payload));

    const { result } = renderHook(() => useAgentRunRecovery());

    await act(() => result.current.loadRecoveryRuns());
    const first = result.current.runs;

    fetchRunsMock.mockResolvedValue(makeRuns([{ id: 1, status: "pending", name: "r" }]));
    await act(() => result.current.loadRecoveryRuns());
    const second = result.current.runs;

    expect(second).toBe(first);
  });

  it("returns a new reference when payload changes", async () => {
    fetchRunsMock.mockResolvedValue(makeRuns([{ id: 1, status: "pending" }]));
    const { result } = renderHook(() => useAgentRunRecovery());

    await act(() => result.current.loadRecoveryRuns());
    const first = result.current.runs;

    fetchRunsMock.mockResolvedValue(makeRuns([{ id: 1, status: "recovered" }]));
    await act(() => result.current.loadRecoveryRuns());
    const second = result.current.runs;

    expect(second).not.toBe(first);
    expect(second).toEqual([{ id: 1, status: "recovered" }]);
  });

  it("does not flip isRecoveryLoading during silent load", async () => {
    let resolve;
    fetchRunsMock.mockImplementation(() => new Promise((r) => { resolve = r; }));

    const { result } = renderHook(() => useAgentRunRecovery());

    let promise;
    act(() => { promise = result.current.loadRecoveryRuns({ silent: true }); });

    expect(result.current.isRecoveryLoading).toBe(false);

    await act(async () => {
      resolve(makeRuns([]));
      await promise;
    });

    expect(result.current.isRecoveryLoading).toBe(false);
  });

  it("flips isRecoveryLoading true then false for non-silent load", async () => {
    let resolve;
    fetchRunsMock.mockImplementation(() => new Promise((r) => { resolve = r; }));

    const { result } = renderHook(() => useAgentRunRecovery());

    let promise;
    act(() => { promise = result.current.loadRecoveryRuns(); });

    expect(result.current.isRecoveryLoading).toBe(true);

    await act(async () => {
      resolve(makeRuns([{ id: 2 }]));
      await promise;
    });

    expect(result.current.isRecoveryLoading).toBe(false);
  });

  it("silent error does not call message.warning", async () => {
    fetchRunsMock.mockRejectedValue(new Error("network"));
    const { result } = renderHook(() => useAgentRunRecovery());

    await act(() => result.current.loadRecoveryRuns({ silent: true }));

    expect(mockWarning).not.toHaveBeenCalled();
  });

  it("non-silent error calls message.warning", async () => {
    fetchRunsMock.mockRejectedValue(new Error("network"));
    const { result } = renderHook(() => useAgentRunRecovery());

    await act(() => result.current.loadRecoveryRuns());

    expect(mockWarning).toHaveBeenCalledWith("Unable to load agent run recovery queue.");
  });

  it("loadRecoveryRuns returns the fresh array even when state is deduplicated", async () => {
    const payload = [{ id: 1, status: "pending" }];
    fetchRunsMock.mockResolvedValue(makeRuns(payload));

    const { result } = renderHook(() => useAgentRunRecovery());

    await act(() => result.current.loadRecoveryRuns());

    const fresh = [{ id: 1, status: "pending" }];
    fetchRunsMock.mockResolvedValue(makeRuns(fresh));

    let returned;
    await act(async () => { returned = await result.current.loadRecoveryRuns(); });

    expect(returned).toEqual(fresh);
  });
});
