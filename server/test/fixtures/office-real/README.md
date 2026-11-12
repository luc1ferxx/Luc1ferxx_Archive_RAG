# Files written by Office itself

`test/office-real-files.test.mjs` loads these five files. Microsoft Word, PowerPoint and Excel 16.115 for Mac wrote them on 2026-11-11. The apps were driven through AppleScript, and each app also saved and exported every file itself.

| File | Written by | What it holds |
| --- | --- | --- |
| `security-review.pptx` | PowerPoint, new deck | title slide; title-and-content slide whose bullets come from the slide master; speaker notes; hidden third slide; section header |
| `incident-targets.pptx` | PowerPoint, open and save | the fixture builder's table deck; PowerPoint repaired the minimal package on open, then saved its own table and notes page |
| `travel-policy.docx` | Word, new document | Heading 1 and Heading 2; List Bullet paragraphs; a footnote |
| `equipment-rules.docx` | Word, open and save | the fixture builder's document: numbered list, table, footnote, endnote, comment |
| `budget.xlsx` | Excel, new workbook | merged title row; number formats; formulas; `DATE()` dates; hidden sheet `Scratch` |

The footnote in `travel-policy.docx` was added with AppleScript (`make new footnote`). When it was added, Word wrote "No Reference" in front of the footnote's text.

## Personal details

Office writes the account name into `docProps/core.xml` (`dc:creator`, `cp:lastModifiedBy`). Excel also writes the folder the workbook was saved in into `xl/workbook.xml` (`x15ac:absPath`). `scrub-office-package.mjs` rewrote only those parts:

- The account name became `Archive RAG test`.
- The folder became `/Users/test/Documents/`.

Every other entry, including its local header and compressed data, is byte for byte what Office wrote. The script fails if a replaced string is still present in any part. The test checks the author fields and that no part names another `/Users/` folder.

To scrub a new file:

```bash
node scrub-office-package.mjs <in> <out> "<account name>=Archive RAG test" "<saved folder>/=/Users/test/Documents/"
```
