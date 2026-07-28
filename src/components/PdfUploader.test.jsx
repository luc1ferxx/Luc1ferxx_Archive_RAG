import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import PdfUploader, { validatePdfFile, MAX_UPLOAD_SIZE_MB } from "./PdfUploader";

const MAX_UPLOAD_SIZE_BYTES = MAX_UPLOAD_SIZE_MB * 1024 * 1024;

describe("validatePdfFile", () => {
  it("accepts a valid .pdf file", () => {
    const file = { name: "a.pdf", size: 1024, type: "application/pdf" };
    expect(validatePdfFile(file)).toEqual({ ok: true });
  });

  it("accepts an uppercase .PDF with empty MIME type", () => {
    const file = { name: "report.PDF", size: 2048, type: "" };
    expect(validatePdfFile(file)).toEqual({ ok: true });
  });

  it("rejects a non-PDF file as invalidType", () => {
    const file = { name: "a.exe", size: 1024, type: "application/octet-stream" };
    expect(validatePdfFile(file)).toEqual({ ok: false, reason: "invalidType" });
  });

  it("rejects a file exceeding the size limit as tooLarge", () => {
    const file = { name: "big.pdf", size: MAX_UPLOAD_SIZE_BYTES + 1, type: "application/pdf" };
    expect(validatePdfFile(file)).toEqual({ ok: false, reason: "tooLarge" });
  });

  it("accepts a file exactly at the size limit", () => {
    const file = { name: "exact.pdf", size: MAX_UPLOAD_SIZE_BYTES, type: "application/pdf" };
    expect(validatePdfFile(file)).toEqual({ ok: true });
  });
});

describe("PdfUploader", () => {
  it("renders the English title when no locale is set", () => {
    render(<PdfUploader />);
    expect(screen.getByText("Add PDFs")).toBeInTheDocument();
  });
});
