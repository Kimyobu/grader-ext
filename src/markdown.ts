/**
 * A deliberately small Markdown subset, sized to what the challenge
 * descriptions actually use: `---` rules, pipe tables with alignment rows,
 * `**bold**`, inline `code`, and `- ` lists. Everything is escaped before any
 * markup is emitted, so the output is safe to inject into a webview.
 *
 * A survey of all 47 descriptions found only tables, rules, lists and bold.
 * There are no headings, fences, or blockquotes, but a few are handled anyway
 * so an unusual description degrades gracefully rather than showing raw pipes.
 */

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderMarkdown(source: string): string {
  const lines = escapeHtml(source).replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (isRule(line)) {
      out.push('<hr>');
      i++;
      continue;
    }

    // Most descriptions use `--- หัวข้อ ---` as a section separator rather than a
    // bare rule; render the label as a centred divider.
    const labelled = /^\s*-{3,}\s*(.+?)\s*-{3,}\s*$/.exec(line);
    if (labelled) {
      out.push(`<div class="rule"><span>${inline(labelled[1])}</span></div>`);
      i++;
      continue;
    }

    if (isTableRow(line)) {
      const table: string[] = [];
      while (i < lines.length && isTableRow(lines[i])) {
        table.push(lines[i]);
        i++;
      }
      out.push(renderTable(table));
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      i++;
      continue;
    }

    if (/^&gt;\s?/.test(line)) {
      out.push(`<blockquote>${inline(line.replace(/^&gt;\s?/, ''))}</blockquote>`);
      i++;
      continue;
    }

    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ''));
        i++;
      }
      out.push(`<ul>${items.map((t) => `<li>${inline(t)}</li>`).join('')}</ul>`);
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ''));
        i++;
      }
      out.push(`<ol>${items.map((t) => `<li>${inline(t)}</li>`).join('')}</ol>`);
      continue;
    }

    if (!line.trim()) {
      i++;
      continue;
    }

    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !isRule(lines[i]) &&
      !isLabelledRule(lines[i]) &&
      !isTableRow(lines[i]) &&
      !/^(#{1,6})\s/.test(lines[i]) &&
      !/^\s*[-*]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i])
    ) {
      para.push(lines[i].trim());
      i++;
    }
    out.push(`<p>${inline(para.join(' '))}</p>`);
  }

  return out.join('');
}

/** Inline emphasis and code spans within an already-escaped line. */
function inline(escaped: string): string {
  return escaped
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>');
}

function isRule(line: string): boolean {
  return /^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line);
}

/** `--- Some section heading ---`, which the descriptions use heavily. */
function isLabelledRule(line: string): boolean {
  return /^\s*-{3,}\s*.+?\s*-{3,}\s*$/.test(line);
}

function isTableRow(line: string): boolean {
  return /^\s*\|.*\|\s*$/.test(line);
}

/** True for the `| :---: | :--- |` separator row that markdown tables carry. */
function isAlignmentRow(cells: string[]): boolean {
  return cells.every((c) => /^:?-{2,}:?$/.test(c.trim()));
}

function splitRow(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|');
}

function renderTable(rows: string[]): string {
  const parsed = rows.map(splitRow);
  const alignRowIndex = parsed.findIndex((cells) => isAlignmentRow(cells));

  // Without an alignment row the first line is still the header, which is the
  // common case for hand-written descriptions.
  const header = parsed[0];
  const body = parsed.slice(alignRowIndex >= 0 ? alignRowIndex + 1 : 1);

  const align = alignRowIndex >= 0 ? parsed[alignRowIndex] : [];
  const alignFor = (index: number): string => {
    const spec = (align[index] ?? '').trim();
    if (spec.startsWith(':') && spec.endsWith(':')) {
      return ' style="text-align:center"';
    }
    if (spec.endsWith(':')) {
      return ' style="text-align:right"';
    }
    return '';
  };

  const thead = `<thead><tr>${header
    .map((cell, idx) => `<th${alignFor(idx)}>${inline(cell.trim())}</th>`)
    .join('')}</tr></thead>`;

  const tbody = `<tbody>${body
    .map(
      (row) =>
        `<tr>${header
          .map((_, idx) => `<td${alignFor(idx)}>${inline((row[idx] ?? '').trim())}</td>`)
          .join('')}</tr>`,
    )
    .join('')}</tbody>`;

  return `<table>${thead}${tbody}</table>`;
}