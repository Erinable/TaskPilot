// A note's title is its file name, so titles follow Obsidian's file rules.
// Kept apart from note_markdown.ts so code that only needs titles (the notes
// store, the practice panel) does not pull the Markdown parser into its bundle.

export const MAX_TITLE = 80;
// Characters a file name cannot hold on some system, plus the ones Obsidian
// reserves inside [[links]] (# heading, ^ block, | alias, brackets).
const TITLE_FORBIDDEN = /[\\/:*?"<>|#^[\]]/g;
// eslint-disable-next-line no-control-regex
const TITLE_CONTROL = /[\u0000-\u001f\u007f‪-‮⁦-⁩]/g;

// Why a title cannot be a note's file name, or null when it can.
export const titleProblem = (title: string): string | null => {
  if (!title.trim()) return '标题不能为空';
  if (title !== title.trim()) return '标题前后不能有空格';
  if ([...title].length > MAX_TITLE) return `标题最多 ${MAX_TITLE} 个字`;
  if (title.startsWith('.')) return '标题不能以 . 开头';
  if (new RegExp(TITLE_FORBIDDEN.source).test(title) || new RegExp(TITLE_CONTROL.source).test(title)) return '标题不能包含 \\ / : * ? " < > | # ^ [ ]';
  return null;
};

// Turns any text (a grade comment, an old note title) into a usable title.
export const toTitle = (text: string): string => {
  const cleaned = text.replace(TITLE_CONTROL, ' ').replace(TITLE_FORBIDDEN, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+/, '').trim();
  const chars = [...cleaned];
  const short =
    chars.length > MAX_TITLE
      ? `${chars
          .slice(0, MAX_TITLE - 1)
          .join('')
          .trim()}…`
      : cleaned;
  return short || '未命名';
};

// Links resolve by title, ignoring case, as in Obsidian.
export const titleKey = (title: string) => title.trim().toLowerCase();
