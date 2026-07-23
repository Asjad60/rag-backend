/**
 * Stage F: Parse Document Structure (Tables, Code Blocks, QA Pairs).
 * Extracts and tags structural blocks so text splitters respect boundaries.
 */

function parseDocumentStructure(rawText) {
  const blocks = [];
  const lines = rawText.split('\n');

  let currentBlockType = 'text';
  let currentLines = [];

  const flushBlock = () => {
    if (currentLines.length > 0) {
      const content = currentLines.join('\n').trim();
      if (content) {
        blocks.push({
          type: currentBlockType,
          content,
        });
      }
      currentLines = [];
    }
  };

  let inCodeBlock = false;
  let inTable = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Fenced Code Block Detection
    if (line.trim().startsWith('```')) {
      if (!inCodeBlock) {
        flushBlock();
        inCodeBlock = true;
        currentBlockType = 'code_block';
        currentLines.push(line);
      } else {
        currentLines.push(line);
        inCodeBlock = false;
        flushBlock();
        currentBlockType = 'text';
      }
      continue;
    }

    if (inCodeBlock) {
      currentLines.push(line);
      continue;
    }

    // Markdown Table Detection
    const isTableLine = /^\s*\|.*\|\s*$/.test(line);
    if (isTableLine) {
      if (!inTable) {
        flushBlock();
        inTable = true;
        currentBlockType = 'table';
      }
      currentLines.push(line);
      continue;
    } else if (inTable) {
      inTable = false;
      flushBlock();
      currentBlockType = 'text';
    }

    // Q&A Pair Detection
    const isQAPair = /^(Q:|Question:|FAQ:|\d+\.\s+Q:)/i.test(line);
    if (isQAPair && currentBlockType !== 'qa_pair') {
      flushBlock();
      currentBlockType = 'qa_pair';
    }

    currentLines.push(line);
  }

  flushBlock();
  return blocks;
}

module.exports = { parseDocumentStructure };
