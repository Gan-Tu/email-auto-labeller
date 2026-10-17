import type { GmailLabel } from "./api";

const collator = new Intl.Collator("en", {
  numeric: true,
  sensitivity: "base",
});
const decorations =
  /[\p{Extended_Pictographic}\p{Emoji_Presentation}\p{Emoji_Modifier}\p{Regional_Indicator}\uFE0E\uFE0F\u200D\u20E3]/gu;

function segmentKey(segment: string) {
  const original = segment.normalize("NFKC").trim();
  // Emoji decorate a label's name; its text determines its position. A label
  // containing only emoji retains its original text as a sortable fallback.
  return (
    original.replace(decorations, "").replace(/\s+/g, " ").trim() || original
  );
}

/** Gmail returns labels in API order. Sort copies, keeping names and IDs intact. */
export function sortLabels<T extends GmailLabel>(labels: readonly T[]): T[] {
  return labels
    .map((label) => ({
      label,
      segments: label.name.split("/").map(segmentKey),
    }))
    .sort((a, b) => {
      const count = Math.min(a.segments.length, b.segments.length);
      for (let index = 0; index < count; index++) {
        const left = a.segments[index],
          right = b.segments[index];
        const pinned =
          Number(right.startsWith("!")) - Number(left.startsWith("!"));
        if (pinned) return pinned;
        const compared = collator.compare(left, right);
        if (compared) return compared;
      }
      // A folder precedes every descendant, keeping each hierarchy together.
      const depth = a.segments.length - b.segments.length;
      if (depth) return depth;
      return a.label.id < b.label.id ? -1 : a.label.id > b.label.id ? 1 : 0;
    })
    .map(({ label }) => label);
}
