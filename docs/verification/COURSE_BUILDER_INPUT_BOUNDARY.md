# Course Builder input boundary

PPTX is treated as untrusted bounded ZIP/XML input. The importer limits compressed bytes, entry count, individual XML bytes, cumulative extracted text, accepted asset bytes, and normalized paths. It rejects traversal and duplicate canonical paths. Extracted slide text and speaker notes are semantic source material; the importer does not claim to preserve slide masters, animations, SmartArt, native charts, embedded macros, or exact layout.

Beamer source and project assets are confined to the Course Builder project. Compilation rejects unsupported/dangerous primitives, disables shell escape, limits subprocess time and captured output, and hashes source, PDF, logs, and receipts. This is a hardened compiler adapter, not an operating-system sandbox.
