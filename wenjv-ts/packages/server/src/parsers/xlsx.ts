import JSZip from 'jszip';

export interface ParsedXlsxSheet {
  name: string;
  rows: string[][];
}

export interface ParsedXlsxResult {
  text: string;
  sheets: ParsedXlsxSheet[];
}

function decodeXmlEntities(raw: string): string {
  return raw
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"');
}

function columnLettersToIndex(ref: string): number {
  const letters = ref.replace(/[^A-Z]/gi, '').toUpperCase();
  let col = 0;
  for (let i = 0; i < letters.length; i++) {
    col = col * 26 + (letters.charCodeAt(i) - 64);
  }
  return Math.max(0, col - 1);
}

function parseSharedStrings(xml: string): string[] {
  const strings: string[] = [];
  const siMatches = xml.match(/<si\b[^>]*>[\s\S]*?<\/si>/g) || [];
  for (const si of siMatches) {
    const tMatches = si.match(/<t\b[^>]*>([\s\S]*?)<\/t>/g) || [];
    const joined = tMatches
      .map((t) => decodeXmlEntities(t.replace(/<t\b[^>]*>/, '').replace(/<\/t>/, '')))
      .join('');
    strings.push(joined);
  }
  return strings;
}

function formatCsvCell(val: string): string {
  const trimmed = val.trim();
  if (!trimmed) return '';
  if (/[",\n\r]/.test(trimmed)) {
    return `"${trimmed.replace(/"/g, '""')}"`;
  }
  return trimmed;
}

function parseWorksheetRows(xml: string, sharedStrings: string[]): string[][] {
  const rows: string[][] = [];
  const rowMatches = xml.match(/<row\b[^>]*>[\s\S]*?<\/row>/g) || [];

  for (const rowXml of rowMatches) {
    const cells: string[] = [];
    const cellMatches = rowXml.match(/<c\b[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g) || [];
    let nextCol = 0;

    for (const cellXml of cellMatches) {
      const refMatch = cellXml.match(/\br="([A-Z]+\d+)"/i);
      const colIdx = refMatch?.[1] ? columnLettersToIndex(refMatch[1]) : nextCol;
      while (cells.length <= colIdx) {
        cells.push('');
      }
      nextCol = colIdx + 1;

      const typeMatch = cellXml.match(/\bt="([^"]+)"/);
      const cellType = typeMatch?.[1] || '';

      let value = '';
      if (cellType === 'inlineStr') {
        const tMatches = cellXml.match(/<t\b[^>]*>([\s\S]*?)<\/t>/g) || [];
        value = tMatches
          .map((t) => decodeXmlEntities(t.replace(/<t\b[^>]*>/, '').replace(/<\/t>/, '')))
          .join('');
      } else {
        const vMatch = cellXml.match(/<v\b[^>]*>([\s\S]*?)<\/v>/);
        const rawVal = vMatch?.[1] ? decodeXmlEntities(vMatch[1]) : '';
        if (cellType === 's') {
          const idx = parseInt(rawVal, 10);
          value = Number.isInteger(idx) && idx >= 0 && idx < sharedStrings.length ? sharedStrings[idx] || '' : '';
        } else if (cellType === 'b') {
          value = rawVal === '1' ? 'TRUE' : 'FALSE';
        } else {
          value = rawVal;
        }
      }
      cells[colIdx] = value.trim();
    }

    if (cells.some((c) => c !== '')) {
      rows.push(cells);
    }
  }

  return rows;
}

/**
 * Parse an Office Open XML workbook (.xlsx) into structured sheet rows and CSV-like text blocks.
 */
export async function parseXlsx(buffer: Buffer): Promise<ParsedXlsxResult> {
  const zip = await JSZip.loadAsync(buffer);

  let sharedStrings: string[] = [];
  const ssFile = zip.file('xl/sharedStrings.xml');
  if (ssFile) {
    sharedStrings = parseSharedStrings(await ssFile.async('string'));
  }

  // Resolve sheet names from workbook.xml + workbook.xml.rels when present
  const sheetNamesByRel = new Map<string, string>();
  const relTargets = new Map<string, string>();

  const relsFile = zip.file('xl/_rels/workbook.xml.rels');
  if (relsFile) {
    const relsXml = await relsFile.async('string');
    const relTags = relsXml.match(/<Relationship\b[^>]*>/g) || [];
    for (const tag of relTags) {
      const idM = tag.match(/\bId="([^"]+)"/);
      const tgtM = tag.match(/\bTarget="([^"]+)"/);
      if (idM?.[1] && tgtM?.[1]) {
        const cleanTarget = tgtM[1].replace(/^\/+/, '');
        const fullPath = cleanTarget.startsWith('xl/') ? cleanTarget : `xl/${cleanTarget}`;
        relTargets.set(idM[1], fullPath);
      }
    }
  }

  const orderedSheets: { name: string; path: string }[] = [];
  const wbFile = zip.file('xl/workbook.xml');
  if (wbFile) {
    const wbXml = await wbFile.async('string');
    const sheetTags = wbXml.match(/<sheet\b[^>]*>/g) || [];
    for (const tag of sheetTags) {
      const nameM = tag.match(/\bname="([^"]+)"/);
      const ridM = tag.match(/\br:id="([^"]+)"/);
      if (nameM?.[1] && ridM?.[1]) {
        const resolved = relTargets.get(ridM[1]);
        if (resolved) {
          orderedSheets.push({ name: decodeXmlEntities(nameM[1]), path: resolved });
          sheetNamesByRel.set(resolved, decodeXmlEntities(nameM[1]));
        }
      }
    }
  }

  if (orderedSheets.length === 0) {
    const fallbackEntries: { num: number; path: string }[] = [];
    zip.forEach((relPath) => {
      const m = relPath.match(/^xl\/worksheets\/sheet(\d+)\.xml$/);
      if (m?.[1]) {
        fallbackEntries.push({ num: parseInt(m[1], 10), path: relPath });
      }
    });
    fallbackEntries.sort((a, b) => a.num - b.num);
    for (const entry of fallbackEntries) {
      orderedSheets.push({ name: `Sheet${entry.num}`, path: entry.path });
    }
  }

  const sheets: ParsedXlsxSheet[] = [];
  const textBlocks: string[] = [];

  for (const entry of orderedSheets) {
    const f = zip.file(entry.path);
    if (!f) continue;
    const xml = await f.async('string');
    const rows = parseWorksheetRows(xml, sharedStrings);
    if (rows.length === 0) continue;
    sheets.push({ name: entry.name, rows });
    const csvLines = rows.map((r) => r.map(formatCsvCell).join(','));
    textBlocks.push(`## ${entry.name}\n${csvLines.join('\n')}`);
  }

  return {
    text: textBlocks.join('\n\n'),
    sheets,
  };
}
