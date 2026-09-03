export function decodeQuotedPrintable(str: string): string {
  if (!str) return '';
  // Remove soft line breaks
  let decoded = str.replace(/=\r?\n/g, '');
  // Decode hex bytes
  decoded = decoded.replace(/=([0-9A-Fa-f]{2})/g, (match, hex) => {
    try {
      const code = parseInt(hex, 16);
      return String.fromCharCode(code);
    } catch {
      return match;
    }
  });
  // Handle UTF-8 multi-byte sequences that may have been decoded as latin1
  try {
    return decodeURIComponent(escape(decoded));
  } catch {
    return decoded;
  }
}

export function cleanEmailBody(raw: string): { cleanText: string; quotedText: string } {
  if (!raw) return { cleanText: '', quotedText: '' };

  let text = raw;

  // 1. If raw contains MIME parts, extract text/plain or text/html
  if (text.includes('Content-Type:') || text.includes('Content-Transfer-Encoding:') || text.includes('--')) {
    // Check if multipart
    const plainPartMatch = text.match(/Content-Type:\s*text\/plain[^;\n]*(?:;[^\n]*)?\r?\n(?:Content-Transfer-Encoding:\s*([^\r\n]+)\r?\n)?(?:\r?\n)([\s\S]*?)(?=(?:\r?\n--|\z))/i);
    
    if (plainPartMatch) {
      let partContent = plainPartMatch[2] || '';
      const encoding = (plainPartMatch[1] || '').trim().toLowerCase();
      if (encoding === 'quoted-printable') {
        partContent = decodeQuotedPrintable(partContent);
      } else if (encoding === 'base64') {
        try {
          partContent = Buffer.from(partContent.replace(/\s+/g, ''), 'base64').toString('utf8');
        } catch { /* ignore */ }
      }
      text = partContent;
    } else {
      // Check html part
      const htmlPartMatch = text.match(/Content-Type:\s*text\/html[^;\n]*(?:;[^\n]*)?\r?\n(?:Content-Transfer-Encoding:\s*([^\r\n]+)\r?\n)?(?:\r?\n)([\s\S]*?)(?=(?:\r?\n--|\z))/i);
      if (htmlPartMatch) {
        let partContent = htmlPartMatch[2] || '';
        const encoding = (htmlPartMatch[1] || '').trim().toLowerCase();
        if (encoding === 'quoted-printable') {
          partContent = decodeQuotedPrintable(partContent);
        } else if (encoding === 'base64') {
          try {
            partContent = Buffer.from(partContent.replace(/\s+/g, ''), 'base64').toString('utf8');
          } catch { /* ignore */ }
        }
        // Strip html tags
        text = partContent.replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n\n').replace(/<[^>]*>/g, '');
      } else {
        // Just decode quoted printable on whole text
        text = decodeQuotedPrintable(text);
      }
    }
  } else {
    text = decodeQuotedPrintable(text);
  }

  // Remove any leftover MIME boundary markers and headers
  text = text
    .replace(/^--[a-zA-Z0-9_-]+.*$/gm, '')
    .replace(/^Content-Type:.*$/gmi, '')
    .replace(/^Content-Transfer-Encoding:.*$/gmi, '')
    .replace(/^Content-Disposition:.*$/gmi, '')
    .replace(/^charset=.*$/gmi, '')
    .trim();

  // 2. Separate new reply from quoted reply history (e.g., "On Thu, Aug 20... Daniel wrote:", "> ...")
  const quoteSplitRegex = /(?:\r?\n|^)(?:On\s+.+?\s+wrote:|-{3,}\s*Original Message\s*-{3,}|From:\s+.+?\nSent:\s+|\>.*)/i;
  const match = text.match(quoteSplitRegex);

  let cleanText = text;
  let quotedText = '';

  if (match && match.index !== undefined && match.index > 0) {
    cleanText = text.slice(0, match.index).trim();
    quotedText = text.slice(match.index).trim();
  } else if (text.startsWith('>')) {
    // Everything is a quote
    cleanText = text;
  }

  // If cleanText became empty, fallback to full text
  if (!cleanText) {
    cleanText = text;
  }

  return { cleanText, quotedText };
}
