# Sample

The Library seeds an empty installation from `papers/`. The sample also supports the reader tests and the help illustrations.

- *Measuring Runoff from Rain Gardens* is a fictional four-page, two-column study with a running header and footer. Nothing in it describes a real experiment. [`scripts/rain-gardens.source.txt`](../scripts/rain-gardens.source.txt) is its text, and `node scripts/make-sample-pdf.mjs` typesets it with headless Chrome. It has two hand-authored maps: a detailed one and a short one. The detailed map includes a quote that repeats, a sentence that crosses a page break, a paraphrased quote that matches approximately, a quote that is not in the paper, and a record with no quote.

All sample files were written for this project and fall under its [MIT License](../LICENSE). The project holds no third-party papers.
