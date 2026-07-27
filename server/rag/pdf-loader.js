import pdfParse from "pdf-parse";
import { readFile } from "node:fs/promises";

const normalizePageText = (text = "") =>
  String(text)
    .replace(/\u0000/g, "")
    .replace(/\r/g, "")
    .replace(/-\n(?=[a-z])/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

const renderPdfPageText = async (pageData) => {
  const textContent = await pageData.getTextContent({
    normalizeWhitespace: false,
    disableCombineTextItems: false,
  });
  let text = "";
  let lastY = null;

  for (const item of textContent.items) {
    const y = item.transform?.[5];
    const value = item.str ?? "";

    if (!value) {
      continue;
    }

    if (lastY === null || lastY === y) {
      text += value;
    } else {
      text += `\n${value}`;
    }

    lastY = y;
  }

  return text;
};

export const loadPdfPages = async (filePath) => {
  const dataBuffer = await readFile(filePath);
  const pages = [];

  await pdfParse(dataBuffer, {
    pagerender: async (pageData) => {
      const text = await renderPdfPageText(pageData);
      pages.push(normalizePageText(text));
      return text;
    },
  });

  return pages.map((text, index) => ({
    pageNumber: index + 1,
    text,
  }));
};
