// Teams/Outlook HTML to plain text (no dependencies, so pure modules and tests can import it).
export const strip = (h) => (h || '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<br\s*\/?>|<\/p>/gi, '\n')
  .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*\n+/g, '\n\n').trim();
