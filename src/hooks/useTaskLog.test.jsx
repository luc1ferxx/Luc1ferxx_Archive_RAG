import { renderHook, act } from "@testing-library/react";
import { useTaskLog, TASK_TYPES, ACTIVE_TASK_STATUSES, hasActiveTasks } from "./useTaskLog";

const mockWarning = vi.fn();
vi.mock("antd", () => ({ message: { warning: (...args) => mockWarning(...args) } }));

let fetchTasksMock;
vi.mock("../archiveApi", () => ({
  fetchTasks: (...args) => fetchTasksMock(...args),
}));

beforeEach(() => {
  fetchTasksMock = vi.fn();
  mockWarning.mockReset();
});

const makeTasks = (items) => ({ tasks: items });

describe("useTaskLog", () => {
  it("returns reference-identical tasks when payload is unchanged", async () => {
    const payload = [{ id: 1, status: "running", name: "a" }];
    fetchTasksMock.mockResolvedValue(makeTasks(payload));

    const { result } = renderHook(() => useTaskLog());

    await act(() => result.current.loadTasks());
    const first = result.current.tasks;

    fetchTasksMock.mockResolvedValue(makeTasks([{ id: 1, status: "running", name: "a" }]));
    await act(() => result.current.loadTasks());
    const second = result.current.tasks;

    expect(second).toBe(first);
  });

  it("returns a new reference when payload changes", async () => {
    fetchTasksMock.mockResolvedValue(makeTasks([{ id: 1, status: "running" }]));
    const { result } = renderHook(() => useTaskLog());

    await act(() => result.current.loadTasks());
    const first = result.current.tasks;

    fetchTasksMock.mockResolvedValue(makeTasks([{ id: 1, status: "done" }]));
    await act(() => result.current.loadTasks());
    const second = result.current.tasks;

    expect(second).not.toBe(first);
    expect(second).toEqual([{ id: 1, status: "done" }]);
  });

  it("does not flip isTaskLogLoading during silent load", async () => {
    let resolve;
    fetchTasksMock.mockImplementation(() => new Promise((r) => { resolve = r; }));

    const { result } = renderHook(() => useTaskLog());

    let promise;
    act(() => { promise = result.current.loadTasks({ silent: true }); });

    expect(result.current.isTaskLogLoading).toBe(false);

    await act(async () => {
      resolve(makeTasks([]));
      await promise;
    });

    expect(result.current.isTaskLogLoading).toBe(false);
  });

  it("flips isTaskLogLoading true then false for non-silent load", async () => {
    let resolve;
    fetchTasksMock.mockImplementation(() => new Promise((r) => { resolve = r; }));

    const { result } = renderHook(() => useTaskLog());

    let promise;
    act(() => { promise = result.current.loadTasks(); });

    expect(result.current.isTaskLogLoading).toBe(true);

    await act(async () => {
      resolve(makeTasks([{ id: 2 }]));
      await promise;
    });

    expect(result.current.isTaskLogLoading).toBe(false);
  });

  it("silent error does not call message.warning", async () => {
    fetchTasksMock.mockRejectedValue(new Error("network"));
    const { result } = renderHook(() => useTaskLog());

    await act(() => result.current.loadTasks({ silent: true }));

    expect(mockWarning).not.toHaveBeenCalled();
  });

  it("non-silent error calls message.warning", async () => {
    fetchTasksMock.mockRejectedValue(new Error("network"));
    const { result } = renderHook(() => useTaskLog());

    await act(() => result.current.loadTasks());

    expect(mockWarning).toHaveBeenCalledWith("Unable to load task log.");
  });

  it("loadTasks returns the fresh array even when state is deduplicated", async () => {
    const payload = [{ id: 1, status: "running" }];
    fetchTasksMock.mockResolvedValue(makeTasks(payload));

    const { result } = renderHook(() => useTaskLog());

    await act(() => result.current.loadTasks());

    const fresh = [{ id: 1, status: "running" }];
    fetchTasksMock.mockResolvedValue(makeTasks(fresh));

    let returned;
    await act(async () => { returned = await result.current.loadTasks(); });

    expect(returned).toEqual(fresh);
  });

  it("exports TASK_TYPES and ACTIVE_TASK_STATUSES unchanged", () => {
    expect(TASK_TYPES.externalRecommendation).toBe("external_recommendation");
    expect(ACTIVE_TASK_STATUSES.has("queued")).toBe(true);
    expect(ACTIVE_TASK_STATUSES.has("running")).toBe(true);
    expect(hasActiveTasks([{ status: "running" }])).toBe(true);
    expect(hasActiveTasks([{ status: "done" }])).toBe(false);
  });
});
