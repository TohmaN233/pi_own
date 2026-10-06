"use client";

import { useI18n } from "@/hooks/useI18n";
import { getFileName } from "@/lib/file-paths";
import type { WrittenFile } from "@/lib/turn-written-files";
import { getFileIcon } from "./FileIcons";
import { LocalFileLink } from "./LocalFileLink";

/**
 * Lists the files a turn actually wrote, as links that open each one in the
 * preview pane. Entries come from the turn's successful `write`/`edit` tool
 * calls — the reply text is never scanned for paths.
 */
export function TurnWrittenFiles({ files, onOpenFile }: {
  files: WrittenFile[];
  onOpenFile?: (filePath: string) => void;
}) {
  const { t } = useI18n();
  if (files.length === 0) return null;

  return (
    <div aria-label={t("chat.filesWritten")} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, marginTop: 6 }}>
      {files.map(({ filePath }) => {
        const name = getFileName(filePath);
        return (
          <LocalFileLink
            key={filePath}
            href={`/__pi_file__/${encodeURIComponent(filePath)}`}
            filePath={filePath}
            onOpenFile={onOpenFile}
            title={filePath}
            aria-label={t("chat.openWrittenFile", { name })}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              padding: "2px 8px",
              fontSize: 12,
              fontFamily: "var(--font-mono)",
              color: "var(--text)",
              background: "var(--bg-subtle)",
              border: "1px solid var(--border)",
              borderRadius: 6,
              cursor: "pointer",
              textDecoration: "none",
            }}
          >
            {getFileIcon(name, 12)}
            <span>{name}</span>
          </LocalFileLink>
        );
      })}
    </div>
  );
}
