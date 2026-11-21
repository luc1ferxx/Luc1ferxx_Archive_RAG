import { createTranslator } from "./archiveI18n";

describe("createTranslator counts", () => {
  test("take the key for 1 and its _plural entry for any other count", () => {
    const en = createTranslator("en");

    expect(en("app.recordedTurn", { count: 0 })).toBe("0 recorded turns");
    expect(en("app.recordedTurn", { count: 1 })).toBe("1 recorded turn");
    expect(en("app.recordedTurn", { count: 5 })).toBe("5 recorded turns");
    expect(en("app.turnShort", { count: 5 })).toBe("5 turns");
    expect(en("common.docs", { count: 1 })).toBe("1 doc");
    expect(en("sidebar.arxivRecommendations", { count: 1 })).toBe("1 arXiv recommendation");
    // A label without a _plural entry reads the same for every count.
    expect(en("sidebar.recoveryWaiting", { count: 2 })).toBe("2 waiting");
  });

  test("Chinese has one form, unless a _plural entry words it differently", () => {
    const zh = createTranslator("zh");

    expect(zh("app.turnShort", { count: 5 })).toBe("5 轮");
    expect(zh("common.docs", { count: 1 })).toBe("1 个文档");
    expect(zh("home.selectedDocuments", { count: 3 })).toBe("已选 3 个文档");
    expect(zh("sidebar.clearWorkspaceConfirm", { count: 3 })).toBe("删除此工作区中的全部 3 个文档？");
  });
});
