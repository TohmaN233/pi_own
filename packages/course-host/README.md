# Course Host

Creates immutable, content-addressed CourseVersions from Markdown, UTF-8 text, code, notebooks, and PDF text extracted through the shipped `PdftotextExtractor` adapter. It gives every source span a stable identity, flags instruction-like content as data, and rejects cross-course reads and session rebinding.

`PdftotextExtractor` writes only the bounded input PDF to a temporary directory and collects `pdftotext` stdout through a live byte-counted pipe. It enforces explicit input, stdout, stderr, and timeout limits. `CourseHost` separately limits extracted PDF text, total normalized course text, and generated source spans before committing an immutable version. Operational extractor configuration, spawn, stdout/stderr, cleanup, and timeout failures remain errors; callers can distinguish validated size limits from invalid course input through `CourseHostError.code`.
